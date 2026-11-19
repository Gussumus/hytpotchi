//! Конвейер запуска: план, подготовка, старт, наблюдение

pub mod plan;
pub mod prepare;
pub mod start;
pub mod warm;
pub mod watch;

pub use plan::{GameAccount, LaunchPlan, plan_launch};
pub use prepare::{LaunchProgress, launch_instance};
pub use start::start_game;
pub use watch::{GameExitInfo, GameWatcher};
