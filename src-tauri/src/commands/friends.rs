//! Друзья: статусы, заявки, приглашения в игру (см. engine::friends)

use std::sync::Arc;

use serde_json::json;
use tauri::{AppHandle, State, command};

use crate::engine::core::settings;
use crate::engine::friends::{FriendsService, FriendsState};

type CmdResult<T> = Result<T, String>;

fn err(e: anyhow::Error) -> String {
    format!("{e:#}")
}

#[command]
pub async fn friends_state(svc: State<'_, Arc<FriendsService>>) -> CmdResult<FriendsState> {
    Ok(svc.state())
}

/// Синхронизироваться сейчас
#[command]
pub async fn friends_refresh(app: AppHandle, svc: State<'_, Arc<FriendsService>>) -> CmdResult<FriendsState> {
    Ok(svc.sync(&app).await)
}

#[command]
pub async fn friends_settings(
    app: AppHandle,
    svc: State<'_, Arc<FriendsService>>,
    enabled: Option<bool>,
    status: Option<String>,
    hosting: Option<bool>,
) -> CmdResult<FriendsState> {
    let mut cfg = settings::load();
    let was_enabled = cfg.friends;
    if let Some(e) = enabled {
        cfg.friends = e;
    }
    if let Some(s) = status {
        if !matches!(s.as_str(), "online" | "busy" | "invisible") {
            return Err("Неизвестный статус".into());
        }
        cfg.friends_status = s;
    }
    if let Some(h) = hosting {
        cfg.friends_hosting = h;
    }
    settings::save(&cfg).map_err(err)?;
    // Выключили друзей — сразу пропадаем из сети у остальных
    if was_enabled && !cfg.friends {
        svc.go_offline(&app).await;
    }
    Ok(svc.sync(&app).await)
}

#[command]
pub async fn friends_request(app: AppHandle, svc: State<'_, Arc<FriendsService>>, nick: String) -> CmdResult<FriendsState> {
    svc.action(&app, "request", json!({ "nick": nick.trim() })).await.map_err(err)
}

/// Зайти в мир друга через туннель лаунчера. Возвращает адрес для игры (127.0.0.1:порт).
#[command]
pub async fn friends_join(app: AppHandle, svc: State<'_, Arc<FriendsService>>, id: String) -> CmdResult<String> {
    svc.join(&app, &id).await.map_err(err)
}

#[command]
pub async fn friends_respond(
    app: AppHandle,
    svc: State<'_, Arc<FriendsService>>,
    id: String,
    accept: bool,
) -> CmdResult<FriendsState> {
    svc.action(&app, "respond", json!({ "id": id, "accept": accept })).await.map_err(err)
}

#[command]
pub async fn friends_remove(app: AppHandle, svc: State<'_, Arc<FriendsService>>, id: String) -> CmdResult<FriendsState> {
    svc.action(&app, "remove", json!({ "id": id })).await.map_err(err)
}

/// Позвать друга в мой открытый мир (без адреса — через туннель) или на сервер по адресу
#[command]
pub async fn friends_invite(
    app: AppHandle,
    svc: State<'_, Arc<FriendsService>>,
    to: String,
    address: Option<String>,
    instance_name: Option<String>,
    mc: Option<String>,
    loader: Option<String>,
    note: Option<String>,
) -> CmdResult<FriendsState> {
    let instance = mc.map(|mc| json!({ "name": instance_name, "mc": mc, "loader": loader }));
    svc.action(
        &app,
        "invite",
        json!({ "to": to, "address": address.map(|a| a.trim().to_string()).filter(|a| !a.is_empty()), "instance": instance, "note": note }),
    )
    .await
    .map_err(err)
}

#[command]
pub async fn friends_dismiss(app: AppHandle, svc: State<'_, Arc<FriendsService>>, id: String) -> CmdResult<FriendsState> {
    svc.action(&app, "dismiss", json!({ "id": id })).await.map_err(err)
}

fn emit_pack(app: &AppHandle, job: &str, label: &str, done: u64, total: u64) {
    let _ = tauri::Emitter::emit(
        app,
        "modpack-progress",
        json!({ "label": label, "done": done, "total": total, "job": job }),
    );
}

/// Поставить ту же сборку, что у друга. Прогресс — событием modpack-progress.
#[command]
pub async fn friends_sync_pack(
    app: AppHandle,
    svc: State<'_, Arc<FriendsService>>,
    id: String,
    memory_mb: Option<u32>,
    job: Option<String>,
) -> CmdResult<crate::engine::profiles::store::Instance> {
    let job = job.unwrap_or_default();
    let progress = |label: &str, done: u64, total: u64| emit_pack(&app, &job, label, done, total);
    svc.sync_pack(&app, &id, memory_mb.unwrap_or(4096), &progress).await.map_err(err)
}

