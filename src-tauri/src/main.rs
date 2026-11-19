//! Hytpotchi Launcher — точка входа

// В релизе не показываем консольное окно рядом с лаунчером
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    hytpotchi_lib::run();
}
