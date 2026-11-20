//! Свои фоны лаунчера: картинки (PNG/JPG/WebP/GIF/AVIF) и видео (MP4/WebM).
//!
//! Файлы копируются в `<данные>/backgrounds/<id>.<ext>`, рядом — `backgrounds.json` с именами.
//! Фронтенд показывает их через asset-протокол Tauri (scope в tauri.conf.json).

use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, command};
use tauri_plugin_dialog::DialogExt;

use crate::engine::core::paths::app_dir;

type CmdResult<T> = Result<T, String>;

fn err(e: anyhow::Error) -> String {
    format!("{e:#}")
}

const IMAGE_EXT: &[&str] = &["png", "jpg", "jpeg", "webp", "gif", "avif"];
const VIDEO_EXT: &[&str] = &["mp4", "webm"];
/// Больше — уже не фон, а фильм; WebView будет держать это в памяти
const MAX_BYTES: u64 = 300 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Background {
    pub id: String,
    pub name: String,
    /// "image" или "video"
    pub kind: String,
    /// Абсолютный путь к файлу (фронтенд превращает его в asset-URL)
    #[serde(default)]
    pub path: String,
    pub file: String,
}

fn dir() -> Result<PathBuf> {
    let d = app_dir()?.join("backgrounds");
    std::fs::create_dir_all(&d)?;
    Ok(d)
}

fn kind_of(ext: &str) -> Option<&'static str> {
    if IMAGE_EXT.contains(&ext) {
        Some("image")
    } else if VIDEO_EXT.contains(&ext) {
        Some("video")
    } else {
        None
    }
}

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric())
}

fn read_meta(d: &Path) -> Vec<Background> {
    let mut list: Vec<Background> = std::fs::read(d.join("backgrounds.json"))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default();
    // Отбрасываем записи, у которых пропал файл, и подставляем актуальный путь
    list.retain(|b| valid_id(&b.id) && d.join(&b.file).is_file());
    for b in &mut list {
        b.path = d.join(&b.file).to_string_lossy().into_owned();
    }
    list
}

fn write_meta(d: &Path, list: &[Background]) -> Result<()> {
    let tmp = d.join("backgrounds.json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(list)?)?;
    std::fs::rename(tmp, d.join("backgrounds.json"))?;
    Ok(())
}

pub fn add_file(src: &Path) -> Result<Background> {
    let ext = src
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .context("У файла нет расширения")?;
    let Some(kind) = kind_of(&ext) else {
        bail!("Этот формат не подходит для фона: .{ext}");
    };
    let size = std::fs::metadata(src)?.len();
    if size > MAX_BYTES {
        bail!("Файл слишком большой ({} МБ), максимум {} МБ", size / 1_048_576, MAX_BYTES / 1_048_576);
    }
    let d = dir()?;
    let id = uuid::Uuid::new_v4().simple().to_string();
    let file = format!("{id}.{ext}");
    std::fs::copy(src, d.join(&file)).context("Не удалось скопировать файл")?;
    let name = src
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "Фон".into());
    let bg = Background { id, name, kind: kind.into(), path: d.join(&file).to_string_lossy().into_owned(), file };
    let mut list = read_meta(&d);
    list.push(bg.clone());
    write_meta(&d, &list)?;
    Ok(bg)
}

#[command]
pub async fn background_list() -> CmdResult<Vec<Background>> {
    dir().map(|d| read_meta(&d)).map_err(err)
}

#[command]
pub async fn background_add(app: AppHandle) -> CmdResult<Option<Background>> {
    let mut all: Vec<&str> = IMAGE_EXT.to_vec();
    all.extend_from_slice(VIDEO_EXT);
    let picked = app
        .dialog()
        .file()
        .set_title("Свой фон: картинка, GIF или видео")
        .add_filter("Картинки и видео", &all)
        .add_filter("Картинки", IMAGE_EXT)
        .add_filter("Видео", VIDEO_EXT)
        .blocking_pick_file();
    let Some(picked) = picked else { return Ok(None) };
    let path = picked.into_path().map_err(|e| e.to_string())?;
    tokio::task::spawn_blocking(move || add_file(&path))
        .await
        .map_err(|e| e.to_string())?
        .map(Some)
        .map_err(err)
}

#[command]
pub async fn background_rename(id: String, name: String) -> CmdResult<Vec<Background>> {
    let name = name.trim();
    if name.is_empty() {
        return Err("Пустое имя".into());
    }
    let d = dir().map_err(err)?;
    let mut list = read_meta(&d);
    if let Some(b) = list.iter_mut().find(|b| b.id == id) {
        b.name = name.chars().take(60).collect();
    }
    write_meta(&d, &list).map_err(err)?;
    Ok(list)
}

#[command]
pub async fn background_remove(id: String) -> CmdResult<Vec<Background>> {
    if !valid_id(&id) {
        return Err("Неверный фон".into());
    }
    let d = dir().map_err(err)?;
    let mut list = read_meta(&d);
    if let Some(pos) = list.iter().position(|b| b.id == id) {
        let removed = list.remove(pos);
        let _ = std::fs::remove_file(d.join(&removed.file));
    }
    write_meta(&d, &list).map_err(err)?;
    Ok(list)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kinds() {
        assert_eq!(kind_of("png"), Some("image"));
        assert_eq!(kind_of("gif"), Some("image"));
        assert_eq!(kind_of("webm"), Some("video"));
        assert_eq!(kind_of("exe"), None);
    }

    #[test]
    fn ids() {
        assert!(valid_id("a1b2c3"));
        assert!(!valid_id("../x"));
        assert!(!valid_id(""));
    }
}
