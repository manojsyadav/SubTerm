// Thin Tauri-command wrappers around the mirror sync engine (top-level
// `mirror.rs`). Kept separate from the engine itself so the engine stays
// Tauri-agnostic; these just translate managed state into engine calls.

use crate::mirror::{self, MirrorMap};
use crate::ssh_manager::SshState;
use std::sync::Arc;

#[tauri::command]
pub(crate) async fn mirror_dry_run(
    ssh: tauri::State<'_, SshState>,
    session_id: String,
    spec: mirror::MirrorSpec,
) -> Result<mirror::DryRunReport, String> {
    let handle = {
        let conns = ssh.connections.lock().await;
        conns.get(&session_id).cloned()
            .ok_or_else(|| "Session not connected".to_string())?
    };
    mirror::dry_run(handle, spec).await
}

#[tauri::command]
pub(crate) async fn start_mirror(
    app: tauri::AppHandle,
    ssh: tauri::State<'_, SshState>,
    mirrors: tauri::State<'_, MirrorMap>,
    session_id: String,
    spec: mirror::MirrorSpec,
) -> Result<String, String> {
    let handle = {
        let conns = ssh.connections.lock().await;
        conns.get(&session_id).cloned()
            .ok_or_else(|| "Session not connected".to_string())?
    };
    mirror::start(app, session_id, handle, Arc::clone(&mirrors), spec).await
}

#[tauri::command]
pub(crate) async fn stop_mirror(
    mirrors: tauri::State<'_, MirrorMap>,
    mirror_id: String,
) -> Result<(), String> {
    mirror::stop(&mirrors, &mirror_id).await
}

#[tauri::command]
pub(crate) async fn list_mirrors(
    mirrors: tauri::State<'_, MirrorMap>,
    session_id: Option<String>,
) -> Result<Vec<mirror::MirrorStatus>, String> {
    Ok(mirror::list(&mirrors, session_id.as_deref()).await)
}

/// Native OS folder picker. Used by MirrorsPanel to fill in `local`.
#[tauri::command]
pub(crate) async fn pick_local_directory() -> Result<Option<String>, String> {
    #[cfg(mobile)]
    {
        return Err("Folder picker not available on Android.".into());
    }
    #[cfg(desktop)]
    {
        let path = rfd::AsyncFileDialog::new().pick_folder().await;
        Ok(path.map(|p| p.path().to_string_lossy().into_owned()))
    }
}
