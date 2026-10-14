// WebView2 asks the user before a page reads the clipboard, with a browser-style "tauri.localhost
// wants to see text and images copied to the clipboard" bubble. In SubTerm that bubble appeared on
// the first right-click paste, Ctrl+V of an image, or menu Paste of a fresh install, and the paste
// hung until it was answered. Clipboard read is granted here for SubTerm's own pages only; every
// other permission keeps WebView2's default handling.

use tauri::Manager;

pub fn allow_clipboard_read(app: &tauri::App) {
    let Some(window) = app.get_webview_window("main") else { return };
    let _ = window.with_webview(|webview| unsafe {
        use webview2_com::Microsoft::Web::WebView2::Win32::*;
        let Ok(core) = webview.controller().CoreWebView2() else { return };
        let handler = webview2_com::PermissionRequestedEventHandler::create(Box::new(|_, args| {
            let Some(args) = args else { return Ok(()) };
            let mut kind = COREWEBVIEW2_PERMISSION_KIND::default();
            args.PermissionKind(&mut kind)?;
            let mut uri = windows_core::PWSTR::null();
            args.Uri(&mut uri)?;
            if kind == COREWEBVIEW2_PERMISSION_KIND_CLIPBOARD_READ && is_app_origin(&webview2_com::take_pwstr(uri)) {
                args.SetState(COREWEBVIEW2_PERMISSION_STATE_ALLOW)?;
            }
            Ok(())
        }));
        let mut token = 0i64;
        let _ = core.add_PermissionRequested(&handler, &mut token);
    });
}

/// The bundled app (`http://tauri.localhost`) or the dev server (`http://localhost:1420`).
fn is_app_origin(uri: &str) -> bool {
    ["http://tauri.localhost/", "https://tauri.localhost/", "http://localhost:1420/"].iter().any(|o| uri.starts_with(o))
}

#[cfg(test)]
mod tests {
    #[test]
    fn only_the_app_itself_gets_clipboard_read() {
        assert!(super::is_app_origin("http://tauri.localhost/"));
        assert!(super::is_app_origin("http://localhost:1420/index.html"));
        assert!(!super::is_app_origin("http://tauri.localhost.evil.example/"));
        assert!(!super::is_app_origin("https://example.com/"));
    }
}
