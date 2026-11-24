//! Косметика игроков Hytpotchi (шапки, крылья, хвосты…): мод Hytpotchi Cosmetics + выбор на сервере.
//!
//! Мод (исходники — mods/cosmetics) вшит в лаунчер — отдельной сборкой под каждую поддержанную
//! версию игры (1.16.5, 1.18.2, 1.19.2, 1.20.1, 1.21.1, 1.21.4, 26.3) — и ставится в сборки Fabric. Он берёт каталог моделей и что надето у каждого игрока с сервера Hytpotchi
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

/// Сборка мода под версии игры. Fabric не запустит игру с модом не той версии
/// (`depends.minecraft` в fabric.mod.json), поэтому versions — ровно то, что там разрешено.
struct ModBuild {
    versions: &'static [&'static str],
    jar: &'static [u8],
}

/// Собранные моды (mods/cosmetics: README — как собрать и куда положить)
const BUILDS: &[ModBuild] = &[
    ModBuild { versions: &["26.3"], jar: include_bytes!("../../../resources/hytpotchi-cosmetics.jar") },
    ModBuild {
        versions: &["1.21.4"],
        jar: include_bytes!("../../../resources/cosmetics/hytpotchi-cosmetics-mc1.21.4.jar"),
    },
    ModBuild {
        versions: &["1.21", "1.21.1"],
        jar: include_bytes!("../../../resources/cosmetics/hytpotchi-cosmetics-mc1.21.1.jar"),
    },
    ModBuild {
        versions: &["1.20", "1.20.1"],
        jar: include_bytes!("../../../resources/cosmetics/hytpotchi-cosmetics-mc1.20.1.jar"),
    },
    ModBuild {
        versions: &["1.19.2"],
        jar: include_bytes!("../../../resources/cosmetics/hytpotchi-cosmetics-mc1.19.2.jar"),
    },
    ModBuild {
        versions: &["1.18.2"],
        jar: include_bytes!("../../../resources/cosmetics/hytpotchi-cosmetics-mc1.18.2.jar"),
    },
    ModBuild {
        versions: &["1.16.5"],
        jar: include_bytes!("../../../resources/cosmetics/hytpotchi-cosmetics-mc1.16.5.jar"),
    },
];
/// Имя файла мода в папке mods сборки
pub const MOD_FILE: &str = "hytpotchi-cosmetics.jar";
const FABRIC_API: &str = "fabric-api";

fn build_for(game_version: &str) -> Option<&'static ModBuild> {
    BUILDS.iter().find(|b| b.versions.contains(&game_version))
}

/// Можно ли поставить мод в эту сборку
pub fn supported(instance: &Instance) -> bool {
    instance.loader.as_deref() == Some("fabric") && build_for(&instance.game_version).is_some()
}

/// Поставить (или обновить) мод и Fabric API. true — если мод только что появился.
pub async fn install(http: &HttpClient, instance: &Instance) -> Result<bool> {
    let Some(build) = build_for(&instance.game_version) else {
        bail!("Мода косметики под Minecraft {} нет", instance.game_version);
    };
    crate::commands::content::ensure_project(http, instance, FABRIC_API).await?;
    let path = instance_mods_dir(&instance.id)?.join(MOD_FILE);
    let existed = path.exists();
    if std::fs::read(&path).ok().as_deref() != Some(build.jar) {
        std::fs::write(&path, build.jar)?;
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

/// Админка: без ника — проверка доступа ({admin: true} или ошибка «Нет доступа»),
/// с ником — выдать / забрать предметы и вернуть {nick, owned}
pub async fn admin(
    http: &HttpClient,
    vault: &SecretsVault,
    server: &str,
    account: &Account,
    nick: Option<&str>,
    grant: &[String],
    revoke: &[String],
) -> Result<Value> {
    let body = match nick {
        None => json!({}),
        Some(n) => {
            let n = n.trim();
            if !(3..=16).contains(&n.len()) || !n.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_') {
                bail!("Ник: 3–16 символов, латиница, цифры и _");
            }
            json!({ "nick": n, "grant": grant, "revoke": revoke })
        }
    };
    authed(http, vault, account, |c| c.post(format!("{server}/api/admin/cosmetics")).json(&body)).await
}

fn strings(v: &Value) -> Vec<String> {
    v.as_array()
        .map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// depends.minecraft из fabric.mod.json вшитого jar
    fn minecraft_range(jar: &[u8]) -> String {
        use std::io::Read;
        let mut zip = zip::ZipArchive::new(std::io::Cursor::new(jar)).expect("это не jar");
        let mut text = String::new();
        zip.by_name("fabric.mod.json").expect("нет fabric.mod.json").read_to_string(&mut text).unwrap();
        let json: Value = serde_json::from_str(&text).unwrap();
        assert!(zip.by_name("ru/hytpotchi/cosmetics/CosmeticsClient.class").is_ok(), "нет CosmeticsClient");
        json["depends"]["minecraft"].as_str().unwrap_or_default().to_string()
    }

    fn version_key(v: &str) -> Vec<u64> {
        let mut parts: Vec<u64> = v.split('.').map(|p| p.parse().unwrap()).collect();
        parts.resize(3, 0);
        parts
    }

    /// Разрешает ли диапазон Fabric ("~1.16.5", ">=1.20 <1.20.2") версию игры
    fn range_allows(range: &str, v: &str) -> bool {
        let v = version_key(v);
        range.split_whitespace().all(|cond| {
            if let Some(base) = cond.strip_prefix('~') {
                let b = version_key(base);
                v >= b && v[..2] == b[..2]
            } else if let Some(min) = cond.strip_prefix(">=") {
                v >= version_key(min)
            } else if let Some(max) = cond.strip_prefix('<') {
                v < version_key(max)
            } else {
                v == version_key(cond)
            }
        })
    }

    #[test]
    fn embedded_mods_match_their_versions() {
        // Каждый вшитый мод — ровно под те версии игры, в которые лаунчер его ставит:
        // иначе Fabric откажется запускать игру
        for build in BUILDS {
            let range = minecraft_range(build.jar);
            for v in build.versions {
                assert!(range_allows(&range, v), "мод с minecraft={range} ставится в {v}");
            }
        }
        assert!(range_allows("~1.16.5", "1.16.5") && !range_allows("~1.16.5", "1.17"));
        assert!(range_allows(">=1.20 <1.20.2", "1.20") && !range_allows(">=1.20 <1.20.2", "1.20.2"));
        for v in ["1.16.5", "1.18.2", "1.19.2", "1.20", "1.20.1", "1.21", "1.21.1", "1.21.4", "26.3"] {
            assert!(build_for(v).is_some(), "{v}");
        }
        assert!(build_for("1.20.2").is_none() && build_for("1.21.3").is_none() && build_for("26.2").is_none());
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
