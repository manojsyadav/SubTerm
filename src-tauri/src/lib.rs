// windows_subsystem is bin-only; the matching attribute lives in main.rs.

use zeroize::Zeroizing;
use rusqlite::Connection;
use std::sync::Mutex as StdMutex;
use std::path::PathBuf;
use tauri::Manager;
mod ssh_agent;
mod ssh_manager;
mod tunnel;
mod monitor;
mod cloud;
mod cloud_config;
mod about;
mod mirror;
mod docker;
mod mcp;
mod hlc;
mod identity;
mod vault;
mod browser_proxy;
#[cfg(windows)]
mod webview_permissions;
mod commands;
#[cfg(desktop)]
mod identifier_migration;
pub use commands::tunnels::start_tunnel_specs_on;
pub(crate) use commands::sync::{decrypt_entity, encrypt_entity, SyncRecord, SyncReport};
pub(crate) use commands::connection::SSH_KEEPALIVE_SECS;
use ssh_manager::SshState;
use monitor::{MonitorMap, SharedSettings};
use mirror::MirrorMap;
use vault::*;

pub struct DbState {
    pub conn: std::sync::Arc<StdMutex<Option<Connection>>>,
    /// `Zeroizing` wipes the 32-byte AES-256-GCM key on drop. Without
    /// this, the master key lives on in the heap allocator until the
    /// slot is reused — long enough to land in a crash dump or swap
    /// file. The mutex slot itself is overwritten with None on profile
    /// close which triggers the Zeroize Drop.
    pub master_key: StdMutex<Option<Zeroizing<[u8; 32]>>>,
    pub salt: StdMutex<Option<[u8; SALT_LEN]>>,
    pub db_path: StdMutex<Option<PathBuf>>,
    /// Name of the profile the user picked on the launch screen. Drives the
    /// path of `db_path` (under `<app_data>/profiles/<name>.submarine`) and is
    /// cleared by `close_profile` so the app returns to the picker.
    pub active_profile: StdMutex<Option<String>>,
    /// This profile's Hybrid Logical Clock, shared into the SQLite `hlc_now()`
    /// custom function so every row mutation auto-stamps `updated_at`. `Some`
    /// while a profile is open; `None` on the picker. Held behind an Arc so the
    /// same clock instance backs both the SQL function and any Rust-side sync
    /// code (the merge engine's `observe`).
    pub hlc: StdMutex<Option<std::sync::Arc<hlc::Hlc>>>,
    /// Unified master password cached in memory during an active app session.
    /// Enables seamless 0-prompt profile/workspace switching. Wiped on lock or sign out.
    pub session_password: StdMutex<Option<Zeroizing<String>>>,
}

// ---------------------------------------------------------------------------
// Profile path helpers
// ---------------------------------------------------------------------------

/// Where all profile files live. Created on first use. Each profile is an
/// independently encrypted `.submarine` file — no shared salt, no shared key.
pub(crate) fn profiles_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let data_dir = app.path().app_data_dir()
        .map_err(|e| format!("[SYSTEM] APP_DATA_DIR_NOT_FOUND: {}", e))?;
    let dir = data_dir.join("profiles");
    // Migration: If the legacy com.submarine.app directory exists, copy any missing profiles
    // so saved servers, credentials, and SSH keys are preserved seamlessly across app renames.
    if let Some(parent) = data_dir.parent() {
        let legacy_dir = parent.join("com.submarine.app").join("profiles");
        if legacy_dir.is_dir() {
            let _ = std::fs::create_dir_all(&dir);
            if let Ok(entries) = std::fs::read_dir(&legacy_dir) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    if let Some(ext) = path.extension().and_then(|s| s.to_str()) {
                        if ext == "submarine" || ext == "subterm" {
                            let dest = dir.join(entry.file_name());
                            if !dest.exists() {
                                let _ = std::fs::copy(&path, &dest);
                            }
                        }
                    }
                }
            }
        }
    }
    Ok(dir)
}

/// Compute the on-disk path for a named profile. Caller has already
/// validated the name with `validate_profile_name`. Supports both modern
/// `.subterm` and legacy `.submarine` profiles seamlessly.
pub(crate) fn profile_path(app: &tauri::AppHandle, name: &str) -> Result<PathBuf, String> {
    let dir = profiles_dir(app)?;
    let subterm_path = dir.join(format!("{}.subterm", name));
    if subterm_path.exists() {
        return Ok(subterm_path);
    }
    let submarine_path = dir.join(format!("{}.submarine", name));
    if submarine_path.exists() {
        return Ok(submarine_path);
    }
    Ok(subterm_path)
}

/// Reject names that would let a user escape the profiles dir or collide
/// with reserved filenames on Windows. Keep the charset narrow on purpose
/// so a profile name is always a safe filename component on every OS.
pub(crate) fn validate_profile_name(name: &str) -> Result<(), String> {
    let n = name.trim();
    if n.is_empty() {
        return Err("Profile name cannot be empty".into());
    }
    if n.len() > 32 {
        return Err("Profile name too long (max 32 chars)".into());
    }
    if !n.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err("Profile name may only contain letters, numbers, '-' and '_'".into());
    }
    // Windows reserved device names — also weird on macOS/Linux as filename roots.
    let upper = n.to_uppercase();
    let reserved = ["CON", "PRN", "AUX", "NUL"];
    // `last_byte` is safe here because we already enforced ASCII-only at
    // the charset check above — but we still use `?`/`.map(...)` rather
    // than `.unwrap()` so a future relaxation can never silently panic.
    let last_ascii_digit = upper.as_bytes().last().is_some_and(|b| b.is_ascii_digit());
    if reserved.contains(&upper.as_str())
        || (upper.starts_with("COM") && upper.len() == 4 && last_ascii_digit)
        || (upper.starts_with("LPT") && upper.len() == 4 && last_ascii_digit)
    {
        return Err(format!("'{}' is a reserved name on Windows", n));
    }
    Ok(())
}

pub(crate) use commands::sftp::{is_safe_dir_entry_name, session_drag_dir, session_sftp_dir};

/// Library entrypoint shared by both the desktop `bin/main.rs` shim and
/// Tauri's Android entry-point macro. Everything that builds the
/// `tauri::Builder`, registers plugins/state/commands, and finally calls
/// `.run(generate_context!())` lives here so the same binary contents
/// ship on both platforms — only the wrapping is different.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Before anything opens app data or the webview: carry data over from the old
    // `com.subterm.app` identifier (see identifier_migration.rs).
    #[cfg(desktop)]
    identifier_migration::run();

    // Tauri 2 on Linux embeds webkit2gtk-4.1. Two failure modes have to be
    // headed off before the WebKit child process spawns, because once it's
    // up the env it inherited is the only one it sees:
    //
    //   1. The DMA-BUF + EGL renderer that WebKit defaults to crashes with
    //      "EGL_BAD_PARAMETER … Aborting" / SIGABRT on Mesa ≥ 24 across
    //      most GPUs. Flipping it off forces the older GLES path.
    //      (WebKit #258834, tauri-apps/tauri#9304)
    //
    //   2. On Wayland sessions with Mesa ≥ 24 (Fedora 40+, KDE Plasma 6,
    //      GNOME 46+) the bundled webkit2gtk-4.1's eglGetDisplay() against
    //      a wl_display still aborts even with the DMA-BUF renderer off,
    //      because the bundled libwayland-egl ABI predates the host Mesa.
    //      Routing GTK through XWayland avoids the mismatched Wayland-EGL
    //      handshake entirely and keeps the app usable on every desktop.
    //      The trade-off is XWayland's slightly fuzzier HiDPI scaling,
    //      which is acceptable in exchange for "the app actually opens".
    //
    // Every override is gated on `var_os(...).is_none()` so power users
    // (or distros that ship a patched WebKit) can opt back in by exporting
    // the variable themselves before launching.
    #[cfg(target_os = "linux")]
    {
        // The single most effective override for the EGL_BAD_PARAMETER abort
        // seen on Fedora 40+ / Mesa 24+: tell WebKit not to attempt hardware
        // accelerated rendering AT ALL. The flag short-circuits the WebKit
        // codepath that calls eglGetDisplay(), which is the exact line that
        // SIGABRTs when the bundled libwayland-egl can't negotiate with the
        // host Mesa. Set before any of the more granular flags so it wins
        // on builds of WebKit that ignore the renderer-specific switches.
        if std::env::var_os("WEBKIT_DISABLE_HARDWARE_ACCELERATION").is_none() {
            std::env::set_var("WEBKIT_DISABLE_HARDWARE_ACCELERATION", "1");
        }
        // bwrap sandbox strips inherited env from WebKitWebProcess (Fedora's
        // SELinux-confined bwrap is the canonical offender) — the flags we
        // set in this block need to reach the render-process child or none
        // of the rendering overrides will fire.
        //
        // WebKit 2.42 renamed `WEBKIT_FORCE_SANDBOX=0` to
        // `WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS=1` and the old name now
        // emits a warning ("no longer allows disabling the sandbox") instead
        // of actually disabling anything. We set BOTH so the override works
        // across the full WebKit version range we'll meet in the wild —
        // older WebKit picks up the legacy name, 2.42+ picks up the loud
        // one. Losing the sandbox boundary for the webview is acceptable
        // for a desktop app that already runs with the user's full
        // filesystem access; the security boundary that matters
        // (Tauri capabilities + strict CSP) is unaffected.
        if std::env::var_os("WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS").is_none() {
            std::env::set_var("WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS", "1");
        }
        if std::env::var_os("WEBKIT_FORCE_SANDBOX").is_none() {
            std::env::set_var("WEBKIT_FORCE_SANDBOX", "0");
        }
        // Older-renderer + DMA-BUF flags stay as belt-and-braces — they
        // cost nothing on builds where WEBKIT_DISABLE_HARDWARE_ACCELERATION
        // already wins, and they cover the corner cases where a downstream
        // patched WebKit honours one but not the other.
        if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
            std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
        }
        if std::env::var_os("WEBKIT_DISABLE_COMPOSITING_MODE").is_none() {
            std::env::set_var("WEBKIT_DISABLE_COMPOSITING_MODE", "1");
        }
        if std::env::var_os("GDK_BACKEND").is_none() {
            std::env::set_var("GDK_BACKEND", "x11");
        }
        // Mesa software rasteriser flag kept as the final fallback in case
        // WebKit's "no hardware" path still calls into Mesa somewhere.
        if std::env::var_os("LIBGL_ALWAYS_SOFTWARE").is_none() {
            std::env::set_var("LIBGL_ALWAYS_SOFTWARE", "1");
        }
    }

    let builder = tauri::Builder::default();
    // Save/restore the main window's last size + position to a JSON file
    // in app_data_dir. Keeps the user's preferred geometry across launches
    // without us having to wire setSize/setPosition by hand. Plain plugin —
    // it intercepts window events; no JS-facing commands to lock down.
    // Mobile builds skip this entirely: Android decides window geometry,
    // not us, and the plugin's crate isn't compiled into the Android target.
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_window_state::Builder::default().build());
    // Start-on-login (Settings > General). Driven only from Rust (`get_autostart` / `set_autostart`),
    // so no plugin permission is granted to the webview.
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, None));
    // Cross-platform URL opener — Android (Intent.ACTION_VIEW), Windows
    // (start), macOS (open), Linux (xdg-open). about.rs's open_external_url
    // dispatches through this so the same code path works in the desktop
    // installer AND the Android APK. Capability is granted in default.json.
    let builder = builder.plugin(tauri_plugin_opener::init());
    builder
        .manage(DbState { conn: std::sync::Arc::new(StdMutex::new(None)), master_key: StdMutex::new(None), salt: StdMutex::new(None), db_path: StdMutex::new(None), active_profile: StdMutex::new(None), hlc: StdMutex::new(None), session_password: StdMutex::new(None) })
        .manage(SshState::new())
        .manage(commands::rdp_session::RdpSessions::default())
        // Docker live-log stream registry — keyed by frontend-issued stream id,
        // values are tokio AbortHandles so the user can stop tailing on demand.
        .manage(docker::DockerStreams::new())
        // Monitoring state is its own root-level Tauri-managed value, separate
        // from SshState — monitors and interactive sessions own different SSH
        // handles per node and don't share lifecycle.
        .manage::<MonitorMap>(std::sync::Arc::new(tokio::sync::Mutex::new(std::collections::HashMap::new())))
        // Mirror tasks live under their own root-managed map — keyed by mirror
        // id, populated by `start_mirror`, drained by the spawned worker on
        // exit. Session teardown calls `mirror::stop_all_for_session` to make
        // sure no orphan watcher is left running after the SSH handle dies.
        .manage::<MirrorMap>(std::sync::Arc::new(tokio::sync::Mutex::new(std::collections::HashMap::new())))
        // Global monitor settings live in one shared Arc<Mutex>. Pollers
        // read it at the start of every cycle so interval/threshold changes
        // are hot-applied without restarting any monitor.
        .manage::<SharedSettings>(std::sync::Arc::new(tokio::sync::Mutex::new(monitor::MonitorSettings::default())))
        // CloudState needs the AppHandle to find app_data_dir on construction
        // (to load any persisted bearer token). Setup is the earliest hook we
        // get an AppHandle, so initialise it there and `manage` it for commands.
        .setup(|app| {
            cloud_config::init(&app.handle());
            let cloud_state = cloud::CloudState::new(&app.handle());
            app.manage(cloud_state);
            commands::connection::spawn_connection_health_watchers(app.handle().clone());
            #[cfg(windows)]
            webview_permissions::allow_clipboard_read(app);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::profile::check_db_exists,
            commands::profile::setup_master_db,
            commands::profile::persist_vault,
            commands::profile::list_profiles,
            commands::profile::cloud_list_sync_profiles,
            commands::profile::cloud_delete_profile,
            commands::profile::force_push_profile,
            commands::profile::select_profile,
            commands::profile::create_profile,
            commands::profile::delete_profile,
            commands::profile::rename_profile,
            commands::profile::close_profile,
            commands::profile::prepare_switch_profile,
            commands::profile::has_session_password,
            commands::profile::switch_profile_seamless,
            commands::profile::get_profiles_sync_status,
            commands::profile::sync_profile_password,
            commands::profile::change_master_password,
            commands::profile::export_profile,
            commands::profile::import_profile_pick,
            commands::profile::import_profile_save,
            commands::profile::save_audit_log,
            cloud::cloud_set_api_base, cloud::cloud_status, cloud::cloud_signup, cloud::cloud_consume_verify_link,
            cloud::cloud_set_password, cloud::cloud_login, cloud::cloud_logout,
            cloud::cloud_request_password_reset, cloud::cloud_reset_password,
            cloud::cloud_request_login_link, cloud::cloud_login_with_link,
            cloud_config::cloud_get_server, cloud_config::cloud_set_server,
            commands::sync::sync_now,
            commands::sync::identity_status,
            commands::sync::setup_identity,
            commands::sync::reset_identity,
            commands::sync::share_current_profile,
            commands::sync::invite_to_share,
            commands::sync::list_shares,
            commands::sync::share_member_list,
            commands::sync::accept_share,
            commands::sync::import_shared_profile,
            commands::sync::restore_personal_profile,
            commands::sync::share_set_role,
            commands::sync::share_revoke,
            commands::sync::share_leave,
            commands::sync::share_delete,
            commands::sync::profile_share_status,
            commands::sync::stop_sharing,
            commands::sync::profile_sync_stats,
            commands::sync::sync_conflict_diff,
            commands::sync::set_editor_label,
            commands::sync::get_sync_excluded,
            commands::profile::save_text_file, commands::profile::save_binary_file, commands::profile::save_temp_file, commands::profile::recordings_dir, commands::profile::save_recording,
            commands::diagnostics::set_ui_zoom,
            commands::diagnostics::get_autostart,
            commands::diagnostics::set_autostart,
            commands::rdp::launch_rdp,
            commands::rdp_session::rdp_connect,
            commands::rdp_session::rdp_send_input,
            commands::rdp_session::rdp_disconnect,
            commands::rdp_session::rdp_answer_certificate,
            commands::servers::set_server_protocol,
            commands::sftp_remote_copy::sftp_copy_between_sessions,
            commands::sync::set_sync_excluded,
            commands::servers::add_server, commands::servers::save_quick_connect_node, commands::servers::resolve_ssh_target, commands::servers::find_saved_servers, commands::servers::edit_server, commands::servers::delete_server, commands::servers::add_mirror_to_server, commands::servers::get_servers, commands::servers::get_ssh_keys, commands::servers::set_server_color, commands::servers::set_folder_color, commands::servers::set_server_notes, commands::servers::set_server_run_on_connect, commands::servers::set_server_jump_host, commands::servers::set_server_is_production, commands::servers::set_server_icon, commands::servers::update_server_os_info, commands::servers::reorder_servers, commands::servers::clone_server, commands::servers::reveal_server_password, commands::servers::reveal_credential_password, commands::servers::reveal_ssh_key,
            commands::servers::get_credentials, commands::servers::generate_ssh_key,
            commands::servers::add_folder, commands::servers::rename_folder, commands::servers::delete_folder, commands::servers::get_folders,
            commands::servers::add_command, commands::servers::edit_command, commands::servers::delete_command, commands::servers::get_commands,
            commands::servers::cmd_history_add, commands::servers::cmd_history_list, commands::servers::cmd_history_clear, commands::servers::cmd_history_prune,
            commands::servers::add_note, commands::servers::edit_note, commands::servers::delete_note, commands::servers::get_notes,
            commands::mirror::mirror_dry_run,
            commands::mirror::start_mirror,
            commands::mirror::stop_mirror,
            commands::mirror::list_mirrors,
            commands::mirror::pick_local_directory,
            commands::servers::add_credential, commands::servers::edit_credential, commands::servers::delete_credential,
            commands::servers::add_ssh_key, commands::servers::edit_ssh_key, commands::servers::delete_ssh_key,
            commands::profile::get_known_hosts,
            commands::profile::delete_known_host,
            commands::profile::clear_all_known_hosts,
            commands::connection::initiate_connection,
            commands::connection::verify_fingerprint_response,
            commands::connection::submit_kbi_response,
            commands::connection::disconnect_session,
            commands::tunnels::start_tunnel, commands::tunnels::stop_tunnel, commands::tunnels::list_tunnels, commands::tunnels::restart_session_tunnels, commands::tunnels::persist_session_tunnels,
            commands::terminal::open_terminal, commands::terminal::open_local_terminal, commands::terminal::subscribe_terminal_output, commands::terminal::get_available_local_shells, commands::terminal::write_terminal_data, commands::terminal::write_saved_password, commands::terminal::has_saved_password, commands::servers::get_synced_shortcuts, commands::servers::set_synced_shortcuts, commands::terminal::resize_terminal, commands::terminal::close_terminal,
            commands::diagnostics::ssh_info_probe_section,
            commands::diagnostics::ssh_systemctl_action,
            commands::diagnostics::ssh_kill_process,
            commands::diagnostics::detect_session_os,
            commands::diagnostics::get_session_telemetry,
            commands::diagnostics::ssh_iptables_chain,
            commands::diagnostics::ssh_nft_chain,
            docker::ssh_docker_container_action,
            docker::ssh_docker_inspect,
            docker::ssh_docker_stats,
            docker::ssh_docker_logs,
            docker::ssh_docker_logs_start,
            docker::ssh_docker_logs_stop,
            docker::ssh_docker_networks,
            docker::ssh_docker_containers,
            docker::ssh_docker_images_list,
            docker::ssh_docker_volumes_list,
            docker::ssh_docker_compose_list,
            docker::ssh_docker_compose_per_container,
            docker::ssh_docker_compose_services,
            docker::ssh_docker_compose_action,
            docker::ssh_docker_compose_view,
            docker::ssh_docker_prune,
            docker::open_container_terminal,
            commands::sftp::select_local_folder, commands::sftp::local_list_dir, commands::sftp::local_drives,
            commands::sftp::local_home_dir, commands::sftp::local_desktop_dir, commands::sftp::local_create_dir, commands::sftp::local_remove, commands::sftp::local_rename,
            commands::sftp::android_quick_dirs, commands::sftp::android_default_local_dir,
            commands::sftp::parse_ssh_config,
            commands::sftp::parse_client_import,
            commands::sftp::sftp_list_dir, commands::sftp::sftp_resolve_owners, commands::sftp::sftp_create_dir, commands::sftp::sftp_remove_file, commands::sftp::sftp_remove_dir,
            commands::sftp::sftp_rename, commands::sftp::sftp_set_permissions, commands::sftp::sftp_set_owner,
            commands::sftp::sftp_download_file, commands::sftp::sftp_download_dir, commands::sftp::sftp_upload_file, commands::sftp::sftp_upload_dir, commands::sftp::sftp_cancel_transfer, commands::sftp::sftp_open_remote_file,
            commands::sftp::sftp_read_file_text, commands::sftp::sftp_write_file_text, commands::sftp::local_read_file_text, commands::sftp::local_write_file_text, commands::sftp::sftp_exec_command, commands::sftp::sftp_resolve_path, commands::sftp::local_resolve_path, commands::connection::set_auto_reconnect_events,
            commands::sftp::sftp_read_file_base64, commands::sftp::local_read_file_base64,
            commands::sftp::local_open_file, commands::sftp::local_open_in_explorer, commands::sftp::sftp_prepare_drag,
            commands::sftp::local_copy_entry,
            commands::terminal::set_ssh_keepalive_interval, commands::terminal::set_ssh_connect_timeout, commands::terminal::set_host_key_policy,
            commands::network::send_wake_on_lan, commands::network::perform_port_knock,
            commands::network::probe_tcp_port, commands::network::batch_probe_ports,
            commands::ai::ai_list_providers,
            commands::ai::ai_save_provider,
            commands::ai::ai_delete_provider,
            commands::ai::ai_list_models,
            commands::ai::ai_chat,
            commands::ai::ai_exec,
            commands::ai::ai_cancel,
            commands::mcp::mcp_start,
            commands::mcp::mcp_stop,
            commands::mcp::mcp_set_sessions,
            commands::mcp::mcp_answer,
            commands::monitor_settings::monitor_list,
            commands::monitor_settings::monitor_add,
            commands::monitor_settings::monitor_remove,
            commands::monitor_settings::monitor_set_metrics,
            commands::monitor_settings::monitor_set_custom_metrics,
            commands::monitor_settings::monitor_resume,
            commands::monitor_settings::monitor_pause,
            commands::monitor_settings::monitor_resume_all,
            commands::monitor_settings::monitor_pause_all,
            commands::monitor_settings::monitor_get_settings,
            commands::monitor_settings::monitor_set_settings,
            commands::browser::browser_proxy_start,
            commands::browser::browser_proxy_stop,
            commands::browser::browser_proxy_status,
            commands::browser::open_browser_window,
            about::app_info, about::check_for_updates, about::open_external_url
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dir_entry_name_rejects_traversal_and_separators() {
        // Attack vectors a hostile SFTP server can put in a readdir name.
        for bad in [
            "",
            ".",
            "..",
            "../../etc/passwd",
            "..\\..\\Startup\\x.bat",
            "a/b",
            "a\\b",
            "/etc/passwd",
            "with\0nul",
        ] {
            assert!(!is_safe_dir_entry_name(bad), "should reject {:?}", bad);
        }
    }

    #[test]
    fn dir_entry_name_accepts_plain_filenames() {
        // Legitimate names must still pass — including ones that merely
        // start with dots or contain colons/spaces (all legal on POSIX).
        for ok in [
            "file.txt",
            "notes 2024.md",
            ".bashrc",
            "..foo",
            "2024:01:01.log",
            "release-v0.2.37",
            "Ω_unicode_名前",
        ] {
            assert!(is_safe_dir_entry_name(ok), "should accept {:?}", ok);
        }
    }
}
