//! Подготовка и запуск сборки: загрузчик → версия → Java → файлы → аккаунт → JVM

use anyhow::{Context, Result, bail};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::engine::accounts::session::{AccountStore, require};
use crate::engine::accounts::vault::{TokenVault, game_session};
use crate::engine::core::http::HttpClient;
use crate::engine::core::paths::{instance_game_dir, instance_natives_dir, version_json_path};
use crate::engine::game::install::{
    ensure_version_files, extract_natives, install_loader, latest_loader_version, legacy_assets_dir,
    loader_version_cmp,
};
use crate::engine::game::java::{ensure_java, normalize_major};
use crate::engine::game::loaders::{self, ForgeKind};
use crate::engine::game::manifest::resolve_version;
use crate::engine::accounts::session::AccountKind;
use crate::engine::game::now_playing::discord;
use crate::engine::skins::offline as offline_skin;
use crate::engine::game::pipeline::plan::{LaunchContext, plan_launch};
use crate::engine::game::pipeline::start::start_game;
use crate::engine::game::pipeline::watch::{GameLogEvent, GameWatcher};
use crate::engine::profiles::store;

/// Событие прогресса для интерфейса
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchProgress {
    pub instance_id: String,
    /// loader | version | java | client | libraries | assets | natives | account | starting | running
    pub stage: String,
    pub label: String,
    pub done: u64,
    pub total: u64,
}

fn stage_label(stage: &str) -> &'static str {
    match stage {
        "loader" => "Установка загрузчика (первый раз — до пары минут)",
        "version" => "Получение версии",
        "java" => "Загрузка Java",
        "client" => "Загрузка клиента",
        "libraries" => "Загрузка библиотек",
        "assets" => "Загрузка ресурсов",
        "natives" => "Распаковка нативов",
        "account" => "Проверка аккаунта",
        "starting" => "Запуск игры",
        "running" => "Игра запущена",
        _ => "Подготовка",
    }
}

/// Полный запуск сборки. Возвращает PID игры.
fn loader_title(loader: Option<&str>) -> &'static str {
    match loader {
        Some("fabric") => "Fabric",
        Some("forge") => "Forge",
        Some("neoforge") => "NeoForge",
        Some("quilt") => "Quilt",
        _ => "Minecraft",
    }
}

pub async fn launch_instance(app: &AppHandle, instance_id: &str, server: Option<&str>) -> Result<u32> {
    let watcher = app.state::<GameWatcher>().inner().clone();
    let _guard = watcher
        .begin_prepare(instance_id)
        .context("Сборка уже запускается или запущена")?;

    let http = app.state::<HttpClient>().inner().clone();
    let vault = app.state::<TokenVault>().inner().clone();

    let emit = |stage: &str, done: u64, total: u64| {
        let label = if stage == "java" {
            format!("{} · {:.0} / {:.0} МБ", stage_label(stage), done as f64 / 1e6, total as f64 / 1e6)
        } else {
            stage_label(stage).to_string()
        };
        let _ = app.emit(
            "launch-progress",
            LaunchProgress {
                instance_id: instance_id.to_string(),
                stage: stage.to_string(),
                label,
                done,
                total,
            },
        );
    };

    let mut instance = store::get(instance_id)?;
    let java_progress = |done: u64, total: Option<u64>| emit("java", done, total.unwrap_or(0));
    let file_progress = |stage: &str, done: u64, total: u64| emit(stage, done, total);
    let console = |line: String| {
        watcher.push_external_log(instance_id, line.clone());
        let _ = app.emit(
            "game-log",
            GameLogEvent { instance_id: instance_id.to_string(), line, stderr: false },
        );
    };

    // 0. Раньше для Quilt выбиралась устаревшая версия (список в мета-API не отсортирован),
    // и новые версии игры падали с «Unsupported class file major version». Если в сборке
    // записан Quilt старее актуального стабильного — переустанавливаем загрузчик.
    if instance.loader.as_deref() == Some("quilt") {
        if let Some(current) = instance.loader_version.clone() {
            if let Ok(latest) =
                latest_loader_version(&http, "quilt", &instance.game_version).await
            {
                if loader_version_cmp(&current, &latest).is_lt() {
                    console(format!("Обновляю Quilt Loader {current} → {latest}"));
                    instance.loader_version = Some(latest);
                    instance.version_id = None;
                }
            }
        }
    }

    // 1. Загрузчик — ставится один раз
    let installed = instance
        .version_id
        .as_ref()
        .filter(|id| version_json_path(id).map(|p| p.exists()).unwrap_or(false))
        .cloned();
    let version_id = match (&instance.loader, installed) {
        (None, _) => instance.game_version.clone(),
        (Some(_), Some(id)) => id,
        (Some(loader), None) => {
            emit("loader", 0, 1);
            let (id, loader_version) = match ForgeKind::parse(loader) {
                Some(kind) => {
                    // Установщику Forge нужны ванильные файлы и Java этой версии
                    let vanilla = resolve_version(&http, &instance.game_version).await?;
                    emit("java", 0, 0);
                    let java =
                        ensure_java(&http, normalize_major(vanilla.required_java()), &java_progress).await?;
                    ensure_version_files(&http, &vanilla, &file_progress).await?;
                    emit("loader", 0, 1);
                    loaders::install(
                        &http,
                        kind,
                        &instance.game_version,
                        instance.loader_version.as_deref(),
                        &java,
                        &console,
                    )
                    .await?
                }
                None => {
                    install_loader(&http, loader, &instance.game_version, instance.loader_version.as_deref())
                        .await?
                }
            };
            instance.version_id = Some(id.clone());
            instance.loader_version = Some(loader_version);
            store::save(&instance)?;
            id
        }
    };

    // 2. Манифест
    emit("version", 0, 1);
    let manifest = resolve_version(&http, &version_id).await?;

    // 3. Java — своя под каждую версию игры
    let major = normalize_major(manifest.required_java());
    emit("java", 0, 0);
    let java = ensure_java(&http, major, &java_progress).await?;
    log::info!("Minecraft {} → Java {}", instance.game_version, java.major_version);

    // 4. Клиент, библиотеки, ресурсы
    ensure_version_files(&http, &manifest, &file_progress).await?;

    // 5. Нативы
    emit("natives", 0, 1);
    let natives_dir = instance_natives_dir(instance_id)?;
    extract_natives(&manifest, &natives_dir).await?;

    // 6. Аккаунт
    emit("account", 0, 1);
    let accounts = app.state::<AccountStore>();
    let account = require(accounts.active())?;
    let session = game_session(&http, &vault, &accounts, &account).await?;

    // Скины через CustomSkinLoader (только в сборках с загрузчиком):
    // свой офлайн-скин + скины других игроков Hytpotchi с общего сервера
    {
        let game_dir = instance_game_dir(instance_id)?;
        let settings = crate::engine::core::settings::load();
        let server = settings
            .shared_skins
            .then(crate::engine::core::settings::skin_server)
            .flatten();
        let own_skin = if account.kind == AccountKind::Hytpotchi {
            account
                .offline_skin
                .as_deref()
                .and_then(|id| crate::commands::skins::library_skin_bytes(id).ok())
        } else {
            None
        };
        if account.kind == AccountKind::Hytpotchi && own_skin.is_none() {
            offline_skin::clear(&game_dir, &account.username);
        }

        match &instance.loader {
            Some(_) if own_skin.is_some() || server.is_some() => {
                let result = async {
                    if crate::commands::content::ensure_project(&http, &instance, offline_skin::CSL_PROJECT).await? {
                        console("Установлен CustomSkinLoader — он показывает офлайн-скины игроков Hytpotchi".into());
                    }
                    let own = own_skin.as_deref().map(|png| offline_skin::OwnSkin {
                        username: &account.username,
                        png,
                        slim: account.offline_variant.as_deref() == Some("slim"),
                    });
                    offline_skin::configure(&game_dir, own, server.as_deref())
                }
                .await;
                if let Err(e) = result {
                    console(format!("Скины не настроены: {e:#}"));
                }
            }
            None if own_skin.is_some() => console(
                "Офлайн-скин работает только в сборках с загрузчиком (Fabric, Forge, NeoForge или Quilt)".into(),
            ),
            _ => {}
        }
    }

    // 6½. Игра с друзьями: e4mc превращает «Открыть для сети» в адрес, доступный из интернета
    if instance.loader.is_some() && crate::engine::core::settings::load().friends_hosting {
        match crate::commands::content::ensure_project(&http, &instance, crate::engine::friends::E4MC_PROJECT).await {
            Ok(true) => console("Установлен e4mc — «Открыть для сети» откроет мир друзьям через интернет".into()),
            Ok(false) => {}
            Err(e) => console(format!("e4mc не установлен (мир будет доступен только в локальной сети): {e:#}")),
        }
    }

    // Миры друзей — сразу в списке серверов игры
    crate::engine::friends::before_launch(&app, &instance).await;

    // 7. План и запуск
    emit("starting", 0, 1);
    let game_dir = instance_game_dir(instance_id)?;
    let extra_jvm: Vec<String> = instance.jvm_args.split_whitespace().map(String::from).collect();
    let plan = plan_launch(LaunchContext {
        manifest: &manifest,
        java: &java,
        game_dir: &game_dir,
        natives_dir: &natives_dir,
        game_assets_dir: legacy_assets_dir(&manifest)?,
        memory_mb: instance.memory_mb,
        extra_jvm_args: &extra_jvm,
        account: &session,
        server,
    })?;
    let child = start_game(&plan)?;

    instance.last_played = Some(chrono::Utc::now().to_rfc3339());
    store::save(&instance)?;

    let state = match server {
        Some(s) => format!("Сервер {s}"),
        None => format!("{} {}", loader_title(instance.loader.as_deref()), instance.game_version),
    };
    discord::set_playing(&instance.name, &state);

    let id_for_exit = instance_id.to_string();
    let pid = watcher.attach(app.clone(), instance_id.to_string(), child, move |info| {
        discord::clear();
        if let Ok(mut inst) = store::get(&id_for_exit) {
            inst.playtime_secs += info.played_secs;
            let _ = store::save(&inst);
        }
    });

    if pid == 0 {
        bail!("Процесс игры завершился сразу после старта");
    }
    emit("running", 1, 1);
    Ok(pid)
}
