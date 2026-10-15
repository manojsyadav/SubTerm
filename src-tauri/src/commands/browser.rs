//! Tauri commands for the embedded browser and homelab proxy.

use crate::browser_proxy::{self, ProxyInfo};
use tauri::AppHandle;

#[tauri::command]
pub async fn browser_proxy_start(port: Option<u16>) -> Result<ProxyInfo, String> {
    browser_proxy::start_proxy(port).await
}

#[tauri::command]
pub fn browser_proxy_stop() -> Result<(), String> {
    browser_proxy::stop_proxy();
    Ok(())
}

#[tauri::command]
pub fn browser_proxy_status() -> Result<ProxyInfo, String> {
    Ok(browser_proxy::get_proxy_status())
}

/// Open a separate native window for a given URL (desktop only).
#[tauri::command]
pub async fn open_browser_window(
    app: AppHandle,
    url: String,
    title: Option<String>,
) -> Result<(), String> {
    let lowered = url.to_ascii_lowercase();
    if !lowered.starts_with("http://") && !lowered.starts_with("https://") {
        return Err("Only http:// and https:// URLs can be opened in a browser window".into());
    }

    let parsed_url = url
        .parse()
        .map_err(|e| format!("Invalid URL: {e}"))?;

    let label = format!("browser-{}", rand::random::<u32>());
    let win_title = title.unwrap_or_else(|| url.clone());

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        tauri::WebviewWindowBuilder::new(
            &app,
            &label,
            tauri::WebviewUrl::External(parsed_url),
        )
        .title(&win_title)
        .inner_size(1024.0, 768.0)
        .build()
        .map_err(|e| format!("Failed to create browser window: {e}"))?;
        Ok(())
    }

    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        use tauri_plugin_opener::OpenerExt;
        app.opener()
            .open_url(&url, None::<&str>)
            .map_err(|e| format!("[OPEN] {}", e))
    }
}
