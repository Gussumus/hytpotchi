//! Пинг сервера Minecraft (Server List Ping, 1.7+)

use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail};
use serde::Serialize;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerStatus {
    pub online: bool,
    pub players: Option<u32>,
    pub max_players: Option<u32>,
    pub version: Option<String>,
    pub motd: Option<String>,
    pub ping_ms: Option<u32>,
    pub favicon: Option<String>,
}

impl ServerStatus {
    pub fn offline() -> Self {
        Self { online: false, players: None, max_players: None, version: None, motd: None, ping_ms: None, favicon: None }
    }
}

/// "host[:port]" → (host, port)
pub fn split_address(address: &str) -> (String, u16) {
    let address = address.trim();
    // IPv6 в квадратных скобках
    if let Some(rest) = address.strip_prefix('[') {
        if let Some((host, tail)) = rest.split_once(']') {
            let port = tail.strip_prefix(':').and_then(|p| p.parse().ok()).unwrap_or(25565);
            return (host.to_string(), port);
        }
    }
    match address.rsplit_once(':') {
        Some((host, port)) if !host.contains(':') => (host.to_string(), port.parse().unwrap_or(25565)),
        _ => (address.to_string(), 25565),
    }
}

fn write_varint(buf: &mut Vec<u8>, mut value: i32) {
    loop {
        let mut byte = (value & 0x7f) as u8;
        value = ((value as u32) >> 7) as i32;
        if value != 0 {
            byte |= 0x80;
        }
        buf.push(byte);
        if value == 0 {
            break;
        }
    }
}

async fn read_varint(stream: &mut TcpStream) -> Result<i32> {
    let mut result = 0i32;
    for i in 0..5 {
        let byte = stream.read_u8().await?;
        result |= ((byte & 0x7f) as i32) << (7 * i);
        if byte & 0x80 == 0 {
            return Ok(result);
        }
    }
    bail!("VarInt слишком длинный")
}

fn packet(id: i32, body: &[u8]) -> Vec<u8> {
    let mut inner = Vec::new();
    write_varint(&mut inner, id);
    inner.extend_from_slice(body);
    let mut out = Vec::new();
    write_varint(&mut out, inner.len() as i32);
    out.extend(inner);
    out
}

/// Текст описания сервера: строка или JSON-компонент с extra
fn motd_text(v: &serde_json::Value) -> String {
    match v {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Object(o) => {
            let mut s = o.get("text").and_then(|t| t.as_str()).unwrap_or("").to_string();
            if let Some(extra) = o.get("extra").and_then(|e| e.as_array()) {
                for e in extra {
                    s.push_str(&motd_text(e));
                }
            }
            s
        }
        serde_json::Value::Array(a) => a.iter().map(motd_text).collect(),
        _ => String::new(),
    }
}

/// Убрать коды форматирования §x
fn strip_codes(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars();
    while let Some(c) = chars.next() {
        if c == '§' {
            chars.next();
        } else {
            out.push(c);
        }
    }
    out
}

async fn ping_inner(address: &str) -> Result<ServerStatus> {
    let (host, port) = split_address(address);
    let started = Instant::now();
    let mut stream = TcpStream::connect((host.as_str(), port)).await.context("Сервер недоступен")?;
    let connect_ms = started.elapsed().as_millis() as u32;

    // Handshake: protocol -1, host, port, next state = 1 (status)
    let mut body = Vec::new();
    write_varint(&mut body, -1);
    write_varint(&mut body, host.len() as i32);
    body.extend_from_slice(host.as_bytes());
    body.extend_from_slice(&port.to_be_bytes());
    write_varint(&mut body, 1);
    stream.write_all(&packet(0, &body)).await?;
    stream.write_all(&packet(0, &[])).await?;

    let _len = read_varint(&mut stream).await?;
    let _id = read_varint(&mut stream).await?;
    let json_len = read_varint(&mut stream).await?;
    if !(0..=2 * 1024 * 1024).contains(&json_len) {
        bail!("Слишком большой ответ сервера");
    }
    let mut json = vec![0u8; json_len as usize];
    stream.read_exact(&mut json).await?;
    let v: serde_json::Value = serde_json::from_slice(&json)?;

    let motd = strip_codes(&motd_text(&v["description"])).trim().to_string();
    Ok(ServerStatus {
        online: true,
        players: v["players"]["online"].as_u64().map(|n| n as u32),
        max_players: v["players"]["max"].as_u64().map(|n| n as u32),
        version: v["version"]["name"].as_str().map(|s| strip_codes(s)),
        motd: (!motd.is_empty()).then_some(motd),
        ping_ms: Some(connect_ms),
        favicon: v["favicon"].as_str().filter(|f| f.starts_with("data:image/")).map(str::to_string),
    })
}

/// Пинг с таймаутом 5 секунд; недоступный сервер — online=false
pub async fn ping(address: &str) -> ServerStatus {
    match tokio::time::timeout(Duration::from_secs(5), ping_inner(address)).await {
        Ok(Ok(status)) => status,
        _ => ServerStatus::offline(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn addresses() {
        assert_eq!(split_address("mc.example.org"), ("mc.example.org".into(), 25565));
        assert_eq!(split_address("1.2.3.4:25570"), ("1.2.3.4".into(), 25570));
        assert_eq!(split_address("[::1]:25566"), ("::1".into(), 25566));
    }

    #[test]
    fn varint() {
        let mut b = Vec::new();
        write_varint(&mut b, 300);
        assert_eq!(b, vec![0xac, 0x02]);
        let mut b = Vec::new();
        write_varint(&mut b, -1);
        assert_eq!(b, vec![0xff, 0xff, 0xff, 0xff, 0x0f]);
    }

    #[test]
    fn motd_strips_codes() {
        let v = serde_json::json!({"text": "§aПривет ", "extra": [{"text": "§lмир"}]});
        assert_eq!(strip_codes(&motd_text(&v)), "Привет мир");
    }
}
