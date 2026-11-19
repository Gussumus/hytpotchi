//! Миры, скриншоты, новости Minecraft, модпаки

use std::path::{Path, PathBuf};

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State, command};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

use crate::engine::content::mrpack;
use crate::engine::core::http::HttpClient;
use crate::engine::core::paths::{instance_game_dir, instance_path, validate_segment};
use crate::engine::profiles::store::Instance;

type CmdResult<T> = Result<T, String>;

fn err(e: anyhow::Error) -> String {
    format!("{e:#}")
}

fn modified_iso(meta: &std::fs::Metadata) -> Option<String> {
    let t: chrono::DateTime<chrono::Utc> = meta.modified().ok()?.into();
    Some(t.to_rfc3339())
}

fn dir_size(path: &Path) -> u64 {
    walkdir::WalkDir::new(path)
        .into_iter()
        .flatten()
        .filter_map(|e| e.metadata().ok())
        .filter(|m| m.is_file())
        .map(|m| m.len())
        .sum()
}

// ---------- Миры ----------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorldInfo {
    pub folder: String,
    pub size: u64,
    pub last_played: Option<String>,
    /// icon.png как data URL
    pub icon: Option<String>,
}

#[command]
pub async fn world_list(id: String) -> CmdResult<Vec<WorldInfo>> {
    let saves = instance_game_dir(&id).map_err(err)?.join("saves");
    tokio::task::spawn_blocking(move || {
        let mut worlds: Vec<WorldInfo> = std::fs::read_dir(&saves)
            .into_iter()
            .flatten()
            .flatten()
            .filter(|e| e.path().join("level.dat").exists())
            .map(|e| {
                let path = e.path();
                let icon = std::fs::read(path.join("icon.png"))
                    .ok()
                    .filter(|b| b.len() < 256 * 1024)
                    .map(|b| format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(b)));
                WorldInfo {
                    folder: e.file_name().to_string_lossy().into_owned(),
                    size: dir_size(&path),
                    last_played: std::fs::metadata(path.join("level.dat")).ok().and_then(|m| modified_iso(&m)),
                    icon,
                }
            })
            .collect();
        worlds.sort_by(|a, b| b.last_played.cmp(&a.last_played));
        worlds
    })
    .await
    .map_err(|e| e.to_string())
}

fn world_path(id: &str, folder: &str) -> anyhow::Result<PathBuf> {
    // Имя папки мира может содержать почти что угодно, кроме разделителей и «..»
    if folder.is_empty() || folder.contains(['/', '\\']) || folder == "." || folder == ".." {
        anyhow::bail!("Недопустимое имя мира");
    }
    let path = instance_game_dir(id)?.join("saves").join(folder);
    if !path.join("level.dat").exists() {
        anyhow::bail!("Мир не найден");
    }
    Ok(path)
}

/// Резервная копия мира в zip (instances/<id>/backups)
#[command]
pub async fn world_backup(id: String, folder: String) -> CmdResult<String> {
    let src = world_path(&id, &folder).map_err(err)?;
    let backups = instance_path(&id).map_err(err)?.join("backups");
    let stamp = chrono::Local::now().format("%Y-%m-%d_%H-%M-%S");
    let safe: String = folder.chars().map(|c| if c.is_alphanumeric() { c } else { '_' }).collect();
    let dest = backups.join(format!("{safe}_{stamp}.zip"));
    let out = dest.clone();
    tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
        std::fs::create_dir_all(&backups)?;
        let mut zip = zip::ZipWriter::new(std::fs::File::create(&out)?);
        let opts = zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        for entry in walkdir::WalkDir::new(&src).into_iter().flatten() {
            let rel = entry.path().strip_prefix(&src)?.to_string_lossy().replace('\\', "/");
            if rel.is_empty() || rel == "session.lock" {
                continue;
            }
            if entry.file_type().is_dir() {
                zip.add_directory(rel, opts)?;
            } else {
                zip.start_file(rel, opts)?;
                std::io::copy(&mut std::fs::File::open(entry.path())?, &mut zip)?;
            }
        }
        zip.finish()?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(err)?;
    Ok(dest.to_string_lossy().into_owned())
}

#[command]
pub async fn world_delete(id: String, folder: String) -> CmdResult<()> {
    let path = world_path(&id, &folder).map_err(err)?;
    std::fs::remove_dir_all(path).map_err(|e| e.to_string())
}

/// Открыть подпапку сборки в проводнике (saves, screenshots, mods, backups…)
#[command]
pub async fn instance_open_subfolder(app: AppHandle, id: String, sub: String) -> CmdResult<()> {
    validate_segment(&sub).map_err(err)?;
    let dir = if sub == "backups" {
        instance_path(&id).map_err(err)?.join("backups")
    } else {
        instance_game_dir(&id).map_err(err)?.join(&sub)
    };
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    app.opener()
        .open_path(dir.to_string_lossy(), None::<&str>)
        .map_err(|e| e.to_string())
}

// ---------- Скриншоты ----------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Screenshot {
    pub name: String,
    pub path: String,
    pub taken_at: Option<String>,
    pub size: u64,
}

#[command]
pub async fn screenshot_list(id: String) -> CmdResult<Vec<Screenshot>> {
    let dir = instance_game_dir(&id).map_err(err)?.join("screenshots");
    let mut shots: Vec<Screenshot> = std::fs::read_dir(&dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| e.path().extension().is_some_and(|x| x.eq_ignore_ascii_case("png")))
        .filter_map(|e| {
            let meta = e.metadata().ok()?;
            Some(Screenshot {
                name: e.file_name().to_string_lossy().into_owned(),
                path: e.path().to_string_lossy().into_owned(),
                taken_at: modified_iso(&meta),
                size: meta.len(),
            })
        })
        .collect();
    shots.sort_by(|a, b| b.taken_at.cmp(&a.taken_at));
    Ok(shots)
}

#[command]
pub async fn screenshot_delete(id: String, name: String) -> CmdResult<()> {
    validate_segment(&name).map_err(err)?;
    let path = instance_game_dir(&id).map_err(err)?.join("screenshots").join(name);
    std::fs::remove_file(path).map_err(|e| e.to_string())
}

#[command]
pub async fn open_file(app: AppHandle, path: String) -> CmdResult<()> {
    // Открываем только файлы внутри каталога данных лаунчера
    let root = crate::engine::core::paths::app_dir().map_err(err)?;
    let canon = std::fs::canonicalize(&path).map_err(|e| e.to_string())?;
    let root = std::fs::canonicalize(root).map_err(|e| e.to_string())?;
    if !canon.starts_with(&root) {
        return Err("Файл вне папки лаунчера".into());
    }
    app.opener()
        .open_path(path, None::<&str>)
        .map_err(|e| e.to_string())
}

// ---------- Новости ----------

#[derive(Deserialize)]
struct PatchNotes {
    entries: Vec<PatchEntry>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PatchEntry {
    title: String,
    version: String,
    #[serde(rename = "type")]
    kind: String,
    image: PatchImage,
    #[serde(default)]
    date: Option<String>,
    #[serde(default)]
    short_text: Option<String>,
}

#[derive(Deserialize)]
struct PatchImage {
    url: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NewsItem {
    pub title: String,
    pub version: String,
    pub kind: String,
    pub image: String,
    pub date: Option<String>,
    pub summary: Option<String>,
    pub url: String,
}

#[command]
pub async fn mc_news(http: State<'_, HttpClient>) -> CmdResult<Vec<NewsItem>> {
    let notes: PatchNotes = http
        .get_json("https://launchercontent.mojang.com/v2/javaPatchNotes.json")
        .await
        .map_err(err)?;
    Ok(notes
        .entries
        .into_iter()
        .take(10)
        .map(|e| NewsItem {
            url: format!(
                "https://www.minecraft.net/ru-ru/article/minecraft-java-edition-{}",
                e.version.replace('.', "-")
            ),
            image: format!("https://launchercontent.mojang.com{}", e.image.url),
            title: e.title,
            version: e.version,
            kind: e.kind,
            date: e.date,
            summary: e.short_text,
        })
        .collect())
}

// ---------- Модпаки ----------

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PackProgressEvent {
    label: String,
    done: u64,
    total: u64,
}

fn emit_pack(app: &AppHandle, label: &str, done: u64, total: u64) {
    let _ = app.emit("modpack-progress", PackProgressEvent { label: label.into(), done, total });
}

/// Установить модпак с Modrinth как новую сборку
#[command]
pub async fn modpack_install(
    app: AppHandle,
    http: State<'_, HttpClient>,
    project_id: String,
    accent: Option<String>,
    memory_mb: Option<u32>,
) -> CmdResult<Instance> {
    let progress = |label: &str, done: u64, total: u64| emit_pack(&app, label, done, total);
    progress("Скачиваем модпак", 0, 1);
    let (file, _title) = mrpack::download_from_modrinth(&http, &project_id).await.map_err(err)?;
    let result = mrpack::install_mrpack(&http, &file, accent, memory_mb.unwrap_or(6144), &progress).await;
    let _ = tokio::fs::remove_file(&file).await;
    result.map_err(err)
}

/// Выбрать .mrpack на диске и установить
#[command]
pub async fn mrpack_import(
    app: AppHandle,
    http: State<'_, HttpClient>,
    accent: Option<String>,
    memory_mb: Option<u32>,
) -> CmdResult<Option<Instance>> {
    let picked = app
        .dialog()
        .file()
        .set_title("Выберите модпак")
        .add_filter("Модпак Modrinth", &["mrpack"])
        .blocking_pick_file();
    let Some(picked) = picked else { return Ok(None) };
    let path = picked.into_path().map_err(|e| e.to_string())?;
    let progress = |label: &str, done: u64, total: u64| emit_pack(&app, label, done, total);
    mrpack::install_mrpack(&http, &path, accent, memory_mb.unwrap_or(6144), &progress)
        .await
        .map(Some)
        .map_err(err)
}

// ---------- Импорт из других лаунчеров ----------

use crate::engine::profiles::{export, imports, store};

/// Выбрать папку сборки другого лаунчера, перенести её как новую сборку
#[command]
pub async fn import_instance(
    app: AppHandle,
    http: State<'_, HttpClient>,
    accent: Option<String>,
    memory_mb: Option<u32>,
) -> CmdResult<Option<Instance>> {
    let picked = app
        .dialog()
        .file()
        .set_title("Папка сборки Prism, MultiMC, CurseForge или .minecraft")
        .blocking_pick_folder();
    let Some(picked) = picked else { return Ok(None) };
    let dir = picked.into_path().map_err(|e| e.to_string())?;
    let detected = imports::detect(&dir).map_err(err)?;

    // Версию не удалось определить (например, профиль «последний релиз») — берём последний релиз
    let game_version = match &detected.game_version {
        Some(v) => v.clone(),
        None => crate::engine::game::manifest::fetch_version_list(&http)
            .await
            .map_err(err)?
            .latest
            .release,
    };

    emit_pack(&app, &format!("Переносим из {}", detected.source_label), 0, 1);
    let app2 = app.clone();
    let inst = tokio::task::spawn_blocking(move || {
        let progress = |done: u64, total: u64| emit_pack(&app2, "Копируем файлы", done, total);
        imports::import(&detected, &game_version, memory_mb.unwrap_or(4096), accent, &progress)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(err)?;
    Ok(Some(inst))
}

/// Экспорт сборки в .mrpack (диалог сохранения)
#[command]
pub async fn export_instance(app: AppHandle, http: State<'_, HttpClient>, id: String) -> CmdResult<Option<String>> {
    let inst = store::get(&id).map_err(err)?;
    let safe: String = inst
        .name
        .chars()
        .map(|c| if c.is_alphanumeric() || c == ' ' || c == '-' { c } else { '_' })
        .collect();
    let picked = app
        .dialog()
        .file()
        .set_title("Сохранить модпак")
        .set_file_name(format!("{}.mrpack", safe.trim()))
        .add_filter("Модпак Modrinth", &["mrpack"])
        .blocking_save_file();
    let Some(picked) = picked else { return Ok(None) };
    let dest = picked.into_path().map_err(|e| e.to_string())?;
    let progress = |label: &str, done: u64, total: u64| emit_pack(&app, label, done, total);
    export::export_mrpack(&http, &inst, &dest, &progress).await.map_err(err)?;
    Ok(Some(dest.to_string_lossy().into_owned()))
}

// ---------- Обложки ----------

#[command]
pub async fn instance_set_cover(app: AppHandle, id: String) -> CmdResult<Option<Instance>> {
    let picked = app
        .dialog()
        .file()
        .set_title("Картинка для обложки")
        .add_filter("Изображения", &["png", "jpg", "jpeg", "webp", "gif"])
        .blocking_pick_file();
    let Some(picked) = picked else { return Ok(None) };
    let path = picked.into_path().map_err(|e| e.to_string())?;
    store::set_cover(&id, &path).map(Some).map_err(err)
}

#[command]
pub async fn instance_clear_cover(id: String) -> CmdResult<Instance> {
    store::clear_cover(&id).map_err(err)
}
