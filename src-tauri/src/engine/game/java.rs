//! Java: автоматическая загрузка нужной версии под каждую версию Minecraft.
//!
//! Мажорная версия берётся из манифеста (`javaVersion.majorVersion`, у старых
//! версий — Java 8). Сборка Eclipse Temurin скачивается из Adoptium API,
//! проверяется по SHA-256 и складывается в `java/temurin-<major>`.
//! Каждая версия Java ставится один раз и переиспользуется всеми сборками.

use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

use crate::engine::core::archive::{extract_tar_gz, extract_zip};
use crate::engine::core::http::{ByteProgress, HttpClient, VerifiedDownload};
use crate::engine::core::paths::{java_dir, java_runtime_path};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JavaRuntime {
    pub version: String,
    pub major_version: u32,
    pub path: PathBuf,
    pub executable: PathBuf,
    pub vendor: String,
    /// Скачана лаунчером (а не найдена в системе)
    pub managed: bool,
}

/// Метаданные, которые лаунчер кладёт рядом с распакованной Java
#[derive(Serialize, Deserialize)]
struct ManagedMarker {
    version: String,
    major: u32,
    vendor: String,
}

const MARKER: &str = "hytpotchi-java.json";

/// Защита от параллельной установки одной и той же Java двумя запусками
static INSTALL_LOCK: Mutex<()> = Mutex::const_new(());

/// Java, которая реально нужна. Java 16 давно не поддерживается — для 1.17 берём 17.
pub fn normalize_major(major: u32) -> u32 {
    match major {
        0..=8 => 8,
        9..=11 => 11,
        12..=17 => 17,
        18..=21 => 21,
        other => other,
    }
}

fn java_exe(root: &Path) -> PathBuf {
    let name = if cfg!(target_os = "windows") { "java.exe" } else { "java" };
    root.join("bin").join(name)
}

/// Уже скачанная лаунчером Java нужной версии
pub fn managed_runtime(major: u32) -> Option<JavaRuntime> {
    let root = java_runtime_path(major).ok()?;
    let marker: ManagedMarker =
        serde_json::from_slice(&std::fs::read(root.join(MARKER)).ok()?).ok()?;
    let executable = java_exe(&root);
    executable.exists().then(|| JavaRuntime {
        version: marker.version,
        major_version: marker.major,
        path: root,
        executable,
        vendor: marker.vendor,
        managed: true,
    })
}

/// Все Java, скачанные лаунчером
pub fn list_managed() -> Vec<JavaRuntime> {
    let Ok(dir) = java_dir() else { return vec![] };
    let Ok(entries) = std::fs::read_dir(dir) else { return vec![] };
    let mut list: Vec<JavaRuntime> = entries
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            name.strip_prefix("temurin-")?.parse::<u32>().ok()
        })
        .filter_map(managed_runtime)
        .collect();
    list.sort_by_key(|r| r.major_version);
    list
}

// ---------- Adoptium ----------

#[derive(Deserialize)]
struct AdoptiumAsset {
    binary: AdoptiumBinary,
    version: AdoptiumVersion,
}

#[derive(Deserialize)]
struct AdoptiumBinary {
    package: AdoptiumPackage,
}

#[derive(Deserialize)]
struct AdoptiumPackage {
    link: String,
    checksum: String,
    size: u64,
    name: String,
}

#[derive(Deserialize)]
struct AdoptiumVersion {
    #[serde(default)]
    openjdk_version: Option<String>,
    #[serde(default)]
    semver: Option<String>,
}

fn adoptium_os() -> &'static str {
    if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "macos") {
        "mac"
    } else {
        "linux"
    }
}

fn adoptium_arch() -> &'static str {
    if cfg!(target_arch = "aarch64") {
        "aarch64"
    } else if cfg!(target_arch = "x86") {
        "x32"
    } else {
        "x64"
    }
}

async fn find_package(client: &HttpClient, major: u32) -> Result<AdoptiumAsset> {
    // Сначала лёгкий JRE, если его нет для платформы — полный JDK
    for image in ["jre", "jdk"] {
        let url = format!(
            "https://api.adoptium.net/v3/assets/latest/{major}/hotspot?architecture={}&image_type={image}&os={}&vendor=eclipse",
            adoptium_arch(),
            adoptium_os()
        );
        match client.get_json::<Vec<AdoptiumAsset>>(&url).await {
            Ok(mut assets) if !assets.is_empty() => return Ok(assets.remove(0)),
            Ok(_) => continue,
            Err(e) => log::warn!("Adoptium {major}/{image}: {e:#}"),
        }
    }
    bail!("Не нашлась сборка Java {major} для этой системы")
}

/// Найти каталог, в котором лежит bin/java
fn find_java_root(dir: &Path) -> Option<PathBuf> {
    if java_exe(dir).exists() {
        return Some(dir.to_path_buf());
    }
    // macOS: Contents/Home
    let mac = dir.join("Contents").join("Home");
    if java_exe(&mac).exists() {
        return Some(mac);
    }
    for entry in std::fs::read_dir(dir).ok()?.flatten() {
        if entry.path().is_dir() {
            if let Some(found) = find_java_root(&entry.path()) {
                return Some(found);
            }
        }
    }
    None
}

/// Гарантировать наличие Java нужной версии: найти скачанную или скачать
pub async fn ensure_java(
    client: &HttpClient,
    required_major: u32,
    progress: ByteProgress<'_>,
) -> Result<JavaRuntime> {
    let major = normalize_major(required_major);
    if let Some(rt) = managed_runtime(major) {
        return Ok(rt);
    }

    let _guard = INSTALL_LOCK.lock().await;
    // Пока ждали замок, её мог поставить параллельный запуск
    if let Some(rt) = managed_runtime(major) {
        return Ok(rt);
    }

    log::info!("Скачиваю Java {major}");
    let asset = find_package(client, major).await?;
    let pkg = &asset.binary.package;

    let base = java_dir()?;
    tokio::fs::create_dir_all(&base).await?;
    let archive = base.join(format!("download-{major}-{}", pkg.name));
    client
        .download_with_progress(
            &pkg.link,
            &archive,
            &VerifiedDownload::new().with_sha256(&pkg.checksum).with_size(pkg.size),
            Some(progress),
        )
        .await
        .with_context(|| format!("Не удалось скачать Java {major}"))?;

    let unpack = base.join(format!(".unpack-{major}"));
    let _ = tokio::fs::remove_dir_all(&unpack).await;
    let extracted = if pkg.name.ends_with(".zip") {
        extract_zip(&archive, &unpack).await
    } else {
        extract_tar_gz(&archive, &unpack).await
    };
    let _ = tokio::fs::remove_file(&archive).await;
    extracted.context("Не удалось распаковать Java")?;

    let root = find_java_root(&unpack).context("В архиве Java нет bin/java")?;
    let target = java_runtime_path(major)?;
    let _ = tokio::fs::remove_dir_all(&target).await;
    tokio::fs::rename(&root, &target).await?;
    let _ = tokio::fs::remove_dir_all(&unpack).await;

    let version = asset
        .version
        .semver
        .or(asset.version.openjdk_version)
        .unwrap_or_else(|| major.to_string());
    let marker = ManagedMarker {
        version,
        major,
        vendor: "Eclipse Temurin".into(),
    };
    tokio::fs::write(target.join(MARKER), serde_json::to_vec_pretty(&marker)?).await?;

    let runtime = managed_runtime(major).context("Java установилась, но не запускается")?;
    validate_executable(&runtime.executable)?;
    log::info!("Java {major} установлена: {}", runtime.path.display());
    Ok(runtime)
}

fn validate_executable(exe: &Path) -> Result<()> {
    let mut cmd = Command::new(exe);
    cmd.arg("-version");
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    let output = cmd.output().context("Java не запускается")?;
    if !output.status.success() {
        bail!("Java завершилась с ошибкой: {}", String::from_utf8_lossy(&output.stderr));
    }
    Ok(())
}

// ---------- Системная Java (только для информации в настройках) ----------

pub fn detect_system() -> Vec<JavaRuntime> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(home) = std::env::var("JAVA_HOME") {
        candidates.push(PathBuf::from(home));
    }
    #[cfg(target_os = "windows")]
    {
        for base in [
            r"C:\Program Files\Java",
            r"C:\Program Files\Eclipse Adoptium",
            r"C:\Program Files\Zulu",
            r"C:\Program Files\Microsoft",
        ] {
            if let Ok(entries) = std::fs::read_dir(base) {
                candidates.extend(entries.flatten().map(|e| e.path()));
            }
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        for base in ["/usr/lib/jvm", "/Library/Java/JavaVirtualMachines"] {
            if let Ok(entries) = std::fs::read_dir(base) {
                candidates.extend(entries.flatten().map(|e| e.path()));
            }
        }
    }

    let mut found: Vec<JavaRuntime> = candidates
        .iter()
        .filter_map(|p| find_java_root(p))
        .filter_map(|root| probe(&root))
        .collect();
    found.sort_by(|a, b| a.path.cmp(&b.path));
    found.dedup_by(|a, b| a.path == b.path);
    found
}

fn probe(root: &Path) -> Option<JavaRuntime> {
    let exe = java_exe(root);
    let mut cmd = Command::new(&exe);
    cmd.arg("-version");
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    let output = cmd.output().ok()?;
    let text = String::from_utf8_lossy(&output.stderr);
    let version = text.lines().next()?.split('"').nth(1)?.to_string();
    let major = parse_major(&version)?;
    Some(JavaRuntime {
        version,
        major_version: major,
        path: root.to_path_buf(),
        executable: exe,
        vendor: "Системная".into(),
        managed: false,
    })
}

/// "1.8.0_402" → 8, "17.0.9" → 17
pub fn parse_major(version: &str) -> Option<u32> {
    let mut parts = version.split(['.', '_', '-', '+']);
    let first: u32 = parts.next()?.parse().ok()?;
    if first == 1 { parts.next()?.parse().ok() } else { Some(first) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn majors() {
        assert_eq!(parse_major("1.8.0_402"), Some(8));
        assert_eq!(parse_major("17.0.9"), Some(17));
        assert_eq!(parse_major("21"), Some(21));
        assert_eq!(normalize_major(16), 17);
        assert_eq!(normalize_major(8), 8);
        assert_eq!(normalize_major(21), 21);
        assert_eq!(normalize_major(25), 25);
    }
}
