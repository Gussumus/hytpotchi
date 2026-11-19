//! Discord Rich Presence через локальный IPC Discord (без сторонних библиотек).
//!
//! Протокол: кадр = [op: u32 LE][len: u32 LE][JSON]. op 0 — handshake, op 1 — команда.
//! Нужен ID приложения Discord (developer portal) в HYTPOTCHI_DISCORD_ID.

use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};

use anyhow::{Context, Result, bail};
use parking_lot::Mutex;

static ENABLED: AtomicBool = AtomicBool::new(true);
static CONN: Mutex<Option<std::fs::File>> = Mutex::new(None);

pub fn set_enabled(enabled: bool) {
    ENABLED.store(enabled, Ordering::Relaxed);
    if !enabled {
        clear();
    }
}

pub fn client_id() -> Option<String> {
    std::env::var("HYTPOTCHI_DISCORD_ID")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .or_else(|| option_env!("HYTPOTCHI_DISCORD_ID").map(str::to_string))
        .filter(|s| !s.is_empty())
}

pub fn available() -> bool {
    client_id().is_some()
}

fn frame(op: u32, payload: &serde_json::Value) -> Vec<u8> {
    let body = payload.to_string().into_bytes();
    let mut out = Vec::with_capacity(8 + body.len());
    out.extend_from_slice(&op.to_le_bytes());
    out.extend_from_slice(&(body.len() as u32).to_le_bytes());
    out.extend(body);
    out
}

fn read_frame(conn: &mut std::fs::File) -> Result<serde_json::Value> {
    let mut header = [0u8; 8];
    conn.read_exact(&mut header)?;
    let len = u32::from_le_bytes(header[4..8].try_into().unwrap()) as usize;
    if len > 64 * 1024 {
        bail!("Слишком большой ответ Discord");
    }
    let mut body = vec![0u8; len];
    conn.read_exact(&mut body)?;
    Ok(serde_json::from_slice(&body).unwrap_or_default())
}

#[cfg(target_os = "windows")]
fn open_pipe() -> Result<std::fs::File> {
    for i in 0..10 {
        let path = format!(r"\\.\pipe\discord-ipc-{i}");
        if let Ok(f) = std::fs::OpenOptions::new().read(true).write(true).open(&path) {
            return Ok(f);
        }
    }
    bail!("Discord не запущен")
}

#[cfg(not(target_os = "windows"))]
fn open_pipe() -> Result<std::fs::File> {
    bail!("Discord RPC поддерживается только на Windows")
}

fn connect() -> Result<std::fs::File> {
    let id = client_id().context("Не задан ID приложения Discord")?;
    let mut conn = open_pipe()?;
    conn.write_all(&frame(0, &serde_json::json!({ "v": 1, "client_id": id })))?;
    let ready = read_frame(&mut conn)?;
    if ready["evt"] != "READY" {
        bail!("Discord отклонил подключение: {ready}");
    }
    Ok(conn)
}

fn send_activity(activity: serde_json::Value) -> Result<()> {
    let mut guard = CONN.lock();
    if guard.is_none() {
        *guard = Some(connect()?);
    }
    let conn = guard.as_mut().unwrap();
    let payload = serde_json::json!({
        "cmd": "SET_ACTIVITY",
        "args": { "pid": std::process::id(), "activity": activity },
        "nonce": uuid::Uuid::new_v4().to_string(),
    });
    let result = conn.write_all(&frame(1, &payload)).map_err(anyhow::Error::from).and_then(|_| read_frame(conn));
    if result.is_err() {
        // Discord перезапустили — переподключимся при следующем вызове
        *guard = None;
    }
    result.map(|_| ())
}

/// Показать «Играет в …»
pub fn set_playing(instance: &str, state: &str) {
    if !ENABLED.load(Ordering::Relaxed) || !available() {
        return;
    }
    let activity = serde_json::json!({
        "details": format!("Играет в «{instance}»"),
        "state": state,
        "timestamps": { "start": chrono::Utc::now().timestamp() },
        "assets": { "large_image": "logo", "large_text": "Hytpotchi" },
        "instance": false,
    });
    std::thread::spawn(move || {
        if let Err(e) = send_activity(activity) {
            log::info!("Discord RPC: {e:#}");
        }
    });
}

/// Убрать статус и закрыть соединение
pub fn clear() {
    std::thread::spawn(|| {
        let mut guard = CONN.lock();
        if let Some(conn) = guard.as_mut() {
            let payload = serde_json::json!({
                "cmd": "SET_ACTIVITY",
                "args": { "pid": std::process::id() },
                "nonce": uuid::Uuid::new_v4().to_string(),
            });
            let _ = conn.write_all(&frame(1, &payload)).and_then(|_| read_frame(conn).map(|_| ()).map_err(std::io::Error::other));
        }
        *guard = None;
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_layout() {
        let f = frame(1, &serde_json::json!({"a": 1}));
        assert_eq!(&f[0..4], &1u32.to_le_bytes());
        assert_eq!(u32::from_le_bytes(f[4..8].try_into().unwrap()) as usize, f.len() - 8);
    }
}
