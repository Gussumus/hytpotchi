//! Косметика игроков Hytpotchi (шапки, крылья, хвосты…): мод Hytpotchi Cosmetics + выбор на сервере.
//!
//! Мод (исходники — mods/cosmetics) вшит в лаунчер — отдельной сборкой под каждую поддержанную
//! версию игры (Fabric и Quilt: 1.16.5, 1.18.2, 1.19.2, 1.20.1, 1.21.1, 1.21.4, 26.3; Forge: 1.20.1).
//! Он берёт каталог моделей и что надето у каждого игрока с сервера Hytpotchi
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

/// Сборка мода под загрузчик и версии игры. Загрузчик не запустит игру с модом не той версии
/// (`depends.minecraft` в fabric.mod.json, `versionRange` в mods.toml), поэтому versions — ровно
/// то, что там разрешено.
struct ModBuild {
    loaders: &'static [&'static str],
    versions: &'static [&'static str],
    jar: &'static [u8],
}

/// Quilt запускает моды Fabric (и Fabric API) как свои
const FABRIC: &[&str] = &["fabric", "quilt"];
const FORGE: &[&str] = &["forge"];

/// Собранные моды (mods/cosmetics: README — как собрать и куда положить)
const BUILDS: &[ModBuild] = &[
    ModBuild { loaders: FABRIC, versions: &["26.3"], jar: include_bytes!("../../../resources/hytpotchi-cosmetics.jar") },
    ModBuild {
        loaders: FABRIC,
        versions: &["1.21.4"],
        jar: include_bytes!("../../../resources/cosmetics/hytpotchi-cosmetics-mc1.21.4.jar"),
    },
    ModBuild {
        loaders: FABRIC,
        versions: &["1.21", "1.21.1"],
        jar: include_bytes!("../../../resources/cosmetics/hytpotchi-cosmetics-mc1.21.1.jar"),
    },
    ModBuild {
        loaders: FABRIC,
        versions: &["1.20", "1.20.1"],
        jar: include_bytes!("../../../resources/cosmetics/hytpotchi-cosmetics-mc1.20.1.jar"),
    },
    ModBuild {
        loaders: FABRIC,
        versions: &["1.19.2"],
        jar: include_bytes!("../../../resources/cosmetics/hytpotchi-cosmetics-mc1.19.2.jar"),
    },
    ModBuild {
        loaders: FABRIC,
        versions: &["1.18.2"],
        jar: include_bytes!("../../../resources/cosmetics/hytpotchi-cosmetics-mc1.18.2.jar"),
    },
    ModBuild {
        loaders: FABRIC,
        versions: &["1.16.5"],
        jar: include_bytes!("../../../resources/cosmetics/hytpotchi-cosmetics-mc1.16.5.jar"),
    },
    ModBuild {
        loaders: FORGE,
        versions: &["1.20", "1.20.1"],
        jar: include_bytes!("../../../resources/cosmetics/hytpotchi-cosmetics-forge-mc1.20.1.jar"),
    },
];
/// Для сообщений игроку: под какие загрузчики и версии есть мод
pub const SUPPORTED_VERSIONS: &str = "Fabric и Quilt на 1.16.5, 1.18.2, 1.19.2, 1.20.1, 1.21.1, 1.21.4 и 26.3, Forge на 1.20.1";
/// Имя файла мода в папке mods сборки
pub const MOD_FILE: &str = "hytpotchi-cosmetics.jar";
const FABRIC_API: &str = "fabric-api";

fn build_for(loader: Option<&str>, game_version: &str) -> Option<&'static ModBuild> {
    let loader = loader?;
    BUILDS.iter().find(|b| b.loaders.contains(&loader) && b.versions.contains(&game_version))
}

/// Можно ли поставить мод в эту сборку
pub fn supported(instance: &Instance) -> bool {
    build_for(instance.loader.as_deref(), &instance.game_version).is_some()
}

/// Поставить (или обновить) мод (и Fabric API — для Fabric и Quilt). true — если мод только что появился.
pub async fn install(http: &HttpClient, instance: &Instance) -> Result<bool> {
    let Some(build) = build_for(instance.loader.as_deref(), &instance.game_version) else {
        bail!("Мода косметики под эту сборку (Minecraft {}) нет", instance.game_version);
    };
    if build.loaders == FABRIC {
        crate::commands::content::ensure_project(http, instance, FABRIC_API).await?;
    }
    // В новой сборке Forge без модов папки mods ещё нет (у Fabric её создаёт установка Fabric API)
    let dir = instance_mods_dir(&instance.id)?;
    std::fs::create_dir_all(&dir)?;
    let path = dir.join(MOD_FILE);
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

/// Аргументы JVM для мода: адрес сервера и системный прокси, если он сейчас отвечает.
/// Java сама не видит прокси Windows, который ставят VPN-программы (v2rayN, Clash…): лаунчер
/// ходит через него, а мод шёл бы напрямую и у части игроков упирался в обрывы соединений с
/// Cloudflare — и не видел косметику других.
pub fn jvm_args(server: &str) -> Vec<String> {
    let mut args = vec![jvm_arg(server)];
    if let Some(proxy) = crate::engine::core::proxy::detect() {
        if crate::engine::core::proxy::Liveness::new(proxy.clone()).alive() {
            args.push(format!("-Dhytpotchi.proxy={}", proxy.url));
        }
    }
    args
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
    /// Диапазон версий игры из вшитого jar: depends.minecraft (Fabric, "~1.16.5") или
    /// versionRange зависимости minecraft в META-INF/mods.toml (Forge, "[1.20,1.20.2)")
    fn minecraft_range(jar: &[u8], forge: bool) -> String {
        use std::io::Read;
        let mut zip = zip::ZipArchive::new(std::io::Cursor::new(jar)).expect("это не jar");
        assert!(zip.by_name("ru/hytpotchi/cosmetics/CosmeticsClient.class").is_ok(), "нет CosmeticsClient");
        let mut text = String::new();
        if forge {
            // Без pack.mcmeta Forge при каждом запуске останавливается на экране предупреждения
            assert!(zip.by_name("pack.mcmeta").is_ok(), "нет pack.mcmeta");
            zip.by_name("META-INF/mods.toml").expect("нет mods.toml").read_to_string(&mut text).unwrap();
            let block = text.split("modId=\"minecraft\"").nth(1).expect("нет зависимости minecraft");
            let line = block.lines().find(|l| l.trim_start().starts_with("versionRange")).expect("нет versionRange");
            return line.split('"').nth(1).unwrap_or_default().to_string();
        }
        zip.by_name("fabric.mod.json").expect("нет fabric.mod.json").read_to_string(&mut text).unwrap();
        let json: Value = serde_json::from_str(&text).unwrap();
        json["depends"]["minecraft"].as_str().unwrap_or_default().to_string()
    }

    /// Диапазон Maven, как в mods.toml: "[1.20,1.20.2)"
    fn maven_range_allows(range: &str, v: &str) -> bool {
        let inner = &range[1..range.len() - 1];
        let (min, max) = inner.split_once(',').unwrap();
        let v = version_key(v);
        let lower = min.is_empty() || if range.starts_with('[') { v >= version_key(min) } else { v > version_key(min) };
        let upper = max.is_empty() || if range.ends_with(']') { v <= version_key(max) } else { v < version_key(max) };
        lower && upper
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
        // иначе загрузчик откажется запускать игру
        for build in BUILDS {
            let forge = build.loaders == FORGE;
            let range = minecraft_range(build.jar, forge);
            for v in build.versions {
                let ok = if forge { maven_range_allows(&range, v) } else { range_allows(&range, v) };
                assert!(ok, "мод с minecraft={range} ставится в {v}");
            }
        }
        assert!(range_allows("~1.16.5", "1.16.5") && !range_allows("~1.16.5", "1.17"));
        assert!(range_allows(">=1.20 <1.20.2", "1.20") && !range_allows(">=1.20 <1.20.2", "1.20.2"));
        assert!(maven_range_allows("[1.20,1.20.2)", "1.20.1") && !maven_range_allows("[1.20,1.20.2)", "1.20.2"));
        for v in ["1.16.5", "1.18.2", "1.19.2", "1.20", "1.20.1", "1.21", "1.21.1", "1.21.4", "26.3"] {
            assert!(build_for(Some("fabric"), v).is_some() && build_for(Some("quilt"), v).is_some(), "{v}");
        }
        assert!(build_for(Some("fabric"), "1.20.2").is_none() && build_for(Some("fabric"), "26.2").is_none());
        // Forge — только 1.20–1.20.1; NeoForge и ванилла — без мода
        assert!(build_for(Some("forge"), "1.20.1").is_some() && build_for(Some("forge"), "1.20").is_some());
        assert!(build_for(Some("forge"), "1.19.2").is_none() && build_for(Some("forge"), "1.21.1").is_none());
        assert!(build_for(Some("neoforge"), "1.20.1").is_none() && build_for(None, "1.20.1").is_none());
        // Сборка Fabric не должна попасть в Forge и наоборот
        assert!(!std::ptr::eq(
            build_for(Some("forge"), "1.20.1").unwrap().jar,
            build_for(Some("fabric"), "1.20.1").unwrap().jar
        ));
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
