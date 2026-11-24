//! Команды: версии, Java, сборки, запуск

use serde::Serialize;
use tauri::{AppHandle, State, command};
use tauri_plugin_opener::OpenerExt;

use crate::engine::core::http::HttpClient;
use crate::engine::core::paths::{app_dir, instance_game_dir};
use crate::engine::game::java::{self, JavaRuntime};
use crate::engine::game::loaders;
use crate::engine::game::manifest::fetch_version_list;
use crate::engine::game::now_playing::discord;
use crate::engine::game::ping::{self, ServerStatus};
use crate::engine::game::pipeline::{GameWatcher, launch_instance};
use crate::engine::game::serversdat::{self, SavedServer};
use crate::engine::profiles::store::{self, Instance, InstancePatch};

type CmdResult<T> = Result<T, String>;

fn err(e: anyhow::Error) -> String {
    format!("{e:#}")
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionView {
    pub id: String,
    #[serde(rename = "type")]
    pub version_type: String,
    pub release_time: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionsView {
    pub latest_release: String,
    pub latest_snapshot: String,
    pub versions: Vec<VersionView>,
}

#[command]
pub async fn version_list(http: State<'_, HttpClient>) -> CmdResult<VersionsView> {
    let list = fetch_version_list(&http).await.map_err(err)?;
    Ok(VersionsView {
        latest_release: list.latest.release,
        latest_snapshot: list.latest.snapshot,
        versions: list
            .versions
            .into_iter()
            .map(|v| VersionView { id: v.id, version_type: v.version_type, release_time: v.release_time })
            .collect(),
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JavaListView {
    pub managed: Vec<JavaRuntime>,
    pub system: Vec<JavaRuntime>,
}

#[command]
pub async fn java_list() -> CmdResult<JavaListView> {
    let system = tokio::task::spawn_blocking(java::detect_system)
        .await
        .map_err(|e| e.to_string())?;
    Ok(JavaListView { managed: java::list_managed(), system })
}

/// Скачать Java заранее (из настроек)
#[command]
pub async fn java_install(http: State<'_, HttpClient>, major: u32) -> CmdResult<JavaRuntime> {
    java::ensure_java(&http, major, &|_, _| {}).await.map_err(err)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemInfo {
    pub total_memory_mb: u64,
    pub recommended_memory_mb: u64,
    pub data_dir: String,
}

#[command]
pub async fn system_info() -> CmdResult<SystemInfo> {
    let mut sys = sysinfo::System::new();
    sys.refresh_memory();
    let total = sys.total_memory() / 1024 / 1024;
    // Половина ОЗУ, но в разумных рамках 2–8 ГБ
    let recommended = (total / 2).clamp(2048, 8192) / 512 * 512;
    Ok(SystemInfo {
        total_memory_mb: total,
        recommended_memory_mb: recommended,
        data_dir: app_dir().map(|p| p.display().to_string()).unwrap_or_default(),
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstanceView {
    #[serde(flatten)]
    pub instance: Instance,
    pub running: bool,
    /// Полный путь к своей обложке
    pub cover_path: Option<String>,
}

#[command]
pub async fn instance_list(watcher: State<'_, GameWatcher>) -> CmdResult<Vec<InstanceView>> {
    Ok(store::list()
        .map_err(err)?
        .into_iter()
        .map(|i| InstanceView { running: watcher.is_running(&i.id), cover_path: store::cover_path(&i), instance: i })
        .collect())
}

#[command]
pub async fn instance_create(
    name: String,
    game_version: String,
    loader: Option<String>,
    loader_version: Option<String>,
    memory_mb: Option<u32>,
    accent: Option<String>,
) -> CmdResult<Instance> {
    if let Some(v) = loader_version.as_deref().map(str::trim).filter(|v| !v.is_empty()) {
        if !loaders::valid_loader_version(v) {
            return Err("Неверная версия загрузчика".into());
        }
    }
    let mut inst = store::create(&name, &game_version, loader, memory_mb.unwrap_or(4096), accent).map_err(err)?;
    if let Some(v) = loader_version.filter(|_| inst.loader.is_some()) {
        store::choose_loader_version(&mut inst, &v).map_err(err)?;
        store::save(&inst).map_err(err)?;
    }
    Ok(inst)
}

/// Версии загрузчика (Forge, NeoForge, Fabric, Quilt) для версии игры — для выбора в интерфейсе
#[command]
pub async fn loader_versions(
    http: State<'_, HttpClient>,
    loader: String,
    game_version: String,
) -> CmdResult<Vec<loaders::LoaderVersionInfo>> {
    loaders::versions(&http, &loader, &game_version).await.map_err(err)
}

#[command]
pub async fn instance_update(id: String, patch: InstancePatch) -> CmdResult<Instance> {
    store::update(&id, patch).map_err(err)
}

#[command]
pub async fn instance_remove(watcher: State<'_, GameWatcher>, id: String) -> CmdResult<()> {
    if watcher.is_busy(&id) {
        return Err("Сначала закройте игру".into());
    }
    store::remove(&id).map_err(err)
}

#[command]
pub async fn instance_open_folder(app: AppHandle, id: String) -> CmdResult<()> {
    let dir = instance_game_dir(&id).map_err(err)?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    app.opener()
        .open_path(dir.to_string_lossy(), None::<&str>)
        .map_err(|e| e.to_string())
}

#[command]
pub async fn open_data_folder(app: AppHandle) -> CmdResult<()> {
    let dir = app_dir().map_err(err)?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    app.opener()
        .open_path(dir.to_string_lossy(), None::<&str>)
        .map_err(|e| e.to_string())
}

/// Запуск сборки. Прогресс — событие `launch-progress`, логи — `game-log`, выход — `game-exit`.
#[command]
pub async fn instance_launch(app: AppHandle, id: String, server: Option<String>) -> CmdResult<u32> {
    launch_instance(&app, &id, server.as_deref()).await.map_err(|e| {
        log::error!("Запуск {id} не удался: {e:#}");
        err(e)
    })
}

// ---------- Серверы ----------

#[command]
pub async fn saved_servers(id: String) -> CmdResult<Vec<SavedServer>> {
    let dir = instance_game_dir(&id).map_err(err)?;
    serversdat::read(&dir).map_err(err)
}

#[command]
pub async fn saved_server_add(id: String, name: String, address: String) -> CmdResult<()> {
    let dir = instance_game_dir(&id).map_err(err)?;
    serversdat::add(&dir, &name, &address).map_err(err)
}

#[command]
pub async fn saved_server_remove(id: String, address: String) -> CmdResult<()> {
    let dir = instance_game_dir(&id).map_err(err)?;
    serversdat::remove(&dir, &address).map_err(err)
}

#[command]
pub async fn server_ping(address: String) -> CmdResult<ServerStatus> {
    Ok(ping::ping(&address).await)
}

// ---------- Discord ----------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscordStatus {
    pub available: bool,
}

#[command]
pub async fn discord_status() -> CmdResult<DiscordStatus> {
    Ok(DiscordStatus { available: discord::available() })
}

#[command]
pub async fn discord_set_enabled(enabled: bool) -> CmdResult<()> {
    discord::set_enabled(enabled);
    Ok(())
}

#[command]
pub async fn instance_stop(watcher: State<'_, GameWatcher>, id: String) -> CmdResult<bool> {
    Ok(watcher.stop(&id))
}

#[command]
pub async fn game_logs(watcher: State<'_, GameWatcher>, id: String) -> CmdResult<Vec<String>> {
    Ok(watcher.logs(&id))
}
