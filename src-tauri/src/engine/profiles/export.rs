//! Экспорт сборки в .mrpack (формат Modrinth)
//!
//! Файлы, которые есть на Modrinth, попадают в индекс ссылками (модпак весит мало),
//! остальное — в overrides/. Миры и личные настройки не экспортируются.

use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::Deserialize;
use sha1::Digest as _;

use crate::engine::core::http::HttpClient;
use crate::engine::core::paths::instance_game_dir;
use crate::engine::game::{install, loaders};
use crate::engine::profiles::store::Instance;

const API: &str = "https://api.modrinth.com/v2";

/// Папки с контентом, который ищем на Modrinth
const CONTENT_DIRS: &[&str] = &["mods", "resourcepacks", "shaderpacks"];
/// Что кладём в overrides целиком
const OVERRIDE_DIRS: &[&str] = &["config", "defaultconfigs", "kubejs"];

#[derive(Deserialize)]
struct VFile {
    url: String,
    hashes: HashMap<String, String>,
}

#[derive(Deserialize)]
struct Version {
    files: Vec<VFile>,
}

struct LocalFile {
    rel: String,
    path: PathBuf,
    sha1: String,
    sha512: String,
    size: u64,
}

fn hash_file(path: &Path) -> Result<(String, String, u64)> {
    let data = std::fs::read(path)?;
    let sha1 = hex::encode(sha1::Sha1::digest(&data));
    let sha512 = hex::encode(sha2::Sha512::digest(&data));
    Ok((sha1, sha512, data.len() as u64))
}

async fn loader_version(http: &HttpClient, inst: &Instance, loader: &str) -> Result<String> {
    if let Some(v) = &inst.loader_version {
        return Ok(v.clone());
    }
    match loaders::ForgeKind::parse(loader) {
        Some(kind) => loaders::latest_version(http, kind, &inst.game_version).await,
        None => install::latest_loader_version(http, loader, &inst.game_version).await,
    }
}

pub async fn export_mrpack(
    http: &HttpClient,
    inst: &Instance,
    dest: &Path,
    progress: &(dyn Fn(&str, u64, u64) + Send + Sync),
) -> Result<()> {
    let game_dir = instance_game_dir(&inst.id)?;
    progress("Считаем хеши файлов", 0, 1);

    // 1. Локальные файлы контента (только включённые)
    let gd = game_dir.clone();
    let files: Vec<LocalFile> = tokio::task::spawn_blocking(move || -> Result<Vec<LocalFile>> {
        let mut out = Vec::new();
        for dir in CONTENT_DIRS {
            let Ok(entries) = std::fs::read_dir(gd.join(dir)) else { continue };
            for e in entries.flatten() {
                let name = e.file_name().to_string_lossy().to_string();
                if !(name.ends_with(".jar") || name.ends_with(".zip")) || !e.path().is_file() {
                    continue;
                }
                let (sha1, sha512, size) = hash_file(&e.path())?;
                out.push(LocalFile { rel: format!("{dir}/{name}"), path: e.path(), sha1, sha512, size });
            }
        }
        Ok(out)
    })
    .await??;

    // 2. Какие из них есть на Modrinth
    progress("Ищем файлы на Modrinth", 0, 1);
    let found: HashMap<String, Version> = if files.is_empty() {
        HashMap::new()
    } else {
        let hashes: Vec<&str> = files.iter().map(|f| f.sha1.as_str()).collect();
        http.client
            .post(format!("{API}/version_files"))
            .json(&serde_json::json!({ "hashes": hashes, "algorithm": "sha1" }))
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?
    };

    let mut index_files = Vec::new();
    let mut overrides: Vec<(String, PathBuf)> = Vec::new();
    for f in &files {
        let url = found.get(&f.sha1).and_then(|v| {
            v.files
                .iter()
                .find(|vf| vf.hashes.get("sha1").map(|h| h.eq_ignore_ascii_case(&f.sha1)) == Some(true))
                .map(|vf| vf.url.clone())
        });
        match url {
            Some(url) => index_files.push(serde_json::json!({
                "path": f.rel,
                "hashes": { "sha1": f.sha1, "sha512": f.sha512 },
                "env": { "client": "required", "server": if f.rel.starts_with("mods/") { "required" } else { "unsupported" } },
                "downloads": [url],
                "fileSize": f.size,
            })),
            None => overrides.push((format!("overrides/{}", f.rel), f.path.clone())),
        }
    }

    // 3. Зависимости
    let mut deps = serde_json::Map::new();
    deps.insert("minecraft".into(), inst.game_version.clone().into());
    if let Some(loader) = inst.loader.as_deref() {
        let key = match loader {
            "fabric" => "fabric-loader",
            "quilt" => "quilt-loader",
            other => other,
        };
        deps.insert(key.into(), loader_version(http, inst, loader).await?.into());
    }

    let index = serde_json::json!({
        "formatVersion": 1,
        "game": "minecraft",
        "versionId": "1.0.0",
        "name": inst.name,
        "summary": "Собрано в Hytpotchi",
        "files": index_files,
        "dependencies": deps,
    });

    // 4. Архив
    progress("Упаковываем", 0, 1);
    let dest = dest.to_path_buf();
    tokio::task::spawn_blocking(move || -> Result<()> {
        let tmp = dest.with_extension("mrpack.part");
        let mut zip = zip::ZipWriter::new(std::fs::File::create(&tmp)?);
        let opts = zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        zip.start_file("modrinth.index.json", opts)?;
        zip.write_all(serde_json::to_string_pretty(&index)?.as_bytes())?;

        for (name, path) in overrides {
            zip.start_file(name, opts)?;
            std::io::copy(&mut std::fs::File::open(path)?, &mut zip)?;
        }
        for dir in OVERRIDE_DIRS {
            let root = game_dir.join(dir);
            if !root.is_dir() {
                continue;
            }
            for e in walkdir::WalkDir::new(&root).into_iter().flatten().filter(|e| e.file_type().is_file()) {
                let rel = e.path().strip_prefix(&game_dir).context("путь")?.to_string_lossy().replace('\\', "/");
                zip.start_file(format!("overrides/{rel}"), opts)?;
                std::io::copy(&mut std::fs::File::open(e.path())?, &mut zip)?;
            }
        }
        zip.finish()?;
        std::fs::rename(tmp, &dest)?;
        Ok(())
    })
    .await??;

    progress("Готово", 1, 1);
    Ok(())
}
