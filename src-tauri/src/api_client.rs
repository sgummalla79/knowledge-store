use crate::config::{self, AppConfig};
use serde_json::Value;
use tauri::AppHandle;

fn client() -> reqwest::Client {
    reqwest::Client::new()
}

async fn map_response(response: reqwest::Response) -> Result<Value, String> {
    let status = response.status();
    let body: Value = response.json().await.unwrap_or(Value::Null);
    if status.is_success() {
        Ok(body)
    } else {
        // Error shape is {"error": {"code", "message", "field"?}} — fall back to the raw
        // "error" value (or a generic message) in case an unmatched Flask/Werkzeug response
        // ever slips through without the envelope.
        let message = body
            .get("error")
            .and_then(|e| e.get("message"))
            .and_then(|v| v.as_str())
            .or_else(|| body.get("error").and_then(|e| e.as_str()))
            .unwrap_or("request failed");
        Err(message.to_string())
    }
}

#[tauri::command]
pub fn get_config(app: AppHandle) -> AppConfig {
    config::load_config(&app)
}

#[tauri::command]
pub fn save_config(app: AppHandle, config: AppConfig) -> Result<(), String> {
    config::save_config(&app, &config)
}

#[tauri::command]
pub async fn get_embedding_options(app: AppHandle) -> Result<Value, String> {
    let cfg = config::load_config(&app);
    let response = client()
        .get(format!("{}/embedding-options", cfg.api_base_url))
        .header("X-API-Key", cfg.api_key)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    map_response(response).await
}

#[tauri::command]
pub async fn list_libraries(app: AppHandle) -> Result<Value, String> {
    let cfg = config::load_config(&app);
    let response = client()
        .get(format!("{}/libraries", cfg.api_base_url))
        .header("X-API-Key", cfg.api_key)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    map_response(response).await
}

#[tauri::command]
pub async fn create_library(app: AppHandle, payload: Value) -> Result<Value, String> {
    let cfg = config::load_config(&app);
    let response = client()
        .post(format!("{}/libraries", cfg.api_base_url))
        .header("X-API-Key", cfg.api_key)
        .json(&payload)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    map_response(response).await
}

#[tauri::command]
pub async fn delete_library(app: AppHandle, library_id: String) -> Result<(), String> {
    let cfg = config::load_config(&app);
    let response = client()
        .delete(format!("{}/libraries/{}", cfg.api_base_url, library_id))
        .header("X-API-Key", cfg.api_key)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if response.status().is_success() {
        Ok(())
    } else {
        Err(map_response(response).await.err().unwrap_or_default())
    }
}

#[tauri::command]
pub async fn list_documents(app: AppHandle, library_id: String) -> Result<Value, String> {
    let cfg = config::load_config(&app);
    let response = client()
        .get(format!("{}/libraries/{}/documents", cfg.api_base_url, library_id))
        .header("X-API-Key", cfg.api_key)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    map_response(response).await
}

#[tauri::command]
pub async fn upload_document(
    app: AppHandle,
    library_id: String,
    file_path: String,
) -> Result<Value, String> {
    let cfg = config::load_config(&app);
    let bytes = std::fs::read(&file_path).map_err(|e| e.to_string())?;
    let filename = std::path::Path::new(&file_path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("upload")
        .to_string();

    let part = reqwest::multipart::Part::bytes(bytes).file_name(filename);
    let form = reqwest::multipart::Form::new().part("file", part);

    let response = client()
        .post(format!("{}/libraries/{}/documents", cfg.api_base_url, library_id))
        .header("X-API-Key", cfg.api_key)
        .multipart(form)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    map_response(response).await
}

#[tauri::command]
pub async fn get_job_status(app: AppHandle, library_id: String, job_id: String) -> Result<Value, String> {
    let cfg = config::load_config(&app);
    let response = client()
        .get(format!(
            "{}/libraries/{}/jobs/{}",
            cfg.api_base_url, library_id, job_id
        ))
        .header("X-API-Key", cfg.api_key)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    map_response(response).await
}
