mod api_client;
mod config;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            api_client::get_config,
            api_client::save_config,
            api_client::get_embedding_options,
            api_client::list_libraries,
            api_client::create_library,
            api_client::delete_library,
            api_client::list_documents,
            api_client::upload_document,
            api_client::get_job_status,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
