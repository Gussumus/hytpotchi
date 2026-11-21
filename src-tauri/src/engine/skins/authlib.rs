//! Скины и плащи аккаунтов Hytpotchi на любой версии, включая ваниллу без модов.
//!
//! Игра запускается с Java-агентом authlib-injector (открытый проект, не мод). Он перенаправляет
//! запросы Minecraft к серверам Mojang (профили, текстуры, вход в мир) на API Yggdrasil сервера
//! Hytpotchi (`<сервер>/yggdrasil`), и игра показывает скины и плащи всех игроков Hytpotchi.
//! Вход в мир тоже идёт через сервер Hytpotchi: игрок подтверждает его токеном своего аккаунта.

use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{Context, Result, bail};
use base64::Engine as _;
use serde::Deserialize;

use crate::engine::core::http::{HttpClient, VerifiedDownload};
use crate::engine::core::paths::{cache_dir, ensure_dir};

const LATEST: &str = "https://authlib-injector.yushi.moe/artifact/latest.json";
const GITHUB: &str = "https://github.com/yushijinhun/authlib-injector/releases/download";

#[derive(Deserialize)]
struct Latest {
    version: String,
    download_url: String,
    checksums: Checksums,
}

#[derive(Deserialize)]
struct Checksums {
    sha256: String,
}

/// Адрес API для authlib-injector на сервере Hytpotchi
pub fn api_root(server: &str) -> String {
    format!("{}/yggdrasil", server.trim_end_matches('/'))
}

fn jar_dir() -> Result<PathBuf> {
    let dir = cache_dir()?.join("authlib-injector");
    ensure_dir(&dir)?;
    Ok(dir)
}

/// Уже скачанный authlib-injector (самый свежий по имени файла)
fn cached_jar(dir: &Path) -> Option<PathBuf> {
    let mut jars: Vec<PathBuf> = std::fs::read_dir(dir)
        .ok()?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.starts_with("authlib-injector-") && n.ends_with(".jar"))
        })
        .collect();
    jars.sort_by_key(|p| version_key(p));
    jars.pop()
}

/// Ключ сортировки по версии из имени `authlib-injector-1.2.8.jar`
fn version_key(path: &Path) -> Vec<u32> {
    path.file_stem()
        .and_then(|n| n.to_str())
        .and_then(|n| n.strip_prefix("authlib-injector-"))
        .map(|v| v.split('.').filter_map(|x| x.parse().ok()).collect())
        .unwrap_or_default()
}

/// Скачать (или взять уже скачанный) authlib-injector с проверкой SHA-256
pub async fn ensure_jar(http: &HttpClient) -> Result<PathBuf> {
    let dir = jar_dir()?;
    let latest = tokio::time::timeout(Duration::from_secs(15), http.get_json::<Latest>(LATEST)).await;
    let latest = match latest {
        Ok(Ok(l)) => l,
        _ => {
            // Без сети к сайту authlib-injector — играем с тем, что уже скачано
            return cached_jar(&dir).context("Не удалось скачать authlib-injector (нужен для скинов)");
        }
    };
    if !latest.version.chars().all(|c| c.is_ascii_digit() || c == '.') {
        bail!("Странная версия authlib-injector: {}", latest.version);
    }
    let dest = dir.join(format!("authlib-injector-{}.jar", latest.version));
    let expected = VerifiedDownload::new().with_sha256(&latest.checksums.sha256);
    if dest.exists() {
        if let Ok(bytes) = tokio::fs::read(&dest).await {
            use sha2::Digest;
            if hex::encode(sha2::Sha256::digest(&bytes)) == latest.checksums.sha256.to_lowercase() {
                return Ok(dest);
            }
        }
    }
    let mirror = format!("{GITHUB}/v{0}/authlib-injector-{0}.jar", latest.version);
    let result = match http.download_verified(&latest.download_url, &dest, expected.clone()).await {
        Ok(()) => Ok(()),
        Err(_) => http.download_verified(&mirror, &dest, expected).await,
    };
    match result {
        Ok(()) => {
            log::info!("authlib-injector {} скачан", latest.version);
            Ok(dest)
        }
        Err(e) => cached_jar(&dir).ok_or(e).context("Не удалось скачать authlib-injector (нужен для скинов)"),
    }
}

/// Метаданные API заранее (передаются в игру, чтобы она не ждала сервер при запуске)
pub async fn prefetch(http: &HttpClient, api: &str) -> Option<String> {
    let resp = http.oneshot.get(format!("{api}/")).timeout(Duration::from_secs(10)).send().await.ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let body = resp.bytes().await.ok()?;
    // Только если сервер уже умеет подписывать текстуры
    let v: serde_json::Value = serde_json::from_slice(&body).ok()?;
    v.get("signaturePublickey")?;
    Some(base64::engine::general_purpose::STANDARD.encode(&body))
}

/// Аргументы JVM для запуска с authlib-injector
pub fn jvm_args(jar: &Path, api: &str, prefetched: Option<&str>) -> Vec<String> {
    let mut args = vec![format!("-javaagent:{}={api}", jar.display())];
    if let Some(p) = prefetched {
        args.push(format!("-Dauthlibinjector.yggdrasil.prefetched={p}"));
    }
    args
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn args_and_versions() {
        assert_eq!(api_root("https://srv.example.dev/"), "https://srv.example.dev/yggdrasil");
        let args = jvm_args(Path::new("C:/cache/authlib-injector-1.2.8.jar"), "https://srv/yggdrasil", Some("e30="));
        assert_eq!(args[0], "-javaagent:C:/cache/authlib-injector-1.2.8.jar=https://srv/yggdrasil");
        assert_eq!(args[1], "-Dauthlibinjector.yggdrasil.prefetched=e30=");
        assert!(version_key(Path::new("authlib-injector-1.10.0.jar")) > version_key(Path::new("authlib-injector-1.2.8.jar")));
    }

    /// План запуска ванильной версии с authlib-injector — для проверки в настоящей игре.
    /// GAME_VERSION=26.3 AUTHLIB_API=http://127.0.0.1:8799/yggdrasil AUTH_NICK=Ник AUTH_TOKEN=токен
    /// PLAN_OUT=plan.json cargo test --lib authlib_plan_live -- --ignored --nocapture
    #[tokio::test]
    #[ignore]
    async fn authlib_plan_live() {
        use crate::engine::game::install::{ensure_version_files, extract_natives, legacy_assets_dir};
        use crate::engine::game::java::{ensure_java, normalize_major};
        use crate::engine::game::manifest::resolve_version;
        use crate::engine::game::pipeline::plan::{GameAccount, LaunchContext, plan_launch};

        let env = |k: &str| std::env::var(k).unwrap_or_else(|_| panic!("нет {k}"));
        let http = HttpClient::new().unwrap();
        let manifest = resolve_version(&http, &env("GAME_VERSION")).await.unwrap();
        let java = ensure_java(&http, normalize_major(manifest.required_java()), &|_, _| {}).await.unwrap();
        ensure_version_files(&http, &manifest, &|_, _, _| {}).await.unwrap();
        let out = std::path::PathBuf::from(env("PLAN_OUT"));
        let base = out.parent().unwrap().to_path_buf();
        let natives = base.join("natives");
        extract_natives(&manifest, &natives).await.unwrap();
        let jar = ensure_jar(&http).await.unwrap();
        let api = env("AUTHLIB_API");
        let prefetched = prefetch(&http, &api).await.expect("сервер не ответил или нет ключа подписи");
        let extra = jvm_args(&jar, &api, Some(&prefetched));
        let nick = env("AUTH_NICK");
        let account = GameAccount {
            uuid: crate::engine::accounts::session::offline_uuid(&nick),
            username: nick,
            access_token: env("AUTH_TOKEN"),
            user_type: "mojang".into(),
        };
        let game_dir = base.join("game");
        let plan = plan_launch(LaunchContext {
            manifest: &manifest,
            java: &java,
            game_dir: &game_dir,
            natives_dir: &natives,
            game_assets_dir: legacy_assets_dir(&manifest).unwrap(),
            memory_mb: 2048,
            extra_jvm_args: &extra,
            account: &account,
            server: None,
        })
        .unwrap();
        let json = serde_json::json!({
            "java": plan.java_executable, "args": plan.args, "cwd": plan.working_dir, "env": plan.environment,
        });
        std::fs::write(&out, serde_json::to_vec_pretty(&json).unwrap()).unwrap();
        println!("План записан: {} ({} аргументов)", out.display(), plan.args.len());
    }
}
