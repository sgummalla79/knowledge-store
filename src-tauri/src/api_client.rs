use crate::config::{self, AppConfig};
use crate::http_client::client;
use crate::oauth_client::{self, TokenState};
use serde_json::Value;
use tauri::{AppHandle, State};

async fn map_response(response: reqwest::Response) -> Result<Value, String> {
    let status = response.status();
    let body: Value = response.json().await.unwrap_or(Value::Null);
    if status.is_success() {
        Ok(body)
    } else {
        // Error shape is {"error": {"code", "message", "field"?}} — fall back to a generic
        // code/message in case an unmatched Flask/Werkzeug response ever slips through without
        // the envelope. Re-serialized as JSON (not just the message) so the frontend can branch
        // on `code` (e.g. "unauthorized" vs "embeddings_not_configured") instead of string-matching
        // human-readable text.
        let code = body
            .get("error")
            .and_then(|e| e.get("code"))
            .and_then(|v| v.as_str())
            .unwrap_or("unknown_error");
        let message = body
            .get("error")
            .and_then(|e| e.get("message"))
            .and_then(|v| v.as_str())
            .or_else(|| body.get("error").and_then(|e| e.as_str()))
            .unwrap_or("request failed");
        Err(serde_json::json!({ "code": code, "message": message }).to_string())
    }
}

/// Attaches an OAuth2 bearer token (resolved by oauth_client::auth_header) and retries once, after
/// invalidating the cached access token, on an unexpected 401 — the same pattern mcp_server/client.py
/// uses. `build` constructs a fresh RequestBuilder given the header name/value; it's called twice
/// on the retry path, so any owned data it needs (e.g. an upload's file bytes) must be cloned into
/// the closure, not moved out of it.
async fn send_with_retry(
    app: &AppHandle,
    tokens: &TokenState,
    cfg: &AppConfig,
    build: impl Fn(&str, &str) -> reqwest::RequestBuilder,
) -> Result<reqwest::Response, String> {
    let (name, value) = oauth_client::auth_header(app, tokens, cfg).await?;
    let response = build(name, &value).send().await.map_err(|e| e.to_string())?;

    if response.status().as_u16() == 401 {
        oauth_client::invalidate(tokens);
        let (name, value) = oauth_client::auth_header(app, tokens, cfg).await?;
        return build(name, &value).send().await.map_err(|e| e.to_string());
    }

    Ok(response)
}

#[tauri::command]
pub fn get_config(app: AppHandle) -> AppConfig {
    config::load_config(&app)
}

#[tauri::command]
pub fn save_config(app: AppHandle, config: AppConfig) -> Result<(), String> {
    config::save_config(&app, &config)
}

/// Clears the OAuth2 credentials (keeps api_base_url) and drops any cached access token, putting
/// the connection back into "not configured" so it can be reconfigured with a different application.
#[tauri::command]
pub fn disconnect(app: AppHandle, tokens: State<'_, TokenState>) -> Result<(), String> {
    let mut cfg = config::load_config(&app);
    cfg.client_id = String::new();
    cfg.client_secret = String::new();
    cfg.refresh_token = String::new();
    oauth_client::invalidate(&tokens);
    config::save_config(&app, &cfg)
}

/// Called right after the Connection form is saved: forces a fresh OAuth2 exchange (invalidating
/// any cached token from previously-saved credentials) so the access token — and, since
/// oauth_client's KNOWLEDGE_STORE_SCOPE always includes offline_access, a refresh token — are
/// obtained and persisted immediately, rather than only lazily on the next API call.
#[tauri::command]
pub async fn authenticate(app: AppHandle, tokens: State<'_, TokenState>) -> Result<(), String> {
    let cfg = config::load_config(&app);
    oauth_client::invalidate(&tokens);
    oauth_client::auth_header(&app, &tokens, &cfg).await?;
    Ok(())
}

#[tauri::command]
pub async fn get_embedding_options(app: AppHandle, tokens: State<'_, TokenState>) -> Result<Value, String> {
    let cfg = config::load_config(&app);
    let url = format!("{}/embedding-options", cfg.api_base_url);
    let response = send_with_retry(&app, &tokens, &cfg, |name, value| client().get(&url).header(name, value)).await?;
    map_response(response).await
}

/// Live, credentialed call — queries the provider itself (via knowledge-api) for its actual
/// available models, using an api_key/base_url the user may not have saved yet. Not cached
/// server-side; rate-limited to 10/min there, so the frontend debounces before calling this.
#[tauri::command]
pub async fn list_embedding_models(app: AppHandle, payload: Value, tokens: State<'_, TokenState>) -> Result<Value, String> {
    let cfg = config::load_config(&app);
    let url = format!("{}/embedding-options/models", cfg.api_base_url);
    let response = send_with_retry(&app, &tokens, &cfg, |name, value| {
        client().post(&url).header(name, value).json(&payload)
    })
    .await?;
    map_response(response).await
}

#[tauri::command]
pub async fn list_libraries(app: AppHandle, tokens: State<'_, TokenState>) -> Result<Value, String> {
    let cfg = config::load_config(&app);
    let url = format!("{}/libraries", cfg.api_base_url);
    let response = send_with_retry(&app, &tokens, &cfg, |name, value| client().get(&url).header(name, value)).await?;
    map_response(response).await
}

#[tauri::command]
pub async fn create_library(app: AppHandle, payload: Value, tokens: State<'_, TokenState>) -> Result<Value, String> {
    let cfg = config::load_config(&app);
    let url = format!("{}/libraries", cfg.api_base_url);
    let response = send_with_retry(&app, &tokens, &cfg, |name, value| {
        client().post(&url).header(name, value).json(&payload)
    })
    .await?;
    map_response(response).await
}

// No PATCH/PUT /libraries/{id} exists on knowledge-api yet (only POST/GET/DELETE) — this will
// 404 until the API team adds it (see the frontend ask drafted for this). Kept as a real,
// already-wired command rather than left unbuilt, so the UI just needs the endpoint to exist,
// not any further frontend work, once it ships.
#[tauri::command]
pub async fn update_library(
    app: AppHandle,
    library_id: String,
    payload: Value,
    tokens: State<'_, TokenState>,
) -> Result<Value, String> {
    let cfg = config::load_config(&app);
    let url = format!("{}/libraries/{}", cfg.api_base_url, library_id);
    let response = send_with_retry(&app, &tokens, &cfg, |name, value| {
        client().patch(&url).header(name, value).json(&payload)
    })
    .await?;
    map_response(response).await
}

#[tauri::command]
pub async fn delete_library(app: AppHandle, library_id: String, tokens: State<'_, TokenState>) -> Result<(), String> {
    let cfg = config::load_config(&app);
    let url = format!("{}/libraries/{}", cfg.api_base_url, library_id);
    let response = send_with_retry(&app, &tokens, &cfg, |name, value| client().delete(&url).header(name, value)).await?;
    if response.status().is_success() {
        Ok(())
    } else {
        Err(map_response(response).await.err().unwrap_or_default())
    }
}

#[tauri::command]
pub async fn list_documents(app: AppHandle, library_id: String, tokens: State<'_, TokenState>) -> Result<Value, String> {
    let cfg = config::load_config(&app);
    let url = format!("{}/libraries/{}/documents", cfg.api_base_url, library_id);
    let response = send_with_retry(&app, &tokens, &cfg, |name, value| client().get(&url).header(name, value)).await?;
    map_response(response).await
}

/// Starts async URL ingestion (single page or crawl) — fire-and-forget like upload_document,
/// returns a job_id polled via get_crawl_status rather than the document-status job endpoint,
/// since a crawl can produce many documents over time, not just one.
#[tauri::command]
pub async fn crawl_document(app: AppHandle, library_id: String, payload: Value, tokens: State<'_, TokenState>) -> Result<Value, String> {
    let cfg = config::load_config(&app);
    let url = format!("{}/libraries/{}/documents/crawl", cfg.api_base_url, library_id);
    let response = send_with_retry(&app, &tokens, &cfg, |name, value| {
        client().post(&url).header(name, value).json(&payload)
    })
    .await?;
    map_response(response).await
}

#[tauri::command]
pub async fn get_crawl_status(app: AppHandle, library_id: String, job_id: String, tokens: State<'_, TokenState>) -> Result<Value, String> {
    let cfg = config::load_config(&app);
    let url = format!("{}/libraries/{}/crawl-jobs/{}", cfg.api_base_url, library_id, job_id);
    let response = send_with_retry(&app, &tokens, &cfg, |name, value| client().get(&url).header(name, value)).await?;
    map_response(response).await
}

#[tauri::command]
pub async fn delete_document(
    app: AppHandle,
    library_id: String,
    document_id: String,
    tokens: State<'_, TokenState>,
) -> Result<(), String> {
    let cfg = config::load_config(&app);
    let url = format!("{}/libraries/{}/documents/{}", cfg.api_base_url, library_id, document_id);
    let response = send_with_retry(&app, &tokens, &cfg, |name, value| client().delete(&url).header(name, value)).await?;
    if response.status().is_success() {
        Ok(())
    } else {
        Err(map_response(response).await.err().unwrap_or_default())
    }
}

/// Pure label edit — works at any document status, including mid-ingestion, and never touches
/// chunks/embeddings or retry eligibility.
#[tauri::command]
pub async fn rename_document(
    app: AppHandle,
    library_id: String,
    document_id: String,
    source_filename: String,
    tokens: State<'_, TokenState>,
) -> Result<Value, String> {
    let cfg = config::load_config(&app);
    let url = format!("{}/libraries/{}/documents/{}", cfg.api_base_url, library_id, document_id);
    let payload = serde_json::json!({ "source_filename": source_filename });
    let response = send_with_retry(&app, &tokens, &cfg, |name, value| {
        client().patch(&url).header(name, value).json(&payload)
    })
    .await?;
    map_response(response).await
}

/// Best-effort, not instant — the server checks for cancellation between embedding batches, so
/// the job (and the document's status) can take a few seconds to actually settle into
/// `cancelled` after this call returns. The frontend doesn't poll this job directly; it relies on
/// the existing document-list poll to notice the status change, same as upload/retry.
#[tauri::command]
pub async fn cancel_upload_job(
    app: AppHandle,
    library_id: String,
    job_id: String,
    tokens: State<'_, TokenState>,
) -> Result<(), String> {
    let cfg = config::load_config(&app);
    let url = format!("{}/libraries/{}/jobs/{}/cancel", cfg.api_base_url, library_id, job_id);
    let response = send_with_retry(&app, &tokens, &cfg, |name, value| client().post(&url).header(name, value)).await?;
    if response.status().is_success() {
        Ok(())
    } else {
        Err(map_response(response).await.err().unwrap_or_default())
    }
}

/// Retries ingestion for a document currently in `failed` status. Async on the server (returns a
/// job_id, the actual re-embed runs in the background) — the frontend doesn't poll this job
/// directly, it just keeps re-fetching list_documents until the document's own status moves off
/// `failed`, same pattern as tracking a fresh upload.
#[tauri::command]
pub async fn retry_document(
    app: AppHandle,
    library_id: String,
    document_id: String,
    tokens: State<'_, TokenState>,
) -> Result<Value, String> {
    let cfg = config::load_config(&app);
    let url = format!("{}/libraries/{}/documents/{}/retry", cfg.api_base_url, library_id, document_id);
    let response = send_with_retry(&app, &tokens, &cfg, |name, value| client().post(&url).header(name, value)).await?;
    map_response(response).await
}

/// Lets the frontend reject an oversized file before ever calling upload_document — knowledge-api
/// enforces a max upload size (Flask's MAX_CONTENT_LENGTH) but doesn't expose the limit through
/// any API response, so the only way to check ahead of time is locally, against the file on disk.
#[tauri::command]
pub fn get_file_size(file_path: String) -> Result<u64, String> {
    std::fs::metadata(&file_path).map(|m| m.len()).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn upload_document(
    app: AppHandle,
    library_id: String,
    file_path: String,
    tokens: State<'_, TokenState>,
) -> Result<Value, String> {
    let cfg = config::load_config(&app);
    let bytes = std::fs::read(&file_path).map_err(|e| e.to_string())?;
    let filename = std::path::Path::new(&file_path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("upload")
        .to_string();
    let url = format!("{}/libraries/{}/documents", cfg.api_base_url, library_id);

    let response = send_with_retry(&app, &tokens, &cfg, |name, value| {
        let part = reqwest::multipart::Part::bytes(bytes.clone()).file_name(filename.clone());
        let form = reqwest::multipart::Form::new().part("file", part);
        client().post(&url).header(name, value).multipart(form)
    })
    .await?;
    map_response(response).await
}

#[tauri::command]
pub async fn get_job_status(
    app: AppHandle,
    library_id: String,
    job_id: String,
    tokens: State<'_, TokenState>,
) -> Result<Value, String> {
    let cfg = config::load_config(&app);
    let url = format!("{}/libraries/{}/jobs/{}", cfg.api_base_url, library_id, job_id);
    let response = send_with_retry(&app, &tokens, &cfg, |name, value| client().get(&url).header(name, value)).await?;
    map_response(response).await
}

#[tauri::command]
pub async fn get_embedding_settings(app: AppHandle, tokens: State<'_, TokenState>) -> Result<Value, String> {
    let cfg = config::load_config(&app);
    let url = format!("{}/embedding-settings", cfg.api_base_url);
    let response = send_with_retry(&app, &tokens, &cfg, |name, value| client().get(&url).header(name, value)).await?;
    map_response(response).await
}

#[tauri::command]
pub async fn save_embedding_settings(app: AppHandle, payload: Value, tokens: State<'_, TokenState>) -> Result<Value, String> {
    let cfg = config::load_config(&app);
    let url = format!("{}/embedding-settings", cfg.api_base_url);
    let response = send_with_retry(&app, &tokens, &cfg, |name, value| {
        client().put(&url).header(name, value).json(&payload)
    })
    .await?;
    map_response(response).await
}

#[tauri::command]
pub async fn clear_embedding_settings(app: AppHandle, tokens: State<'_, TokenState>) -> Result<Value, String> {
    let cfg = config::load_config(&app);
    let url = format!("{}/embedding-settings", cfg.api_base_url);
    let response = send_with_retry(&app, &tokens, &cfg, |name, value| client().delete(&url).header(name, value)).await?;
    map_response(response).await
}

#[tauri::command]
pub async fn get_search_settings(app: AppHandle, tokens: State<'_, TokenState>) -> Result<Value, String> {
    let cfg = config::load_config(&app);
    let url = format!("{}/search-settings", cfg.api_base_url);
    let response = send_with_retry(&app, &tokens, &cfg, |name, value| client().get(&url).header(name, value)).await?;
    map_response(response).await
}

#[tauri::command]
pub async fn save_search_settings(app: AppHandle, payload: Value, tokens: State<'_, TokenState>) -> Result<Value, String> {
    let cfg = config::load_config(&app);
    let url = format!("{}/search-settings", cfg.api_base_url);
    let response = send_with_retry(&app, &tokens, &cfg, |name, value| {
        client().put(&url).header(name, value).json(&payload)
    })
    .await?;
    map_response(response).await
}
