//! Импорт сборок из других лаунчеров: Prism/MultiMC, CurseForge App, обычная .minecraft

use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use serde::Serialize;

use crate::engine::core::paths::instance_game_dir;
use crate::engine::profiles::store::{self, Instance};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Detected {
    /// prism | curseforge | vanilla
    pub source: String,
    pub source_label: String,
    pub name: String,
    pub game_version: Option<String>,
    pub loader: Option<String>,
    pub loader_version: Option<String>,
    #[serde(skip)]
    pub game_dir: PathBuf,
}

/// Что переносим из игровой папки
const COPY_ITEMS: &[&str] = &[
    "mods",
    "config",
    "saves",
    "resourcepacks",
    "shaderpacks",
    "screenshots",
    "schematics",
    "defaultconfigs",
    "kubejs",
    "options.txt",
    "optionsof.txt",
    "optionsshaders.txt",
    "servers.dat",
];

fn prism(dir: &Path) -> Result<Option<Detected>> {
    let pack = dir.join("mmc-pack.json");
    if !pack.exists() {
        return Ok(None);
    }
    let json: serde_json::Value = serde_json::from_slice(&std::fs::read(&pack)?)?;
    let cfg = std::fs::read_to_string(dir.join("instance.cfg")).unwrap_or_default();
    let name = cfg
        .lines()
        .find_map(|l| l.strip_prefix("name="))
        .map(str::to_string)
        .or_else(|| dir.file_name().map(|n| n.to_string_lossy().into_owned()))
        .unwrap_or_else(|| "Импорт".into());

    let mut game_version = None;
    let mut loader = None;
    let mut loader_version = None;
    for c in json["components"].as_array().into_iter().flatten() {
        let version = c["version"].as_str().map(str::to_string);
        match c["uid"].as_str().unwrap_or("") {
            "net.minecraft" => game_version = version,
            "net.fabricmc.fabric-loader" => (loader, loader_version) = (Some("fabric"), version),
            "org.quiltmc.quilt-loader" => (loader, loader_version) = (Some("quilt"), version),
            "net.minecraftforge" => (loader, loader_version) = (Some("forge"), version),
            "net.neoforged" => (loader, loader_version) = (Some("neoforge"), version),
            _ => {}
        }
    }
    let game_dir = [".minecraft", "minecraft"]
        .iter()
        .map(|d| dir.join(d))
        .find(|p| p.is_dir())
        .unwrap_or_else(|| dir.join(".minecraft"));
    Ok(Some(Detected {
        source: "prism".into(),
        source_label: "Prism / MultiMC".into(),
        name,
        game_version,
        loader: loader.map(str::to_string),
        loader_version,
        game_dir,
    }))
}

fn curseforge(dir: &Path) -> Result<Option<Detected>> {
    let file = dir.join("minecraftinstance.json");
    if !file.exists() {
        return Ok(None);
    }
    let json: serde_json::Value = serde_json::from_slice(&std::fs::read(&file)?)?;
    let base = json["baseModLoader"]["name"].as_str().unwrap_or("");
    // "forge-47.3.0", "neoforge-21.1.77", "fabric-0.16.9-1.20.1", "quilt-0.26.4-1.20.1"
    let (loader, loader_version) = match base.split_once('-') {
        Some((kind @ ("forge" | "neoforge"), v)) => (Some(kind.to_string()), Some(v.to_string())),
        Some((kind @ ("fabric" | "quilt"), rest)) => {
            (Some(kind.to_string()), rest.split('-').next().map(str::to_string))
        }
        _ => (None, None),
    };
    Ok(Some(Detected {
        source: "curseforge".into(),
        source_label: "CurseForge".into(),
        name: json["name"].as_str().unwrap_or("Импорт CurseForge").to_string(),
        game_version: json["gameVersion"].as_str().map(str::to_string),
        loader,
        loader_version,
        game_dir: dir.to_path_buf(),
    }))
}

/// Разобрать id версии из launcher_profiles: "fabric-loader-0.16.9-1.21.4", "1.20.1-forge-47.3.0"
fn parse_version_id(id: &str) -> (Option<String>, Option<String>, Option<String>) {
    if let Some(rest) = id.strip_prefix("fabric-loader-") {
        if let Some((lv, mc)) = rest.split_once('-') {
            return (Some(mc.into()), Some("fabric".into()), Some(lv.into()));
        }
    }
    if let Some(rest) = id.strip_prefix("quilt-loader-") {
        if let Some((lv, mc)) = rest.split_once('-') {
            return (Some(mc.into()), Some("quilt".into()), Some(lv.into()));
        }
    }
    if let Some((mc, lv)) = id.split_once("-forge-") {
        return (Some(mc.into()), Some("forge".into()), Some(lv.into()));
    }
    if let Some(lv) = id.strip_prefix("neoforge-") {
        return (None, Some("neoforge".into()), Some(lv.into()));
    }
    if id.starts_with("latest-") || id.is_empty() {
        return (None, None, None);
    }
    (Some(id.into()), None, None)
}

fn vanilla(dir: &Path) -> Result<Option<Detected>> {
    let profiles = dir.join("launcher_profiles.json");
    if !profiles.exists() && !dir.join("saves").is_dir() {
        return Ok(None);
    }
    let mut picked = (None, None, None);
    if let Ok(data) = std::fs::read(&profiles) {
        let json: serde_json::Value = serde_json::from_slice(&data).unwrap_or_default();
        let best = json["profiles"]
            .as_object()
            .into_iter()
            .flatten()
            .map(|(_, p)| p)
            .max_by_key(|p| p["lastUsed"].as_str().unwrap_or("").to_string());
        if let Some(p) = best {
            picked = parse_version_id(p["lastVersionId"].as_str().unwrap_or(""));
        }
    }
    Ok(Some(Detected {
        source: "vanilla".into(),
        source_label: ".minecraft".into(),
        name: "Моя .minecraft".into(),
        game_version: picked.0,
        loader: picked.1,
        loader_version: picked.2,
        game_dir: dir.to_path_buf(),
    }))
}

pub fn detect(dir: &Path) -> Result<Detected> {
    if !dir.is_dir() {
        bail!("Папка не найдена");
    }
    if let Some(d) = prism(dir)? {
        return Ok(d);
    }
    if let Some(d) = curseforge(dir)? {
        return Ok(d);
    }
    if let Some(d) = vanilla(dir)? {
        return Ok(d);
    }
    bail!("Не похоже на сборку: выберите папку сборки Prism/MultiMC, CurseForge или .minecraft")
}

fn count_files(path: &Path) -> u64 {
    if path.is_file() {
        return 1;
    }
    walkdir::WalkDir::new(path).into_iter().flatten().filter(|e| e.file_type().is_file()).count() as u64
}

/// Создать сборку и перенести файлы. `progress(сделано, всего)`
pub fn import(
    detected: &Detected,
    game_version: &str,
    memory_mb: u32,
    accent: Option<String>,
    progress: &dyn Fn(u64, u64),
) -> Result<Instance> {
    let mut inst = store::create(&detected.name, game_version, detected.loader.clone(), memory_mb, accent)?;
    inst.loader_version = detected.loader_version.clone();
    store::save(&inst)?;
    let target = instance_game_dir(&inst.id)?;

    let items: Vec<PathBuf> = COPY_ITEMS
        .iter()
        .map(|i| detected.game_dir.join(i))
        .filter(|p| p.exists())
        .collect();
    let total: u64 = items.iter().map(|p| count_files(p)).sum();
    let mut done = 0u64;
    progress(0, total);

    let result: Result<()> = (|| {
        for item in &items {
            for entry in walkdir::WalkDir::new(item).into_iter().flatten() {
                let rel = entry
                    .path()
                    .strip_prefix(&detected.game_dir)
                    .context("Неверный путь")?;
                let out = target.join(rel);
                if entry.file_type().is_dir() {
                    std::fs::create_dir_all(&out)?;
                } else if entry.file_type().is_file() {
                    if let Some(parent) = out.parent() {
                        std::fs::create_dir_all(parent)?;
                    }
                    std::fs::copy(entry.path(), &out)?;
                    done += 1;
                    if done % 25 == 0 || done == total {
                        progress(done, total);
                    }
                }
            }
        }
        Ok(())
    })();

    if let Err(e) = result {
        let _ = store::remove(&inst.id);
        return Err(e);
    }
    Ok(inst)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_launcher_version_ids() {
        assert_eq!(
            parse_version_id("fabric-loader-0.16.9-1.21.4"),
            (Some("1.21.4".into()), Some("fabric".into()), Some("0.16.9".into()))
        );
        assert_eq!(
            parse_version_id("1.20.1-forge-47.3.0"),
            (Some("1.20.1".into()), Some("forge".into()), Some("47.3.0".into()))
        );
        assert_eq!(parse_version_id("1.21.4"), (Some("1.21.4".into()), None, None));
        assert_eq!(parse_version_id("latest-release"), (None, None, None));
    }
}
