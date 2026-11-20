//! Настройки лаунчера, которые нужны бэкенду (launcher.json в каталоге данных)

use anyhow::{Result, bail};
use serde::{Deserialize, Serialize};

use crate::engine::core::paths::app_dir;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LauncherSettings {
    /// Свой адрес сервера скинов (иначе — из сборки/окружения)
    #[serde(default)]
    pub skin_server: Option<String>,
    /// Показывать скины других игроков Hytpotchi (ставит CustomSkinLoader в сборки с загрузчиком)
    #[serde(default = "yes")]
    pub shared_skins: bool,
    /// Друзья включены (синхронизация с сервером Hytpotchi)
    #[serde(default = "yes")]
    pub friends: bool,
    /// Статус для друзей: online | busy | invisible
    #[serde(default = "online")]
    pub friends_status: String,
    /// Ставить e4mc в сборки с загрузчиком, чтобы «Открыть для сети» открывало мир друзьям через интернет
    #[serde(default)]
    pub friends_hosting: bool,
}

fn online() -> String {
    "online".into()
}

fn yes() -> bool {
    true
}

impl Default for LauncherSettings {
    fn default() -> Self {
        Self {
            skin_server: None,
            shared_skins: true,
            friends: true,
            friends_status: online(),
            friends_hosting: false,
        }
    }
}

pub fn load() -> LauncherSettings {
    app_dir()
        .ok()
        .and_then(|d| std::fs::read(d.join("launcher.json")).ok())
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

pub fn save(settings: &LauncherSettings) -> Result<()> {
    let dir = app_dir()?;
    std::fs::create_dir_all(&dir)?;
    let tmp = dir.join("launcher.json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(settings)?)?;
    std::fs::rename(tmp, dir.join("launcher.json"))?;
    Ok(())
}

/// Проверить и нормализовать адрес сервера: https (или http для localhost), без хвостового /
pub fn normalize_server(url: &str) -> Result<String> {
    let url = url.trim().trim_end_matches('/');
    let parsed = url::Url::parse(url).map_err(|_| anyhow::anyhow!("Некорректный адрес сервера"))?;
    let local = matches!(parsed.host_str(), Some("localhost" | "127.0.0.1"));
    if parsed.scheme() != "https" && !(local && parsed.scheme() == "http") {
        bail!("Адрес сервера скинов должен начинаться с https://");
    }
    Ok(url.to_string())
}

/// Адрес сервера скинов: настройка → переменная окружения → вшитый при сборке
pub fn skin_server() -> Option<String> {
    let from_settings = load().skin_server.filter(|s| !s.trim().is_empty());
    let from_env = std::env::var("HYTPOTCHI_SKIN_SERVER").ok().filter(|s| !s.trim().is_empty());
    let built_in = option_env!("HYTPOTCHI_SKIN_SERVER").map(str::to_string).filter(|s| !s.is_empty());
    from_settings
        .or(from_env)
        .or(built_in)
        .and_then(|s| normalize_server(&s).ok())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn server_urls() {
        assert_eq!(normalize_server("https://skins.example.org/").unwrap(), "https://skins.example.org");
        assert!(normalize_server("http://skins.example.org").is_err());
        assert!(normalize_server("http://localhost:8787").is_ok());
        assert!(normalize_server("не адрес").is_err());
    }
}
