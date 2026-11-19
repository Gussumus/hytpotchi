//! Пути к данным лаунчера.
//!
//! Раскладка (общие файлы — один раз на все сборки, как у официального лаунчера):
//! ```text
//! %APPDATA%/.hytpotchi/
//!   versions/<id>/<id>.json|.jar   манифесты версий и клиенты
//!   libraries/                      maven-библиотеки
//!   assets/indexes|objects|virtual  ресурсы игры
//!   java/temurin-<major>/           автоматически скачанная Java
//!   instances/<uuid>/               сборки (instance.json + minecraft/)
//! ```

use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};

/// Корневой каталог данных (можно переопределить через `HYTPOTCHI_HOME`)
pub fn app_dir() -> Result<PathBuf> {
    if let Ok(custom) = std::env::var("HYTPOTCHI_HOME") {
        if !custom.trim().is_empty() {
            return Ok(PathBuf::from(custom));
        }
    }
    let base = directories::BaseDirs::new().context("Не удалось определить папку пользователя")?;
    Ok(base.data_dir().join(".hytpotchi"))
}

pub fn instances_dir() -> Result<PathBuf> {
    Ok(app_dir()?.join("instances"))
}

pub fn java_dir() -> Result<PathBuf> {
    Ok(app_dir()?.join("java"))
}

pub fn cache_dir() -> Result<PathBuf> {
    Ok(app_dir()?.join("cache"))
}

pub fn temp_dir() -> Result<PathBuf> {
    Ok(std::env::temp_dir().join("hytpotchi"))
}

pub fn logs_dir() -> Result<PathBuf> {
    Ok(app_dir()?.join("logs"))
}

pub fn versions_dir() -> Result<PathBuf> {
    Ok(app_dir()?.join("versions"))
}

pub fn libraries_dir() -> Result<PathBuf> {
    Ok(app_dir()?.join("libraries"))
}

pub fn assets_dir() -> Result<PathBuf> {
    Ok(app_dir()?.join("assets"))
}

/// Каталог конкретной версии
pub fn version_dir(version_id: &str) -> Result<PathBuf> {
    validate_segment(version_id)?;
    Ok(versions_dir()?.join(version_id))
}

pub fn version_json_path(version_id: &str) -> Result<PathBuf> {
    Ok(version_dir(version_id)?.join(format!("{version_id}.json")))
}

pub fn version_jar_path(version_id: &str) -> Result<PathBuf> {
    Ok(version_dir(version_id)?.join(format!("{version_id}.jar")))
}

/// Каталог сборки
pub fn instance_path(instance_id: &str) -> Result<PathBuf> {
    validate_segment(instance_id)?;
    Ok(instances_dir()?.join(instance_id))
}

/// Игровая папка сборки (аналог .minecraft)
pub fn instance_game_dir(instance_id: &str) -> Result<PathBuf> {
    Ok(instance_path(instance_id)?.join("minecraft"))
}

pub fn instance_mods_dir(instance_id: &str) -> Result<PathBuf> {
    Ok(instance_game_dir(instance_id)?.join("mods"))
}

pub fn instance_resourcepacks_dir(instance_id: &str) -> Result<PathBuf> {
    Ok(instance_game_dir(instance_id)?.join("resourcepacks"))
}

pub fn instance_shaderpacks_dir(instance_id: &str) -> Result<PathBuf> {
    Ok(instance_game_dir(instance_id)?.join("shaderpacks"))
}

pub fn instance_natives_dir(instance_id: &str) -> Result<PathBuf> {
    Ok(instance_path(instance_id)?.join("natives"))
}

pub fn instance_logs_dir(instance_id: &str) -> Result<PathBuf> {
    Ok(instance_game_dir(instance_id)?.join("logs"))
}

pub fn instance_screenshots_dir(instance_id: &str) -> Result<PathBuf> {
    Ok(instance_game_dir(instance_id)?.join("screenshots"))
}

/// Каталог управляемой Java нужной мажорной версии
pub fn java_runtime_path(major: u32) -> Result<PathBuf> {
    Ok(java_dir()?.join(format!("temurin-{major}")))
}

pub fn ensure_dir(path: &Path) -> Result<()> {
    std::fs::create_dir_all(path)
        .with_context(|| format!("Не удалось создать папку: {}", path.display()))
}

/// Один сегмент пути из внешнего ввода: без разделителей, `..` и спецсимволов
pub fn validate_segment(segment: &str) -> Result<()> {
    let ok = !segment.is_empty()
        && segment.len() <= 128
        && segment != "."
        && segment != ".."
        && segment
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '+' | ' '));
    if !ok || segment.ends_with('.') || segment.ends_with(' ') {
        bail!("Недопустимое имя: {segment}");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn segment_validation() {
        assert!(validate_segment("1.21.4").is_ok());
        assert!(validate_segment("fabric-loader-0.16.9-1.21.4").is_ok());
        assert!(validate_segment("../evil").is_err());
        assert!(validate_segment("a/b").is_err());
        assert!(validate_segment("..").is_err());
    }
}
