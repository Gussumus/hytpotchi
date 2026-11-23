//! Косметика игроков Hytpotchi (шапки, крылья, хвосты…): мод Hytpotchi Cosmetics + выбор на сервере.
//!
//! Мод (исходники — mods/cosmetics) вшит в лаунчер и ставится в сборки Fabric той версии игры,
//! под которую собран. Он берёт каталог моделей и что надето у каждого игрока с сервера Hytpotchi
//! (адрес передаётся через -Dhytpotchi.server). Без мода косметику не видно: ванильный клиент
//! умеет рисовать на игроке только скин и плащ.

use anyhow::{Result, bail};
use base64::Engine as _;
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

/// Путь к 3D-модели из каталога: cosmetics/<id>/<файл>.json — ничего, кроме файлов косметики
fn valid_mesh_path(path: &str) -> bool {
    let parts: Vec<&str> = path.split('/').collect();
    let id_ok = |s: &str| !s.is_empty() && s.len() <= 32 && s.bytes().all(|b| b.is_ascii_lowercase() || b == b'_');
    let file_ok = |s: &str| {
        s.strip_suffix(".json")
            .is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'-'))
    };
    parts.len() == 3 && parts[0] == "cosmetics" && id_ok(parts[1]) && file_ok(parts[2])
}

/// Имя текстуры внутри mesh.json: tex<N>.png
fn valid_texture_name(name: &str) -> bool {
    name.strip_prefix("tex")
        .and_then(|n| n.strip_suffix(".png"))
        .is_some_and(|n| !n.is_empty() && n.len() <= 3 && n.bytes().all(|b| b.is_ascii_digit()))
}

/// Самая большая текстура модели, которую примем
const MAX_TEXTURE: usize = 4 * 1024 * 1024;

/// 3D-модель предмета (mesh.json) и её текстуры как data:-URL — для 3D-просмотра в лаунчере
/// (интерфейсу нельзя ходить к серверу напрямую)
pub async fn mesh(http: &HttpClient, server: &str, path: &str) -> Result<Value> {
    if !valid_mesh_path(path) {
        bail!("Неверный путь к модели");
    }
    let mesh = get_json(http, &format!("{server}/{path}")).await?;
    let dir = path.rsplit_once('/').map(|(d, _)| d).unwrap_or_default();
    let mut textures = Vec::new();
    for name in mesh["textures"].as_array().into_iter().flatten() {
        let name = name.as_str().unwrap_or_default();
        if !valid_texture_name(name) {
            bail!("Неверное имя текстуры в модели");
        }
        let resp = http
            .oneshot
            .get(format!("{server}/{dir}/{name}"))
            .send()
            .await
            .map_err(|_| anyhow::anyhow!("Сервер Hytpotchi недоступен"))?;
        if !resp.status().is_success() {
            return Err(hytpotchi::server_error(resp).await);
        }
        let bytes = resp.bytes().await?;
        if bytes.len() > MAX_TEXTURE || !bytes.starts_with(b"\x89PNG") {
            bail!("Текстура модели повреждена");
        }
        textures.push(format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(&bytes)));
    }
    Ok(json!({ "mesh": mesh, "textures": textures }))
}

/// Что надето у игрока и что он купил
#[derive(Debug, Clone, serde::Serialize)]
pub struct CosmeticsState {
    pub items: Vec<String>,
    pub owned: Vec<String>,
}

fn state(v: &Value) -> CosmeticsState {
    CosmeticsState { items: strings(&v["items"]), owned: strings(&v["owned"]) }
}

/// Что надето у игрока и что куплено
pub async fn selection(http: &HttpClient, server: &str, nick: &str) -> Result<CosmeticsState> {
    let v = get_json(http, &format!("{server}/api/cosmetics/{}", urlencoding::encode(nick))).await?;
    Ok(state(&v))
}

/// Запрос к серверу от имени аккаунта Hytpotchi (с его токеном)
async fn authed(
    http: &HttpClient,
    vault: &SecretsVault,
    account: &Account,
    req: impl FnOnce(&reqwest::Client) -> reqwest::RequestBuilder,
) -> Result<Value> {
    let token = hytpotchi::token(vault, account).await?;
    let resp = req(&http.oneshot)
        .bearer_auth(token)
        .send()
        .await
        .map_err(|_| anyhow::anyhow!("Сервер Hytpotchi недоступен"))?;
    if !resp.status().is_success() {
        return Err(hytpotchi::server_error(resp).await);
    }
    Ok(resp.json().await?)
}

/// Надеть набор косметики (только владелец аккаунта; платное — только купленное)
pub async fn set_selection(
    http: &HttpClient,
    vault: &SecretsVault,
    server: &str,
    account: &Account,
    chosen: &[String],
) -> Result<CosmeticsState> {
    if chosen.len() > 10 {
        bail!("Можно надеть не больше 10 предметов");
    }
    let url = format!("{server}/api/cosmetics/{}", urlencoding::encode(&account.username));
    let v = authed(http, vault, account, |c| c.put(url).json(&json!({ "items": chosen }))).await?;
    Ok(state(&v))
}

/// Начать покупку предмета: сервер создаёт платёж ЮKassa и отдаёт страницу оплаты
pub async fn buy(http: &HttpClient, vault: &SecretsVault, server: &str, account: &Account, item: &str) -> Result<Value> {
    if item.is_empty() || item.len() > 32 || !item.bytes().all(|b| b.is_ascii_lowercase() || b == b'_') {
        bail!("Такого предмета нет");
    }
    let body = json!({ "nick": account.username, "item": item });
    let v = authed(http, vault, account, |c| c.post(format!("{server}/api/shop/buy")).json(&body)).await?;
    let url = v["url"].as_str().unwrap_or_default();
    // Открываем в браузере только настоящую страницу оплаты
    if !url.starts_with("https://") {
        bail!("Платёжный сервис вернул неверную ссылку");
    }
    Ok(v)
}

/// Статус платежа (сервер заодно перепроверяет его у ЮKassa) и что теперь куплено
pub async fn payment(http: &HttpClient, vault: &SecretsVault, server: &str, account: &Account, id: &str) -> Result<Value> {
    if id.is_empty() || id.len() > 64 || !id.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-') {
        bail!("Неверный номер платежа");
    }
    authed(http, vault, account, |c| c.get(format!("{server}/api/shop/payment/{id}"))).await
}

fn strings(v: &Value) -> Vec<String> {
    v.as_array()
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
        let s = state(&json!({"items": ["crown", 5, "halo"], "owned": ["crown"]}));
        assert_eq!(s.items, vec!["crown", "halo"]);
        assert_eq!(s.owned, vec!["crown"]);
        assert!(state(&json!({"items": []})).owned.is_empty(), "старый сервер без owned");
    }

    #[test]
    fn mesh_paths_stay_inside_cosmetics() {
        assert!(valid_mesh_path("cosmetics/jester_hat/mesh.json"));
        assert!(valid_mesh_path("cosmetics/bat_wings/mesh-left.json"));
        for bad in [
            "cosmetics/../secrets.json",
            "api/cosmetics/catalog",
            "cosmetics/x/mesh.png",
            "cosmetics/x/y/mesh.json",
            "cosmetics//mesh.json",
            "https://evil/cosmetics/x/mesh.json",
            "cosmetics/X/mesh.json",
        ] {
            assert!(!valid_mesh_path(bad), "{bad}");
        }
        assert!(valid_texture_name("tex0.png") && valid_texture_name("tex12.png"));
        assert!(!valid_texture_name("../tex0.png") && !valid_texture_name("tex.png") && !valid_texture_name("tex0.jpg"));
    }
}
