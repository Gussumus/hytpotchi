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
    if manifest.id != manifest.jar_id {
        link_client_jar(&manifest.jar_id, &manifest.id)?;
    }

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

/// Клиент для версии с загрузчиком — копия ванильного под именем `versions/<id>/<id>.jar`,
/// как у официального лаунчера. Forge и NeoForge 1.17+ узнают ванильный jar в classpath
/// только по этому имени (`-DignoreList=…,${version_name}.jar`), а иначе грузят Minecraft
/// второй раз: «ResolutionException: Modules _1._20._1 and minecraft export package …».
/// Жёсткая ссылка места не занимает; не вышло — обычная копия.
fn link_client_jar(parent_id: &str, id: &str) -> Result<()> {
    let src = version_jar_path(parent_id)?;
    let dst = version_jar_path(id)?;
    let same = match (std::fs::metadata(&src), std::fs::metadata(&dst)) {
        (Ok(s), Ok(d)) => s.len() == d.len(),
        _ => false,
    };
    if same {
        return Ok(());
    }
    if let Some(parent) = dst.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let _ = std::fs::remove_file(&dst);
    if std::fs::hard_link(&src, &dst).is_err() {
        let tmp = dst.with_extension("jar.part");
        std::fs::copy(&src, &tmp).with_context(|| format!("Не удалось скопировать {}", src.display()))?;
        std::fs::rename(&tmp, &dst)?;
    }
    Ok(())
}

/// Jar клиента для classpath: у версии с загрузчиком — своя копия (см. [`link_client_jar`])
pub fn client_jar_path(manifest: &VersionManifest) -> Result<std::path::PathBuf> {
    let own = version_jar_path(&manifest.id)?;
    if manifest.id != manifest.jar_id && own.is_file() {
        return Ok(own);
    }
    version_jar_path(&manifest.jar_id)
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
    pick_loader_version(&entries)
        .with_context(|| format!("{loader} не поддерживает Minecraft {game_version}"))
}

/// Все версии Fabric/Quilt для версии игры (порядок — как в мета-API)
pub async fn meta_loader_versions(
    client: &HttpClient,
    loader: &str,
    game_version: &str,
) -> Result<Vec<crate::engine::game::loaders::LoaderVersionInfo>> {
    let base = loader_meta(loader)?;
    let url = format!("{base}/versions/loader/{}", urlencoding::encode(game_version));
    let entries: Vec<LoaderEntry> = client.get_json(&url).await?;
    let recommended = pick_loader_version(&entries);
    Ok(entries
        .iter()
        .map(|e| crate::engine::game::loaders::LoaderVersionInfo {
            stable: is_stable_loader(&e.loader),
            recommended: recommended.as_deref() == Some(e.loader.version.as_str()),
            version: e.loader.version.clone(),
        })
        .collect())
}

fn is_stable_loader(info: &LoaderInfo) -> bool {
    info.stable.unwrap_or_else(|| {
        let v = info.version.to_lowercase();
        !(v.contains("beta") || v.contains("alpha") || v.contains("pre") || v.contains("rc"))
    })
}

/// Ключ сравнения версий загрузчика: "0.30.2" → [0, 30, 2], "0.31.0-beta.6" → [0, 31, 0] + [6]
fn loader_version_key(v: &str) -> (Vec<u64>, Vec<u64>) {
    let (core, suffix) = v.split_once(['-', '+']).unwrap_or((v, ""));
    let nums = |s: &str| -> Vec<u64> {
        s.split(|c: char| !c.is_ascii_digit())
            .filter(|p| !p.is_empty())
            .filter_map(|p| p.parse().ok())
            .collect()
    };
    (nums(core), nums(suffix))
}

pub fn loader_version_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    loader_version_key(a).cmp(&loader_version_key(b))
}

/// Самая новая стабильная версия, иначе самая новая вообще.
/// Порядок в мета-API не гарантирован: у Quilt список для версии игры не отсортирован,
/// поэтому «первая стабильная» могла оказаться древней (0.24.0 без поддержки Java 25).
fn pick_loader_version(entries: &[LoaderEntry]) -> Option<String> {
    let newest = |stable_only: bool| {
        entries
            .iter()
            .filter(|e| !stable_only || is_stable_loader(&e.loader))
            .max_by(|a, b| loader_version_cmp(&a.loader.version, &b.loader.version))
            .map(|e| e.loader.version.clone())
    };
    newest(true).or_else(|| newest(false))
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

#[cfg(test)]
mod loader_pick_tests {
    use super::*;

    fn entry(v: &str, stable: Option<bool>) -> LoaderEntry {
        LoaderEntry { loader: LoaderInfo { version: v.into(), stable } }
    }

    #[test]
    fn picks_newest_stable_from_unsorted_list() {
        let list = [
            entry("0.20.0-beta.9", None),
            entry("0.24.0", None),
            entry("0.30.0-beta.8", None),
            entry("0.19.5", None),
            entry("0.30.2", None),
            entry("0.31.0-beta.6", None),
            entry("0.30.10", None),
        ];
        assert_eq!(pick_loader_version(&list).as_deref(), Some("0.30.10"));
    }

    #[test]
    fn falls_back_to_newest_beta() {
        let list = [entry("0.1.0-beta.2", None), entry("0.1.0-beta.10", None)];
        assert_eq!(pick_loader_version(&list).as_deref(), Some("0.1.0-beta.10"));
    }

    #[test]
    fn respects_stable_flag() {
        let list = [entry("0.20.1", Some(true)), entry("0.21.0", Some(false))];
        assert_eq!(pick_loader_version(&list).as_deref(), Some("0.20.1"));
    }

    #[test]
    fn compares_versions() {
        use std::cmp::Ordering::*;
        assert_eq!(loader_version_cmp("0.24.0", "0.30.2"), Less);
        assert_eq!(loader_version_cmp("0.30.10", "0.30.2"), Greater);
        assert_eq!(loader_version_cmp("0.30.2", "0.30.2"), Equal);
    }
}
