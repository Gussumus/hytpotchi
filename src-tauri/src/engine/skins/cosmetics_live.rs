//! Косметика у других игроков — проверка целиком, как в жизни: локальный сервер и два клиента
//! Fabric / Quilt / Forge, поставленные так же, как их ставит лаунчер (мод косметики, для Fabric и
//! Quilt — ещё Fabric API, аргументы -Dhytpotchi.*).
//! На первом игроке (WEARER) надета косметика на сервере Hytpotchi; второй (VIEWER) стоит
//! напротив и снимает его от первого лица. Снимки — `<LOADER_MATRIX_DIR>/cosmetics-<загрузчик>-<версия>/view.png`.
//!
//! ```text
//! cargo test --lib cosmetics_multiplayer -- --ignored --nocapture
//! COSMETICS_MC="26.3 quilt:1.20.1" cargo test --lib cosmetics_multiplayer -- --ignored --nocapture
//! ```

use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};

use crate::engine::core::http::{HttpClient, VerifiedDownload};
use crate::engine::core::paths::{instance_game_dir, instance_path};
use crate::engine::game::install::{ensure_version_files, extract_natives, install_loader, legacy_assets_dir};
use crate::engine::game::java::{JavaRuntime, ensure_java, normalize_major};
use crate::engine::game::loaders::{self, ForgeKind};
use crate::engine::game::manifest::{VersionManifest, resolve_version};
use crate::engine::game::pipeline::plan::{GameAccount, LaunchContext, plan_launch};
use crate::engine::game::pipeline::start::start_game;
use crate::engine::profiles::store::Instance;
use crate::engine::skins::cosmetics;

/// На этом нике на сервере Hytpotchi надеты нимб и крылья
const WEARER: &str = "Gussumus";
const VIEWER: &str = "HytTest";
const PORT: u16 = 25599;
/// Через сколько секунд в мире второй игрок делает снимок
const VIEW_AFTER: u64 = 25;
const DEFAULT: &str = "26.3 1.21.4 1.20.1 1.16.5";
/// Адрес сервера Hytpotchi, если в настройках и окружении его нет (тот же, что в versions/shared.gradle)
const FALLBACK_SERVER: &str = "https://hytpotchi-skins.akiom31.workers.dev";

type Lines = Arc<Mutex<Vec<String>>>;

async fn pump<R: AsyncRead + Unpin>(stream: R, lines: Lines) {
    let mut reader = BufReader::new(stream).lines();
    while let Ok(Some(line)) = reader.next_line().await {
        lines.lock().unwrap().push(line);
    }
}

fn watch(child: &mut Child) -> Lines {
    let lines: Lines = Arc::default();
    if let Some(out) = child.stdout.take() {
        tokio::spawn(pump(out, lines.clone()));
    }
    if let Some(err) = child.stderr.take() {
        tokio::spawn(pump(err, lines.clone()));
    }
    lines
}

async fn wait_line(lines: &Lines, what: &str, timeout: Duration, child: &mut Child) -> Result<()> {
    let start = Instant::now();
    loop {
        if lines.lock().unwrap().iter().any(|l| l.contains(what)) {
            return Ok(());
        }
        if let Some(status) = child.try_wait()? {
            bail!("процесс закрылся ({status}), не дождавшись «{what}»");
        }
        if start.elapsed() > timeout {
            bail!("за {} с не дождался «{what}»", timeout.as_secs());
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
}

async fn command(stdin: &mut ChildStdin, cmd: &str) -> Result<()> {
    stdin.write_all(format!("{cmd}\n").as_bytes()).await?;
    stdin.flush().await?;
    Ok(())
}

/// Временная сборка в каталоге лаунчера (без instance.json — в списке сборок её не видно)
fn temp_instance(loader: &str, mc: &str, version_id: &str, who: &str) -> Instance {
    Instance {
        id: format!("cosmetics-test-{}-{}", who.to_lowercase(), mc.replace('.', "_")),
        name: format!("Тест косметики {who}"),
        game_version: mc.to_string(),
        loader: Some(loader.into()),
        loader_version: None,
        loader_pinned: false,
        version_id: Some(version_id.to_string()),
        memory_mb: 1536,
        jvm_args: String::new(),
        accent: None,
        created_at: String::new(),
        last_played: None,
        playtime_secs: 0,
        group: None,
        cover: None,
    }
}

#[allow(clippy::too_many_arguments)]
async fn start_client(
    http: &HttpClient,
    manifest: &VersionManifest,
    java: &JavaRuntime,
    natives: &Path,
    inst: &Instance,
    who: &str,
    server_url: &str,
    extra: &[String],
) -> Result<Child> {
    // Как в prepare.rs: мод + Fabric API в папку mods, адрес сервера и прокси — аргументами JVM
    cosmetics::install(http, inst).await.context("мод косметики не поставился")?;
    let mut jvm = cosmetics::jvm_args(server_url);
    // Офлайн-сессия без authlib-injector — как в prepare.rs (иначе 1.16.5 не пустит в мультиплеер)
    jvm.extend(crate::engine::game::pipeline::plan::offline_api_args());
    jvm.extend(extra.iter().cloned());
    let game_dir = instance_game_dir(&inst.id)?;
    let _ = std::fs::remove_dir_all(game_dir.join("screenshots"));
    // Первый запуск 1.20+ сначала показывает экран доступности и только после него подключается
    // к серверу из --quickPlayMultiplayer — в тесте его пропускаем
    std::fs::create_dir_all(&game_dir)?;
    // pauseOnLostFocus: окна двух игр перекрывают друг друга — без этого снимок выйдет с меню паузы
    std::fs::write(
        game_dir.join("options.txt"),
        "onboardAccessibility:false\nskipMultiplayerWarning:true\npauseOnLostFocus:false\n",
    )?;
    let account = GameAccount {
        uuid: format!("{:032x}", who.len() as u128 * 7919),
        username: who.to_string(),
        access_token: "0".into(),
        user_type: "legacy".into(),
    };
    let address = format!("127.0.0.1:{PORT}");
    let plan = plan_launch(LaunchContext {
        manifest,
        java,
        game_dir: &game_dir,
        natives_dir: natives,
        game_assets_dir: legacy_assets_dir(manifest)?,
        memory_mb: inst.memory_mb,
        extra_jvm_args: &jvm,
        account: &account,
        server: Some(&address),
    })?;
    start_game(&plan)
}

async fn run(http: &HttpClient, loader: &str, mc: &str, dir: &Path, server_url: &str) -> Result<()> {
    let no_bytes = |_: u64, _: Option<u64>| {};
    let no_files = |_: &str, _: u64, _: u64| {};
    std::fs::create_dir_all(dir)?;

    let (id, _) = match ForgeKind::parse(loader) {
        // Как в prepare.rs: установщику Forge нужны ванильные файлы и Java этой версии
        Some(kind) => {
            let vanilla = resolve_version(http, mc).await?;
            let java = ensure_java(http, normalize_major(vanilla.required_java()), &no_bytes).await?;
            ensure_version_files(http, &vanilla, &no_files).await?;
            loaders::install(http, kind, mc, None, &java, &|_| {}).await?
        }
        None => install_loader(http, loader, mc, None).await?,
    };
    let manifest = resolve_version(http, &id).await?;
    let java = ensure_java(http, normalize_major(manifest.required_java()), &no_bytes).await?;
    ensure_version_files(http, &manifest, &no_files).await?;
    let natives = dir.join("natives");
    extract_natives(&manifest, &natives).await?;

    // Ванильный сервер без проверки аккаунтов
    let server_dir = dir.join("server");
    std::fs::create_dir_all(&server_dir)?;
    let jar = server_dir.join("server.jar");
    let download = manifest.downloads.as_ref().and_then(|d| d.server.clone()).context("у версии нет сервера")?;
    http.download_verified(&download.url, &jar, VerifiedDownload::new().sha1_opt(download.sha1.as_deref()))
        .await?;
    std::fs::write(server_dir.join("eula.txt"), "eula=true\n")?;
    std::fs::write(
        server_dir.join("server.properties"),
        // Белый список новые версии (26.x) включают по умолчанию — выключаем явно
        format!(
            "online-mode=false\nwhite-list=false\nenforce-whitelist=false\nserver-port={PORT}\nspawn-protection=0\n\
             view-distance=4\nsimulation-distance=4\nmotd=hyt-test\n"
        ),
    )?;
    let mut server = Command::new(&java.executable)
        .args(["-Xmx1G", "-jar", "server.jar", "nogui"])
        .current_dir(&server_dir)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()?;
    let server_log = watch(&mut server);
    let mut console = server.stdin.take().context("нет stdin сервера")?;

    let wearer = temp_instance(loader, mc, &id, WEARER);
    let viewer = temp_instance(loader, mc, &id, VIEWER);
    let mut clients: Vec<(Child, Lines)> = Vec::new();
    let result = async {
        wait_line(&server_log, "Done (", Duration::from_secs(300), &mut server).await?;

        let mut a = start_client(http, &manifest, &java, &natives, &wearer, WEARER, server_url, &[]).await?;
        let a_log = watch(&mut a);
        clients.push((a, a_log));
        wait_line(&server_log, &format!("{WEARER} joined the game"), Duration::from_secs(300), &mut server).await?;

        let shot = format!("-Dhytpotchi.cosmetics.viewshot={VIEW_AFTER}");
        let mut b = start_client(http, &manifest, &java, &natives, &viewer, VIEWER, server_url, &[shot]).await?;
        let b_log = watch(&mut b);
        clients.push((b, b_log.clone()));
        wait_line(&server_log, &format!("{VIEWER} joined the game"), Duration::from_secs(300), &mut server).await?;

        // Площадка в небе, игроки лицом друг к другу: WEARER смотрит на север, VIEWER — на юг.
        // Ночное зрение — потому что свет над новой площадкой клиент досчитывает не сразу
        for cmd in [
            "time set 6000",
            "weather clear",
            // Точка появления бывает далеко от (0, 0) — без этого площадка «not loaded»
            "forceload add -16 -16 16 16",
            "fill -3 199 -3 3 199 9 minecraft:stone",
            &format!("effect give {VIEWER} minecraft:night_vision 99999 0 true"),
            &format!("tp {WEARER} 0 200 6 180 0"),
            &format!("tp {VIEWER} 0 200 0 0 0"),
        ] {
            command(&mut console, cmd).await?;
        }
        // Тело стоящего игрока может отставать от головы до 75° (так в самой игре) — пусть WEARER
        // пройдёт пару шагов к VIEWER: тогда тело, а с ним крылья, развернётся лицом к камере
        tokio::time::sleep(Duration::from_secs(4)).await;
        command(&mut console, &format!("tp {VIEWER} 0 200 0 0 0")).await?;
        for z in ["5.5", "5", "4.5", "4"] {
            command(&mut console, &format!("tp {WEARER} 0 200 {z} 180 0")).await?;
            tokio::time::sleep(Duration::from_millis(250)).await;
        }

        let png = instance_game_dir(&viewer.id)?.join("screenshots").join("cosmetics_view.png");
        let start = Instant::now();
        while !png.exists() {
            if start.elapsed() > Duration::from_secs(VIEW_AFTER + 60) {
                bail!("второй игрок не сделал снимок");
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
        std::fs::copy(&png, dir.join("view.png"))?;
        let mod_lines: Vec<String> =
            b_log.lock().unwrap().iter().filter(|l| l.contains("Hytpotchi Cosmetics")).cloned().collect();
        println!("  мод у {VIEWER}:\n    {}", mod_lines.join("\n    "));
        anyhow::Ok(())
    }
    .await;

    // Уборка: игры и сервер закрыть, логи сохранить, временные сборки удалить
    let _ = command(&mut console, "stop").await;
    for (i, (child, lines)) in clients.iter_mut().enumerate() {
        let _ = child.kill().await;
        let _ = std::fs::write(dir.join(format!("client-{i}.log")), lines.lock().unwrap().join("\n"));
    }
    tokio::time::sleep(Duration::from_secs(3)).await;
    let _ = server.kill().await;
    let _ = std::fs::write(dir.join("server.log"), server_log.lock().unwrap().join("\n"));
    for inst in [&wearer, &viewer] {
        if let Ok(path) = instance_path(&inst.id) {
            let _ = std::fs::remove_dir_all(path);
        }
    }
    result
}

#[tokio::test]
#[ignore = "запускает сервер и две игры — только вручную"]
async fn cosmetics_multiplayer() {
    let http = HttpClient::new().unwrap();
    let server_url = crate::engine::core::settings::skin_server().unwrap_or_else(|| FALLBACK_SERVER.into());
    let root = std::env::var_os("LOADER_MATRIX_DIR")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| std::env::temp_dir().join("hytpotchi-loader-matrix"));
    let versions = std::env::var("COSMETICS_MC").unwrap_or_else(|_| DEFAULT.into());
    let mut failed = Vec::new();
    for case in versions.split_whitespace() {
        // "26.3" — Fabric, "quilt:26.3" — Quilt, "forge:1.20.1" — Forge
        let (loader, mc) = case.split_once(':').unwrap_or(("fabric", case));
        let dir = root.join(format!("cosmetics-{loader}-{mc}"));
        println!("▶ {loader} {mc}");
        match run(&http, loader, mc, &dir, &server_url).await {
            Ok(()) => println!("  ✔ {mc}: снимок {}", dir.join("view.png").display()),
            Err(e) => {
                println!("  ✘ {mc}: {e:#}\n    логи: {}", dir.display());
                failed.push(mc.to_string());
            }
        }
    }
    assert!(failed.is_empty(), "не вышло: {}", failed.join(", "));
}
