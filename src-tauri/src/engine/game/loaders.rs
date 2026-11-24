//! Forge и NeoForge.
//!
//! Современные версии (Forge 1.13+, NeoForge) ставятся официальным установщиком в тихом
//! режиме `--installClient` прямо в общее хранилище лаунчера: раскладка `versions/` и
//! `libraries/` совпадает с .minecraft. Старый Forge (до 1.13) ставится вручную: профиль
//! берётся из `install_profile.json`, universal-jar распаковывается в libraries.

use std::io::Read;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, BufReader};

use crate::engine::core::http::{HttpClient, VerifiedDownload};
use crate::engine::core::paths::{app_dir, cache_dir, libraries_dir, version_json_path};
use crate::engine::game::java::JavaRuntime;
use crate::engine::game::manifest::maven_path;

const FORGE_MAVEN: &str = "https://maven.minecraftforge.net/net/minecraftforge/forge";
/// promotions_slim.json лежит не в maven, а на files.minecraftforge.net (в maven — 404)
const FORGE_FILES: &str = "https://files.minecraftforge.net/net/minecraftforge/forge";
const NEO_MAVEN: &str = "https://maven.neoforged.net/releases/net/neoforged";
const NEO_API: &str = "https://maven.neoforged.net/api/maven/versions/releases/net/neoforged";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ForgeKind {
    Forge,
    NeoForge,
}

impl ForgeKind {
    pub fn parse(loader: &str) -> Option<Self> {
        match loader {
            "forge" => Some(Self::Forge),
            "neoforge" => Some(Self::NeoForge),
            _ => None,
        }
    }

    pub fn title(self) -> &'static str {
        match self {
            Self::Forge => "Forge",
            Self::NeoForge => "NeoForge",
        }
    }
}

// ---------- Версии ----------

#[derive(Deserialize)]
struct Promotions {
    promos: std::collections::HashMap<String, String>,
}

#[derive(Deserialize)]
struct NeoVersions {
    versions: Vec<String>,
}

/// Префикс версий NeoForge: 1.21.4 → "21.4.", 1.21 → "21.0.", 26.3 → "26.3."
fn neoforge_prefix(mc: &str) -> String {
    let trimmed = mc.strip_prefix("1.").unwrap_or(mc);
    let parts: Vec<&str> = trimmed.split('.').collect();
    match parts.as_slice() {
        [major] => format!("{major}.0."),
        [major, minor, ..] => format!("{major}.{minor}."),
        _ => format!("{trimmed}."),
    }
}

fn is_unstable(v: &str) -> bool {
    let v = v.to_lowercase();
    v.contains("beta") || v.contains("alpha") || v.contains("rc") || v.contains("pre")
}

/// Рекомендуемая (или последняя) версия загрузчика для версии игры
pub async fn latest_version(http: &HttpClient, kind: ForgeKind, mc: &str) -> Result<String> {
    match kind {
        ForgeKind::Forge => {
            let promos: Promotions = http
                .get_json(&format!("{FORGE_FILES}/promotions_slim.json"))
                .await?;
            promos
                .promos
                .get(&format!("{mc}-recommended"))
                .or_else(|| promos.promos.get(&format!("{mc}-latest")))
                .cloned()
                .with_context(|| format!("Forge не поддерживает Minecraft {mc}"))
        }
        ForgeKind::NeoForge if mc == "1.20.1" => {
            // Для 1.20.1 NeoForge выпускался под старым именем артефакта
            let list: NeoVersions = http.get_json(&format!("{NEO_API}/forge")).await?;
            list.versions
                .iter()
                .rev()
                .find(|v| v.starts_with("1.20.1-"))
                .cloned()
                .context("NeoForge для 1.20.1 не найден")
        }
        ForgeKind::NeoForge => {
            let list: NeoVersions = http.get_json(&format!("{NEO_API}/neoforge")).await?;
            let prefix = neoforge_prefix(mc);
            let matching: Vec<&String> =
                list.versions.iter().filter(|v| v.starts_with(&prefix)).collect();
            matching
                .iter()
                .rev()
                .find(|v| !is_unstable(v))
                .or_else(|| matching.last())
                .map(|v| v.to_string())
                .with_context(|| format!("NeoForge не поддерживает Minecraft {mc}"))
        }
    }
}

/// Версия загрузчика в списке для выбора
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LoaderVersionInfo {
    pub version: String,
    /// Не бета/альфа
    pub stable: bool,
    /// Её лаунчер ставит сам, если версию не выбрали
    pub recommended: bool,
}

/// Версия загрузчика безопасна для адресов и имён файлов (её может прислать интерфейс)
pub fn valid_loader_version(v: &str) -> bool {
    !v.is_empty()
        && v.len() <= 64
        && !v.contains("..")
        && v.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'+' | b'_'))
}

/// Все версии загрузчика для версии игры, новые сверху
pub async fn versions(http: &HttpClient, loader: &str, mc: &str) -> Result<Vec<LoaderVersionInfo>> {
    let mut list = match ForgeKind::parse(loader) {
        Some(ForgeKind::Forge) => forge_versions(http, mc).await?,
        Some(ForgeKind::NeoForge) => {
            let recommended = latest_version(http, ForgeKind::NeoForge, mc).await.ok();
            let (artifact, prefix) = if mc == "1.20.1" {
                ("forge", "1.20.1-".to_string())
            } else {
                ("neoforge", neoforge_prefix(mc))
            };
            let all: NeoVersions = http.get_json(&format!("{NEO_API}/{artifact}")).await?;
            all.versions
                .into_iter()
                .filter(|v| v.starts_with(&prefix))
                .map(|v| LoaderVersionInfo {
                    stable: !is_unstable(&v),
                    recommended: recommended.as_deref() == Some(v.as_str()),
                    version: v,
                })
                .collect()
        }
        None => crate::engine::game::install::meta_loader_versions(http, loader, mc).await?,
    };
    list.retain(|v| valid_loader_version(&v.version));
    list.sort_by(|a, b| crate::engine::game::install::loader_version_cmp(&b.version, &a.version));
    Ok(list)
}

/// Forge: все сборки из maven-metadata.json, «рекомендуемая» — из promotions_slim.json
async fn forge_versions(http: &HttpClient, mc: &str) -> Result<Vec<LoaderVersionInfo>> {
    let all: std::collections::HashMap<String, Vec<String>> =
        http.get_json(&format!("{FORGE_FILES}/maven-metadata.json")).await?;
    let recommended = latest_version(http, ForgeKind::Forge, mc).await.ok();
    Ok(all
        .get(mc)
        .map(|list| list.iter().filter_map(|full| forge_build(mc, full)).collect::<Vec<_>>())
        .unwrap_or_default()
        .into_iter()
        .map(|v| LoaderVersionInfo { stable: true, recommended: recommended.as_deref() == Some(v.as_str()), version: v })
        .collect())
}

/// "1.7.10-10.13.4.1614-1.7.10" → "10.13.4.1614" (так версию ждёт установщик и promotions)
fn forge_build(mc: &str, full: &str) -> Option<String> {
    let rest = full.strip_prefix(mc)?.strip_prefix('-')?;
    let build = rest.strip_suffix(&format!("-{mc}")).unwrap_or(rest);
    (!build.is_empty()).then(|| build.to_string())
}

fn installer_urls(kind: ForgeKind, mc: &str, version: &str) -> Vec<String> {
    match kind {
        ForgeKind::Forge => vec![
            format!("{FORGE_MAVEN}/{mc}-{version}/forge-{mc}-{version}-installer.jar"),
            // Старые сборки (1.7.10 и т.п.) лежат в папке с суффиксом версии игры
            format!("{FORGE_MAVEN}/{mc}-{version}-{mc}/forge-{mc}-{version}-{mc}-installer.jar"),
        ],
        ForgeKind::NeoForge if version.starts_with("1.20.1-") => {
            vec![format!("{NEO_MAVEN}/forge/{version}/forge-{version}-installer.jar")]
        }
        ForgeKind::NeoForge => {
            vec![format!("{NEO_MAVEN}/neoforge/{version}/neoforge-{version}-installer.jar")]
        }
    }
}

async fn download_installer(http: &HttpClient, kind: ForgeKind, mc: &str, version: &str) -> Result<PathBuf> {
    let dir = cache_dir()?.join("installers");
    tokio::fs::create_dir_all(&dir).await?;
    let mut last_err = None;
    for url in installer_urls(kind, mc, version) {
        let file = dir.join(url.rsplit('/').next().unwrap_or("installer.jar"));
        if file.exists() {
            return Ok(file);
        }
        // Maven публикует .sha1 рядом с файлом — проверяем, если он есть
        let mut expected = VerifiedDownload::new();
        if let Ok(resp) = http.get(&format!("{url}.sha1")).await {
            if let Ok(text) = resp.text().await {
                let hash = text.split_whitespace().next().unwrap_or("").to_lowercase();
                if hash.len() == 40 {
                    expected = expected.with_sha1(hash);
                }
            }
        }
        match http.download_verified(&url, &file, expected).await {
            Ok(()) => return Ok(file),
            Err(e) => last_err = Some(e),
        }
    }
    Err(last_err.unwrap_or_else(|| anyhow::anyhow!("Установщик не найден")))
        .with_context(|| format!("Не удалось скачать установщик {} {version}", kind.title()))
}

fn read_jar_entry(jar: &Path, name: &str) -> Result<Option<Vec<u8>>> {
    let mut zip = zip::ZipArchive::new(std::fs::File::open(jar)?)?;
    let result = match zip.by_name(name) {
        Ok(mut entry) => {
            let mut buf = Vec::new();
            entry.read_to_end(&mut buf)?;
            Some(buf)
        }
        Err(_) => None,
    };
    Ok(result)
}

/// Старый Forge: профиль из install_profile.json + universal-jar в libraries
fn install_legacy(installer: &Path, profile: &serde_json::Value) -> Result<String> {
    let info = &profile["versionInfo"];
    let id = info["id"].as_str().context("В профиле Forge нет id")?.to_string();

    let install = &profile["install"];
    let file_path = install["filePath"].as_str().context("Нет filePath")?;
    let coords = install["path"].as_str().context("Нет path")?;
    let target = libraries_dir()?.join(maven_path(coords).context("Неверный путь universal")?);
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let data = read_jar_entry(installer, file_path)?.context("В установщике нет universal-jar")?;
    std::fs::write(&target, data)?;

    // У части библиотек старого Forge нет URL — подставляем репозитории
    let mut info = info.clone();
    if let Some(libs) = info["libraries"].as_array_mut() {
        for lib in libs {
            if lib.get("url").is_none() && lib.get("downloads").is_none() {
                lib["url"] = "https://libraries.minecraft.net/".into();
            }
        }
    }
    let json_path = version_json_path(&id)?;
    std::fs::create_dir_all(json_path.parent().unwrap())?;
    std::fs::write(&json_path, serde_json::to_vec_pretty(&info)?)?;
    Ok(id)
}

async fn run_installer(
    java: &JavaRuntime,
    installer: &Path,
    flag: &str,
    target: &Path,
    log: &(dyn Fn(String) + Send + Sync),
) -> Result<bool> {
    let mut cmd = tokio::process::Command::new(&java.executable);
    cmd.arg("-jar")
        .arg(installer)
        .arg(flag)
        .arg(target)
        .current_dir(installer.parent().unwrap_or(target))
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    #[cfg(target_os = "windows")]
    cmd.creation_flags(0x0800_0000);

    let mut child = cmd.spawn().context("Не удалось запустить установщик")?;
    let stdout = child.stdout.take().context("нет stdout")?;
    let stderr = child.stderr.take().context("нет stderr")?;

    // stdout и stderr читаем одновременно, иначе установщик может встать на полном буфере
    async fn pump<R: tokio::io::AsyncRead + Unpin>(
        stream: R,
        log: &(dyn Fn(String) + Send + Sync),
    ) -> Vec<String> {
        let mut out = Vec::new();
        let mut reader = BufReader::new(stream).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            log(format!("[installer] {line}"));
            out.push(line);
        }
        out
    }
    let (mut lines, err_lines) = tokio::join!(pump(stdout, log), pump(stderr, log));
    lines.extend(err_lines);
    let unknown_flag = lines
        .iter()
        .any(|l| l.contains("is not a recognized option") || l.contains("UnrecognizedOption"));
    let status = child.wait().await?;
    if status.success() {
        return Ok(true);
    }
    if unknown_flag {
        return Ok(false);
    }
    let tail = lines.iter().rev().take(4).rev().cloned().collect::<Vec<_>>().join("\n");
    bail!("Установщик завершился с ошибкой:\n{tail}");
}

/// Установить Forge/NeoForge. Возвращает (id версии для запуска, версия загрузчика).
pub async fn install(
    http: &HttpClient,
    kind: ForgeKind,
    mc: &str,
    loader_version: Option<&str>,
    java: &JavaRuntime,
    log: &(dyn Fn(String) + Send + Sync),
) -> Result<(String, String)> {
    let version = match loader_version {
        Some(v) => v.to_string(),
        None => latest_version(http, kind, mc).await?,
    };
    log(format!("Устанавливаю {} {version} для Minecraft {mc}", kind.title()));
    let installer = download_installer(http, kind, mc, &version).await?;

    let jar = installer.clone();
    let (profile, version_json) = tokio::task::spawn_blocking(move || -> Result<_> {
        let profile = read_jar_entry(&jar, "install_profile.json")?
            .context("В установщике нет install_profile.json")?;
        let version = read_jar_entry(&jar, "version.json")?;
        Ok((profile, version))
    })
    .await??;
    let profile: serde_json::Value = serde_json::from_slice(&profile)?;

    // Старый формат (Forge до 1.13)
    if profile.get("versionInfo").is_some() {
        let jar = installer.clone();
        let id = tokio::task::spawn_blocking(move || install_legacy(&jar, &profile)).await??;
        log(format!("{} установлен: {id}", kind.title()));
        return Ok((id, version));
    }

    let id = version_json
        .as_deref()
        .and_then(|d| serde_json::from_slice::<serde_json::Value>(d).ok())
        .and_then(|v| v["id"].as_str().map(str::to_string))
        .or_else(|| profile["version"].as_str().map(str::to_string))
        .context("Не удалось определить id версии загрузчика")?;

    if version_json_path(&id)?.exists() {
        return Ok((id, version));
    }

    // Установщику нужен launcher_profiles.json в целевой папке
    let root = app_dir()?;
    let profiles = root.join("launcher_profiles.json");
    if !profiles.exists() {
        tokio::fs::write(&profiles, br#"{"profiles":{}}"#).await?;
    }

    let mut ok = run_installer(java, &installer, "--installClient", &root, log).await?;
    if !ok {
        ok = run_installer(java, &installer, "--install-client", &root, log).await?;
    }
    if !ok || !version_json_path(&id)?.exists() {
        bail!("{} не установился — подробности в консоли", kind.title());
    }
    log(format!("{} установлен: {id}", kind.title()));
    Ok((id, version))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn neo_prefix() {
        assert_eq!(neoforge_prefix("1.21.4"), "21.4.");
        assert_eq!(neoforge_prefix("1.21"), "21.0.");
        assert_eq!(neoforge_prefix("1.20.6"), "20.6.");
        assert_eq!(neoforge_prefix("26.3"), "26.3.");
    }

    #[test]
    fn forge_builds() {
        assert_eq!(forge_build("1.20.1", "1.20.1-47.4.29").as_deref(), Some("47.4.29"));
        assert_eq!(forge_build("1.7.10", "1.7.10-10.13.4.1614-1.7.10").as_deref(), Some("10.13.4.1614"));
        assert_eq!(forge_build("1.7.10", "1.7.10-10.13.0.1150").as_deref(), Some("10.13.0.1150"));
        assert_eq!(forge_build("1.2", "1.2.5-3.4.9"), None);
    }

    #[test]
    fn loader_version_is_safe() {
        assert!(valid_loader_version("47.4.29"));
        assert!(valid_loader_version("1.20.1-47.1.106"));
        assert!(valid_loader_version("0.31.0-beta.6"));
        assert!(!valid_loader_version("../../evil"));
        assert!(!valid_loader_version("1/2"));
        assert!(!valid_loader_version(""));
    }
}
