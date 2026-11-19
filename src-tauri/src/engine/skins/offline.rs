//! Скины офлайн-игроков через CustomSkinLoader.
//!
//! Серверы Mojang не хранят скины офлайн-игроков, поэтому лаунчер:
//! 1) ставит в сборку мод CustomSkinLoader (Fabric/Forge/NeoForge/Quilt);
//! 2) кладёт свой скин в `CustomSkinLoader/LocalSkin/skins/<ник>.png` — он виден сразу, даже без сети;
//! 3) добавляет источник «Hytpotchi» (сервер скинов), чтобы видеть скины других игроков лаунчера;
//! 4) ставит эти источники перед Mojang, чтобы скин реального игрока с таким же ником их не перебивал.

use std::path::Path;

use anyhow::Result;

pub const CSL_PROJECT: &str = "customskinloader";

/// Свой скин для локального источника
pub struct OwnSkin<'a> {
    pub username: &'a str,
    pub png: &'a [u8],
    pub slim: bool,
}

fn local_skin_entry(slim: bool) -> serde_json::Value {
    serde_json::json!({
        "name": "LocalSkin",
        "type": "Legacy",
        "checkPNG": false,
        "skin": "LocalSkin/skins/{USERNAME}.png",
        "model": if slim { "slim" } else { "default" },
        "cape": "LocalSkin/capes/{USERNAME}.png",
        "elytra": "LocalSkin/elytras/{USERNAME}.png"
    })
}

fn server_entry(server: &str) -> serde_json::Value {
    serde_json::json!({
        "name": "Hytpotchi",
        "type": "CustomSkinAPI",
        "root": format!("{}/", server.trim_end_matches('/')),
    })
}

/// Настроить CustomSkinLoader в игровой папке сборки
pub fn configure(game_dir: &Path, own: Option<OwnSkin<'_>>, server: Option<&str>) -> Result<()> {
    let root = game_dir.join("CustomSkinLoader");
    std::fs::create_dir_all(&root)?;

    let mut first = Vec::new();
    if let Some(own) = &own {
        let skins = root.join("LocalSkin").join("skins");
        std::fs::create_dir_all(&skins)?;
        std::fs::write(skins.join(format!("{}.png", own.username)), own.png)?;
        first.push(local_skin_entry(own.slim));
    }
    if let Some(server) = server {
        first.push(server_entry(server));
    }

    let config_path = root.join("CustomSkinLoader.json");
    let mut config: serde_json::Value = std::fs::read(&config_path)
        .ok()
        .and_then(|d| serde_json::from_slice(&d).ok())
        .unwrap_or_else(|| serde_json::json!({ "enable": true, "loadlist": [{ "name": "Mojang", "type": "MojangAPI" }] }));

    let ours = ["LocalSkin", "Hytpotchi"];
    let rest: Vec<serde_json::Value> = config["loadlist"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter(|e| !e["name"].as_str().is_some_and(|n| ours.contains(&n)))
        .collect();
    first.extend(rest);
    config["loadlist"] = serde_json::Value::Array(first);
    std::fs::write(config_path, serde_json::to_vec_pretty(&config)?)?;
    Ok(())
}

/// Убрать свой офлайн-скин (стандартный Стив/Алекс)
pub fn clear(game_dir: &Path, username: &str) {
    let _ = std::fs::remove_file(
        game_dir
            .join("CustomSkinLoader")
            .join("LocalSkin")
            .join("skins")
            .join(format!("{username}.png")),
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn our_sources_go_first() {
        let dir = tempfile::TempDir::new().unwrap();
        let cfg_dir = dir.path().join("CustomSkinLoader");
        std::fs::create_dir_all(&cfg_dir).unwrap();
        std::fs::write(
            cfg_dir.join("CustomSkinLoader.json"),
            r#"{"enable":true,"loadlist":[{"name":"Mojang","type":"MojangAPI"},{"name":"LocalSkin","type":"Legacy"}]}"#,
        )
        .unwrap();
        configure(
            dir.path(),
            Some(OwnSkin { username: "Steve", png: b"png", slim: true }),
            Some("https://skins.example.org"),
        )
        .unwrap();
        let cfg: serde_json::Value =
            serde_json::from_slice(&std::fs::read(cfg_dir.join("CustomSkinLoader.json")).unwrap()).unwrap();
        let list = cfg["loadlist"].as_array().unwrap();
        assert_eq!(list.len(), 3);
        assert_eq!(list[0]["name"], "LocalSkin");
        assert_eq!(list[0]["model"], "slim");
        assert_eq!(list[1]["name"], "Hytpotchi");
        assert_eq!(list[1]["root"], "https://skins.example.org/");
        assert_eq!(list[2]["name"], "Mojang");
        assert!(cfg_dir.join("LocalSkin/skins/Steve.png").exists());

        // Повторная настройка без своего скина не дублирует источники
        configure(dir.path(), None, Some("https://skins.example.org")).unwrap();
        let cfg: serde_json::Value =
            serde_json::from_slice(&std::fs::read(cfg_dir.join("CustomSkinLoader.json")).unwrap()).unwrap();
        let names: Vec<_> = cfg["loadlist"].as_array().unwrap().iter().map(|e| e["name"].clone()).collect();
        assert_eq!(names, vec!["Hytpotchi", "Mojang"]);
    }
}
