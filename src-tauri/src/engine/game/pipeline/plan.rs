//! План запуска — чистая функция: манифест + окружение → командная строка JVM

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};

use crate::engine::core::paths::{assets_dir, libraries_dir, version_jar_path};
use crate::engine::game::java::JavaRuntime;
use crate::engine::game::manifest::{ArgValue, Argument, VersionManifest};

/// Данные игрока для подстановки в аргументы
#[derive(Clone)]
pub struct GameAccount {
    pub uuid: String,
    pub username: String,
    pub access_token: String,
    /// "msa" для Microsoft, "legacy" для офлайн
    pub user_type: String,
}

impl std::fmt::Debug for GameAccount {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("GameAccount")
            .field("username", &self.username)
            .field("user_type", &self.user_type)
            .finish_non_exhaustive()
    }
}

/// Параметры запуска
pub struct LaunchContext<'a> {
    pub manifest: &'a VersionManifest,
    pub java: &'a JavaRuntime,
    pub game_dir: &'a Path,
    pub natives_dir: &'a Path,
    pub game_assets_dir: Option<PathBuf>,
    pub memory_mb: u32,
    pub extra_jvm_args: &'a [String],
    pub account: &'a GameAccount,
    /// Сразу зайти на сервер "host[:port]"
    pub server: Option<&'a str>,
}

/// Поддерживает ли версия Quick Play (1.20+): в манифесте есть аргумент quickPlayMultiplayer
fn supports_quick_play(m: &VersionManifest) -> bool {
    m.arguments.as_ref().is_some_and(|a| {
        a.game.iter().any(|arg| match arg {
            Argument::Plain(s) => s.contains("quickPlayMultiplayer"),
            Argument::Ruled { value, .. } => match value {
                ArgValue::One(s) => s.contains("quickPlayMultiplayer"),
                ArgValue::Many(v) => v.iter().any(|s| s.contains("quickPlayMultiplayer")),
            },
        })
    })
}

#[derive(Debug, Clone)]
pub struct LaunchPlan {
    pub java_executable: PathBuf,
    pub args: Vec<String>,
    pub working_dir: PathBuf,
    pub environment: HashMap<String, String>,
}

/// Флаги G1 GC (в духе флагов Aikar) — работают на Java 8–25
fn gc_flags() -> Vec<String> {
    [
        "-XX:+UseG1GC",
        "-XX:+ParallelRefProcEnabled",
        "-XX:MaxGCPauseMillis=200",
        "-XX:+UnlockExperimentalVMOptions",
        "-XX:+DisableExplicitGC",
        "-XX:G1NewSizePercent=30",
        "-XX:G1MaxNewSizePercent=40",
        "-XX:G1HeapRegionSize=8M",
        "-XX:G1ReservePercent=20",
        "-XX:G1HeapWastePercent=5",
        "-XX:G1MixedGCCountTarget=4",
        "-XX:InitiatingHeapOccupancyPercent=15",
        "-XX:G1MixedGCLiveThresholdPercent=90",
        "-XX:SurvivorRatio=32",
        "-XX:+PerfDisableSharedMem",
        "-XX:MaxTenuringThreshold=1",
    ]
    .into_iter()
    .map(String::from)
    .collect()
}

fn substitute(arg: &str, vars: &HashMap<&str, String>) -> String {
    if !arg.contains("${") {
        return arg.to_string();
    }
    let mut out = arg.to_string();
    for (key, value) in vars {
        out = out.replace(&format!("${{{key}}}"), value);
    }
    out
}

pub fn plan_launch(ctx: LaunchContext<'_>) -> Result<LaunchPlan> {
    let m = ctx.manifest;
    let libs = libraries_dir()?;
    let assets = assets_dir()?;
    let sep = if cfg!(target_os = "windows") { ";" } else { ":" };

    let client_jar = version_jar_path(&m.jar_id)?;
    let mut classpath: Vec<String> = m
        .classpath_entries()
        .into_iter()
        .map(|p| libs.join(p).to_string_lossy().into_owned())
        .collect();
    classpath.push(client_jar.to_string_lossy().into_owned());

    let asset_index = m
        .asset_index
        .as_ref()
        .map(|a| a.id.clone())
        .or_else(|| m.assets.clone())
        .unwrap_or_else(|| "legacy".into());
    let game_assets = ctx.game_assets_dir.clone().unwrap_or_else(|| assets.clone());

    let mut vars: HashMap<&str, String> = HashMap::new();
    vars.insert("auth_player_name", ctx.account.username.clone());
    vars.insert("auth_uuid", ctx.account.uuid.clone());
    vars.insert("auth_access_token", ctx.account.access_token.clone());
    vars.insert(
        "auth_session",
        format!("token:{}:{}", ctx.account.access_token, ctx.account.uuid),
    );
    vars.insert("auth_xuid", "0".into());
    vars.insert("clientid", "0".into());
    vars.insert("user_type", ctx.account.user_type.clone());
    vars.insert("user_properties", "{}".into());
    vars.insert("version_name", m.id.clone());
    vars.insert("version_type", "Hytpotchi".into());
    vars.insert("game_directory", ctx.game_dir.to_string_lossy().into_owned());
    vars.insert("assets_root", assets.to_string_lossy().into_owned());
    vars.insert("game_assets", game_assets.to_string_lossy().into_owned());
    vars.insert("assets_index_name", asset_index);
    vars.insert("natives_directory", ctx.natives_dir.to_string_lossy().into_owned());
    vars.insert("launcher_name", "Hytpotchi".into());
    vars.insert("launcher_version", env!("CARGO_PKG_VERSION").into());
    vars.insert("classpath", classpath.join(sep));
    vars.insert("classpath_separator", sep.into());
    vars.insert("library_directory", libs.to_string_lossy().into_owned());
    vars.insert("primary_jar", client_jar.to_string_lossy().into_owned());

    // --- JVM ---
    let memory = ctx.memory_mb.max(512);
    let mut args = vec![
        format!("-Xmx{memory}M"),
        format!("-Xms{}M", (memory / 2).max(512)),
        "-Dfile.encoding=UTF-8".into(),
        "-Dstdout.encoding=UTF-8".into(),
        "-Dstderr.encoding=UTF-8".into(),
    ];
    args.extend(gc_flags());

    let manifest_jvm: Vec<String> = m
        .arguments
        .as_ref()
        .map(|a| a.jvm.iter().flat_map(|arg| arg.resolve()).collect())
        .unwrap_or_default();
    if manifest_jvm.is_empty() {
        // Старый формат манифеста: аргументы JVM не описаны
        args.extend([
            "-Djava.library.path=${natives_directory}".to_string(),
            "-Dminecraft.launcher.brand=${launcher_name}".into(),
            "-Dminecraft.launcher.version=${launcher_version}".into(),
            "-cp".into(),
            "${classpath}".into(),
        ]);
    } else {
        args.extend(manifest_jvm);
    }

    if let Some(log) = m.logging.as_ref().and_then(|l| l.client.as_ref()) {
        let path = assets.join("log_configs").join(&log.file.id);
        if path.exists() {
            args.push(log.argument.replace("${path}", &path.to_string_lossy()));
        }
    }
    args.extend(ctx.extra_jvm_args.iter().cloned());

    // --- Главный класс и аргументы игры ---
    args.push(m.main_class.clone().context("Нет mainClass")?);
    match (&m.arguments, &m.minecraft_arguments) {
        (Some(a), _) if !a.game.is_empty() => {
            args.extend(a.game.iter().flat_map(|arg| arg.resolve()));
        }
        (_, Some(legacy)) => args.extend(legacy.split_whitespace().map(String::from)),
        _ => {}
    }

    if let Some(server) = ctx.server.filter(|s| !s.trim().is_empty()) {
        if supports_quick_play(m) {
            args.push("--quickPlayMultiplayer".into());
            args.push(server.trim().to_string());
        } else {
            let (host, port) = crate::engine::game::ping::split_address(server);
            args.extend(["--server".into(), host, "--port".into(), port.to_string()]);
        }
    }

    let args = args.iter().map(|a| substitute(a, &vars)).collect();

    let mut environment = HashMap::new();
    environment.insert("JAVA_HOME".into(), ctx.java.path.to_string_lossy().into_owned());

    Ok(LaunchPlan {
        java_executable: ctx.java.executable.clone(),
        args,
        working_dir: ctx.game_dir.to_path_buf(),
        environment,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn substitution() {
        let mut vars = HashMap::new();
        vars.insert("auth_player_name", "Steve".to_string());
        assert_eq!(substitute("--username=${auth_player_name}", &vars), "--username=Steve");
        assert_eq!(substitute("plain", &vars), "plain");
    }

    #[test]
    fn gc_flags_have_no_java21_only_options() {
        assert!(!gc_flags().iter().any(|f| f.contains("ZGenerational")));
    }
}
