use crate::config::{self, AppConfig};
use serde_json::Value;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::AppHandle;

// Requested on every client_credentials exchange — Knowledge Store is the admin/management UI, so
// unlike mcp_server's narrow libraries:read+query:execute grant, it needs close to everything.
const KNOWLEDGE_STORE_SCOPE: &str = "libraries:read libraries:write documents:read documents:write \
    query:execute embedding_settings:read embedding_settings:write search_settings:read \
    search_settings:write offline_access";

// Refresh a bit before the JWT's real expiry so a request never starts with an about-to-expire token.
const EXPIRY_SAFETY_MARGIN_SECONDS: u64 = 30;

struct CachedToken {
    access_token: String,
    expires_at: Instant,
}

/// In-memory only, cleared on app restart — the persisted refresh_token (in config.json) is what
/// avoids redoing a client_credentials exchange (which needs the secret) on every launch.
#[derive(Default)]
pub struct TokenState(Mutex<Option<CachedToken>>);

pub fn oauth_configured(cfg: &AppConfig) -> bool {
    !cfg.client_id.is_empty() && !cfg.client_secret.is_empty()
}

/// Used by the retry-on-401 path in api_client.rs to force a fresh token on the next auth_header call.
pub fn invalidate(tokens: &TokenState) {
    *tokens.0.lock().unwrap() = None;
}

pub async fn auth_header(
    app: &AppHandle,
    tokens: &TokenState,
    cfg: &AppConfig,
) -> Result<(&'static str, String), String> {
    if !oauth_configured(cfg) {
        return Err(serde_json::json!({
            "code": "not_configured",
            "message": "Set Client ID and Client Secret in Configuration first.",
        })
        .to_string());
    }

    if let Some(cached) = tokens.0.lock().unwrap().as_ref() {
        if Instant::now() < cached.expires_at {
            return Ok(("Authorization", format!("Bearer {}", cached.access_token)));
        }
    }

    let access_token = ensure_fresh_token(app, tokens, cfg).await?;
    Ok(("Authorization", format!("Bearer {}", access_token)))
}

async fn ensure_fresh_token(app: &AppHandle, tokens: &TokenState, cfg: &AppConfig) -> Result<String, String> {
    if !cfg.refresh_token.is_empty() {
        if let Ok(body) = refresh_via_refresh_token(cfg).await {
            return cache_and_return(tokens, &body);
        }
        // Refresh token rejected (expired/revoked) — fall through to client_credentials below.
    }

    let body = refresh_via_client_credentials(cfg).await?;
    let access_token = cache_and_return(tokens, &body)?;
    if let Some(new_refresh_token) = body.get("refresh_token").and_then(|v| v.as_str()) {
        let mut updated_cfg = cfg.clone();
        updated_cfg.refresh_token = new_refresh_token.to_string();
        config::save_config(app, &updated_cfg)?;
    }
    Ok(access_token)
}

async fn refresh_via_refresh_token(cfg: &AppConfig) -> Result<Value, String> {
    let response = reqwest::Client::new()
        .post(format!("{}/oauth/token", cfg.api_base_url))
        .form(&[("grant_type", "refresh_token"), ("refresh_token", cfg.refresh_token.as_str())])
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(oauth_error_message(response).await);
    }
    response.json::<Value>().await.map_err(|e| e.to_string())
}

async fn refresh_via_client_credentials(cfg: &AppConfig) -> Result<Value, String> {
    let response = reqwest::Client::new()
        .post(format!("{}/oauth/token", cfg.api_base_url))
        .form(&[
            ("grant_type", "client_credentials"),
            ("client_id", cfg.client_id.as_str()),
            ("client_secret", cfg.client_secret.as_str()),
            ("scope", KNOWLEDGE_STORE_SCOPE),
        ])
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(oauth_error_message(response).await);
    }
    response.json::<Value>().await.map_err(|e| e.to_string())
}

fn cache_and_return(tokens: &TokenState, body: &Value) -> Result<String, String> {
    let access_token = body
        .get("access_token")
        .and_then(|v| v.as_str())
        .ok_or("Token response missing access_token")?
        .to_string();
    let expires_in = body.get("expires_in").and_then(|v| v.as_u64()).unwrap_or(3600);
    let expires_at = Instant::now() + Duration::from_secs(expires_in.saturating_sub(EXPIRY_SAFETY_MARGIN_SECONDS));
    *tokens.0.lock().unwrap() = Some(CachedToken { access_token: access_token.clone(), expires_at });
    Ok(access_token)
}

// Same {"error": {"code","message"}} -> re-serialized JSON string convention as api_client.rs's
// map_response, so the frontend's parseError() handles token-endpoint failures identically to
// every other endpoint's.
async fn oauth_error_message(response: reqwest::Response) -> String {
    let body: Value = response.json().await.unwrap_or(Value::Null);
    let code = body
        .get("error")
        .and_then(|e| e.get("code"))
        .and_then(|v| v.as_str())
        .unwrap_or("unknown_error");
    let message = body
        .get("error")
        .and_then(|e| e.get("message"))
        .and_then(|v| v.as_str())
        .unwrap_or("Authentication failed");
    serde_json::json!({ "code": code, "message": message }).to_string()
}
