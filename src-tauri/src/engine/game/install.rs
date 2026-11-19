//! Установка версии: client.jar, библиотеки, ресурсы, конфиг логов, загрузчики.

use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use anyhow::{Context, Result, bail};
use futures::StreamExt;
use serde::Deserialize;

use crate::engine::core::archive::extract_zip_sync;
use crate::engine::core::http::{HttpClient, VerifiedDownload, file_matches_size};
use crate::engine::core::paths::{
    assets_dir, libraries_dir, version_jar_path, version_json_path,
};
use crate::engine::game::manifest::VersionManifest;

/// Прогресс установки: (этап, сделано, всего)
pub type StageProgress<'a> = &'a (dyn Fn(&str, u64, u64) + Send + Sync);

struct Job {
    url: String,
    dest: std::path::PathBuf,
    expected: VerifiedDownload,
}

/// Скачать набор файлов параллельно; уже скачанные (по размеру) пропускаются
async fn run_jobs(
    client: &HttpClient,
    jobs: Vec<Job>,
    concurrency: usize,
    stage: &str,
    progress: StageProgress<'_>,
) -> Result<()> {
    let total = jobs.len() as u64;
    let done = Arc::new(AtomicU64::new(0));
    progress(stage, 0, total);

    let mut stream = futures::stream::iter(jobs.into_iter().map(|job| {
        let client = client.clone();
        let done = done.clone();
        async move {
            if !file_matches_size(&job.dest, job.expected.size).await {
                client.download_verified(&job.url, &job.dest, job.expected).await?;
            }
            Ok::<u64, anyhow::Error>(done.fetch_add(1, Ordering::Relaxed) + 1)
        }
    }))
    .buffer_unordered(concurrency);

    let mut last_report = 0;
    while let Some(result) = stream.next().await {
        let n = result?;
        // Не заваливаем фронтенд событиями — максимум ~100 обновлений на этап
        if n == total || n - last_report >= (total / 100).max(1) {
            last_report = n;
            progress(stage, n, total);
        }
    }
    Ok(())
}

/// Убедиться, что все файлы версии на месте
pub async fn ensure_version_files(
    client: &HttpClient,
    manifest: &VersionManifest,
    progress: StageProgress<'_>,
) -> Result<()> {
    // 1. Клиент
    let downloads = manifest
        .downloads
        .as_ref()
        .context("В манифесте нет ссылки на клиент")?;
    let jar = version_jar_path(&manifest.jar_id)?;
    run_jobs(
        client,
        vec![Job {
            url: downloads.client.url.clone(),
            dest: jar,
            expected: VerifiedDownload::new()
                .sha1_opt(downloads.client.sha1.as_deref())
                .size_opt(downloads.client.size),
        }],
        1,
        "client",
        progress,
    )
    .await?;

    // 2. Библиотеки
    let lib_root = libraries_dir()?;
    let jobs = manifest
        .library_files()
        .into_iter()
        .map(|f| Job {
            url: f.url,
            dest: lib_root.join(&f.path),
            expected: VerifiedDownload::new().sha1_opt(f.sha1.as_deref()).size_opt(f.size),
        })
        .collect();
    run_jobs(client, jobs, 16, "libraries", progress).await?;

    // 3. Конфиг логирования (в т.ч. защита от Log4Shell для старых версий)
    if let Some(log) = manifest.logging.as_ref().and_then(|l| l.client.as_ref()) {
        let dest = assets_dir()?.join("log_configs").join(&log.file.id);
        if !file_matches_size(&dest, Some(log.file.size)).await {
            client
                .download_verified(
                    &log.file.url,
                    &dest,
                    VerifiedDownload::new().with_sha1(&log.file.sha1).with_size(log.file.size),
                )
                .await?;
        }
    }

    // 4. Ресурсы
    ensure_assets(client, manifest, progress).await
}

#[derive(Deserialize)]
struct AssetIndexFile {
    objects: std::collections::HashMap<String, AssetObject>,
    #[serde(default, rename = "virtual")]
    is_virtual: bool,
    #[serde(default)]
    map_to_resources: bool,
}

#[derive(Deserialize)]
struct AssetObject {
    hash: String,
    size: u64,
}

async fn ensure_assets(
    client: &HttpClient,
    manifest: &VersionManifest,
    progress: StageProgress<'_>,
) -> Result<()> {
    let Some(index) = &manifest.asset_index else {
        return Ok(());
    };
    let root = assets_dir()?;
    let index_path = root.join("indexes").join(format!("{}.json", index.id));
    if !file_matches_size(&index_path, Some(index.size)).await {
        client
            .download_verified(
                &index.url,
                &index_path,
                VerifiedDownload::new().with_sha1(&index.sha1).with_size(index.size),
            )
            .await?;
    }
    let parsed: AssetIndexFile = serde_json::from_slice(&tokio::fs::read(&index_path).await?)
        .context("Повреждён индекс ресурсов")?;

    let objects = root.join("objects");
    let jobs = parsed
        .objects
        .values()
        .map(|obj| {
            let hash = obj.hash.to_lowercase();
            let prefix = &hash[..2];
            Job {
                url: format!("https://resources.download.minecraft.net/{prefix}/{hash}"),
                dest: objects.join(prefix).join(&hash),
                expected: VerifiedDownload::new().with_sha1(&hash).with_size(obj.size),
            }
        })
        .collect();
    run_jobs(client, jobs, 32, "assets", progress).await?;

    // Очень старые версии (до 1.7) читают ресурсы из «виртуальной» папки
    if parsed.is_virtual || parsed.map_to_resources {
        let virtual_dir = root.join("virtual").join(&index.id);
        for (name, obj) in &parsed.objects {
            let target = virtual_dir.join(name);
            if file_matches_size(&target, Some(obj.size)).await {
                continue;
            }
            if let Some(parent) = target.parent() {
                tokio::fs::create_dir_all(parent).await?;
            }
            let hash = obj.hash.to_lowercase();
            tokio::fs::copy(objects.join(&hash[..2]).join(&hash), &target).await?;
        }
    }
    Ok(())
}

/// Папка с ресурсами для аргумента `${game_assets}`
pub fn legacy_assets_dir(manifest: &VersionManifest) -> Result<Option<std::path::PathBuf>> {
    let Some(index) = &manifest.asset_index else {
        return Ok(None);
    };
    let dir = assets_dir()?.join("virtual").join(&index.id);
    Ok(dir.exists().then_some(dir))
}

/// Распаковать нативные библиотеки (.dll/.so/.dylib) в каталог запуска
pub async fn extract_natives(manifest: &VersionManifest, natives_dir: &Path) -> Result<()> {
    let lib_root = libraries_dir()?;
    let jars: Vec<_> = manifest.native_jars().into_iter().map(|p| lib_root.join(p)).collect();
    let natives_dir = natives_dir.to_path_buf();

    tokio::task::spawn_blocking(move || -> Result<()> {
        if natives_dir.exists() {
            let _ = std::fs::remove_dir_all(&natives_dir);
        }
        std::fs::create_dir_all(&natives_dir)?;
        // Новые версии (26.x+) указывают JVM на подпапки natives/<...> — они должны существовать
        for sub in ["java", "jna", "lwjgl", "netty"] {
            std::fs::create_dir_all(natives_dir.join(sub))?;
        }
        let tmp = natives_dir.join(".unpack");
        for jar in jars {
            if !jar.exists() {
                continue;
            }
            let _ = std::fs::remove_dir_all(&tmp);
            extract_zip_sync(&jar, &tmp)?;
            for entry in walkdir::WalkDir::new(&tmp).into_iter().flatten() {
                let path = entry.path();
                let is_native = path
                    .extension()
                    .and_then(|e| e.to_str())
                    .is_some_and(|e| matches!(e, "dll" | "so" | "dylib" | "jnilib"));
                if !entry.file_type().is_file() || !is_native || !native_entry_for_this_arch(path) {
                    continue;
                }
                if let Some(name) = path.file_name() {
                    // Нативы кладём и в корень (старые версии), и в natives/java (26.x+)
                    std::fs::copy(path, natives_dir.join(name))?;
                    std::fs::copy(path, natives_dir.join("java").join(name))?;
                }
            }
        }
        let _ = std::fs::remove_dir_all(&tmp);
        Ok(())
    })
    .await?
}

/// Внутри одного jar бывают нативы под разные архитектуры (windows/x64, windows/arm64…)
fn native_entry_for_this_arch(path: &Path) -> bool {
    use crate::engine::game::manifest::OS_ARCH;
    let parts: Vec<String> = path
        .components()
        .map(|c| c.as_os_str().to_string_lossy().to_lowercase())
        .collect();
    let has = |names: &[&str]| parts.iter().any(|p| names.contains(&p.as_str()));
    match OS_ARCH {
        "arm64" => !has(&["x64", "x86", "x86_64", "amd64"]),
        "x86" => !has(&["x64", "x86_64", "amd64", "arm64", "aarch64"]),
        _ => !has(&["arm64", "aarch64", "arm32", "x86"]),
    }
}

// ---------- Загрузчики ----------

#[derive(Deserialize)]
struct LoaderEntry {
    loader: LoaderInfo,
}

#[derive(Deserialize)]
struct LoaderInfo {
    version: String,
    #[serde(default)]
    stable: Option<bool>,
}

fn loader_meta(loader: &str) -> Result<&'static str> {
    match loader {
        "fabric" => Ok("https://meta.fabricmc.net/v2"),
        "quilt" => Ok("https://meta.quiltmc.org/v3"),
        other => bail!("Неизвестный загрузчик: {other}"),
    }
}

/// Последняя стабильная версия загрузчика для версии игры
pub async fn latest_loader_version(
    client: &HttpClient,
    loader: &str,
    game_version: &str,
) -> Result<String> {
    let base = loader_meta(loader)?;
    let url = format!("{base}/versions/loader/{}", urlencoding::encode(game_version));
    let entries: Vec<LoaderEntry> = client.get_json(&url).await?;
    let pick = entries
        .iter()
        .find(|e| {
            e.loader.stable.unwrap_or_else(|| {
                let v = e.loader.version.to_lowercase();
                !(v.contains("beta") || v.contains("pre") || v.contains("rc"))
            })
        })
        .or_else(|| entries.first())
        .with_context(|| format!("{loader} не поддерживает Minecraft {game_version}"))?;
    Ok(pick.loader.version.clone())
}

/// Установить профиль загрузчика. Возвращает id версии для запуска.
pub async fn install_loader(
    client: &HttpClient,
    loader: &str,
    game_version: &str,
    loader_version: Option<&str>,
) -> Result<(String, String)> {
    let base = loader_meta(loader)?;
    let loader_version = match loader_version {
        Some(v) => v.to_string(),
        None => latest_loader_version(client, loader, game_version).await?,
    };
    let url = format!(
        "{base}/versions/loader/{}/{}/profile/json",
        urlencoding::encode(game_version),
        urlencoding::encode(&loader_version)
    );
    let profile: serde_json::Value = client.get_json(&url).await?;
    let id = profile["id"]
        .as_str()
        .context("Профиль загрузчика без id")?
        .to_string();

    let path = version_json_path(&id)?;
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    tokio::fs::write(&path, serde_json::to_vec_pretty(&profile)?).await?;
    Ok((id, loader_version))
}
