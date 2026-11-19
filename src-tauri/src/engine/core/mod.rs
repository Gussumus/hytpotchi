//! Core engine utilities

pub mod archive;
pub mod crash;
// pub mod dedup;
pub mod diskgate;
pub mod diskkind;
pub mod doh;
pub mod external;
pub mod fsctx;
pub mod hedge;
pub mod http;
pub mod ids;
pub mod jobs;
pub mod media;
pub mod mirror;
pub mod pace;
pub mod paths;
pub mod prefs;
pub mod proc;
// pub mod pulse;
pub mod safepath;
// pub mod selfdelta;
// pub mod selfheal;
pub mod selfupdate;
pub mod silentupdate;
pub mod store_index;
pub mod ui_text;

pub use paths::{app_dir, instances_dir, java_dir, cache_dir, temp_dir};
pub use safepath::{safe_join, safe_child, safe_file_name};
pub use http::HttpClient;
pub use archive::{extract_zip, extract_tar_gz, extract_zstd};
// pub use dedup::{DedupStore, DedupError};
pub use selfupdate::{SelfUpdater, UpdateManifest};
// pub use selfheal::SelfHeal;