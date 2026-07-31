use std::time::Duration;

const REQUEST_TIMEOUT_SECONDS: u64 = 30;

/// Shared HTTP client for every outbound request this app makes — API calls and the OAuth2 token
/// endpoint alike. A bare `reqwest::Client::new()` has no timeout at all, so a stalled connection
/// (a network hiccup, a server that stops responding mid-request) hangs the calling Tauri command
/// forever: the invoke() promise never resolves or rejects, so the frontend has nothing to catch
/// and just sits on whatever it rendered optimistically before the call — no error, no recovery,
/// indefinitely. A finite timeout guarantees every request eventually surfaces one or the other.
pub fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(REQUEST_TIMEOUT_SECONDS))
        .build()
        .expect("failed to build HTTP client")
}
