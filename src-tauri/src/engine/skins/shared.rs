//! Общие офлайн-скины: публикация на сервер скинов Hytpotchi

use anyhow::{Result, bail};

use crate::engine::core::http::HttpClient;
use crate::secrets::SecretsVault;

fn claim_key(username: &str) -> String {
    format!("skin-claim:{}", username.to_lowercase())
}

/// Секретный ключ владения ником (создаётся при первой публикации)
async fn token_for(vault: &SecretsVault, username: &str) -> Result<String> {
    let key = claim_key(username);
    if let Some(token) = vault.get_secret(&key).await {
        return Ok(token);
    }
    let mut bytes = [0u8; 32];
    getrandom::getrandom(&mut bytes)?;
    let token = hex::encode(bytes);
    vault.set_secret(&key, token.clone()).await?;
    Ok(token)
}

async fn server_error(resp: reqwest::Response) -> anyhow::Error {
    let status = resp.status();
    let message = resp
        .json::<serde_json::Value>()
        .await
        .ok()
        .and_then(|v| v["error"].as_str().map(str::to_string))
        .unwrap_or_else(|| format!("ошибка сервера ({status})"));
    anyhow::anyhow!(message)
}

/// Загрузить скин на сервер, чтобы его видели другие игроки
pub async fn publish(
    http: &HttpClient,
    vault: &SecretsVault,
    server: &str,
    username: &str,
    png: Vec<u8>,
    slim: bool,
) -> Result<()> {
    let token = token_for(vault, username).await?;
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
        return Err(server_error(resp).await);
    }
    Ok(())
}

/// Убрать скин с сервера (ник остаётся за вами)
pub async fn unpublish(http: &HttpClient, vault: &SecretsVault, server: &str, username: &str) -> Result<()> {
    let Some(token) = vault.get_secret(&claim_key(username)).await else {
        return Ok(());
    };
    let resp = http
        .client
        .delete(format!("{server}/api/skins/{}", urlencoding::encode(username)))
        .bearer_auth(token)
        .send()
        .await?;
    if !resp.status().is_success() {
        return Err(server_error(resp).await);
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
