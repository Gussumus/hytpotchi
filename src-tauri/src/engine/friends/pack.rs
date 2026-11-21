//! «Та же сборка, что у друга».
//!
//! Хозяин мира: лаунчер собирает опись модов сборки — какие файлы, их SHA-1, размер и ссылка
//! на Modrinth (по хешу через API Modrinth) — и кладёт на сервер Hytpotchi. Моды не с Modrinth
//! передать нельзя: они попадают в список `missing`, и интерфейс о них предупреждает.
//!
//! Гость: лаунчер создаёт отдельную сборку «Сборка <ник>» (или обновляет её) с той же
//! версией игры и загрузчика, докачивает недостающие моды с проверкой хеша и убирает те,
//! что ставил раньше по описи, но у друга их больше нет. Свои моды гостя не трогаются.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use futures::StreamExt;
use serde::{Deserialize, Serialize};
use sha1::Digest as _;

use crate::engine::core::http::{HttpClient, VerifiedDownload};
use crate::engine::core::paths::{app_dir, instance_mods_dir, instance_path};
use crate::engine::profiles::store::{self, Instance};

const API: &str = "https://api.modrinth.com/v2";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PackFile {
    /// Имя файла в папке mods
    pub name: String,
    pub sha1: String,
    pub size: u64,
    pub url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SharedPack {
    pub name: String,
    pub mc: String,
    pub loader: Option<String>,
    pub loader_version: Option<String>,
    pub files: Vec<PackFile>,
    /// Моды, которых нет на Modrinth: друг их не получит
    #[serde(default)]
    pub missing: Vec<String>,
}

/// Подпись папки mods: имя + размер + время изменения. Меняется — опись пересобираем.
pub fn mods_signature(instance_id: &str) -> String {
    let Ok(dir) = instance_mods_dir(instance_id) else { return String::new() };
    let mut items: Vec<String> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().ends_with(".jar"))
        .filter_map(|e| {
            let meta = e.metadata().ok()?;
            let modified = meta.modified().ok()?.duration_since(std::time::UNIX_EPOCH).ok()?.as_secs();
            Some(format!("{}:{}:{}", e.file_name().to_string_lossy(), meta.len(), modified))
        })
        .collect();
    items.sort();
    items.join("|")
}

#[derive(Deserialize)]
struct VFile {
    url: String,
    hashes: HashMap<String, String>,
}

#[derive(Deserialize)]
struct Version {
    files: Vec<VFile>,
}

/// Собрать опись сборки хозяина (только включённые моды)
pub async fn build(http: &HttpClient, inst: &Instance) -> Result<SharedPack> {
    let dir = instance_mods_dir(&inst.id)?;
    let local: Vec<(String, String, u64)> = tokio::task::spawn_blocking(move || -> Result<_> {
        let mut out = Vec::new();
        for e in std::fs::read_dir(&dir).into_iter().flatten().flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if !name.ends_with(".jar") || !e.path().is_file() {
                continue;
            }
            let data = std::fs::read(e.path())?;
            out.push((name, hex::encode(sha1::Sha1::digest(&data)), data.len() as u64));
        }
        out.sort();
        Ok(out)
    })
    .await??;

    let found: HashMap<String, Version> = if local.is_empty() {
        HashMap::new()
    } else {
        let hashes: Vec<&str> = local.iter().map(|(_, h, _)| h.as_str()).collect();
        http.client
            .post(format!("{API}/version_files"))
            .json(&serde_json::json!({ "hashes": hashes, "algorithm": "sha1" }))
            .send()
            .await
            .context("Modrinth недоступен")?
            .error_for_status()?
            .json()
            .await?
    };

    let mut files = Vec::new();
    let mut missing = Vec::new();
    for (name, sha1, size) in local {
        // e4mc нужен только хозяину мира (и только как запасной путь) — другу его не передаём
        if name.to_lowercase().contains("e4mc") {
            continue;
        }
        // Мод косметики лаунчер ставит сам — в описи сборки он не нужен
        if name == crate::engine::skins::cosmetics::MOD_FILE {
            continue;
        }
        let url = found.get(&sha1).and_then(|v| {
            v.files
                .iter()
                .find(|f| f.hashes.get("sha1").is_some_and(|h| h.eq_ignore_ascii_case(&sha1)))
                .map(|f| f.url.clone())
        });
        match url {
            Some(url) => files.push(PackFile { name, sha1, size, url }),
            None => missing.push(name),
        }
    }
    Ok(SharedPack {
        name: inst.name.clone(),
        mc: inst.game_version.clone(),
        loader: inst.loader.clone(),
        loader_version: inst.loader_version.clone(),
        files,
        missing,
    })
}

// ---------- Гость ----------

/// Какие сборки созданы для каких друзей: id друга → id сборки
fn links_path() -> Result<PathBuf> {
    Ok(app_dir()?.join("friend-packs.json"))
}

fn load_links() -> HashMap<String, String> {
    links_path()
        .ok()
        .and_then(|p| std::fs::read(p).ok())
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

fn save_links(links: &HashMap<String, String>) -> Result<()> {
    std::fs::write(links_path()?, serde_json::to_vec_pretty(links)?)?;
    Ok(())
}

/// Файлы, которые лаунчер поставил по описи (их можно убирать при обновлении)
fn managed_path(instance_id: &str) -> Result<PathBuf> {
    Ok(instance_path(instance_id)?.join("friend-pack.json"))
}

fn load_managed(instance_id: &str) -> HashSet<String> {
    managed_path(instance_id)
        .ok()
        .and_then(|p| std::fs::read(p).ok())
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

/// Имя файла без путей и опасных символов
fn safe_name(name: &str) -> Result<&str> {
    let ok = !name.is_empty()
        && name.len() <= 200
        && name.ends_with(".jar")
        && !name.contains(['/', '\\', ':'])
        && !name.starts_with('.');
    if !ok {
        bail!("Подозрительное имя файла в сборке друга: {name}");
    }
    Ok(name)
}

fn file_sha1(path: &Path) -> Option<String> {
    std::fs::read(path).ok().map(|d| hex::encode(sha1::Sha1::digest(&d)))
}

/// Ссылки только на CDN Modrinth — опись приходит от другого игрока
fn trusted_url(url: &str) -> bool {
    url.starts_with("https://cdn.modrinth.com/")
}

/// Поставить ту же сборку, что у друга. Возвращает сборку, готовую к запуску.
pub async fn apply(
    http: &HttpClient,
    friend_id: &str,
    friend_nick: &str,
    pack: &SharedPack,
    memory_mb: u32,
    progress: &(dyn Fn(&str, u64, u64) + Send + Sync),
) -> Result<Instance> {
    for f in &pack.files {
        safe_name(&f.name)?;
        if !trusted_url(&f.url) {
            bail!("В сборке друга ссылка не на Modrinth: {}", f.name);
        }
        if f.sha1.len() != 40 {
            bail!("В сборке друга нет хеша у {}", f.name);
        }
    }

    progress("Готовим сборку друга", 0, 1);
    let mut links = load_links();
    let existing = links.get(friend_id).and_then(|id| store::get(id).ok());
    let mut inst = match existing {
        Some(i) => i,
        None => {
            let name = format!("Сборка {friend_nick}");
            let i = store::create(&name, &pack.mc, pack.loader.clone(), memory_mb, Some("#4f9cff".into()))?;
            links.insert(friend_id.to_string(), i.id.clone());
            save_links(&links)?;
            i
        }
    };

    // Версия игры и загрузчик — как у друга; поменялись — профиль запуска переустановится
    if inst.game_version != pack.mc || inst.loader != pack.loader || inst.loader_version != pack.loader_version {
        inst.game_version = pack.mc.clone();
        inst.loader = pack.loader.clone();
        inst.loader_version = pack.loader_version.clone();
        inst.version_id = None;
        store::save(&inst)?;
    }

    let mods = instance_mods_dir(&inst.id)?;
    std::fs::create_dir_all(&mods)?;
    let wanted: HashSet<&str> = pack.files.iter().map(|f| f.name.as_str()).collect();

    // Убираем то, что ставили раньше по описи, а у друга больше нет
    let previous = load_managed(&inst.id);
    for name in &previous {
        if !wanted.contains(name.as_str()) && safe_name(name).is_ok() {
            let _ = std::fs::remove_file(mods.join(name));
        }
    }

    // Докачиваем недостающее и изменившееся
    let jobs: Vec<(String, PathBuf, VerifiedDownload)> = pack
        .files
        .iter()
        .filter(|f| file_sha1(&mods.join(&f.name)).as_deref() != Some(f.sha1.as_str()))
        .map(|f| {
            let expected = VerifiedDownload::new().with_sha1(f.sha1.clone()).size_opt(Some(f.size));
            (f.url.clone(), mods.join(&f.name), expected)
        })
        .collect();
    let total = jobs.len() as u64;
    progress("Скачиваем моды друга", 0, total);
    let mut done = 0u64;
    let mut stream = futures::stream::iter(jobs.into_iter().map(|(url, dest, expected)| {
        let http = http.clone();
        async move { http.download_verified(&url, &dest, expected).await }
    }))
    .buffer_unordered(8);
    while let Some(r) = stream.next().await {
        r?;
        done += 1;
        progress("Скачиваем моды друга", done, total);
    }

    let managed: Vec<&str> = wanted.into_iter().collect();
    std::fs::write(managed_path(&inst.id)?, serde_json::to_vec_pretty(&managed)?)?;
    progress("Готово", 1, 1);
    store::get(&inst.id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_and_urls() {
        assert!(safe_name("sodium-0.6.jar").is_ok());
        assert!(safe_name("../evil.jar").is_err());
        assert!(safe_name("x\\y.jar").is_err());
        assert!(safe_name("readme.txt").is_err());
        assert!(trusted_url("https://cdn.modrinth.com/data/AANobbMI/versions/x/sodium.jar"));
        assert!(!trusted_url("https://evil.example/sodium.jar"));
        assert!(!trusted_url("http://cdn.modrinth.com/x.jar"));
    }
}
