//! Общие скины: публикация скина аккаунта Hytpotchi на сервер Hytpotchi.
//! Скин для ника принимает только владелец аккаунта с этим ником.

use anyhow::{Result, bail};

use crate::engine::accounts::hytpotchi;
use crate::engine::accounts::session::Account;
use crate::engine::core::http::HttpClient;
use crate::secrets::SecretsVault;


/// Загрузить скин на сервер, чтобы его видели другие игроки
pub async fn publish(
    http: &HttpClient,
    vault: &SecretsVault,
    server: &str,
    account: &Account,
    png: Vec<u8>,
    slim: bool,
) -> Result<()> {
    let token = hytpotchi::token(vault, account).await?;
    let username = account.username.as_str();
    let url = format!(
        "{server}/api/skins/{}?model={}",
        urlencoding::encode(username),
        if slim { "slim" } else { "default" }
    );
    let resp = http
        .client
        .put(url)
        .bearer_auth(token)
        .header("content-type", "image/png")
        .body(png)
        .send()
        .await
        .map_err(|_| anyhow::anyhow!("Сервер скинов недоступен"))?;
    if !resp.status().is_success() {
        return Err(hytpotchi::server_error(resp).await);
    }
    Ok(())
}

/// Убрать скин с сервера (ник остаётся за вами)
pub async fn unpublish(http: &HttpClient, vault: &SecretsVault, server: &str, account: &Account) -> Result<()> {
    let Ok(token) = hytpotchi::token(vault, account).await else {
        return Ok(());
    };
    let username = account.username.as_str();
    let resp = http
        .client
        .delete(format!("{server}/api/skins/{}", urlencoding::encode(username)))
        .bearer_auth(token)
        .send()
        .await?;
    if !resp.status().is_success() {
        return Err(hytpotchi::server_error(resp).await);
    }
    Ok(())
}

/// Проверить, что по адресу отвечает сервер скинов Hytpotchi
pub async fn check(http: &HttpClient, server: &str) -> Result<()> {
    let resp = http
        .client
        .get(format!("{server}/"))
        .send()
        .await
        .map_err(|_| anyhow::anyhow!("Сервер не отвечает"))?;
    let body: serde_json::Value = resp.json().await.unwrap_or_default();
    if body["service"] != "hytpotchi-skins" {
        bail!("По этому адресу не сервер скинов Hytpotchi");
    }
    Ok(())
}
