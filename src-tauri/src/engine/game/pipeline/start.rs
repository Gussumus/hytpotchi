//! Запуск процесса игры

use anyhow::{Context, Result};
use tokio::process::{Child, Command};

use crate::engine::game::pipeline::plan::LaunchPlan;

/// Запустить JVM по готовому плану (без консольного окна, с перехватом вывода)
pub fn start_game(plan: &LaunchPlan) -> Result<Child> {
    std::fs::create_dir_all(&plan.working_dir)?;

    let mut cmd = Command::new(&plan.java_executable);
    cmd.args(&plan.args)
        .current_dir(&plan.working_dir)
        .envs(&plan.environment)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(false);

    #[cfg(target_os = "windows")]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW

    log::info!(
        "Запуск: {} ({} аргументов)",
        plan.java_executable.display(),
        plan.args.len()
    );
    cmd.spawn().context("Не удалось запустить Java")
}
