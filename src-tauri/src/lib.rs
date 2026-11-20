//! Hytpotchi Launcher — бэкенд на Tauri 2
//!
//! Minecraft-лаунчер: вход через Microsoft, установка версий и загрузчиков,
//! автоматическая загрузка нужной Java для каждой версии, моды с Modrinth.

#![allow(clippy::too_many_arguments)]

pub mod commands;
pub mod engine;
pub mod secrets;

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager};

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn build_tray(app: &tauri::App) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Открыть Hytpotchi", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Выйти", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;

    let mut builder = TrayIconBuilder::with_id("main")
        .tooltip("Hytpotchi")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show_main_window(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        });

    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

/// Запуск приложения
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_log::Builder::new().level(log::LevelFilter::Info).build())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_os::init());
    // Автообновление есть только в релизах из CI: там вшиты ключ и адрес обновлений
    let builder = if commands::update::enabled() {
        builder.plugin(tauri_plugin_updater::Builder::new().build())
    } else {
        builder
    };
    builder
        .invoke_handler(tauri::generate_handler![
            // Аккаунты
            commands::accounts::microsoft_auth_start,
            commands::accounts::microsoft_auth_poll,
            commands::accounts::microsoft_refresh_token,
            commands::accounts::account_add_offline,
            commands::accounts::account_list,
            commands::accounts::account_remove,
            commands::accounts::account_set_active,
            // Игра
            commands::game::version_list,
            commands::game::java_list,
            commands::game::java_install,
            commands::game::system_info,
            commands::game::instance_create,
            commands::game::instance_list,
            commands::game::instance_update,
            commands::game::instance_remove,
            commands::game::instance_open_folder,
            commands::game::instance_launch,
            commands::game::instance_stop,
            commands::game::game_logs,
            commands::game::saved_servers,
            commands::game::saved_server_add,
            commands::game::saved_server_remove,
            commands::game::server_ping,
            commands::game::discord_status,
            commands::game::discord_set_enabled,
            commands::game::open_data_folder,
            // Контент
            commands::content::modrinth_search,
            commands::content::modrinth_project,
            commands::content::modrinth_install,
            commands::content::modrinth_versions,
            commands::content::modrinth_install_version,
            commands::content::content_check_updates,
            commands::content::local_mods_scan,
            commands::content::mod_toggle,
            commands::content::mod_remove,
            // Миры, скриншоты, новости, модпаки
            commands::extras::world_list,
            commands::extras::world_backup,
            commands::extras::world_delete,
            commands::extras::instance_open_subfolder,
            commands::extras::screenshot_list,
            commands::extras::screenshot_delete,
            commands::extras::open_file,
            commands::extras::mc_news,
            commands::extras::modpack_install,
            commands::extras::mrpack_import,
            commands::extras::import_instance,
            commands::extras::export_instance,
            commands::extras::instance_set_cover,
            commands::extras::instance_clear_cover,
            // Профили
            commands::profiles::group_create,
            commands::profiles::group_update,
            commands::profiles::group_remove,
            // Скины
            commands::skins::skin_profile,
            commands::skins::skin_library,
            commands::skins::skin_library_add,
            commands::skins::skin_library_remove,
            commands::skins::skin_apply,
            commands::skins::skin_reset,
            commands::skins::skin_save_current,
            commands::skins::cape_set,
            commands::skins::shared_skins_get,
            commands::skins::shared_skins_set,
            commands::skins::skin_publish,
            // Обновления и статус сервисов
            commands::update::update_check,
            commands::update::update_install,
            commands::update::features_status,
            // Облако
            commands::cloud::sync_push,
            commands::cloud::sync_pull,
            commands::cloud::sync_status,
            // Друзья
            commands::friends::friend_list,
            commands::friends::friend_add,
            commands::friends::friend_remove,
            commands::friends::friend_accept,
            commands::friends::friend_block,
            commands::friends::presence_list,
            // Голос
            commands::voice::call_start,
            commands::voice::call_join,
            commands::voice::call_leave,
            commands::voice::call_invite,
            // Сервер
            commands::server::server_list,
            commands::server::server_create,
            commands::server::server_update,
            commands::server::server_remove,
            commands::server::server_start,
            commands::server::server_stop,
            commands::server::server_logs,
            commands::server::server_console,
            commands::server::server_backup,
            commands::server::server_restore,
            commands::server::server_properties_get,
            commands::server::server_properties_set,
            // Телеметрия
            commands::telemetry::telemetry_config,
            commands::telemetry::telemetry_set_enabled,
            commands::telemetry::telemetry_track,
            commands::telemetry::telemetry_flush,
        ])
        .setup(|app| {
            let root = engine::core::paths::app_dir()?;
            std::fs::create_dir_all(&root)?;

            // Всё состояние создаётся один раз и синхронно — до первого вызова команд
            app.manage(secrets::SecretsVault::open(&root)?);
            app.manage(engine::accounts::AccountStore::load(&root)?);
            app.manage(engine::game::GameWatcher::new());
            app.manage(engine::core::http::HttpClient::new()?);

            build_tray(app)?;
            log::info!("Hytpotchi запущен, данные: {}", root.display());
            Ok(())
        })
        .on_window_event(|window, event| {
            // Закрытие окна сворачивает лаунчер в трей (выход — через меню трея)
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Hytpotchi");
}
