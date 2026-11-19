//! Global preferences storage

use anyhow::{Result, Context};
use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;
use std::collections::HashMap;
use std::sync::Arc;
use directories::ProjectDirs;

/// Global preferences
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct GlobalPrefs {
    #[serde(skip)]
    path: Option<std::path::PathBuf>,
    #[serde(skip)]
    dirty: bool,
    data: HashMap<String, serde_json::Value>,
}

impl GlobalPrefs {
    pub async fn load<R: tauri::Runtime>(_app_handle: &tauri::AppHandle<R>) -> Result<Arc<RwLock<Self>>> {
        let proj_dirs = ProjectDirs::from("com", "hytpotchi", "launcher")
            .context("Failed to get project dirs")?;
        let app_dir = proj_dirs.data_dir().to_path_buf();

        tokio::fs::create_dir_all(&app_dir).await?;

        let path = app_dir.join("preferences.json");
        let prefs = if path.exists() {
            let content = tokio::fs::read_to_string(&path).await?;
            let mut prefs: GlobalPrefs = serde_json::from_str(&content)?;
            prefs.path = Some(path);
            prefs
        } else {
            let mut prefs = GlobalPrefs::default();
            prefs.path = Some(path);
            prefs
        };

        let prefs = Arc::new(RwLock::new(prefs));

        // Auto-save on change
        let prefs_clone = prefs.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(tokio::time::Duration::from_secs(5)).await;
                let mut prefs = prefs_clone.write().await;
                if prefs.dirty {
                    if let Err(e) = prefs.save().await {
                        log::error!("Failed to save preferences: {}", e);
                    }
                }
            }
        });

        Ok(prefs)
    }

    pub async fn get(&self, key: &str) -> Option<serde_json::Value> {
        self.data.get(key).cloned()
    }

    pub async fn set(&mut self, key: &str, value: &str) -> Result<()> {
        self.data.insert(key.to_string(), serde_json::Value::String(value.to_string()));
        self.dirty = true;
        Ok(())
    }

    pub async fn set_json(&mut self, key: &str, value: serde_json::Value) -> Result<()> {
        self.data.insert(key.to_string(), value);
        self.dirty = true;
        Ok(())
    }

    async fn save(&mut self) -> Result<()> {
        if let Some(path) = &self.path {
            let content = serde_json::to_string_pretty(&self.data)?;
            tokio::fs::write(path, content).await?;
            self.dirty = false;
        }
        Ok(())
    }
}