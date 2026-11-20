//! Друзья: работают от аккаунта Hytpotchi на сервере Hytpotchi (том же, что для скинов).
//!
//! Фоновая задача раз в ~45 с (и сразу при изменениях — `poke`) отправляет на сервер
//! «что я делаю» и получает снимок: друзья, заявки, приглашения. Снимок кешируется
//! здесь и уходит в интерфейс событием `friends-update`; новые приглашения — `friends-invite`.
//!
//! Открытый мир («Открыть для сети») лаунчер сам пробрасывает друзьям через туннель
//! сервера Hytpotchi — без модов. Если стоит e4mc, друзьям отдаётся его адрес.

pub mod pack;
pub mod presence;
pub mod tunnel;

use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Result, bail};
use parking_lot::Mutex;
use serde::Serialize;
use serde_json::{Value, json};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::Notify;

use crate::engine::accounts::hytpotchi;
use crate::engine::accounts::session::{Account, AccountKind};
use crate::engine::accounts::AccountStore;
use crate::engine::core::http::HttpClient;
use crate::engine::core::settings;
use crate::engine::game::GameWatcher;
use crate::engine::profiles::store;
use crate::secrets::SecretsVault;

const SYNC_EVERY: Duration = Duration::from_secs(45);
/// Мод, который открывает мир через свой сервер (запасной вариант к туннелю лаунчера)
pub const E4MC_PROJECT: &str = "e4mc";

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FriendsState {
    /// Друзья включены в настройках
    pub enabled: bool,
    /// Есть адрес сервера Hytpotchi
    pub configured: bool,
    /// Ник аккаунта Hytpotchi, от которого работают друзья
    pub account: Option<String>,
    pub status: String,
    /// Ставить e4mc в сборки с загрузчиком
    pub hosting: bool,
    /// Последний ответ сервера (me, friends, requests, outgoing, invites)
    pub snapshot: Option<Value>,
    pub error: Option<String>,
    /// Мои открытые миры
    pub hosted: Vec<LocalHost>,
    pub syncing: bool,
    /// Хозяин мира вошёл через Microsoft — друзьям с аккаунтом Hytpotchi нужна лицензия
    pub host_online_mode: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalHost {
    pub instance_id: String,
    pub instance: String,
    pub mc: String,
    pub loader: Option<String>,
    /// Адрес e4mc или локальный адрес LAN
    pub address: String,
    pub world: Option<String>,
    /// Открыт через «Открыть для сети» без e4mc → друзья заходят через туннель лаунчера
    pub relay: bool,
    #[serde(skip)]
    pub port: Option<u16>,
    /// Сколько модов друзья получат вместе со сборкой
    pub mods: Option<usize>,
    /// Моды не с Modrinth — их друзья не получат
    pub missing: Vec<String>,
}

/// Последняя загруженная опись сборки хозяина
struct PackCache {
    instance_id: String,
    signature: String,
    hash: String,
    mods: usize,
    missing: Vec<String>,
}

#[derive(Default)]
pub struct FriendsService {
    state: Mutex<FriendsState>,
    seen_invites: Mutex<HashSet<String>>,
    wake: Notify,
    /// Не синхронизироваться параллельно (фон + кнопка в интерфейсе)
    lock: tokio::sync::Mutex<()>,
    tunnels: Arc<tunnel::Tunnels>,
    pack: Mutex<Option<PackCache>>,
}

/// Игра закрылась: закрыть вход к другу (локальный порт) и обновить статус
pub fn game_exited(app: &AppHandle) {
    if let Some(svc) = app.try_state::<Arc<FriendsService>>() {
        svc.tunnels.stop_guest();
        svc.wake.notify_one();
    }
}

/// Разбудить синхронизацию (сменился статус, открылся мир, закрылась игра…)
pub fn poke(app: &AppHandle) {
    if let Some(svc) = app.try_state::<Arc<FriendsService>>() {
        svc.wake.notify_one();
    }
}

/// Аккаунт Hytpotchi для друзей: активный, а если активен Microsoft — первый Hytpotchi
fn friends_account(app: &AppHandle) -> Option<Account> {
    let store = app.state::<AccountStore>();
    if let Some(a) = store.active().filter(|a| a.kind == AccountKind::Hytpotchi) {
        return Some(a);
    }
    store.list().0.into_iter().find(|a| a.kind == AccountKind::Hytpotchi)
}

impl FriendsService {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    pub fn state(&self) -> FriendsState {
        self.state.lock().clone()
    }

    async fn token(app: &AppHandle) -> Result<(Account, String)> {
        let Some(account) = friends_account(app) else {
            bail!("Войдите в аккаунт Hytpotchi, чтобы добавлять друзей");
        };
        let vault = app.state::<Arc<SecretsVault>>();
        let token = hytpotchi::token(&vault, &account).await?;
        Ok((account, token))
    }

    /// Мои открытые миры с данными сборок
    fn local_hosts(app: &AppHandle) -> Vec<LocalHost> {
        let watcher = app.state::<GameWatcher>();
        let mut hosts: Vec<LocalHost> = watcher
            .hosted()
            .into_iter()
            .filter_map(|(id, h)| {
                let inst = store::get(&id).ok()?;
                Some(LocalHost {
                    instance_id: id,
                    instance: inst.name,
                    mc: inst.game_version,
                    loader: inst.loader,
                    address: h.address,
                    world: h.world,
                    relay: h.lan,
                    port: h.port,
                    mods: None,
                    missing: Vec::new(),
                })
            })
            .collect();
        // Сначала адреса e4mc (из интернета напрямую)
        hosts.sort_by_key(|h| h.relay);
        hosts
    }

    /// Опись сборки открытого мира: собрать (если папка mods поменялась) и выложить на сервер.
    /// Возвращает (хеш, модов, не с Modrinth). Ошибка не мешает играть — просто без сборки.
    async fn ensure_pack(&self, http: &HttpClient, token: &str, host: &LocalHost) -> Option<(String, usize, Vec<String>)> {
        let signature = pack::mods_signature(&host.instance_id);
        if let Some(c) = self.pack.lock().as_ref() {
            if c.instance_id == host.instance_id && c.signature == signature {
                return Some((c.hash.clone(), c.mods, c.missing.clone()));
            }
        }
        let result = async {
            let inst = store::get(&host.instance_id)?;
            let shared = pack::build(http, &inst).await?;
            let reply = hytpotchi::post(http, "/api/friends/pack", Some(token), json!({ "pack": shared })).await?;
            let hash = reply["hash"].as_str().unwrap_or_default().to_string();
            anyhow::Ok((hash, shared.files.len(), shared.missing))
        }
        .await;
        match result {
            Ok((hash, mods, missing)) if !hash.is_empty() => {
                *self.pack.lock() = Some(PackCache {
                    instance_id: host.instance_id.clone(),
                    signature,
                    hash: hash.clone(),
                    mods,
                    missing: missing.clone(),
                });
                Some((hash, mods, missing))
            }
            Ok(_) => None,
            Err(e) => {
                log::warn!("Сборка для друзей не выложена: {e:#}");
                None
            }
        }
    }

    /// Что сейчас делает игрок — для друзей
    fn presence_body(app: &AppHandle, status: &str, hosts: &[LocalHost]) -> Value {
        let watcher = app.state::<GameWatcher>();
        let running = watcher.running_ids().into_iter().find_map(|id| store::get(&id).ok());
        let activity = running
            .as_ref()
            .map(|i| json!({ "instance": i.name, "mc": i.game_version, "loader": i.loader }));
        let host = hosts.first().map(|h| {
            let mut v = json!({ "world": h.world, "mc": h.mc, "loader": h.loader, "mods": h.mods });
            if h.relay {
                v["relay"] = true.into();
            } else {
                v["address"] = h.address.clone().into();
            }
            v
        });
        json!({ "status": status, "activity": activity, "host": host })
    }

    /// Один цикл синхронизации. Ошибки остаются в состоянии, а не роняют задачу.
    pub async fn sync(&self, app: &AppHandle) -> FriendsState {
        let _guard = self.lock.lock().await;
        let cfg = settings::load();
        let configured = settings::skin_server().is_some();
        let account = friends_account(app);
        let hosts = Self::local_hosts(app);
        let active_ms = app
            .state::<AccountStore>()
            .active()
            .is_some_and(|a| a.kind == AccountKind::Microsoft);
        {
            let mut s = self.state.lock();
            s.enabled = cfg.friends;
            s.configured = configured;
            s.account = account.as_ref().map(|a| a.username.clone());
            s.status = cfg.friends_status.clone();
            s.hosting = cfg.friends_hosting;
            s.hosted = hosts.clone();
            s.host_online_mode = active_ms && !hosts.is_empty();
            s.syncing = cfg.friends && configured && account.is_some();
        }
        if !cfg.friends || !configured || account.is_none() {
            self.tunnels.stop_host();
            let mut s = self.state.lock();
            s.syncing = false;
            s.error = None;
            if account.is_none() {
                s.snapshot = None;
            }
            let snapshot = s.clone();
            drop(s);
            let _ = app.emit("friends-update", &snapshot);
            return snapshot;
        }

        let mut hosts = hosts;
        let result = async {
            let (_, token) = Self::token(app).await?;
            let http = app.state::<HttpClient>();
            // Сборка открытого мира — чтобы друг поставил такую же
            let mut pack_hash = None;
            if let Some(first) = hosts.first_mut() {
                if let Some((hash, mods, missing)) = self.ensure_pack(&http, &token, first).await {
                    first.mods = Some(mods);
                    first.missing = missing;
                    pack_hash = Some(hash);
                }
            }
            let mut body = Self::presence_body(app, &cfg.friends_status, &hosts);
            if let Some(hash) = pack_hash {
                body["host"]["pack"] = hash.into();
            }
            hytpotchi::post(&http, "/api/friends/sync", Some(&token), body).await
        }
        .await;
        self.state.lock().hosted = hosts.clone();

        // Туннель хозяина: сервер выдал hostId/secret — держим мир открытым
        if let Ok(snap) = &result {
            let relay = &snap["me"]["relay"];
            let port = hosts.iter().find(|h| h.relay).and_then(|h| h.port);
            match (relay["hostId"].as_str(), relay["secret"].as_str(), port, hytpotchi::server()) {
                (Some(id), Some(secret), Some(port), Ok(server)) => self.tunnels.ensure_host(&server, id, secret, port),
                _ => self.tunnels.stop_host(),
            }
        }

        let snapshot = {
            let mut s = self.state.lock();
            s.syncing = false;
            match result {
                Ok(snap) => {
                    s.snapshot = Some(snap);
                    s.error = None;
                }
                Err(e) => s.error = Some(format!("{e:#}")),
            }
            s.clone()
        };

        // Новые приглашения — отдельным событием, чтобы показать уведомление один раз
        if let Some(invites) = snapshot.snapshot.as_ref().and_then(|v| v["invites"].as_array()) {
            let mut seen = self.seen_invites.lock();
            for inv in invites {
                if let Some(id) = inv["id"].as_str() {
                    if seen.insert(id.to_string()) {
                        let _ = app.emit("friends-invite", inv);
                    }
                }
            }
        }
        let _ = app.emit("friends-update", &snapshot);
        snapshot
    }

    /// Действие (заявка, приглашение…), затем свежий снимок
    pub async fn action(&self, app: &AppHandle, action: &str, body: Value) -> Result<FriendsState> {
        let (_, token) = Self::token(app).await?;
        let http = app.state::<HttpClient>();
        hytpotchi::post(&http, &format!("/api/friends/{action}"), Some(&token), body).await?;
        Ok(self.sync(app).await)
    }

    /// Зайти в мир друга через туннель: вернуть локальный адрес для игры
    pub async fn join(&self, app: &AppHandle, friend_id: &str) -> Result<String> {
        let (_, token) = Self::token(app).await?;
        let server = hytpotchi::server()?;
        let http = app.state::<HttpClient>().inner().clone();
        let first = hytpotchi::post(&http, "/api/friends/join", Some(&token), json!({ "id": friend_id })).await?;
        let host_id = first["hostId"].as_str().unwrap_or_default().to_string();
        if host_id.is_empty() {
            bail!("Сервер не открыл туннель");
        }
        // Первый билет уже есть, но живёт 5 минут, а игра до подключения может долго скачиваться:
        // берём его, только если он свежий; иначе — и для всех следующих соединений — новый
        let first_ticket = Arc::new(Mutex::new(
            first["ticket"].as_str().map(|t| (t.to_string(), std::time::Instant::now())),
        ));
        let friend_id = friend_id.to_string();
        let tickets: tunnel::TicketSource = Arc::new(move || {
            let (http, token, friend_id, first_ticket) = (http.clone(), token.clone(), friend_id.clone(), first_ticket.clone());
            Box::pin(async move {
                if let Some((t, at)) = first_ticket.lock().take() {
                    if at.elapsed() < Duration::from_secs(4 * 60) {
                        return Ok(t);
                    }
                }
                let r = hytpotchi::post(&http, "/api/friends/join", Some(&token), json!({ "id": friend_id })).await?;
                r["ticket"].as_str().map(str::to_string).ok_or_else(|| anyhow::anyhow!("Сервер не выдал билет"))
            })
        });
        self.tunnels.start_guest(&server, &host_id, tickets).await
    }

    /// Поставить ту же сборку, что у друга (по его описи на сервере)
    pub async fn sync_pack(
        &self,
        app: &AppHandle,
        friend_id: &str,
        memory_mb: u32,
        progress: &(dyn Fn(&str, u64, u64) + Send + Sync),
    ) -> Result<store::Instance> {
        let (_, token) = Self::token(app).await?;
        let http = app.state::<HttpClient>();
        let reply = hytpotchi::post(&http, "/api/friends/pack/get", Some(&token), json!({ "id": friend_id })).await?;
        let shared: pack::SharedPack =
            serde_json::from_value(reply["pack"].clone()).map_err(|_| anyhow::anyhow!("Сборка друга повреждена"))?;
        let nick = self
            .state
            .lock()
            .snapshot
            .as_ref()
            .and_then(|s| s["friends"].as_array().cloned())
            .and_then(|fs| fs.into_iter().find(|f| f["id"] == friend_id))
            .and_then(|f| f["nick"].as_str().map(str::to_string))
            .unwrap_or_else(|| "друга".into());
        pack::apply(&http, friend_id, &nick, &shared, memory_mb, progress).await
    }

    /// Сообщить серверу, что мы вышли (при закрытии лаунчера)
    pub async fn go_offline(&self, app: &AppHandle) {
        self.tunnels.stop_host();
        self.tunnels.stop_guest();
        let Ok((_, token)) = Self::token(app).await else { return };
        let http = app.state::<HttpClient>();
        let _ = tokio::time::timeout(
            Duration::from_secs(3),
            hytpotchi::post(&http, "/api/friends/offline", Some(&token), json!({})),
        )
        .await;
    }

    /// Фоновая синхронизация на всё время работы лаунчера
    pub fn start(self: &Arc<Self>, app: AppHandle) {
        let svc = self.clone();
        tauri::async_runtime::spawn(async move {
            // Даём лаунчеру спокойно открыться
            tokio::time::sleep(Duration::from_secs(2)).await;
            // Токен анонимного профиля друзей из версии до аккаунтов больше не используется
            let _ = app.state::<Arc<SecretsVault>>().remove_secret("friends-token").await;
            loop {
                svc.sync(&app).await;
                tokio::select! {
                    _ = tokio::time::sleep(SYNC_EVERY) => {}
                    _ = svc.wake.notified() => {
                        // Пачку быстрых изменений (несколько строк лога) склеиваем в один запрос
                        tokio::time::sleep(Duration::from_millis(800)).await;
                    }
                }
            }
        });
    }
}
