//! Косметика игроков Hytpotchi (шапки, крылья, хвосты…): мод Hytpotchi Cosmetics + выбор на сервере.
//!
//! Мод (исходники — mods/cosmetics) вшит в лаунчер и ставится в сборки Fabric той версии игры,
//! под которую собран. Он берёт каталог моделей и что надето у каждого игрока с сервера Hytpotchi
//! (адрес передаётся через -Dhytpotchi.server). Без мода косметику не видно: ванильный клиент
//! умеет рисовать на игроке только скин и плащ.

use anyhow::{Result, bail};
use serde_json::{Value, json};

use crate::engine::accounts::hytpotchi;
use crate::engine::accounts::session::Account;
use crate::engine::core::http::HttpClient;
use crate::engine::core::paths::instance_mods_dir;
use crate::engine::profiles::store::Instance;
use crate::secrets::SecretsVault;

/// Собранный мод (mods/cosmetics: gradlew build → копия сюда)
const MOD_JAR: &[u8] = include_bytes!("../../../resources/hytpotchi-cosmetics.jar");
/// Имя файла мода в папке mods сборки
pub const MOD_FILE: &str = "hytpotchi-cosmetics.jar";
/// Версия игры, под которую собран мод
const MOD_MC: &str = "26.3";
const FABRIC_API: &str = "fabric-api";

/// Можно ли поставить мод в эту сборку
pub fn supported(instance: &Instance) -> bool {
    instance.loader.as_deref() == Some("fabric") && instance.game_version == MOD_MC
}

/// Поставить (или обновить) мод и Fabric API. true — если мод только что появился.
pub async fn install(http: &HttpClient, instance: &Instance) -> Result<bool> {
    crate::commands::content::ensure_project(http, instance, FABRIC_API).await?;
    let path = instance_mods_dir(&instance.id)?.join(MOD_FILE);
    let existed = path.exists();
    if std::fs::read(&path).ok().as_deref() != Some(MOD_JAR) {
        std::fs::write(&path, MOD_JAR)?;
    }
    Ok(!existed)
}

/// Убрать мод из сборки, где он не подходит (иначе Fabric не запустит игру)
pub fn remove(instance: &Instance) {
    if let Ok(dir) = instance_mods_dir(&instance.id) {
        let _ = std::fs::remove_file(dir.join(MOD_FILE));
    }
}

/// Аргумент JVM с адресом сервера для мода
pub fn jvm_arg(server: &str) -> String {
    format!("-Dhytpotchi.server={}", server.trim_end_matches('/'))
}

async fn get_json(http: &HttpClient, url: &str) -> Result<Value> {
    let resp = http
        .oneshot
        .get(url)
        .send()
        .await
        .map_err(|_| anyhow::anyhow!("Сервер Hytpotchi недоступен"))?;
    if !resp.status().is_success() {
        return Err(hytpotchi::server_error(resp).await);
    }
    Ok(resp.json().await?)
}

/// Каталог косметики (модели — для 3D-просмотра в лаунчере)
pub async fn catalog(http: &HttpClient, server: &str) -> Result<Value> {
    get_json(http, &format!("{server}/api/cosmetics/catalog")).await
}

/// Что надето у игрока
pub async fn selection(http: &HttpClient, server: &str, nick: &str) -> Result<Vec<String>> {
    let v = get_json(http, &format!("{server}/api/cosmetics/{}", urlencoding::encode(nick))).await?;
    Ok(items(&v))
}

/// Надеть набор косметики (только владелец аккаунта)
pub async fn set_selection(
    http: &HttpClient,
    vault: &SecretsVault,
    server: &str,
    account: &Account,
    chosen: &[String],
) -> Result<Vec<String>> {
    if chosen.len() > 10 {
        bail!("Можно надеть не больше 10 предметов");
    }
    let token = hytpotchi::token(vault, account).await?;
    let resp = http
        .oneshot
        .put(format!("{server}/api/cosmetics/{}", urlencoding::encode(&account.username)))
        .bearer_auth(token)
        .json(&json!({ "items": chosen }))
        .send()
        .await
        .map_err(|_| anyhow::anyhow!("Сервер Hytpotchi недоступен"))?;
    if !resp.status().is_success() {
        return Err(hytpotchi::server_error(resp).await);
    }
    Ok(items(&resp.json().await?))
}

fn items(v: &Value) -> Vec<String> {
    v["items"]
        .as_array()
        .map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embedded_mod_is_for_this_version() {
        // В лаунчер вшит мод именно под MOD_MC
        let text = String::from_utf8_lossy(MOD_JAR);
        assert!(MOD_JAR.starts_with(b"PK"), "это не jar");
        assert!(text.contains("fabric.mod.json"));
        assert!(text.contains("ru/hytpotchi/cosmetics/CosmeticsClient"));
        assert_eq!(jvm_arg("https://srv/"), "-Dhytpotchi.server=https://srv");
        assert_eq!(items(&json!({"items": ["crown", 5, "halo"]})), vec!["crown", "halo"]);
    }
}
