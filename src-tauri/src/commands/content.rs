//! Контент: поиск и установка с Modrinth, управление модами сборки

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use tauri::{State, command};

use crate::engine::core::http::{HttpClient, VerifiedDownload};
use crate::engine::core::paths::{
    instance_mods_dir, instance_path, instance_resourcepacks_dir, instance_shaderpacks_dir,
};
use crate::engine::core::safepath::safe_file_name;
use crate::engine::profiles::store::{self, Instance};

const API: &str = "https://api.modrinth.com/v2";

type CmdResult<T> = Result<T, String>;

fn err(e: anyhow::Error) -> String {
    format!("{e:#}")
}

/// Поиск проектов. `project_type`: mod | modpack | resourcepack | shader
#[command]
pub async fn modrinth_search(
    http: State<'_, HttpClient>,
    query: String,
    project_type: Option<String>,
    game_version: Option<String>,
    loader: Option<String>,
    sort: Option<String>,
    offset: Option<u32>,
    limit: Option<u32>,
) -> CmdResult<serde_json::Value> {
    let mut facets: Vec<Vec<String>> = vec![vec![format!(
        "project_type:{}",
        project_type.as_deref().unwrap_or("mod")
    )]];
    if let Some(v) = game_version.filter(|v| !v.is_empty()) {
        facets.push(vec![format!("versions:{v}")]);
    }
    if let Some(l) = loader.filter(|l| !l.is_empty()) {
        // Quilt запускает и Fabric-моды
        if l == "quilt" {
            facets.push(vec!["categories:quilt".into(), "categories:fabric".into()]);
        } else {
            facets.push(vec![format!("categories:{l}")]);
        }
    }
    let url = format!(
        "{API}/search?query={}&facets={}&index={}&offset={}&limit={}",
        urlencoding::encode(&query),
        urlencoding::encode(&serde_json::to_string(&facets).unwrap()),
        sort.as_deref().unwrap_or("relevance"),
        offset.unwrap_or(0),
        limit.unwrap_or(20).min(100)
    );
    http.get_json(&url).await.map_err(err)
}

#[command]
pub async fn modrinth_project(http: State<'_, HttpClient>, project_id: String) -> CmdResult<serde_json::Value> {
    let url = format!("{API}/project/{}", urlencoding::encode(&project_id));
    http.get_json(&url).await.map_err(err)
}

// ---------- Установка ----------

#[derive(Deserialize, Clone)]
struct MrVersion {
    id: String,
    project_id: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    version_number: String,
    /// release | beta | alpha
    #[serde(default)]
    version_type: String,
    #[serde(default)]
    date_published: String,
    files: Vec<MrFile>,
    #[serde(default)]
    dependencies: Vec<MrDependency>,
}

#[derive(Deserialize, Clone)]
struct MrFile {
    url: String,
    filename: String,
    #[serde(default)]
    primary: bool,
    size: u64,
    hashes: HashMap<String, String>,
}

#[derive(Deserialize, Clone)]
struct MrDependency {
    #[serde(default)]
    project_id: Option<String>,
    #[serde(default)]
    version_id: Option<String>,
    dependency_type: String,
}

#[derive(Deserialize)]
struct MrProject {
    title: String,
    project_type: String,
    #[serde(default)]
    icon_url: Option<String>,
}

/// Что установлено с Modrinth (для удаления, смены версий, зависимостей)
#[derive(Default, Serialize, Deserialize)]
struct ModIndex {
    entries: HashMap<String, IndexEntry>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct IndexEntry {
    project_id: String,
    title: String,
    filename: String,
    kind: String,
    #[serde(default)]
    icon_url: Option<String>,
    #[serde(default)]
    version_id: Option<String>,
    #[serde(default)]
    version_number: Option<String>,
    #[serde(default)]
    version_type: Option<String>,
}

fn index_path(instance_id: &str) -> Result<PathBuf> {
    Ok(instance_path(instance_id)?.join("content.json"))
}

fn load_index(instance_id: &str) -> ModIndex {
    index_path(instance_id)
        .ok()
        .and_then(|p| std::fs::read(p).ok())
        .and_then(|d| serde_json::from_slice(&d).ok())
        .unwrap_or_default()
}

fn save_index(instance_id: &str, index: &ModIndex) -> Result<()> {
    std::fs::write(index_path(instance_id)?, serde_json::to_vec_pretty(index)?)?;
    Ok(())
}

fn content_dir(instance_id: &str, kind: &str) -> Result<PathBuf> {
    match kind {
        "resourcepack" => instance_resourcepacks_dir(instance_id),
        "shader" => instance_shaderpacks_dir(instance_id),
        _ => instance_mods_dir(instance_id),
    }
}

fn loaders_for(instance: &Instance, kind: &str) -> Result<Vec<String>> {
    Ok(match kind {
        "mod" => match instance.loader.as_deref() {
            Some("quilt") => vec!["quilt".into(), "fabric".into()],
            Some(l) => vec![l.to_string()],
            None => bail!("Для модов нужен загрузчик — создайте сборку с Fabric, Forge, NeoForge или Quilt"),
        },
        "shader" => vec!["iris".into(), "optifine".into(), "canvas".into()],
        "resourcepack" => vec!["minecraft".into()],
        "modpack" => bail!("Модпак ставится как отдельная сборка — вкладка «Модпаки» в каталоге"),
        other => bail!("Неподдерживаемый тип: {other}"),
    })
}

/// Все версии проекта, совместимые со сборкой (новые первыми)
async fn compatible_versions(
    http: &HttpClient,
    project_id: &str,
    instance: &Instance,
    loaders: &[String],
) -> Result<Vec<MrVersion>> {
    let url = format!(
        "{API}/project/{}/version?loaders={}&game_versions={}",
        urlencoding::encode(project_id),
        urlencoding::encode(&serde_json::to_string(loaders)?),
        urlencoding::encode(&serde_json::to_string(&[&instance.game_version])?)
    );
    http.get_json(&url).await
}

/// Лучшая версия: самая новая стабильная, бета — только если релизов нет
fn pick_best(versions: &[MrVersion]) -> Option<&MrVersion> {
    ["release", "beta", "alpha"]
        .iter()
        .find_map(|t| versions.iter().find(|v| v.version_type == *t))
        .or_else(|| versions.first())
}

async fn fetch_version(http: &HttpClient, version_id: &str) -> Result<MrVersion> {
    http.get_json(&format!("{API}/version/{}", urlencoding::encode(version_id)))
        .await
}

/// Поставить конкретную версию (заменяя прежний файл проекта) и её зависимости
async fn install_version(
    http: &HttpClient,
    instance: &Instance,
    index: &mut ModIndex,
    version: MrVersion,
    depth: u8,
) -> Result<Vec<String>> {
    let project: MrProject = http
        .get_json(&format!("{API}/project/{}", urlencoding::encode(&version.project_id)))
        .await?;
    let kind = project.project_type.clone();

    let file = version
        .files
        .iter()
        .find(|f| f.primary)
        .or_else(|| version.files.first())
        .context("У версии нет файлов")?;
    let filename = safe_file_name(&file.filename)?;
    let dir = content_dir(&instance.id, &kind)?;
    let mut expected = VerifiedDownload::new().with_size(file.size);
    if let Some(sha1) = file.hashes.get("sha1") {
        expected = expected.with_sha1(sha1);
    }
    http.download_verified(&file.url, &dir.join(&filename), expected).await?;

    // Старый файл этого же проекта убираем, чтобы не было дубликатов
    if let Some(old) = index.entries.get(&version.project_id) {
        if old.filename != filename {
            let old_dir = content_dir(&instance.id, &old.kind)?;
            let _ = std::fs::remove_file(old_dir.join(&old.filename));
            let _ = std::fs::remove_file(old_dir.join(format!("{}.disabled", old.filename)));
        }
    }

    index.entries.insert(
        version.project_id.clone(),
        IndexEntry {
            project_id: version.project_id.clone(),
            title: project.title.clone(),
            filename,
            kind,
            icon_url: project.icon_url,
            version_id: Some(version.id.clone()),
            version_number: Some(version.version_number.clone()),
            version_type: Some(version.version_type.clone()),
        },
    );
    let mut installed = vec![project.title];

    // Обязательные зависимости: если указана точная версия — ставим именно её
    if depth < 4 {
        for dep in version.dependencies.iter().filter(|d| d.dependency_type == "required") {
            let result = async {
                match (&dep.version_id, &dep.project_id) {
                    (Some(vid), _) => {
                        let v = fetch_version(http, vid).await?;
                        let same = index.entries.get(&v.project_id).and_then(|e| e.version_id.clone());
                        if same.as_deref() == Some(vid.as_str()) {
                            return Ok(vec![]);
                        }
                        Box::pin(install_version(http, instance, index, v, depth + 1)).await
                    }
                    (None, Some(pid)) => {
                        if index.entries.contains_key(pid) {
                            return Ok(vec![]);
                        }
                        Box::pin(install_project(http, instance, index, pid, depth + 1)).await
                    }
                    _ => Ok(vec![]),
                }
            }
            .await;
            match result {
                Ok(names) => installed.extend(names),
                Err(e) => log::warn!("Зависимость: {e:#}"),
            }
        }
    }
    Ok(installed)
}

async fn install_project(
    http: &HttpClient,
    instance: &Instance,
    index: &mut ModIndex,
    project_id: &str,
    depth: u8,
) -> Result<Vec<String>> {
    if index.entries.contains_key(project_id) {
        return Ok(vec![]);
    }
    let project: MrProject = http
        .get_json(&format!("{API}/project/{}", urlencoding::encode(project_id)))
        .await?;
    let loaders = loaders_for(instance, &project.project_type)?;
    let versions = compatible_versions(http, project_id, instance, &loaders).await?;
    let version = pick_best(&versions)
        .cloned()
        .with_context(|| format!("{}: нет версии для Minecraft {}", project.title, instance.game_version))?;
    install_version(http, instance, index, version, depth).await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallResult {
    pub installed: Vec<String>,
}

/// Установить проект Modrinth в сборку (стабильная совместимая версия + зависимости)
#[command]
pub async fn modrinth_install(
    http: State<'_, HttpClient>,
    project_id: String,
    instance_id: String,
) -> CmdResult<InstallResult> {
    let instance = store::get(&instance_id).map_err(err)?;
    let mut index = load_index(&instance_id);
    let installed = install_project(&http, &instance, &mut index, &project_id, 0)
        .await
        .map_err(err)?;
    save_index(&instance_id, &index).map_err(err)?;
    Ok(InstallResult { installed })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionChoice {
    pub id: String,
    pub name: String,
    pub number: String,
    pub version_type: String,
    pub date: String,
    pub current: bool,
    pub recommended: bool,
}

/// Совместимые версии мода — для ручного выбора (откат беты, обновление)
#[command]
pub async fn modrinth_versions(
    http: State<'_, HttpClient>,
    project_id: String,
    instance_id: String,
) -> CmdResult<Vec<VersionChoice>> {
    let instance = store::get(&instance_id).map_err(err)?;
    let index = load_index(&instance_id);
    let current = index.entries.get(&project_id).and_then(|e| e.version_id.clone());
    let kind = index
        .entries
        .get(&project_id)
        .map(|e| e.kind.clone())
        .unwrap_or_else(|| "mod".into());
    let loaders = loaders_for(&instance, &kind).map_err(err)?;
    let versions = compatible_versions(&http, &project_id, &instance, &loaders)
        .await
        .map_err(err)?;
    let best = pick_best(&versions).map(|v| v.id.clone());
    Ok(versions
        .into_iter()
        .take(40)
        .map(|v| VersionChoice {
            current: current.as_deref() == Some(v.id.as_str()),
            recommended: best.as_deref() == Some(v.id.as_str()),
            id: v.id,
            name: v.name,
            number: v.version_number,
            version_type: v.version_type,
            date: v.date_published,
        })
        .collect())
}

/// Поставить выбранную версию мода вместо текущей
#[command]
pub async fn modrinth_install_version(
    http: State<'_, HttpClient>,
    version_id: String,
    instance_id: String,
) -> CmdResult<InstallResult> {
    let instance = store::get(&instance_id).map_err(err)?;
    let mut index = load_index(&instance_id);
    let version = fetch_version(&http, &version_id).await.map_err(err)?;
    let installed = install_version(&http, &instance, &mut index, version, 0)
        .await
        .map_err(err)?;
    save_index(&instance_id, &index).map_err(err)?;
    Ok(InstallResult { installed })
}

// ---------- Локальные файлы ----------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalContent {
    pub filename: String,
    pub title: String,
    pub enabled: bool,
    pub size: u64,
    pub kind: String,
    pub project_id: Option<String>,
    pub icon_url: Option<String>,
    pub version_number: Option<String>,
    pub version_type: Option<String>,
}

fn scan_dir(dir: &Path, kind: &str, by_file: &HashMap<String, IndexEntry>, out: &mut Vec<LocalContent>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let Ok(meta) = entry.metadata() else { continue };
        if !meta.is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        let enabled = !name.ends_with(".disabled");
        let base = name.trim_end_matches(".disabled").to_string();
        let valid = base.ends_with(".jar") || base.ends_with(".zip");
        if !valid {
            continue;
        }
        let known = by_file.get(&base);
        out.push(LocalContent {
            title: known.map(|k| k.title.clone()).unwrap_or_else(|| {
                base.trim_end_matches(".jar").trim_end_matches(".zip").to_string()
            }),
            project_id: known.map(|k| k.project_id.clone()),
            icon_url: known.and_then(|k| k.icon_url.clone()),
            version_number: known.and_then(|k| k.version_number.clone()),
            version_type: known.and_then(|k| k.version_type.clone()),
            filename: name,
            enabled,
            size: meta.len(),
            kind: kind.to_string(),
        });
    }
}

#[command]
pub async fn local_mods_scan(instance_id: String) -> CmdResult<Vec<LocalContent>> {
    let index = load_index(&instance_id);
    let by_file: HashMap<String, IndexEntry> = index
        .entries
        .values()
        .map(|e| (e.filename.clone(), e.clone()))
        .collect();
    let mut out = Vec::new();
    for kind in ["mod", "resourcepack", "shader"] {
        let dir = content_dir(&instance_id, kind).map_err(err)?;
        scan_dir(&dir, kind, &by_file, &mut out);
    }
    out.sort_by_key(|c| c.title.to_lowercase());
    Ok(out)
}

fn content_file(instance_id: &str, kind: &str, filename: &str) -> Result<PathBuf> {
    let safe = safe_file_name(filename)?;
    if safe != filename {
        bail!("Недопустимое имя файла");
    }
    Ok(content_dir(instance_id, kind)?.join(safe))
}

#[command]
pub async fn mod_toggle(
    instance_id: String,
    kind: String,
    filename: String,
    enabled: bool,
) -> CmdResult<String> {
    let path = content_file(&instance_id, &kind, &filename).map_err(err)?;
    let base = filename.trim_end_matches(".disabled");
    let new_name = if enabled { base.to_string() } else { format!("{base}.disabled") };
    if new_name != filename {
        std::fs::rename(&path, path.with_file_name(&new_name)).map_err(|e| e.to_string())?;
    }
    Ok(new_name)
}

#[command]
pub async fn mod_remove(instance_id: String, kind: String, filename: String) -> CmdResult<()> {
    let path = content_file(&instance_id, &kind, &filename).map_err(err)?;
    std::fs::remove_file(&path).map_err(|e| e.to_string())?;
    let base = filename.trim_end_matches(".disabled");
    let mut index = load_index(&instance_id);
    index.entries.retain(|_, e| e.filename != base);
    save_index(&instance_id, &index).map_err(err)
}

// ---------- Обновления ----------

/// Опознать по SHA-1 файлы, поставленные не через лаунчер, и добавить их в индекс
async fn identify_unknown(http: &HttpClient, instance_id: &str, index: &mut ModIndex) -> Result<()> {
    let known: std::collections::HashSet<String> = index.entries.values().map(|e| e.filename.clone()).collect();
    let mut files: Vec<(String, String, String)> = Vec::new(); // (sha1, filename, kind)
    for kind in ["mod", "resourcepack", "shader"] {
        let dir = content_dir(instance_id, kind)?;
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            let base = name.trim_end_matches(".disabled").to_string();
            if !(base.ends_with(".jar") || base.ends_with(".zip")) || known.contains(&base) {
                continue;
            }
            let sha1 = crate::engine::core::http::file_sha1(&entry.path()).await?;
            files.push((sha1, base, kind.to_string()));
        }
    }
    if files.is_empty() {
        return Ok(());
    }

    let hashes: Vec<&str> = files.iter().map(|f| f.0.as_str()).collect();
    let found: HashMap<String, MrVersion> = http
        .client
        .post(http.route_url(&format!("{API}/version_files")))
        .json(&serde_json::json!({ "hashes": hashes, "algorithm": "sha1" }))
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    if found.is_empty() {
        return Ok(());
    }

    #[derive(Deserialize)]
    struct Proj {
        id: String,
        title: String,
        #[serde(default)]
        icon_url: Option<String>,
    }
    let ids: Vec<&str> = found.values().map(|v| v.project_id.as_str()).collect();
    let projects: Vec<Proj> = http
        .get_json(&format!(
            "{API}/projects?ids={}",
            urlencoding::encode(&serde_json::to_string(&ids)?)
        ))
        .await?;
    let by_id: HashMap<&str, &Proj> = projects.iter().map(|p| (p.id.as_str(), p)).collect();

    for (sha1, filename, kind) in files {
        let Some(v) = found.get(&sha1) else { continue };
        let Some(p) = by_id.get(v.project_id.as_str()) else { continue };
        index.entries.entry(v.project_id.clone()).or_insert(IndexEntry {
            project_id: v.project_id.clone(),
            title: p.title.clone(),
            filename,
            kind,
            icon_url: p.icon_url.clone(),
            version_id: Some(v.id.clone()),
            version_number: Some(v.version_number.clone()),
            version_type: Some(v.version_type.clone()),
        });
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub project_id: String,
    pub title: String,
    pub current: Option<String>,
    pub latest: String,
    pub version_id: String,
    pub version_type: String,
}

/// Найти обновления всех модов/ресурспаков/шейдеров сборки
#[command]
pub async fn content_check_updates(
    http: State<'_, HttpClient>,
    instance_id: String,
) -> CmdResult<Vec<UpdateInfo>> {
    let instance = store::get(&instance_id).map_err(err)?;
    let mut index = load_index(&instance_id);
    if let Err(e) = identify_unknown(&http, &instance_id, &mut index).await {
        log::warn!("Не удалось опознать файлы: {e:#}");
    }
    save_index(&instance_id, &index).map_err(err)?;

    let entries: Vec<IndexEntry> = index.entries.values().cloned().collect();
    let mut updates = Vec::new();
    for chunk in entries.chunks(8) {
        let checks = chunk.iter().map(|e| {
            let http = http.inner().clone();
            let instance = instance.clone();
            let e = e.clone();
            async move {
                let loaders = loaders_for(&instance, &e.kind).ok()?;
                let versions = compatible_versions(&http, &e.project_id, &instance, &loaders).await.ok()?;
                let best = pick_best(&versions)?.clone();
                // Не предлагаем менять стабильную версию на бету
                let current_stable = e.version_type.as_deref() == Some("release");
                if best.id == e.version_id.clone().unwrap_or_default()
                    || (current_stable && best.version_type != "release")
                {
                    return None;
                }
                Some(UpdateInfo {
                    project_id: e.project_id,
                    title: e.title,
                    current: e.version_number,
                    latest: best.version_number,
                    version_id: best.id,
                    version_type: best.version_type,
                })
            }
        });
        updates.extend(futures::future::join_all(checks).await.into_iter().flatten());
    }
    updates.sort_by_key(|u| u.title.to_lowercase());
    Ok(updates)
}

/// Поставить проект в сборку, если его там ещё нет (используется лаунчером, например для CustomSkinLoader)
pub async fn ensure_project(http: &HttpClient, instance: &Instance, project_id: &str) -> Result<bool> {
    let mut index = load_index(&instance.id);
    if index.entries.contains_key(project_id) {
        return Ok(false);
    }
    let installed = install_project(http, instance, &mut index, project_id, 0).await?;
    save_index(&instance.id, &index)?;
    Ok(!installed.is_empty())
}
