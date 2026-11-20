//! Автообновление через GitHub Releases.
//!
//! Включено только в сборках из CI: там при сборке задаётся `HYTPOTCHI_UPDATER=1`,
//! а в конфиг добавляются публичный ключ подписи и адрес `latest.json`.
//! Каждое обновление проверяется подписью minisign — подменить его нельзя.

use serde::Serialize;
use tauri::{AppHandle, command};
use tauri_plugin_updater::UpdaterExt;

/// Есть ли в этой сборке автообновление
pub fn enabled() -> bool {
    option_env!("HYTPOTCHI_UPDATER").is_some_and(|v| !v.is_empty() && v != "0")
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    /// Автообновление поддерживается этой сборкой
    pub supported: bool,
    pub current_version: String,
    /// Новая версия, если есть
    pub version: Option<String>,
    pub notes: Option<String>,
}

#[command]
pub async fn update_check(app: AppHandle) -> Result<UpdateInfo, String> {
    let current_version = app.package_info().version.to_string();
    if !enabled() {
        return Ok(UpdateInfo { supported: false, current_version, version: None, notes: None });
    }
    let update = app
        .updater()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| format!("Не удалось проверить обновления: {e}"))?;
    Ok(UpdateInfo {
        supported: true,
        current_version,
        version: update.as_ref().map(|u| u.version.clone()),
        notes: update.and_then(|u| u.body),
    })
}

/// Скачать, проверить подпись, установить и перезапустить лаунчер
#[command]
pub async fn update_install(app: AppHandle) -> Result<(), String> {
    if !enabled() {
        return Err("Автообновление недоступно в этой сборке".into());
    }
    let update = app
        .updater()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| e.to_string())?
        .ok_or("Обновлений нет")?;
    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(|e| format!("Не удалось установить обновление: {e}"))?;
    app.restart();
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeaturesStatus {
    pub version: String,
    pub microsoft: bool,
    pub skin_server: bool,
    pub discord: bool,
    pub updater: bool,
}

/// Какие внешние сервисы настроены в этой сборке (для интерфейса)
#[command]
pub async fn features_status(app: AppHandle) -> Result<FeaturesStatus, String> {
    Ok(FeaturesStatus {
        version: app.package_info().version.to_string(),
        microsoft: crate::engine::accounts::microsoft::client_id().is_ok(),
        skin_server: crate::engine::core::settings::skin_server().is_some(),
        discord: crate::engine::game::now_playing::discord::available(),
        updater: enabled(),
    })
}
