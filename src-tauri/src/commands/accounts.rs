//! Команды аккаунтов. Токены во фронтенд не отдаются.

use serde::Serialize;
use tauri::{State, command};

use crate::engine::accounts::hytpotchi;
use crate::engine::accounts::microsoft::MicrosoftAuth;
use crate::engine::accounts::session::{
    Account, AccountKind, AccountStore, new_account, offline_uuid, validate_username,
};
use crate::engine::accounts::vault::{TokenVault, store_login};
use crate::engine::core::http::HttpClient;
use crate::secrets::AccountId;

type CmdResult<T> = Result<T, String>;

fn err(e: anyhow::Error) -> String {
    format!("{e:#}")
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountView {
    pub id: String,
    pub username: String,
    pub uuid: String,
    pub kind: AccountKind,
    pub active: bool,
    pub skin_url: Option<String>,
    /// Офлайн-скин из библиотеки (data URL) — для аватара
    pub offline_skin: Option<String>,
}

fn view(a: Account, active: &Option<String>) -> AccountView {
    AccountView {
        active: active.as_deref() == Some(a.id.as_str()),
        id: a.id,
        username: a.username,
        uuid: a.uuid,
        kind: a.kind,
        offline_skin: a
            .offline_skin
            .as_deref()
            .and_then(|id| crate::commands::skins::library_skin_bytes(id).ok())
            .map(|b| format!("data:image/png;base64,{}", base64::Engine::encode(&base64::engine::general_purpose::STANDARD, b))),
        skin_url: a.skin_url,
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceCodeView {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    pub expires_in: u64,
    pub interval: u64,
}

#[command]
pub async fn microsoft_auth_start(http: State<'_, HttpClient>) -> CmdResult<DeviceCodeView> {
    let auth = MicrosoftAuth::new(http.inner().clone()).map_err(err)?;
    let d = auth.start_device_flow().await.map_err(err)?;
    Ok(DeviceCodeView {
        device_code: d.device_code,
        user_code: d.user_code,
        verification_uri: d.verification_uri,
        expires_in: d.expires_in,
        interval: d.interval,
    })
}

/// Один опрос входа; `null`, пока пользователь не подтвердил код
#[command]
pub async fn microsoft_auth_poll(
    http: State<'_, HttpClient>,
    vault: State<'_, TokenVault>,
    store: State<'_, AccountStore>,
    device_code: String,
) -> CmdResult<Option<AccountView>> {
    let auth = MicrosoftAuth::new(http.inner().clone()).map_err(err)?;
    let Some(ms) = auth.poll_token(&device_code).await.map_err(err)? else {
        return Ok(None);
    };
    let login = auth.login(ms, None).await.map_err(err)?;
    let skin = login
        .profile
        .skins
        .iter()
        .find(|s| s.state == "ACTIVE")
        .map(|s| s.url.clone());
    let account = store
        .upsert(new_account(&login.profile.name, &login.profile.id, AccountKind::Microsoft, skin))
        .map_err(err)?;
    store_login(&vault, &account.id, &login).await.map_err(err)?;
    let (_, active) = store.list();
    Ok(Some(view(account, &active)))
}

#[command]
pub async fn microsoft_refresh_token(
    http: State<'_, HttpClient>,
    vault: State<'_, TokenVault>,
    store: State<'_, AccountStore>,
    account_id: String,
) -> CmdResult<()> {
    let account = store.get(&account_id).ok_or("Аккаунт не найден")?;
    let bundle = vault
        .get_token(&AccountId(account_id.clone()))
        .await
        .map_err(err)?
        .ok_or("Нет сохранённого входа")?;
    let auth = MicrosoftAuth::new(http.inner().clone()).map_err(err)?;
    let ms = auth.refresh(&bundle.ms_refresh_token).await.map_err(err)?;
    let login = auth.login(ms, Some(&bundle.ms_refresh_token)).await.map_err(err)?;
    store_login(&vault, &account.id, &login).await.map_err(err)?;
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HytpotchiAuthView {
    pub account: AccountView,
    /// Код восстановления — показать один раз
    pub recovery: Option<String>,
}

/// Сохранить вход Hytpotchi: аккаунт в списке + токен сеанса в хранилище.
/// `replace` — старый офлайн-аккаунт с тем же ником: забираем его скин и удаляем.
async fn finish_hytpotchi(
    store: &AccountStore,
    vault: &TokenVault,
    reply: hytpotchi::AuthReply,
    replace: Option<String>,
) -> anyhow::Result<HytpotchiAuthView> {
    let nick = reply.user.nick;
    let mut account = new_account(&nick, &offline_uuid(&nick), AccountKind::Hytpotchi, None);
    let old = replace
        .as_deref()
        .and_then(|id| store.get(id))
        .filter(|a| a.kind == AccountKind::Offline);
    if let Some(old) = &old {
        account.offline_skin = old.offline_skin.clone();
        account.offline_variant = old.offline_variant.clone();
    }
    let account = store.upsert(account)?;
    vault.set_secret(&hytpotchi::session_key(&account.id), reply.token).await?;
    if let Some(old) = old {
        store.remove(&old.id)?;
        store.set_active(&account.id)?;
    }
    let (_, active) = store.list();
    Ok(HytpotchiAuthView { account: view(account, &active), recovery: reply.recovery })
}

fn check_password(password: &str) -> anyhow::Result<()> {
    if password.chars().count() < 8 {
        anyhow::bail!("Пароль — минимум 8 символов");
    }
    Ok(())
}

#[command]
pub async fn hytpotchi_register(
    http: State<'_, HttpClient>,
    store: State<'_, AccountStore>,
    vault: State<'_, TokenVault>,
    nick: String,
    password: String,
    replace: Option<String>,
) -> CmdResult<HytpotchiAuthView> {
    let nick = nick.trim().to_string();
    validate_username(&nick).map_err(err)?;
    check_password(&password).map_err(err)?;
    let reply = hytpotchi::register(&http, &nick, &password).await.map_err(err)?;
    finish_hytpotchi(&store, &vault, reply, replace).await.map_err(err)
}

#[command]
pub async fn hytpotchi_login(
    http: State<'_, HttpClient>,
    store: State<'_, AccountStore>,
    vault: State<'_, TokenVault>,
    nick: String,
    password: String,
    replace: Option<String>,
) -> CmdResult<AccountView> {
    let nick = nick.trim().to_string();
    validate_username(&nick).map_err(err)?;
    let reply = hytpotchi::login(&http, &nick, &password).await.map_err(err)?;
    let view = finish_hytpotchi(&store, &vault, reply, replace).await.map_err(err)?;
    Ok(view.account)
}

#[command]
pub async fn hytpotchi_recover(
    http: State<'_, HttpClient>,
    store: State<'_, AccountStore>,
    vault: State<'_, TokenVault>,
    nick: String,
    recovery: String,
    password: String,
) -> CmdResult<HytpotchiAuthView> {
    let nick = nick.trim().to_string();
    validate_username(&nick).map_err(err)?;
    check_password(&password).map_err(err)?;
    let reply = hytpotchi::recover(&http, &nick, recovery.trim(), &password).await.map_err(err)?;
    finish_hytpotchi(&store, &vault, reply, None).await.map_err(err)
}

#[command]
pub async fn hytpotchi_change_password(
    http: State<'_, HttpClient>,
    store: State<'_, AccountStore>,
    vault: State<'_, TokenVault>,
    account_id: String,
    old: String,
    password: String,
) -> CmdResult<()> {
    check_password(&password).map_err(err)?;
    let account = store.get(&account_id).ok_or("Аккаунт не найден")?;
    let token = hytpotchi::token(&vault, &account).await.map_err(err)?;
    hytpotchi::change_password(&http, &token, &old, &password).await.map_err(err)
}

#[command]
pub async fn account_list(store: State<'_, AccountStore>) -> CmdResult<Vec<AccountView>> {
    let (accounts, active) = store.list();
    Ok(accounts.into_iter().map(|a| view(a, &active)).collect())
}

#[command]
pub async fn account_remove(
    http: State<'_, HttpClient>,
    store: State<'_, AccountStore>,
    vault: State<'_, TokenVault>,
    account_id: String,
) -> CmdResult<()> {
    // Аккаунт Hytpotchi: выходим на сервере и забываем токен
    if let Some(account) = store.get(&account_id).filter(|a| a.kind == AccountKind::Hytpotchi) {
        if let Ok(token) = hytpotchi::token(&vault, &account).await {
            hytpotchi::logout(&http, &token).await;
        }
        vault.remove_secret(&hytpotchi::session_key(&account_id)).await.map_err(err)?;
    }
    vault
        .remove_account(&AccountId(account_id.clone()))
        .await
        .map_err(err)?;
    store.remove(&account_id).map_err(err)
}

#[command]
pub async fn account_set_active(store: State<'_, AccountStore>, account_id: String) -> CmdResult<()> {
    store.set_active(&account_id).map_err(err)
}
