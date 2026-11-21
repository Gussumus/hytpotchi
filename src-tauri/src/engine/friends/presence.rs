//! Что делает игрок: по логу игры узнаём, что мир открыт для друзей.
//!
//! - e4mc (мод, ставится лаунчером): «Domain assigned: <адрес>» — мир доступен из интернета.
//!   Закрытие: «Local game no longer publicly hosted».
//! - Обычное «Открыть для сети» без e4mc: «Started serving on <порт>» (старые версии)
//!   или «Published LAN server on port <порт>» (новые, 26.x) — только в одной сети.
//! - Имя мира подсматриваем в «ServerLevel[<имя>]».

use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostedWorld {
    pub address: String,
    pub world: Option<String>,
    /// Только локальная сеть (без e4mc) — такой мир лаунчер открывает друзьям через туннель
    pub lan: bool,
    /// Порт «Открыть для сети» на этом компьютере
    pub port: Option<u16>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum LogEvent {
    Hosted { address: String, lan: bool },
    LanPort(u16),
    Closed,
    World(String),
}

fn after<'a>(line: &'a str, marker: &str) -> Option<&'a str> {
    line.find(marker).map(|i| &line[i + marker.len()..])
}

fn clean_domain(raw: &str) -> Option<String> {
    let d: String = raw
        .trim()
        .trim_end_matches(|c: char| !c.is_ascii_alphanumeric())
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric() || *c == '.' || *c == '-' || *c == ':')
        .collect();
    (d.contains('.') && d.len() <= 255).then_some(d)
}

/// Разобрать строку лога игры
pub fn parse_line(line: &str) -> Option<LogEvent> {
    if let Some(rest) = after(line, "Domain assigned: ") {
        return clean_domain(rest).map(|address| LogEvent::Hosted { address, lan: false });
    }
    if let Some(rest) = after(line, "Local game hosted on domain [") {
        return clean_domain(rest.split(']').next()?).map(|address| LogEvent::Hosted { address, lan: false });
    }
    if line.contains("Local game no longer publicly hosted") || line.contains("Stopping server") {
        return Some(LogEvent::Closed);
    }
    for marker in ["Started serving on ", "Published LAN server on port "] {
        if let Some(rest) = after(line, marker) {
            let port: String = rest.chars().take_while(char::is_ascii_digit).collect();
            return port.parse().ok().map(LogEvent::LanPort);
        }
    }
    if let Some(rest) = after(line, "ServerLevel[") {
        let name = rest.split(']').next()?.trim();
        if !name.is_empty() && name.len() <= 64 {
            return Some(LogEvent::World(name.to_string()));
        }
    }
    None
}

/// Локальный IPv4 этого компьютера (без отправки пакетов: UDP connect только выбирает маршрут)
pub fn local_ip() -> Option<String> {
    let socket = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("192.0.2.1:80").ok()?;
    match socket.local_addr().ok()?.ip() {
        std::net::IpAddr::V4(ip) if !ip.is_loopback() && !ip.is_unspecified() => Some(ip.to_string()),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn e4mc_domain() {
        assert_eq!(
            parse_line("[12:00:01] [e4mc/INFO] (e4mc) Domain assigned: brave-otter.ru.e4mc.link"),
            Some(LogEvent::Hosted { address: "brave-otter.ru.e4mc.link".into(), lan: false })
        );
        assert_eq!(
            parse_line("[CHAT] Local game hosted on domain [calm-fox.eu.e4mc.link] (Click here to stop)"),
            Some(LogEvent::Hosted { address: "calm-fox.eu.e4mc.link".into(), lan: false })
        );
        assert_eq!(parse_line("[CHAT] Local game no longer publicly hosted"), Some(LogEvent::Closed));
    }

    #[test]
    fn lan_and_world() {
        assert_eq!(parse_line("[Server thread/INFO]: Started serving on 51234"), Some(LogEvent::LanPort(51234)));
        // Minecraft 26.x, лог в формате log4j XML
        assert_eq!(
            parse_line("    <log4j:Message><![CDATA[Published LAN server on port 54141]]></log4j:Message>"),
            Some(LogEvent::LanPort(54141))
        );
        assert_eq!(
            parse_line("Saving chunks for level 'ServerLevel[Мой мир]'/minecraft:overworld"),
            Some(LogEvent::World("Мой мир".into()))
        );
        assert_eq!(parse_line("[Render thread/INFO]: Loaded 7 advancements"), None);
        assert_eq!(parse_line("Domain assigned: "), None);
    }
}
