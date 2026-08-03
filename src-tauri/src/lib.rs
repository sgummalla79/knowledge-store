mod api_client;
mod config;
mod http_client;
mod oauth_client;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(oauth_client::TokenState::default())
        .invoke_handler(tauri::generate_handler![
            api_client::get_config,
            api_client::save_config,
            api_client::authenticate,
            api_client::disconnect,
            api_client::get_embedding_options,
            api_client::list_embedding_models,
            api_client::list_libraries,
            api_client::create_library,
            api_client::update_library,
            api_client::delete_library,
            api_client::list_documents,
            api_client::crawl_document,
            api_client::get_crawl_status,
            api_client::delete_document,
            api_client::rename_document,
            api_client::cancel_upload_job,
            api_client::retry_document,
            api_client::get_file_size,
            api_client::upload_document,
            api_client::get_job_status,
            api_client::get_embedding_settings,
            api_client::save_embedding_settings,
            api_client::clear_embedding_settings,
            api_client::get_search_settings,
            api_client::save_search_settings,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
