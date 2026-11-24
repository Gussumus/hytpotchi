//! Игра: версии, установка, Java, конвейер запуска

pub mod crashcause;
pub mod install;
pub mod java;
#[cfg(test)]
mod loader_matrix;
pub mod loaders;
pub mod manifest;
pub mod nbt;
pub mod now_playing;
pub mod ping;
pub mod serversdat;
pub mod pipeline;

pub use java::{JavaRuntime, ensure_java};
pub use manifest::{VersionManifest, resolve_version};
pub use pipeline::{GameWatcher, launch_instance};
