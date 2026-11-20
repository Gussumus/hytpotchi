//! Аккаунты Hytpotchi: ник + пароль на сервере Hytpotchi.
//!
//! Ник уникален и совпадает с ником в игре (вход как у офлайн-сервера, UUID из ника).
//! Сервер держит за аккаунтом скин и друзей. В лаунчере хранится только токен сеанса —
//! в зашифрованном хранилище; пароль никуда не сохраняется.

use std::time::Duration;

use anyhow::{Context, Result, bail};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::engine::core::http::HttpClient;
use crate::engine::core::settings;
use crate::secrets::SecretsVault;

use super::session::{Account, AccountKind};

#[derive(Debug, Deserialize)]
pub struct ServerUser {
    pub id: String,
    pub nick: String,
}

#[derive(Debug, Deserialize)]
pub struct AuthReply {
    pub token: String,
    pub user: ServerUser,
    /// Код восстановления (при регистрации и восстановлении)
    #[serde(default)]
    pub recovery: Option<String>,
}

pub fn session_key(account_id: &str) -> String {
    format!("hyt-session:{account_id}")
}

pub fn server() -> Result<String> {
    match settings::skin_server() {
        Some(s) => Ok(s),
        None => bail!("Не задан сервер Hytpotchi — укажите его адрес"),
    }
}

/// Текст ошибки из ответа сервера Hytpotchi ({"error": "..."}), иначе — код статуса
pub async fn server_error(resp: reqwest::Response) -> anyhow::Error {
    let status = resp.status();
    let message = resp
        .json::<Value>()
        .await
        .ok()
        .and_then(|v| v["error"].as_str().map(str::to_string))
        .unwrap_or_else(|| format!("ошибка сервера ({status})"));
    anyhow::anyhow!(message)
}

/// POST на сервер Hytpotchi; ошибки сервера приходят понятным текстом
pub async fn post(http: &HttpClient, path: &str, token: Option<&str>, body: Value) -> Result<Value> {
    let server = server()?;
    let build = || {
        let req = http.client.post(format!("{server}{path}")).json(&body).timeout(Duration::from_secs(20));
        match token {
            Some(t) => req.bearer_auth(t),
            None => req,
        }
    };
    // Один повтор: соединение могло оборваться разово (переподключение VPN, смена сети)
    let resp = match build().send().await {
        Ok(r) => r,
        Err(first) => {
            log::warn!("Сервер Hytpotchi: {first:#} — повторяю");
            tokio::time::sleep(Duration::from_millis(600)).await;
            build().send().await.map_err(|e| {
                log::warn!("Сервер Hytpotchi недоступен: {e:#}");
                anyhow::anyhow!("Сервер Hytpotchi недоступен — проверьте интернет")
            })?
        }
    };
    if !resp.status().is_success() {
        return Err(server_error(resp).await);
    }
    Ok(resp.json().await?)
}

pub async fn register(http: &HttpClient, nick: &str, password: &str) -> Result<AuthReply> {
    let v = post(http, "/api/account/register", None, json!({ "nick": nick, "password": password })).await?;
    Ok(serde_json::from_value(v)?)
}

pub async fn login(http: &HttpClient, nick: &str, password: &str) -> Result<AuthReply> {
    let v = post(http, "/api/account/login", None, json!({ "nick": nick, "password": password })).await?;
    Ok(serde_json::from_value(v)?)
}

pub async fn recover(http: &HttpClient, nick: &str, recovery: &str, password: &str) -> Result<AuthReply> {
    let v = post(
        http,
        "/api/account/recover",
        None,
        json!({ "nick": nick, "recovery": recovery, "password": password }),
    )
    .await?;
    Ok(serde_json::from_value(v)?)
}

/// Токен сеанса аккаунта Hytpotchi
pub async fn token(vault: &SecretsVault, account: &Account) -> Result<String> {
    if account.kind != AccountKind::Hytpotchi {
        bail!("Это не аккаунт Hytpotchi");
    }
    vault
        .get_secret(&session_key(&account.id))
        .await
        .context("Сеанс не найден — войдите в аккаунт Hytpotchi заново")
}

pub async fn change_password(http: &HttpClient, token: &str, old: &str, new: &str) -> Result<()> {
    post(http, "/api/account/password", Some(token), json!({ "old": old, "password": new })).await?;
    Ok(())
}

/// Выйти на сервере (не страшно, если сервер недоступен — токен всё равно забудем)
pub async fn logout(http: &HttpClient, token: &str) {
    let _ = tokio::time::timeout(
        Duration::from_secs(4),
        post(http, "/api/account/logout", Some(token), json!({})),
    )
    .await;
}
