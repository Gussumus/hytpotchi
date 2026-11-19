//! Слежение за запущенными играми: логи, остановка, событие выхода

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::Arc;

use parking_lot::Mutex;
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncRead, BufReader};
use tokio::process::Child;
use tokio::sync::oneshot;

use crate::engine::game::crashcause::{self, CrashHint};

const LOG_LIMIT: usize = 5000;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GameLogEvent {
    pub instance_id: String,
    pub line: String,
    pub stderr: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GameExitInfo {
    pub instance_id: String,
    pub exit_code: Option<i32>,
    pub crashed: bool,
    pub killed: bool,
    pub played_secs: u64,
    /// Вероятная причина краша
    pub hint: Option<CrashHint>,
}

struct Running {
    kill: Option<oneshot::Sender<()>>,
}

#[derive(Default)]
struct State {
    running: HashMap<String, Running>,
    preparing: HashSet<String>,
    logs: HashMap<String, VecDeque<String>>,
}

/// Реестр запущенных игр (по id сборки)
#[derive(Clone, Default)]
pub struct GameWatcher {
    state: Arc<Mutex<State>>,
}

/// Снимается при выходе из подготовки (в т.ч. при ошибке)
pub struct PrepareGuard {
    watcher: GameWatcher,
    instance_id: String,
}

impl Drop for PrepareGuard {
    fn drop(&mut self) {
        self.watcher.state.lock().preparing.remove(&self.instance_id);
    }
}

impl GameWatcher {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn is_busy(&self, instance_id: &str) -> bool {
        let s = self.state.lock();
        s.running.contains_key(instance_id) || s.preparing.contains(instance_id)
    }

    pub fn is_running(&self, instance_id: &str) -> bool {
        self.state.lock().running.contains_key(instance_id)
    }

    /// Пометить сборку как готовящуюся к запуску (защита от двойного клика)
    pub fn begin_prepare(&self, instance_id: &str) -> Option<PrepareGuard> {
        let mut s = self.state.lock();
        if s.running.contains_key(instance_id) || !s.preparing.insert(instance_id.to_string()) {
            return None;
        }
        Some(PrepareGuard {
            watcher: self.clone(),
            instance_id: instance_id.to_string(),
        })
    }

    pub fn running_ids(&self) -> Vec<String> {
        self.state.lock().running.keys().cloned().collect()
    }

    pub fn logs(&self, instance_id: &str) -> Vec<String> {
        self.state
            .lock()
            .logs
            .get(instance_id)
            .map(|l| l.iter().cloned().collect())
            .unwrap_or_default()
    }

    /// Строка от лаунчера (например, вывод установщика Forge) в консоль сборки
    pub fn push_external_log(&self, instance_id: &str, line: String) {
        self.push_log(instance_id, line);
    }

    fn push_log(&self, instance_id: &str, line: String) {
        let mut s = self.state.lock();
        let buf = s.logs.entry(instance_id.to_string()).or_default();
        if buf.len() >= LOG_LIMIT {
            buf.pop_front();
        }
        buf.push_back(line);
    }

    /// Остановить игру
    pub fn stop(&self, instance_id: &str) -> bool {
        let mut s = self.state.lock();
        match s.running.get_mut(instance_id).and_then(|r| r.kill.take()) {
            Some(tx) => tx.send(()).is_ok(),
            None => false,
        }
    }

    /// Взять процесс под наблюдение. Возвращает PID.
    pub fn attach<F>(&self, app: AppHandle, instance_id: String, mut child: Child, on_exit: F) -> u32
    where
        F: FnOnce(&GameExitInfo) + Send + 'static,
    {
        let pid = child.id().unwrap_or(0);
        let (kill_tx, kill_rx) = oneshot::channel();
        {
            let mut s = self.state.lock();
            // Логи подготовки (например, установщика Forge) сохраняем
            s.logs.entry(instance_id.clone()).or_insert_with(VecDeque::new);
            s.running.insert(instance_id.clone(), Running { kill: Some(kill_tx) });
        }

        if let Some(out) = child.stdout.take() {
            self.spawn_reader(app.clone(), instance_id.clone(), out, false);
        }
        if let Some(err) = child.stderr.take() {
            self.spawn_reader(app.clone(), instance_id.clone(), err, true);
        }

        let watcher = self.clone();
        tokio::spawn(async move {
            let started = std::time::Instant::now();
            let mut killed = false;
            let status = tokio::select! {
                status = child.wait() => status,
                _ = kill_rx => {
                    killed = true;
                    let _ = child.kill().await;
                    child.wait().await
                }
            };
            let exit_code = status.ok().and_then(|s| s.code());
            let crashed = !killed && exit_code.is_some_and(|c| c != 0);
            let hint = if crashed {
                // Даём читателям логов дочитать вывод процесса
                tokio::time::sleep(std::time::Duration::from_millis(300)).await;
                let mut text = watcher.logs(&instance_id).join("\n");
                if let Ok(dir) = crate::engine::core::paths::instance_game_dir(&instance_id) {
                    if let Some(report) = crashcause::latest_crash_report(&dir) {
                        text.push('\n');
                        text.push_str(&report);
                    }
                }
                crashcause::analyze(&text)
            } else {
                None
            };
            let info = GameExitInfo {
                instance_id: instance_id.clone(),
                exit_code,
                crashed,
                killed,
                played_secs: started.elapsed().as_secs(),
                hint,
            };
            watcher.state.lock().running.remove(&instance_id);
            log::info!("Игра {instance_id} (pid {pid}) завершилась: {exit_code:?}");
            on_exit(&info);
            let _ = app.emit("game-exit", &info);
        });
        pid
    }

    fn spawn_reader<R>(&self, app: AppHandle, instance_id: String, stream: R, stderr: bool)
    where
        R: AsyncRead + Unpin + Send + 'static,
    {
        let watcher = self.clone();
        tokio::spawn(async move {
            // Читаем байты: у старых версий вывод бывает не в UTF-8
            let mut reader = BufReader::new(stream);
            let mut buf = Vec::with_capacity(512);
            loop {
                buf.clear();
                match reader.read_until(b'\n', &mut buf).await {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {
                        let line = String::from_utf8_lossy(&buf).trim_end().to_string();
                        if line.is_empty() {
                            continue;
                        }
                        watcher.push_log(&instance_id, line.clone());
                        let _ = app.emit(
                            "game-log",
                            GameLogEvent { instance_id: instance_id.clone(), line, stderr },
                        );
                    }
                }
            }
        });
    }
}
