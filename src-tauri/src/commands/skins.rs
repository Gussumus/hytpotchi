//! Скины и плащи (Minecraft Services API) + локальная библиотека скинов

use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State, command};
use tauri_plugin_dialog::DialogExt;

use crate::engine::accounts::session::AccountStore;
use crate::engine::accounts::vault::{TokenVault, game_session};
use crate::engine::core::http::HttpClient;
use crate::engine::core::paths::app_dir;
use crate::engine::core::settings::{self, LauncherSettings};
use crate::engine::skins::shared;

const PROFILE: &str = "https://api.minecraftservices.com/minecraft/profile";

type CmdResult<T> = Result<T, String>;

fn err(e: anyhow::Error) -> String {
    format!("{e:#}")
}

fn data_url(bytes: &[u8]) -> String {
    format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes))
}

/// Проверить, что это PNG-скин 64×64 или 64×32
fn validate_skin(bytes: &[u8]) -> Result<()> {
    if bytes.len() < 24 || &bytes[..8] != b"\x89PNG\r\n\x1a\n" {
        bail!("Это не PNG-файл");
    }
    let w = u32::from_be_bytes(bytes[16..20].try_into().unwrap());
    let h = u32::from_be_bytes(bytes[20..24].try_into().unwrap());
    if !(w == 64 && (h == 64 || h == 32)) {
        bail!("Скин должен быть 64×64 или 64×32 пикселя (сейчас {w}×{h})");
    }
    if bytes.len() > 1024 * 1024 {
        bail!("Файл скина слишком большой");
    }
    Ok(())
}

async fn token(
    http: &HttpClient,
    vault: &TokenVault,
    store: &AccountStore,
    account_id: &str,
) -> Result<String> {
    let account = store.get(account_id).context("Аккаунт не найден")?;
    if account.kind.offline_mode() {
        bail!("Плащи и загрузка скина на серверы Mojang доступны только для аккаунтов Microsoft");
    }
    Ok(game_session(http, vault, store, &account).await?.access_token)
}

#[derive(Deserialize)]
struct ApiProfile {
    name: String,
    id: String,
    #[serde(default)]
    skins: Vec<ApiSkin>,
    #[serde(default)]
    capes: Vec<ApiCape>,
}

#[derive(Deserialize)]
struct ApiSkin {
    state: String,
    url: String,
    #[serde(default)]
    variant: Option<String>,
}

#[derive(Deserialize)]
struct ApiCape {
    id: String,
    state: String,
    url: String,
    #[serde(default)]
    alias: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CapeView {
    pub id: String,
    pub name: String,
    pub active: bool,
    pub image: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkinProfile {
    pub username: String,
    pub uuid: String,
    /// Текущий скин (data URL PNG)
    pub skin: Option<String>,
    /// classic | slim
    pub variant: String,
    pub capes: Vec<CapeView>,
    /// Результат публикации офлайн-скина на общий сервер
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shared: Option<SharedStatus>,
}

async fn fetch_png(http: &HttpClient, url: &str) -> Option<String> {
    // textures.minecraft.net отдаёт по http — переводим на https
    let url = url.replacen("http://", "https://", 1);
    let bytes = http.get(&url).await.ok()?.bytes().await.ok()?;
    Some(data_url(&bytes))
}

async fn load_profile(http: &HttpClient, token: &str) -> Result<SkinProfile> {
    let resp = http.client.get(PROFILE).bearer_auth(token).send().await?;
    if !resp.status().is_success() {
        bail!("Профиль Minecraft недоступен ({})", resp.status());
    }
    let p: ApiProfile = resp.json().await?;
    let active = p.skins.iter().find(|s| s.state == "ACTIVE");
    let skin = match active {
        Some(s) => fetch_png(http, &s.url).await,
        None => None,
    };
    let mut capes = Vec::new();
    for c in &p.capes {
        capes.push(CapeView {
            id: c.id.clone(),
            name: c.alias.clone().unwrap_or_else(|| "Плащ".into()),
            active: c.state == "ACTIVE",
            image: fetch_png(http, &c.url).await,
        });
    }
    Ok(SkinProfile {
        username: p.name,
        uuid: p.id,
        skin,
        variant: active
            .and_then(|s| s.variant.clone())
            .unwrap_or_else(|| "CLASSIC".into())
            .to_lowercase(),
        capes,
        shared: None,
    })
}

/// PNG скина из библиотеки
pub fn library_skin_bytes(skin_id: &str) -> Result<Vec<u8>> {
    if skin_id.is_empty() || !skin_id.chars().all(|c| c.is_ascii_alphanumeric()) {
        bail!("Неверный скин");
    }
    Ok(std::fs::read(library_dir()?.join(format!("{skin_id}.png")))?)
}

/// Свой плащ аккаунта Hytpotchi (копия того, что загружен на сервер)
fn cape_path(account_id: &str) -> Result<PathBuf> {
    if account_id.is_empty() || !account_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        bail!("Неверный аккаунт");
    }
    let dir = app_dir()?.join("capes");
    std::fs::create_dir_all(&dir)?;
    Ok(dir.join(format!("{account_id}.png")))
}

/// PNG плаща: ширина вдвое больше высоты, 64…512 (как принимает сервер)
fn validate_cape(bytes: &[u8]) -> Result<()> {
    if bytes.len() < 24 || &bytes[..8] != b"\x89PNG\r\n\x1a\n" {
        bail!("Это не PNG-файл");
    }
    let w = u32::from_be_bytes(bytes[16..20].try_into().unwrap());
    let h = u32::from_be_bytes(bytes[20..24].try_into().unwrap());
    if ![64, 128, 256, 512].contains(&w) || h * 2 != w {
        bail!("Плащ должен быть 64×32, 128×64, 256×128 или 512×256 пикселей (сейчас {w}×{h})");
    }
    if bytes.len() > 256 * 1024 {
        bail!("Файл плаща слишком большой (до 256 КБ)");
    }
    Ok(())
}

/// Профиль аккаунта Hytpotchi: скин из библиотеки и свой плащ
fn offline_profile(account: &crate::engine::accounts::session::Account) -> SkinProfile {
    let skin = account
        .offline_skin
        .as_deref()
        .and_then(|id| library_skin_bytes(id).ok())
        .map(|b| data_url(&b));
    SkinProfile {
        username: account.username.clone(),
        uuid: account.uuid.clone(),
        variant: if skin.is_some() {
            account.offline_variant.clone().unwrap_or_else(|| "classic".into())
        } else {
            "classic".into()
        },
        skin,
        capes: cape_path(&account.id)
            .ok()
            .and_then(|p| std::fs::read(p).ok())
            .map(|png| CapeView { id: "hytpotchi".into(), name: "Свой плащ".into(), active: true, image: Some(data_url(&png)) })
            .into_iter()
            .collect(),
        shared: None,
    }
}

/// Загрузить свой плащ аккаунта Hytpotchi (виден всем игрокам Hytpotchi, и на ванилле)
#[command]
pub async fn hytpotchi_cape_upload(
    app: AppHandle,
    http: State<'_, HttpClient>,
    vault: State<'_, TokenVault>,
    store: State<'_, AccountStore>,
    account_id: String,
) -> CmdResult<Option<SkinProfile>> {
    let account = offline_account(&store, &account_id).ok_or("Свой плащ — только для аккаунтов Hytpotchi")?;
    let picked = app
        .dialog()
        .file()
        .set_title("Плащ Minecraft (PNG 64×32)")
        .add_filter("PNG", &["png"])
        .blocking_pick_file();
    let Some(picked) = picked else { return Ok(None) };
    let path = picked.into_path().map_err(|e| e.to_string())?;
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    validate_cape(&bytes).map_err(err)?;
    let server = settings::skin_server().ok_or("Нет сервера Hytpotchi")?;
    shared::put_cape(&http, &vault, &server, &account, bytes.clone()).await.map_err(err)?;
    std::fs::write(cape_path(&account.id).map_err(err)?, &bytes).map_err(|e| e.to_string())?;
    Ok(Some(offline_profile(&account)))
}

/// Каталог косметики (для выбора и 3D-просмотра)
#[command]
pub async fn cosmetics_catalog(http: State<'_, HttpClient>) -> CmdResult<serde_json::Value> {
    let server = settings::skin_server().ok_or("Нет сервера Hytpotchi")?;
    crate::engine::skins::cosmetics::catalog(&http, &server).await.map_err(err)
}

/// Что надето у аккаунта Hytpotchi
#[command]
pub async fn cosmetics_get(
    http: State<'_, HttpClient>,
    store: State<'_, AccountStore>,
    account_id: String,
) -> CmdResult<Vec<String>> {
    let account = offline_account(&store, &account_id).ok_or("Косметика — только для аккаунтов Hytpotchi")?;
    let server = settings::skin_server().ok_or("Нет сервера Hytpotchi")?;
    crate::engine::skins::cosmetics::selection(&http, &server, &account.username).await.map_err(err)
}

/// Надеть набор косметики (можно несколько предметов сразу)
#[command]
pub async fn cosmetics_set(
    http: State<'_, HttpClient>,
    vault: State<'_, TokenVault>,
    store: State<'_, AccountStore>,
    account_id: String,
    items: Vec<String>,
) -> CmdResult<Vec<String>> {
    let account = offline_account(&store, &account_id).ok_or("Косметика — только для аккаунтов Hytpotchi")?;
    let server = settings::skin_server().ok_or("Нет сервера Hytpotchi")?;
    crate::engine::skins::cosmetics::set_selection(&http, &vault, &server, &account, &items).await.map_err(err)
}

/// Снять свой плащ
#[command]
pub async fn hytpotchi_cape_remove(
    http: State<'_, HttpClient>,
    vault: State<'_, TokenVault>,
    store: State<'_, AccountStore>,
    account_id: String,
) -> CmdResult<SkinProfile> {
    let account = offline_account(&store, &account_id).ok_or("Свой плащ — только для аккаунтов Hytpotchi")?;
    let server = settings::skin_server().ok_or("Нет сервера Hytpotchi")?;
    shared::delete_cape(&http, &vault, &server, &account).await.map_err(err)?;
    if let Ok(p) = cape_path(&account.id) {
        let _ = std::fs::remove_file(p);
    }
    Ok(offline_profile(&account))
}

fn offline_account(store: &AccountStore, account_id: &str) -> Option<crate::engine::accounts::session::Account> {
    // Скин из библиотеки + общий сервер — у аккаунтов Hytpotchi (и у старых офлайн, чтобы показать их скин)
    store.get(account_id).filter(|a| a.kind.offline_mode())
}

#[command]
pub async fn skin_profile(
    http: State<'_, HttpClient>,
    vault: State<'_, TokenVault>,
    store: State<'_, AccountStore>,
    account_id: String,
) -> CmdResult<SkinProfile> {
    if let Some(account) = offline_account(&store, &account_id) {
        return Ok(offline_profile(&account));
    }
    let token = token(&http, &vault, &store, &account_id).await.map_err(err)?;
    load_profile(&http, &token).await.map_err(err)
}

async fn upload(http: &HttpClient, token: &str, bytes: Vec<u8>, variant: &str) -> Result<()> {
    validate_skin(&bytes)?;
    let variant = if variant == "slim" { "slim" } else { "classic" };
    let part = reqwest::multipart::Part::bytes(bytes).file_name("skin.png").mime_str("image/png")?;
    let form = reqwest::multipart::Form::new().text("variant", variant).part("file", part);
    let resp = http
        .client
        .post(format!("{PROFILE}/skins"))
        .bearer_auth(token)
        .multipart(form)
        .send()
        .await?;
    if !resp.status().is_success() {
        bail!("Mojang не принял скин: {}", resp.text().await.unwrap_or_default());
    }
    Ok(())
}

// ---------- Библиотека ----------

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LibrarySkin {
    pub id: String,
    pub name: String,
    pub variant: String,
    #[serde(default)]
    pub image: String,
}

fn library_dir() -> Result<PathBuf> {
    let dir = app_dir()?.join("skins");
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

fn library_meta(dir: &Path) -> Vec<LibrarySkin> {
    std::fs::read(dir.join("library.json"))
        .ok()
        .and_then(|d| serde_json::from_slice(&d).ok())
        .unwrap_or_default()
}

fn save_meta(dir: &Path, items: &[LibrarySkin]) -> Result<()> {
    let stripped: Vec<LibrarySkin> = items.iter().map(|s| LibrarySkin { image: String::new(), ..s.clone() }).collect();
    std::fs::write(dir.join("library.json"), serde_json::to_vec_pretty(&stripped)?)?;
    Ok(())
}

fn add_to_library(bytes: &[u8], name: &str, variant: &str) -> Result<LibrarySkin> {
    validate_skin(bytes)?;
    let dir = library_dir()?;
    let mut items = library_meta(&dir);
    let id = uuid::Uuid::new_v4().simple().to_string();
    std::fs::write(dir.join(format!("{id}.png")), bytes)?;
    let skin = LibrarySkin {
        id,
        name: name.chars().take(40).collect(),
        variant: if variant == "slim" { "slim".into() } else { "classic".into() },
        image: data_url(bytes),
    };
    items.push(skin.clone());
    save_meta(&dir, &items)?;
    Ok(skin)
}

#[command]
pub async fn skin_library() -> CmdResult<Vec<LibrarySkin>> {
    let dir = library_dir().map_err(err)?;
    Ok(library_meta(&dir)
        .into_iter()
        .filter_map(|mut s| {
            let bytes = std::fs::read(dir.join(format!("{}.png", s.id))).ok()?;
            s.image = data_url(&bytes);
            Some(s)
        })
        .collect())
}

/// Добавить скин из файла в библиотеку
#[command]
pub async fn skin_library_add(app: AppHandle, variant: String) -> CmdResult<Option<LibrarySkin>> {
    let picked = app
        .dialog()
        .file()
        .set_title("Скин Minecraft (PNG 64×64)")
        .add_filter("PNG", &["png"])
        .blocking_pick_file();
    let Some(picked) = picked else { return Ok(None) };
    let path = picked.into_path().map_err(|e| e.to_string())?;
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    let name = path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "Скин".into());
    add_to_library(&bytes, &name, &variant).map(Some).map_err(err)
}

#[command]
pub async fn skin_library_remove(id: String) -> CmdResult<()> {
    let dir = library_dir().map_err(err)?;
    let items: Vec<LibrarySkin> = library_meta(&dir).into_iter().filter(|s| s.id != id).collect();
    if id.chars().all(|c| c.is_ascii_alphanumeric()) {
        let _ = std::fs::remove_file(dir.join(format!("{id}.png")));
    }
    save_meta(&dir, &items).map_err(err)
}

/// Надеть скин из библиотеки
#[command]
pub async fn skin_apply(
    http: State<'_, HttpClient>,
    vault: State<'_, TokenVault>,
    store: State<'_, AccountStore>,
    account_id: String,
    skin_id: String,
    variant: Option<String>,
) -> CmdResult<SkinProfile> {
    if !skin_id.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err("Неверный скин".into());
    }
    let dir = library_dir().map_err(err)?;
    let meta = library_meta(&dir).into_iter().find(|s| s.id == skin_id).ok_or("Скин не найден")?;
    let bytes = std::fs::read(dir.join(format!("{skin_id}.png"))).map_err(|e| e.to_string())?;

    // Офлайн: запоминаем выбор, скин подхватит CustomSkinLoader при запуске
    if offline_account(&store, &account_id).is_some() {
        let variant = variant.unwrap_or(meta.variant);
        let slim = variant == "slim";
        let account = store
            .set_offline_skin(&account_id, Some((skin_id, variant)))
            .map_err(err)?;
        let mut profile = offline_profile(&account);
        // Публикуем на общий сервер, чтобы скин видели другие игроки Hytpotchi
        profile.shared = Some(match crate::engine::core::settings::skin_server() {
            Some(server) => match shared::publish(&http, &vault, &server, &account, bytes, slim).await {
                Ok(()) => SharedStatus::published(),
                Err(e) => SharedStatus::failed(format!("{e:#}")),
            },
            None => SharedStatus::not_configured(),
        });
        return Ok(profile);
    }

    let token = token(&http, &vault, &store, &account_id).await.map_err(err)?;
    upload(&http, &token, bytes, variant.as_deref().unwrap_or(&meta.variant))
        .await
        .map_err(err)?;
    load_profile(&http, &token).await.map_err(err)
}

/// Сбросить скин на стандартный
#[command]
pub async fn skin_reset(
    http: State<'_, HttpClient>,
    vault: State<'_, TokenVault>,
    store: State<'_, AccountStore>,
    account_id: String,
) -> CmdResult<SkinProfile> {
    if offline_account(&store, &account_id).is_some() {
        let account = store.set_offline_skin(&account_id, None).map_err(err)?;
        if let Some(server) = crate::engine::core::settings::skin_server() {
            if let Err(e) = shared::unpublish(&http, &vault, &server, &account).await {
                log::warn!("Не удалось убрать скин с сервера: {e:#}");
            }
        }
        return Ok(offline_profile(&account));
    }
    let token = token(&http, &vault, &store, &account_id).await.map_err(err)?;
    http.client
        .delete(format!("{PROFILE}/skins/active"))
        .bearer_auth(&token)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    load_profile(&http, &token).await.map_err(err)
}

/// Надеть плащ (`None` — снять)
#[command]
pub async fn cape_set(
    http: State<'_, HttpClient>,
    vault: State<'_, TokenVault>,
    store: State<'_, AccountStore>,
    account_id: String,
    cape_id: Option<String>,
) -> CmdResult<SkinProfile> {
    let token = token(&http, &vault, &store, &account_id).await.map_err(err)?;
    let req = match &cape_id {
        Some(id) => http
            .client
            .put(format!("{PROFILE}/capes/active"))
            .json(&serde_json::json!({ "capeId": id })),
        None => http.client.delete(format!("{PROFILE}/capes/active")),
    };
    let resp = req.bearer_auth(&token).send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("Не удалось сменить плащ ({})", resp.status()));
    }
    load_profile(&http, &token).await.map_err(err)
}

/// Сохранить текущий скин аккаунта в библиотеку
#[command]
pub async fn skin_save_current(
    http: State<'_, HttpClient>,
    vault: State<'_, TokenVault>,
    store: State<'_, AccountStore>,
    account_id: String,
) -> CmdResult<LibrarySkin> {
    let token = token(&http, &vault, &store, &account_id).await.map_err(err)?;
    let profile = load_profile(&http, &token).await.map_err(err)?;
    let image = profile.skin.ok_or("У аккаунта нет своего скина")?;
    let b64 = image.trim_start_matches("data:image/png;base64,");
    let bytes = base64::engine::general_purpose::STANDARD.decode(b64).map_err(|e| e.to_string())?;
    add_to_library(&bytes, &profile.username, &profile.variant).map_err(err)
}

// ---------- Общие офлайн-скины ----------

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SharedStatus {
    /// published | failed | not_configured
    pub state: String,
    pub message: String,
}

impl SharedStatus {
    fn published() -> Self {
        Self { state: "published".into(), message: "Скин опубликован — его видят другие игроки Hytpotchi".into() }
    }
    fn failed(message: String) -> Self {
        Self { state: "failed".into(), message: format!("Скин надет только у вас: {message}") }
    }
    fn not_configured() -> Self {
        Self {
            state: "not_configured".into(),
            message: "Скин надет только у вас: сервер скинов не настроен (Настройки → Общие скины)".into(),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedSkinsView {
    pub enabled: bool,
    /// Адрес из настроек (пусто — используется встроенный)
    pub custom_server: Option<String>,
    /// Итоговый адрес, которым пользуется лаунчер
    pub server: Option<String>,
}

#[command]
pub async fn shared_skins_get() -> CmdResult<SharedSkinsView> {
    let s = settings::load();
    Ok(SharedSkinsView { enabled: s.shared_skins, custom_server: s.skin_server.clone(), server: settings::skin_server() })
}

/// Сохранить настройки общих скинов (адрес проверяется перед сохранением)
#[command]
pub async fn shared_skins_set(
    http: State<'_, HttpClient>,
    enabled: bool,
    server: Option<String>,
) -> CmdResult<SharedSkinsView> {
    let server = match server.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()) {
        Some(url) => {
            let url = settings::normalize_server(&url).map_err(err)?;
            shared::check(&http, &url).await.map_err(err)?;
            Some(url)
        }
        None => None,
    };
    // Остальные настройки (например, друзей) не трогаем
    settings::save(&LauncherSettings { skin_server: server, shared_skins: enabled, ..settings::load() }).map_err(err)?;
    shared_skins_get().await
}

/// Опубликовать текущий офлайн-скин заново (например, после настройки сервера)
#[command]
pub async fn skin_publish(
    http: State<'_, HttpClient>,
    vault: State<'_, TokenVault>,
    store: State<'_, AccountStore>,
    account_id: String,
) -> CmdResult<SharedStatus> {
    let account = offline_account(&store, &account_id).ok_or("Публикация нужна только аккаунтам Hytpotchi")?;
    let skin_id = account.offline_skin.clone().ok_or("Сначала наденьте скин")?;
    let bytes = library_skin_bytes(&skin_id).map_err(err)?;
    let slim = account.offline_variant.as_deref() == Some("slim");
    Ok(match settings::skin_server() {
        Some(server) => match shared::publish(&http, &vault, &server, &account, bytes, slim).await {
            Ok(()) => SharedStatus::published(),
            Err(e) => SharedStatus::failed(format!("{e:#}")),
        },
        None => SharedStatus::not_configured(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn png(w: u32, h: u32) -> Vec<u8> {
        let mut b = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR".to_vec();
        b.extend(w.to_be_bytes());
        b.extend(h.to_be_bytes());
        b
    }

    #[test]
    fn skin_size_validation() {
        assert!(validate_skin(&png(64, 64)).is_ok());
        assert!(validate_skin(&png(64, 32)).is_ok());
        assert!(validate_skin(&png(128, 128)).is_err());
        assert!(validate_skin(b"not a png at all, sorry!").is_err());
    }
}
