use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

#[derive(Serialize, Deserialize, Clone)]
pub struct AppConfig {
    pub api_base_url: String,
    pub api_key: String,
}

impl Default for AppConfig {
    fn default() -> Self {
        // rag-api's docker-compose maps its own PORT env var (default 8000) to the same host
        // port, so this is a reasonable local-dev default. api_key has no default and must be
        // set via the Settings screen before any API call will succeed.
        AppConfig {
            api_base_url: "http://localhost:8000".to_string(),
            api_key: String::new(),
        }
    }
}

fn config_path(app: &AppHandle) -> PathBuf {
    let dir = app.path().app_config_dir().expect("no app config dir");
    fs::create_dir_all(&dir).ok();
    dir.join("config.json")
}

pub fn load_config(app: &AppHandle) -> AppConfig {
    let path = config_path(app);
    match fs::read_to_string(&path) {
        Ok(contents) => serde_json::from_str(&contents).unwrap_or_default(),
        Err(_) => AppConfig::default(),
    }
}

pub fn save_config(app: &AppHandle, config: &AppConfig) -> Result<(), String> {
    let path = config_path(app);
    let contents = serde_json::to_string_pretty(config).map_err(|e| e.to_string())?;
    fs::write(&path, contents).map_err(|e| e.to_string())
}
