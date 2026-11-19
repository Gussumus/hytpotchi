//! Модпаки Modrinth (.mrpack): создать сборку, скачать моды, распаковать overrides

use std::collections::HashMap;
use std::io::Read;
use std::path::{Component, Path, PathBuf};

use anyhow::{Context, Result, bail};
use futures::StreamExt;
use serde::Deserialize;

use crate::engine::core::http::{HttpClient, VerifiedDownload};
use crate::engine::core::paths::{cache_dir, instance_game_dir};
use crate::engine::profiles::store::{self, Instance};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Index {
    name: String,
    #[serde(default)]
    files: Vec<PackFile>,
    dependencies: HashMap<String, String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PackFile {
    path: String,
    hashes: HashMap<String, String>,
    #[serde(default)]
    env: Option<HashMap<String, String>>,
    downloads: Vec<String>,
    #[serde(default)]
    file_size: Option<u64>,
}

/// Относительный путь из архива без выхода за пределы папки
fn safe_relative(path: &str) -> Result<PathBuf> {
    let p = Path::new(path);
    if p.components().all(|c| matches!(c, Component::Normal(_))) && !path.is_empty() {
        Ok(p.to_path_buf())
    } else {
        bail!("Опасный путь в модпаке: {path}")
    }
}

/// Прогресс установки модпака: (подпись, сделано, всего)
pub type PackProgress<'a> = &'a (dyn Fn(&str, u64, u64) + Send + Sync);

/// Установить .mrpack как новую сборку
pub async fn install_mrpack(
    http: &HttpClient,
    file: &Path,
    accent: Option<String>,
    memory_mb: u32,
    progress: PackProgress<'_>,
) -> Result<Instance> {
    progress("Читаем модпак", 0, 1);
    let path = file.to_path_buf();
    let index: Index = tokio::task::spawn_blocking(move || -> Result<Index> {
        let mut zip = zip::ZipArchive::new(std::fs::File::open(&path)?)?;
        let mut buf = Vec::new();
        zip.by_name("modrinth.index.json")
            .context("Это не модпак Modrinth (нет modrinth.index.json)")?
            .read_to_end(&mut buf)?;
        Ok(serde_json::from_slice(&buf)?)
    })
    .await??;

    let game_version = index
        .dependencies
        .get("minecraft")
        .context("В модпаке не указана версия Minecraft")?
        .clone();
    let (loader, loader_version) = [
        ("fabric-loader", "fabric"),
        ("quilt-loader", "quilt"),
        ("forge", "forge"),
        ("neoforge", "neoforge"),
    ]
    .iter()
    .find_map(|(key, name)| index.dependencies.get(*key).map(|v| (Some(name.to_string()), Some(v.clone()))))
    .unwrap_or((None, None));

    let mut instance = store::create(&index.name, &game_version, loader, memory_mb, accent)?;
    instance.loader_version = loader_version;
    store::save(&instance)?;
    let game_dir = instance_game_dir(&instance.id)?;

    let result: Result<()> = async {
        // Файлы модпака
        let mut jobs: Vec<(String, PathBuf, VerifiedDownload)> = Vec::new();
        for f in &index.files {
            let client_env = f.env.as_ref().and_then(|e| e.get("client")).map(String::as_str);
            if client_env == Some("unsupported") {
                continue;
            }
            let url = f.downloads.first().context("У файла нет ссылки")?.clone();
            let mut expected = VerifiedDownload::new().size_opt(f.file_size);
            if let Some(sha1) = f.hashes.get("sha1") {
                expected = expected.with_sha1(sha1);
            }
            jobs.push((url, game_dir.join(safe_relative(&f.path)?), expected));
        }
        let total = jobs.len() as u64;
        progress("Скачиваем моды", 0, total);
        let mut done = 0u64;
        let mut stream = futures::stream::iter(jobs.into_iter().map(|(url, dest, expected)| {
            let http = http.clone();
            async move { http.download_verified(&url, &dest, expected).await }
        }))
        .buffer_unordered(8);
        while let Some(r) = stream.next().await {
            r?;
            done += 1;
            progress("Скачиваем моды", done, total);
        }

        // overrides и client-overrides
        progress("Распаковываем настройки", 0, 1);
        let path = file.to_path_buf();
        let target = game_dir.clone();
        tokio::task::spawn_blocking(move || -> Result<()> {
            let mut zip = zip::ZipArchive::new(std::fs::File::open(&path)?)?;
            for prefix in ["overrides/", "client-overrides/"] {
                for i in 0..zip.len() {
                    let mut entry = zip.by_index(i)?;
                    let Some(rel) = entry.name().strip_prefix(prefix).map(str::to_string) else {
                        continue;
                    };
                    if rel.is_empty() || entry.is_dir() {
                        continue;
                    }
                    let out = target.join(safe_relative(&rel)?);
                    if let Some(parent) = out.parent() {
                        std::fs::create_dir_all(parent)?;
                    }
                    std::io::copy(&mut entry, &mut std::fs::File::create(&out)?)?;
                }
            }
            Ok(())
        })
        .await??;
        Ok(())
    }
    .await;

    if let Err(e) = result {
        let _ = store::remove(&instance.id);
        return Err(e);
    }
    instance = store::get(&instance.id)?;
    progress("Готово", 1, 1);
    Ok(instance)
}

/// Скачать последнюю версию модпака с Modrinth
pub async fn download_from_modrinth(http: &HttpClient, project_id: &str) -> Result<(PathBuf, String)> {
    #[derive(Deserialize)]
    struct Version {
        files: Vec<VFile>,
    }
    #[derive(Deserialize)]
    struct VFile {
        url: String,
        filename: String,
        primary: bool,
        size: u64,
        hashes: HashMap<String, String>,
    }
    #[derive(Deserialize)]
    struct Project {
        title: String,
    }

    let api = "https://api.modrinth.com/v2";
    let id = urlencoding::encode(project_id);
    let project: Project = http.get_json(&format!("{api}/project/{id}")).await?;
    let versions: Vec<Version> = http.get_json(&format!("{api}/project/{id}/version")).await?;
    let file = versions
        .iter()
        .flat_map(|v| v.files.iter())
        .find(|f| f.primary && f.filename.ends_with(".mrpack"))
        .context("У модпака нет файла .mrpack")?;

    let dest = cache_dir()?.join("modpacks").join(format!("{}.mrpack", uuid::Uuid::new_v4()));
    let mut expected = VerifiedDownload::new().with_size(file.size);
    if let Some(sha1) = file.hashes.get("sha1") {
        expected = expected.with_sha1(sha1);
    }
    http.download_verified(&file.url, &dest, expected).await?;
    Ok((dest, project.title))
}
