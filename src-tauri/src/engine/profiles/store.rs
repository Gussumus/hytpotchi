//! Сборки (instances): instance.json в каталоге каждой сборки

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};

use crate::engine::core::paths::{instance_game_dir, instance_path, instances_dir};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Instance {
    pub id: String,
    pub name: String,
    /// Версия Minecraft, например "1.21.4"
    pub game_version: String,
    /// "fabric" | "quilt" | None (ванилла)
    #[serde(default)]
    pub loader: Option<String>,
    #[serde(default)]
    pub loader_version: Option<String>,
    /// Версию загрузчика выбрал игрок — лаунчер её сам не меняет
    #[serde(default)]
    pub loader_pinned: bool,
    /// Установленный id версии для запуска (профиль загрузчика)
    #[serde(default)]
    pub version_id: Option<String>,
    pub memory_mb: u32,
    #[serde(default)]
    pub jvm_args: String,
    /// Цвет обложки (hex)
    #[serde(default)]
    pub accent: Option<String>,
    pub created_at: String,
    #[serde(default)]
    pub last_played: Option<String>,
    #[serde(default)]
    pub playtime_secs: u64,
    /// Группа в библиотеке (None — без группы)
    #[serde(default)]
    pub group: Option<String>,
    /// Имя файла своей обложки в каталоге сборки (cover.png / cover.jpg)
    #[serde(default)]
    pub cover: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstancePatch {
    pub name: Option<String>,
    pub memory_mb: Option<u32>,
    pub jvm_args: Option<String>,
    pub accent: Option<String>,
    /// Пустая строка — убрать из группы
    pub group: Option<String>,
    /// Версия загрузчика; пустая строка — подбирать самому (рекомендуемую)
    pub loader_version: Option<String>,
}

fn config_path(id: &str) -> Result<std::path::PathBuf> {
    Ok(instance_path(id)?.join("instance.json"))
}

pub fn list() -> Result<Vec<Instance>> {
    let dir = instances_dir()?;
    let mut items = Vec::new();
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path().join("instance.json");
            match std::fs::read(&path).map(|d| serde_json::from_slice::<Instance>(&d)) {
                Ok(Ok(inst)) => items.push(inst),
                Ok(Err(e)) => log::warn!("Пропускаю {}: {e}", path.display()),
                Err(_) => {}
            }
        }
    }
    // Последние запущенные — первыми, потом по дате создания
    items.sort_by(|a, b| {
        b.last_played
            .cmp(&a.last_played)
            .then_with(|| b.created_at.cmp(&a.created_at))
    });
    Ok(items)
}

pub fn get(id: &str) -> Result<Instance> {
    let data = std::fs::read(config_path(id)?).context("Сборка не найдена")?;
    Ok(serde_json::from_slice(&data)?)
}

pub fn save(instance: &Instance) -> Result<()> {
    let path = config_path(&instance.id)?;
    std::fs::create_dir_all(path.parent().unwrap())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(instance)?)?;
    std::fs::rename(tmp, path)?;
    Ok(())
}

fn clean_name(name: &str) -> Result<String> {
    let name = name.trim();
    if name.is_empty() {
        bail!("Введите название сборки");
    }
    if name.chars().count() > 48 {
        bail!("Название длиннее 48 символов");
    }
    Ok(name.to_string())
}

pub fn create(
    name: &str,
    game_version: &str,
    loader: Option<String>,
    memory_mb: u32,
    accent: Option<String>,
) -> Result<Instance> {
    let loader = loader.filter(|l| !l.is_empty() && l != "vanilla");
    let instance = Instance {
        id: uuid::Uuid::new_v4().to_string(),
        name: clean_name(name)?,
        game_version: game_version.to_string(),
        loader,
        loader_version: None,
        loader_pinned: false,
        version_id: None,
        memory_mb: memory_mb.clamp(1024, 65536),
        jvm_args: String::new(),
        accent,
        created_at: chrono::Utc::now().to_rfc3339(),
        last_played: None,
        playtime_secs: 0,
        group: None,
        cover: None,
    };
    std::fs::create_dir_all(instance_game_dir(&instance.id)?)?;
    save(&instance)?;
    Ok(instance)
}

pub fn update(id: &str, patch: InstancePatch) -> Result<Instance> {
    let mut inst = get(id)?;
    if let Some(name) = patch.name {
        inst.name = clean_name(&name)?;
    }
    if let Some(mem) = patch.memory_mb {
        inst.memory_mb = mem.clamp(1024, 65536);
    }
    if let Some(args) = patch.jvm_args {
        inst.jvm_args = args;
    }
    if let Some(accent) = patch.accent {
        inst.accent = Some(accent);
    }
    if let Some(group) = patch.group {
        let group = group.trim().chars().take(32).collect::<String>();
        inst.group = (!group.is_empty()).then_some(group);
    }
    if let Some(version) = patch.loader_version {
        choose_loader_version(&mut inst, &version)?;
    }
    save(&inst)?;
    Ok(inst)
}

/// Выбрать версию загрузчика ("" — рекомендуемую). Загрузчик переустановится при запуске.
pub fn choose_loader_version(inst: &mut Instance, version: &str) -> Result<()> {
    let version = version.trim();
    if inst.loader.is_none() {
        bail!("В ванильной сборке нет загрузчика");
    }
    if !version.is_empty() && !crate::engine::game::loaders::valid_loader_version(version) {
        bail!("Неверная версия загрузчика");
    }
    let chosen = (!version.is_empty()).then(|| version.to_string());
    let unchanged = match &chosen {
        Some(v) => inst.loader_pinned && inst.loader_version.as_ref() == Some(v),
        None => !inst.loader_pinned,
    };
    if !unchanged {
        inst.loader_pinned = chosen.is_some();
        inst.loader_version = chosen;
        inst.version_id = None;
    }
    Ok(())
}

/// Поставить свою обложку (копируется в каталог сборки)
pub fn set_cover(id: &str, source: &std::path::Path) -> Result<Instance> {
    let ext = source
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_lowercase)
        .filter(|e| matches!(e.as_str(), "png" | "jpg" | "jpeg" | "webp" | "gif"))
        .context("Подходят PNG, JPG, WEBP или GIF")?;
    let size = std::fs::metadata(source)?.len();
    if size > 10 * 1024 * 1024 {
        bail!("Картинка больше 10 МБ");
    }
    let mut inst = get(id)?;
    let dir = instance_path(id)?;
    if let Some(old) = &inst.cover {
        let _ = std::fs::remove_file(dir.join(old));
    }
    // Новое имя каждый раз — чтобы WebView не показывал старую картинку из кеша
    let name = format!("cover-{}.{ext}", chrono::Utc::now().timestamp());
    std::fs::copy(source, dir.join(&name))?;
    inst.cover = Some(name);
    save(&inst)?;
    Ok(inst)
}

pub fn clear_cover(id: &str) -> Result<Instance> {
    let mut inst = get(id)?;
    if let Some(old) = inst.cover.take() {
        let _ = std::fs::remove_file(instance_path(id)?.join(old));
    }
    save(&inst)?;
    Ok(inst)
}

/// Полный путь к обложке (для asset-протокола)
pub fn cover_path(inst: &Instance) -> Option<String> {
    let name = inst.cover.as_ref()?;
    Some(instance_path(&inst.id).ok()?.join(name).to_string_lossy().into_owned())
}

pub fn remove(id: &str) -> Result<()> {
    let dir = instance_path(id)?;
    if dir.exists() {
        std::fs::remove_dir_all(dir).context("Не удалось удалить папку сборки (файлы заняты?)")?;
    }
    Ok(())
}
