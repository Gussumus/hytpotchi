//! Проверка загрузчиков (Forge, NeoForge, Fabric, Quilt) на разных версиях игры: поставить загрузчик так же, как при запуске
//! сборки, запустить игру и дождаться главного меню. Качает гигабайты, поэтому только вручную:
//!
//! ```text
//! cargo test --lib loader_matrix -- --ignored --nocapture
//! LOADER_MATRIX="forge:1.20.1 neoforge:1.21.1" cargo test --lib loader_matrix -- --ignored --nocapture
//! ```
//!
//! Файлы игры — в общем хранилище лаунчера (`HYTPOTCHI_HOME`), папки игры и логи запусков —
//! в `LOADER_MATRIX_DIR` (по умолчанию `<временная папка>/hytpotchi-loader-matrix`).

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail};
use tokio::io::{AsyncBufReadExt, AsyncRead, BufReader};

use crate::engine::core::http::HttpClient;
use crate::engine::game::install::{ensure_version_files, extract_natives, install_loader, legacy_assets_dir};
use crate::engine::game::java::{ensure_java, normalize_major};
use crate::engine::game::loaders::{self, ForgeKind};
use crate::engine::game::manifest::resolve_version;
use crate::engine::game::pipeline::plan::{GameAccount, LaunchContext, plan_launch};
use crate::engine::game::pipeline::start::start_game;

const DEFAULT: &str = "forge:1.7.10 forge:1.8.9 forge:1.12.2 forge:1.16.5 forge:1.18.2 forge:1.19.2 \
    forge:1.20.1 forge:1.20.4 forge:1.21.1 forge:1.21.4 forge:26.3 \
    neoforge:1.20.1 neoforge:1.21.1 neoforge:1.21.4 neoforge:26.3 \
    fabric:1.20.1 fabric:26.3 quilt:1.20.1 quilt:26.3";

/// Строка лога, после которой игра считается дошедшей до главного меню (есть во всех версиях)
const READY: &[&str] = &["Sound engine started"];
/// Сколько ждать меню
const READY_TIMEOUT: Duration = Duration::from_secs(300);
/// Сколько ещё подержать игру после меню — вдруг упадёт сразу
const AFTER_READY: Duration = Duration::from_secs(8);

fn work_dir() -> PathBuf {
    std::env::var_os("LOADER_MATRIX_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::temp_dir().join("hytpotchi-loader-matrix"))
}

async fn pump<R: AsyncRead + Unpin>(stream: R, lines: Arc<Mutex<Vec<String>>>) {
    let mut reader = BufReader::new(stream).lines();
    while let Ok(Some(line)) = reader.next_line().await {
        lines.lock().unwrap().push(line);
    }
}

/// Поставить загрузчик и запустить игру. Ok(версия) — дошла до меню
async fn run_case(http: &HttpClient, loader: &str, mc: &str, dir: &Path) -> Result<String> {
    let log_lines = Arc::new(Mutex::new(Vec::<String>::new()));
    let console = {
        let lines = log_lines.clone();
        move |line: String| lines.lock().unwrap().push(line)
    };
    let no_bytes = |_: u64, _: Option<u64>| {};
    let no_files = |_: &str, _: u64, _: u64| {};

    let result = async {
        // Как в prepare.rs: ваниль + её Java, затем установщик загрузчика
        let vanilla = resolve_version(http, mc).await?;
        let java = ensure_java(http, normalize_major(vanilla.required_java()), &no_bytes).await?;
        ensure_version_files(http, &vanilla, &no_files).await?;
        let (id, version) = match ForgeKind::parse(loader) {
            Some(kind) => loaders::install(http, kind, mc, None, &java, &console).await?,
            None => install_loader(http, loader, mc, None).await?,
        };

        let manifest = resolve_version(http, &id).await?;
        let java = ensure_java(http, normalize_major(manifest.required_java()), &no_bytes).await?;
        ensure_version_files(http, &manifest, &no_files).await?;
        let natives = dir.join("natives");
        extract_natives(&manifest, &natives).await?;

        let game_dir = dir.join("minecraft");
        let account = GameAccount {
            uuid: "1e1e1e1e1e1e4e1e9e1e1e1e1e1e1e1e".into(),
            username: "HytTest".into(),
            access_token: "0".into(),
            user_type: "legacy".into(),
        };
        let plan = plan_launch(LaunchContext {
            manifest: &manifest,
            java: &java,
            game_dir: &game_dir,
            natives_dir: &natives,
            game_assets_dir: legacy_assets_dir(&manifest)?,
            memory_mb: 2048,
            extra_jvm_args: &[],
            account: &account,
            server: None,
        })?;
        std::fs::write(dir.join("command.txt"), plan.args.join("\n"))?;

        let mut child = start_game(&plan)?;
        let out = tokio::spawn(pump(child.stdout.take().context("нет stdout")?, log_lines.clone()));
        let err = tokio::spawn(pump(child.stderr.take().context("нет stderr")?, log_lines.clone()));

        let started = Instant::now();
        let mut ready_at: Option<Instant> = None;
        loop {
            if let Some(status) = child.try_wait()? {
                let _ = tokio::join!(out, err);
                bail!("игра закрылась ({status}) {}", if ready_at.is_some() { "после меню" } else { "до меню" });
            }
            if ready_at.is_none() && log_lines.lock().unwrap().iter().any(|l| READY.iter().any(|r| l.contains(r))) {
                ready_at = Some(Instant::now());
            }
            match ready_at {
                Some(t) if t.elapsed() >= AFTER_READY => break,
                None if started.elapsed() > READY_TIMEOUT => {
                    let _ = child.kill().await;
                    bail!("за {} с игра не дошла до меню", READY_TIMEOUT.as_secs());
                }
                _ => {}
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
        let _ = child.kill().await;
        Ok(format!("{id} (загрузчик {version}, Java {}, {} с)", java.major_version, started.elapsed().as_secs()))
    }
    .await;

    let lines = log_lines.lock().unwrap().clone();
    let _ = std::fs::write(dir.join("run.log"), lines.join("\n"));
    result
}

#[tokio::test]
#[ignore = "качает гигабайты и запускает игру — только вручную"]
async fn loader_matrix() {
    let cases = std::env::var("LOADER_MATRIX").unwrap_or_else(|_| DEFAULT.into());
    let http = HttpClient::new().unwrap();
    let root = work_dir();
    let mut failed = Vec::new();
    for case in cases.split_whitespace() {
        let (loader, mc) = case.split_once(':').expect("формат loader:версия");
        let dir = root.join(case.replace(':', "-"));
        let _ = std::fs::remove_dir_all(dir.join("minecraft").join("crash-reports"));
        std::fs::create_dir_all(&dir).unwrap();
        println!("▶ {case}");
        match run_case(&http, loader, mc, &dir).await {
            Ok(info) => println!("  ✔ {case}: {info}"),
            Err(e) => {
                println!("  ✘ {case}: {e:#}\n    лог: {}", dir.join("run.log").display());
                failed.push(case.to_string());
            }
        }
    }
    assert!(failed.is_empty(), "не запустились: {}", failed.join(", "));
}

/// Списки версий загрузчиков с живых серверов (то, что видит игрок при создании сборки)
#[tokio::test]
#[ignore = "ходит в интернет — только вручную"]
async fn loader_versions_live() {
    let http = HttpClient::new().unwrap();
    for (loader, mc) in [
        ("forge", "1.20.1"),
        ("forge", "1.7.10"),
        ("neoforge", "1.21.1"),
        ("neoforge", "1.20.1"),
        ("fabric", "26.3"),
        ("quilt", "1.20.1"),
        ("forge", "1.0"),
    ] {
        let list = loaders::versions(&http, loader, mc).await.unwrap();
        let recommended: Vec<_> = list.iter().filter(|v| v.recommended).map(|v| v.version.as_str()).collect();
        let head: Vec<_> = list.iter().take(3).map(|v| v.version.as_str()).collect();
        println!("{loader} {mc}: {} версий, сверху {head:?}, рекомендуемая {recommended:?}", list.len());
        if mc != "1.0" {
            assert!(!list.is_empty() && recommended.len() == 1, "{loader} {mc}");
        }
    }
}
