// Profile lifecycle: create/list/select/switch/close/rename/delete/export/
// import profiles, master-password change, the vault schema bootstrap
// (setup_master_db/setup_master_db_inner), and known-hosts management.
// Extracted out of lib.rs as one unit since nearly every command here
// calls directly into both vault crypto and the sync engine bootstrap
// rather than through a narrow API.

use crate::vault::{
    decrypt_with_key, derive_key, encrypt_with_key, get_or_create_dek, parse_vault_blob,
    save_vault_blocking, save_vault_internal, to_sqlite_owned, vault_decompress, write_vault_blob,
    HEADER_LEN, NONCE_LEN, SALT_LEN, VAULT_MAGIC, VAULT_VERSION,
};
use crate::{
    cloud, commands, hlc, monitor, profile_path, profiles_dir, session_drag_dir,
    session_sftp_dir, tunnel, validate_profile_name, DbState, MonitorMap, SshState, SyncReport,
};
use rand::Rng;
use rusqlite::{Connection, DatabaseName};
use std::fs;
use std::path::PathBuf;
use zeroize::{Zeroize, Zeroizing};

pub(crate) async fn save_vault_async(state: &DbState) -> Result<(), String> {
    let conn_arc = std::sync::Arc::clone(&state.conn);
    let (key, salt, path) = {
        let kg = state.master_key.lock().map_err(|_| "[STATE] MUTEX_POISON_KEY")?;
        let sg = state.salt.lock().map_err(|_| "[STATE] MUTEX_POISON_SALT")?;
        let pg = state.db_path.lock().map_err(|_| "[STATE] MUTEX_POISON_PATH")?;
        match (kg.as_ref(), sg.as_ref(), pg.as_ref()) {
            (Some(k), Some(s), Some(p)) => (k.clone(), *s, p.clone()),
            _ => return Err("[STATE] MISSING_REQUIRED_RESOURCES_FOR_SAVE".into()),
        }
    };
    tokio::task::spawn_blocking(move || {
        let cg = conn_arc.lock().map_err(|_| "[STATE] MUTEX_POISON_CONN")?;
        let conn = cg.as_ref().ok_or("[STATE] DATABASE_NOT_INITIALIZED")?;
        save_vault_blocking(conn, &key, &salt, &path)
    })
    .await
    .map_err(|e| format!("[CRYPTO] VAULT_JOIN: {}", e))?
}

/// Returns the list of available profile names (sorted, lowercased not enforced).
#[tauri::command]
pub(crate) async fn list_profiles(app_handle: tauri::AppHandle) -> Result<Vec<String>, String> {
    let dir = profiles_dir(&app_handle)?;
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    for entry in fs::read_dir(&dir).map_err(|e| format!("[FILE] READ_DIR_FAILED: {}", e))? {
        let entry = match entry { Ok(e) => e, Err(_) => continue };
        let path = entry.path();
        if !path.is_file() { continue; }
        let ext = path.extension().and_then(|e| e.to_str());
        if ext != Some("subterm") && ext != Some("submarine") { continue; }
        if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
            // Hide anything that wouldn't pass our name validator — likely
            // a manually-placed file or stray artefact. We don't surface it
            // because the user has no way to act on it from the UI.
            if !out.contains(&stem.to_string()) && validate_profile_name(stem).is_ok() {
                out.push(stem.to_string());
            }
        }
    }
    out.sort_by(|a, b| a.to_lowercase().cmp(&b.to_lowercase()));
    Ok(out)
}

/// List the caller's CLOUD profiles (from the per-entity sync store) so the
/// picker can surface profiles that exist in the account but not yet on this
/// device — the "sign in and see all your profiles" path. Read-only; requires
/// a signed-in cloud session. The UI merges these with the local
/// `list_profiles`, matching by name: a profile present locally is opened with
/// its password; a cloud-only one is restored (name pre-filled) then opened.
#[tauri::command]
pub(crate) async fn cloud_list_sync_profiles(
    app: tauri::AppHandle,
    cloud: tauri::State<'_, std::sync::Arc<cloud::CloudState>>,
) -> Result<Vec<cloud::SyncProfileInfo>, String> {
    cloud::list_sync_profiles(&app, &cloud).await
}

/// Delete one of the caller's OWN personal profiles from the cloud: wipes every
/// synced record (data, tombstones, and the escrow key) for that partition on
/// the server. Owner-scoped by construction — the /sync store is per-user, so a
/// caller can only ever delete their own partition. The local vault (if any) is
/// left alone; the UI offers "remove from this device" as a separate action.
/// Returns the number of records the server removed.
#[tauri::command]
pub(crate) async fn cloud_delete_profile(
    app: tauri::AppHandle,
    cloud: tauri::State<'_, std::sync::Arc<cloud::CloudState>>,
    profile: String,
) -> Result<i64, String> {
    let profile = profile.trim().to_string();
    if profile.is_empty() {
        return Err("[SYNC] NO_PROFILE_NAME".into());
    }
    cloud::delete_sync_profile(&app, &cloud, &profile).await
}

/// Replace this profile's entire cloud copy with what's on THIS device.
///
/// The escape hatch for a partition that can no longer converge. Records are
/// encrypted with the profile's DEK, and a vault copy that reached a device
/// without one — an old pre-sync backup, say — mints a brand-new DEK on open and
/// pushes everything under it. Those records are then permanently undecryptable
/// to every other device: the merge skips them on every sync (correctly — they
/// could be corrupt or hostile), so they sit in the cloud forever showing up as
/// "N to receive" that no amount of syncing can clear. Nothing else can remove
/// them, because you can't tombstone a record whose uuid you never learned.
///
/// Wipes the server partition, then pushes the local vault back in full. Local
/// data is never touched. Personal profiles only — on a shared one this would
/// silently destroy other members' contributions, which is not a decision one
/// member gets to make from a "fix my sync" button.
#[tauri::command]
pub(crate) async fn force_push_profile(
    app: tauri::AppHandle,
    db_state: tauri::State<'_, DbState>,
    cloud: tauri::State<'_, std::sync::Arc<cloud::CloudState>>,
) -> Result<SyncReport, String> {
    let profile = db_state
        .active_profile
        .lock()
        .map_err(|_| "[STATE] LOCK_PROFILE")?
        .clone()
        .ok_or("[SYNC] NO_PROFILE_OPEN")?;
    let (share_id, cloud_profile) = {
        let conn_g = db_state.conn.lock().map_err(|_| "[STATE] LOCK_CONN")?;
        let conn = conn_g.as_ref().ok_or("[STATE] DB_NOT_OPEN")?;
        let sid: Option<String> = conn
            .query_row("SELECT value FROM sync_meta WHERE key='share_id'", [], |r| r.get(0))
            .ok();
        let cp: String = conn
            .query_row("SELECT value FROM sync_meta WHERE key='cloud_profile'", [], |r| r.get(0))
            .unwrap_or_else(|_| profile.clone());
        (sid, cp)
    };
    if share_id.is_some() {
        return Err("[SYNC] SHARED_PROFILE: this profile is shared with other people, and replacing the cloud copy would delete their changes too. Stop sharing first if you really want to reset it.".into());
    }
    let removed = cloud::delete_sync_profile(&app, &cloud, &cloud_profile).await?;
    eprintln!("[SYNC] force push: server dropped {removed} record(s) for '{cloud_profile}'");
    // Pushes are always a full set, so the very next sync repopulates the
    // partition from this vault — including a fresh DEK escrow record.
    commands::sync::sync_now(app, db_state, cloud).await
}

/// Mark a profile as the active one. Subsequent `check_db_exists` /
/// `setup_master_db` calls operate against that profile's file. Returns
/// whether the profile's encrypted file already exists (caller uses this
/// to decide between "ask for password" and "this profile is empty / not
/// yet created" flows).
#[tauri::command]
pub(crate) async fn select_profile(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, DbState>,
    name: String,
) -> Result<bool, String> {
    validate_profile_name(&name)?;
    *state.active_profile.lock().map_err(|_| "[STATE] LOCK_FAILED")? = Some(name.clone());
    Ok(profile_path(&app_handle, &name)?.exists())
}

/// Helper to tear down runtime state for the currently active profile
/// (flushes in-memory DB changes, disconnects all SSH/SFTP/PTY sessions, stops monitors,
/// and clears active connection handles).
pub(crate) async fn teardown_profile_runtime(
    state: &DbState,
    ssh: &SshState,
    monitor_map: &MonitorMap,
) -> Result<(), String> {
    // 0. Persist any accumulated in-memory changes (chief among them:
    // cmd_history rows written by TerminalView's Enter-key handler, which
    // deliberately skip a per-keystroke fsync). Best-effort: if the vault
    // isn't in a saveable state (partial init, crypto error) just log via
    // the returned Err and continue teardown — losing recent history is
    // preferable to leaking session state.
    let _ = save_vault_async(state).await;

    // 1. Stop monitor pollers. Flip `paused` first so the next loop iteration
    // releases the SSH handle, then drop the map so the Arc strong_count
    // falls to 1 and the poller exits.
    monitor::pause_all(monitor_map.clone()).await;
    monitor_map.lock().await.clear();

    // 2. Collect every active session id, then run the standard
    // disconnect path for each one. This frees tunnel listener sockets,
    // SFTP channels, and the SSH handle in the right order.
    let session_ids: Vec<String> = ssh.connections.lock().await.keys().cloned().collect();
    for sid in &session_ids {
        tunnel::stop_all_for_session(&ssh.tunnels, sid).await;
        ssh.forwarded_targets.lock().await.remove(sid);
        ssh.sftp_sessions.lock().await.remove(sid);
        ssh.connections.lock().await.remove(sid);
        let temp = session_sftp_dir(sid);
        if temp.exists() {
            let _ = std::fs::remove_dir_all(&temp);
        }
        let drag = session_drag_dir(sid);
        if drag.exists() {
            let _ = std::fs::remove_dir_all(&drag);
        }
    }

    // 3. Close every terminal channel. The spawned PTY task watches its
    // `rx` end — dropping the senders here lets each task observe `None`
    // and call `channel.close()` cleanly. We do this AFTER connections are
    // gone so the task sees the close before trying another write.
    ssh.terminal_txs.lock().await.clear();
    ssh.resize_txs.lock().await.clear();

    // 4. Abort any pending fingerprint prompts. Sending `false` to the
    // oneshot rejects the prompt; if the rx side is already gone, the
    // send just errors out which is fine.
    let waiters: Vec<tokio::sync::oneshot::Sender<bool>> =
        ssh.fp_txs.lock().await.drain().map(|(_, v)| v).collect();
    for tx in waiters {
        let _ = tx.send(false);
    }
    // Same for any pending keyboard-interactive (2FA) prompt — sending `None`
    // signals cancel so the connect worker aborts the interactive attempt
    // instead of hanging on its 120s timeout after the profile is gone.
    let kbi_waiters: Vec<tokio::sync::oneshot::Sender<Option<Vec<String>>>> =
        ssh.kbi_txs.lock().await.drain().map(|(_, v)| v).collect();
    for tx in kbi_waiters {
        let _ = tx.send(None);
    }

    // 5. Belt-and-suspenders: clear the residual maps in case anything
    // raced in between the steps above.
    ssh.tunnels.lock().await.clear();
    ssh.forwarded_targets.lock().await.clear();
    ssh.sftp_sessions.lock().await.clear();
    ssh.connections.lock().await.clear();
    ssh.jump_connections.lock().await.clear();
    ssh.fp_txs.lock().await.clear();
    ssh.kbi_txs.lock().await.clear();

    // 6. Drop DB state last, so any in-flight write triggered by a
    // disconnecting handler above had a valid DB to land in.
    *state.conn.lock().map_err(|_| "[STATE] LOCK_FAILED_CONN")? = None;
    *state.master_key.lock().map_err(|_| "[STATE] LOCK_FAILED_KEY")? = None;
    *state.salt.lock().map_err(|_| "[STATE] LOCK_FAILED_SALT")? = None;
    *state.db_path.lock().map_err(|_| "[STATE] LOCK_FAILED_PATH")? = None;
    *state.active_profile.lock().map_err(|_| "[STATE] LOCK_FAILED_PROFILE")? = None;
    *state.hlc.lock().map_err(|_| "[STATE] LOCK_FAILED_HLC")? = None;
    Ok(())
}

/// Explicit lock / sign out. Tears down all profile state and purges
/// the cached session master password from memory.
#[tauri::command]
pub(crate) async fn close_profile(
    state: tauri::State<'_, DbState>,
    ssh: tauri::State<'_, SshState>,
    monitor_map: tauri::State<'_, MonitorMap>,
) -> Result<(), String> {
    teardown_profile_runtime(&state, &ssh, &monitor_map).await?;
    *state.session_password.lock().map_err(|_| "[STATE] LOCK_FAILED_SESSION_PW")? = None;
    Ok(())
}

/// Prepare to switch profile (returns to profile select while preserving
/// the cached master session password).
#[tauri::command]
pub(crate) async fn prepare_switch_profile(
    state: tauri::State<'_, DbState>,
    ssh: tauri::State<'_, SshState>,
    monitor_map: tauri::State<'_, MonitorMap>,
) -> Result<(), String> {
    teardown_profile_runtime(&state, &ssh, &monitor_map).await
}

/// Check if a valid master session password is currently cached in memory.
#[tauri::command]
pub(crate) async fn has_session_password(state: tauri::State<'_, DbState>) -> Result<bool, String> {
    let guard = state.session_password.lock().map_err(|_| "[STATE] LOCK_FAILED")?;
    Ok(guard.is_some())
}

/// Switch active profile/workspace directly using the cached session master password.
/// Drops existing SSH connections and runtime state of the active profile,
/// and attempts to open the target profile using the current session's password.
#[tauri::command]
pub(crate) async fn switch_profile_seamless(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, DbState>,
    ssh: tauri::State<'_, SshState>,
    monitor_map: tauri::State<'_, MonitorMap>,
    target_name: String,
) -> Result<(), String> {
    validate_profile_name(&target_name)?;
    let target_path = profile_path(&app_handle, &target_name)?;
    if !target_path.exists() {
        return Err(format!("Profile '{}' not found on disk", target_name));
    }

    let cached_pw = {
        let guard = state.session_password.lock().map_err(|_| "[STATE] LOCK_FAILED")?;
        match guard.as_ref() {
            Some(pw) => (**pw).clone(),
            None => return Err("[AUTH] NO_SESSION_PASSWORD: sign-in required".into()),
        }
    };

    teardown_profile_runtime(&state, &ssh, &monitor_map).await?;

    *state.active_profile.lock().map_err(|_| "[STATE] LOCK_FAILED")? = Some(target_name.clone());

    match setup_master_db_inner(app_handle, cached_pw, state.clone(), false).await {
        Ok(()) => Ok(()),
        Err(e) => {
            *state.active_profile.lock().map_err(|_| "[STATE] LOCK_FAILED")? = None;
            Err(e)
        }
    }
}

#[derive(serde::Serialize)]
pub(crate) struct ProfileSyncStatus {
    name: String,
    synced: bool,
}

/// Check which on-disk profiles match the current master session password.
#[tauri::command]
pub(crate) async fn get_profiles_sync_status(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, DbState>,
) -> Result<Vec<ProfileSyncStatus>, String> {
    let cached_pw = {
        let guard = state.session_password.lock().map_err(|_| "[STATE] LOCK_FAILED")?;
        match guard.as_ref() {
            Some(pw) => (**pw).clone(),
            None => return Err("[AUTH] NO_SESSION_PASSWORD".into()),
        }
    };

    let dir = profiles_dir(&app_handle)?;
    if !dir.exists() {
        return Ok(Vec::new());
    }

    let mut results = Vec::new();
    let entries = fs::read_dir(&dir).map_err(|e| format!("[FILE] READ_DIR: {}", e))?;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() { continue; }
        let ext = path.extension().and_then(|e| e.to_str());
        if ext != Some("subterm") && ext != Some("submarine") { continue; }
        if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
            if validate_profile_name(stem).is_err() { continue; }
            let name = stem.to_string();
            let pw_copy = cached_pw.clone();
            let path_copy = path.clone();
            let is_synced = tokio::task::spawn_blocking(move || {
                if let Ok(data) = fs::read(&path_copy) {
                    if let Ok((parsed_salt, nonce, ciphertext)) = parse_vault_blob(&data) {
                        let mut salt_fixed = [0u8; SALT_LEN];
                        salt_fixed.copy_from_slice(&parsed_salt);
                        if let Ok(derived) = derive_key(&pw_copy, &salt_fixed) {
                            let key = Zeroizing::new(derived);
                            return decrypt_with_key(&ciphertext, &nonce, &key).is_ok();
                        }
                    }
                }
                false
            }).await.unwrap_or(false);

            results.push(ProfileSyncStatus { name, synced: is_synced });
        }
    }
    results.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(results)
}

/// Convert an existing profile to use the current Unified Master Password.
/// Requires the profile's current password once to decrypt its vault.
#[tauri::command]
pub(crate) async fn sync_profile_password(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, DbState>,
    name: String,
    current_password: String,
) -> Result<(), String> {
    validate_profile_name(&name)?;
    let target_path = profile_path(&app_handle, &name)?;
    if !target_path.exists() {
        return Err(format!("Profile '{}' not found on disk", name));
    }

    let master_pw = {
        let guard = state.session_password.lock().map_err(|_| "[STATE] LOCK_FAILED")?;
        match guard.as_ref() {
            Some(pw) => (**pw).clone(),
            None => return Err("[AUTH] NO_SESSION_PASSWORD: sign-in required".into()),
        }
    };

    let target_path_clone = target_path.clone();
    let master_pw_for_task = master_pw.clone();
    tokio::task::spawn_blocking(move || {
        let data = fs::read(&target_path_clone)
            .map_err(|e| format!("[FILE] READ_FAILED: {}", e))?;
        let (parsed_salt, nonce, ciphertext) = parse_vault_blob(&data)?;
        let mut old_salt = [0u8; SALT_LEN];
        old_salt.copy_from_slice(&parsed_salt);

        let old_derived = derive_key(&current_password, &old_salt)
            .map_err(|e| format!("[CRYPTO] DERIVE_FAILED: {}", e))?;
        let old_key = Zeroizing::new(old_derived);
        let decrypted_raw = Zeroizing::new(decrypt_with_key(&ciphertext, &nonce, &old_key)
            .map_err(|_| "Incorrect current password for this workspace".to_string())?);

        // Generate fresh salt and encrypt with master_pw
        let mut fresh_salt = [0u8; SALT_LEN];
        rand::thread_rng().fill(&mut fresh_salt);
        let new_derived = derive_key(&master_pw_for_task, &fresh_salt)
            .map_err(|e| format!("[CRYPTO] DERIVE_NEW_FAILED: {}", e))?;
        let new_key = Zeroizing::new(new_derived);

        let (new_ciphertext, new_nonce) = encrypt_with_key(&decrypted_raw, &new_key)?;
        let new_blob = write_vault_blob(&fresh_salt, &new_nonce, &new_ciphertext);

        let tmp_path = target_path_clone.with_extension("subterm.tmp");
        {
            use std::io::Write as _;
            let mut f = fs::File::create(&tmp_path)
                .map_err(|e| format!("[FILE] TMP_CREATE_FAILED: {}", e))?;
            f.write_all(&new_blob)
                .map_err(|e| format!("[FILE] TMP_WRITE_FAILED: {}", e))?;
            f.sync_all()
                .map_err(|e| format!("[FILE] TMP_SYNC_FAILED: {}", e))?;
        }
        fs::rename(&tmp_path, &target_path_clone)
            .map_err(|e| format!("[FILE] RENAME_FAILED: {}", e))?;

        Ok::<(), String>(())
    })
    .await
    .map_err(|e| format!("[CRYPTO] JOIN_ERROR: {}", e))??;

    // If this profile was active in memory, also update state.master_key and salt
    let is_active = {
        let active = state.active_profile.lock().map_err(|_| "[STATE] LOCK_FAILED")?;
        active.as_deref() == Some(&name)
    };
    if is_active {
        let mut fresh_salt = [0u8; SALT_LEN];
        rand::thread_rng().fill(&mut fresh_salt);
        let derived = derive_key(&master_pw, &fresh_salt)?;
        *state.master_key.lock().map_err(|_| "[STATE] LOCK_FAILED")? = Some(Zeroizing::new(derived));
        *state.salt.lock().map_err(|_| "[STATE] LOCK_FAILED")? = Some(fresh_salt);
        let _ = save_vault_async(&state).await;
    }

    Ok(())
}

/// Change the unified Master Password for the active workspace and app session.
#[tauri::command]
pub(crate) async fn change_master_password(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, DbState>,
    new_password: String,
) -> Result<(), String> {
    if new_password.chars().count() < 8 {
        return Err("Password must be at least 8 characters".into());
    }

    let active_name = {
        let guard = state.active_profile.lock().map_err(|_| "[STATE] LOCK_FAILED")?;
        match guard.as_ref() {
            Some(n) => n.clone(),
            None => return Err("[AUTH] NO_ACTIVE_PROFILE".into()),
        }
    };

    let _target_path = profile_path(&app_handle, &active_name)?;

    let mut fresh_salt = [0u8; SALT_LEN];
    rand::thread_rng().fill(&mut fresh_salt);
    let mut pw_copy = new_password.clone();
    let derived = tokio::task::spawn_blocking(move || {
        let res = derive_key(&pw_copy, &fresh_salt);
        pw_copy.zeroize();
        res
    })
    .await
    .map_err(|e| format!("[CRYPTO] KDF_JOIN: {}", e))??;

    let new_key = Zeroizing::new(derived);

    {
        *state.master_key.lock().map_err(|_| "[STATE] LOCK_KEY")? = Some(new_key);
        *state.salt.lock().map_err(|_| "[STATE] LOCK_SALT")? = Some(fresh_salt);
        *state.session_password.lock().map_err(|_| "[STATE] LOCK_SESSION_PW")? = Some(Zeroizing::new(new_password));
    }

    save_vault_async(&state).await?;
    Ok(())
}

/// Permanently delete a profile's encrypted file. The caller must NOT be
/// "in" that profile (would orphan in-memory state pointing at a deleted
/// file). UI enforces this by only showing the delete button on the picker
/// screen.
#[tauri::command]
pub(crate) async fn delete_profile(app_handle: tauri::AppHandle, name: String) -> Result<(), String> {
    validate_profile_name(&name)?;
    let path = profile_path(&app_handle, &name)?;
    if path.exists() {
        fs::remove_file(&path)
            .map_err(|e| format!("[FILE] DELETE_PROFILE_FAILED at {:?}: {}", path, e))?;
    }
    Ok(())
}

/// Rename a profile's encrypted file on disk. If the profile was active,
/// its active state and db_path are updated in memory.
#[tauri::command]
pub(crate) async fn rename_profile(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, DbState>,
    old_name: String,
    new_name: String,
) -> Result<(), String> {
    validate_profile_name(&old_name)?;
    validate_profile_name(&new_name)?;
    if old_name == new_name {
        return Ok(());
    }

    let src = profile_path(&app_handle, &old_name)?;
    if !src.exists() {
        return Err(format!("Profile '{}' not found on disk", old_name));
    }

    let dir = profiles_dir(&app_handle)?;
    let dest_subterm = dir.join(format!("{}.subterm", new_name));
    let dest_submarine = dir.join(format!("{}.submarine", new_name));
    if dest_subterm.exists() || dest_submarine.exists() {
        return Err(format!("A profile named '{}' already exists", new_name));
    }

    fs::rename(&src, &dest_subterm)
        .map_err(|e| format!("[FILE] RENAME_PROFILE_FAILED: {}", e))?;

    // If this profile was the active one in memory, update state
    let mut active = state.active_profile.lock().map_err(|_| "[STATE] LOCK_FAILED")?;
    if active.as_deref() == Some(&old_name) {
        *active = Some(new_name.clone());
        let mut path_guard = state.db_path.lock().map_err(|_| "[STATE] LOCK_FAILED_PATH")?;
        *path_guard = Some(dest_subterm);
    }

    Ok(())
}

/// Copy a profile's encrypted file to a user-chosen location so it can be
/// backed up or moved between machines. The file is already encrypted at
/// rest — we just copy bytes; we never decrypt or re-encrypt.
///
/// Returns `Some(path)` on success or `None` if the user cancels the
/// native save dialog. Errors bubble up as `Err`.
#[tauri::command]
pub(crate) async fn export_profile(
    app_handle: tauri::AppHandle,
    name: String,
) -> Result<Option<String>, String> {
    validate_profile_name(&name)?;
    let src = profile_path(&app_handle, &name)?;
    if !src.exists() {
        return Err(format!("Profile '{}' not found on disk", name));
    }

    // Native file dialogs are desktop-only. On Android we'd hit the SAF
    // intent system via a Tauri plugin instead, but profile export from
    // the mobile UI isn't a wired feature yet, so the command just refuses.
    #[cfg(mobile)]
    {
        let _ = src;
        return Err("Profile export is not available on Android.".into());
    }
    #[cfg(desktop)]
    {
        // rfd's blocking dialog must not run on the main thread on macOS — we're
        // already off the UI thread in a tauri async command so a direct call is
        // fine. spawn_blocking would be needed if this was wrapped differently.
        let default_name = format!("{}.subterm", name);
        let chosen = rfd::FileDialog::new()
            .set_title("Export SubTerm Profile")
            .set_file_name(&default_name)
            .add_filter("SubTerm profile (*.subterm, *.submarine)", &["subterm", "submarine"])
            .save_file();

        let dst = match chosen {
            Some(p) => p,
            None => return Ok(None),
        };

        fs::copy(&src, &dst)
            .map_err(|e| format!("[FILE] EXPORT_COPY_FAILED to {:?}: {}", dst, e))?;
        Ok(Some(dst.to_string_lossy().to_string()))
    }
}

/// Prompt the user with a native Save dialog to save a session audit log file.
#[tauri::command]
pub(crate) async fn save_audit_log(
    content: String,
    filename: String,
) -> Result<Option<String>, String> {
    #[cfg(mobile)]
    {
        let _ = (content, filename);
        return Err("Audit log export is not available on Android.".into());
    }
    #[cfg(desktop)]
    {
        let chosen = rfd::FileDialog::new()
            .set_title("Save Session Audit Log")
            .set_file_name(&filename)
            .add_filter("Log file (*.log)", &["log"])
            .add_filter("Text file (*.txt)", &["txt"])
            .save_file();

        let dst = match chosen {
            Some(p) => p,
            None => return Ok(None),
        };

        std::fs::write(&dst, content)
            .map_err(|e| format!("Failed to write audit log to {:?}: {}", dst, e))?;
        Ok(Some(dst.to_string_lossy().to_string()))
    }
}

/// Native "Save as" dialog + write for text the UI generated (terminal
/// recordings, buffer exports). The webview's blob-download trick doesn't
/// reliably save anything inside Tauri, so saving goes through the OS dialog.
/// `extension` is without the dot (e.g. "cast"). Returns the chosen path, or
/// `None` when the user cancels.
/// Folder for automatic ("always record this server") recordings, created on demand.
#[tauri::command]
pub(crate) fn recordings_dir(app: tauri::AppHandle) -> Result<String, String> {
    use tauri::Manager as _;
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("recordings");
    std::fs::create_dir_all(&dir).map_err(|e| format!("Failed to create {:?}: {}", dir, e))?;
    Ok(dir.to_string_lossy().to_string())
}

/// `name` reduced to a plain file name: no folders, no characters Windows rejects.
pub(crate) fn safe_file_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_') { c } else { '_' })
        .collect();
    let cleaned = cleaned.trim_start_matches('.');
    if cleaned.is_empty() { "recording.cast".into() } else { cleaned.chars().take(150).collect() }
}

/// Save an automatic recording into `recordings_dir` without a dialog. Returns the path.
#[tauri::command]
pub(crate) async fn save_recording(app: tauri::AppHandle, content: String, filename: String) -> Result<String, String> {
    let path = std::path::Path::new(&recordings_dir(app)?).join(safe_file_name(&filename));
    std::fs::write(&path, content).map_err(|e| format!("Failed to write {:?}: {}", path, e))?;
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
pub(crate) async fn save_text_file(
    content: String,
    filename: String,
    extension: String,
) -> Result<Option<String>, String> {
    #[cfg(mobile)]
    {
        let _ = (content, filename, extension);
        return Err("Saving files from here is not available on Android.".into());
    }
    #[cfg(desktop)]
    {
        save_with_dialog(content.as_bytes(), &filename, &extension)
    }
}

/// Native Save dialog, then write `content`. `Ok(None)` when the user cancels.
#[cfg(desktop)]
fn save_with_dialog(content: &[u8], filename: &str, extension: &str) -> Result<Option<String>, String> {
    let ext = extension.trim_start_matches('.').to_string();
    let mut dialog = rfd::FileDialog::new().set_title("Save").set_file_name(filename);
    if !ext.is_empty() {
        dialog = dialog.add_filter(format!("*.{ext}"), &[ext.as_str()]);
    }
    let Some(dst) = dialog.save_file() else { return Ok(None) };
    std::fs::write(&dst, content).map_err(|e| format!("Failed to write {:?}: {}", dst, e))?;
    Ok(Some(dst.to_string_lossy().to_string()))
}

/// Binary sibling of `save_text_file` (e.g. a GIF export). The bytes arrive as the raw
/// request body; `x-filename` and `x-extension` headers carry the suggested name.
#[tauri::command]
pub(crate) async fn save_binary_file(request: tauri::ipc::Request<'_>) -> Result<Option<String>, String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("Expected the file contents as raw bytes".into());
    };
    let header = |k: &str| request.headers().get(k).and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
    #[cfg(mobile)]
    {
        let _ = (bytes, header);
        return Err("Saving files from here is not available on Android.".into());
    }
    #[cfg(desktop)]
    {
        save_with_dialog(bytes, &safe_file_name(&header("x-filename")), &header("x-extension"))
    }
}

/// Write a pasted image (raw request body, `x-filename` header) to
/// `<temp>/subterm-paste/` and return its path, so the terminal can type it.
#[tauri::command]
pub(crate) async fn save_temp_file(request: tauri::ipc::Request<'_>) -> Result<String, String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("Expected the file contents as raw bytes".into());
    };
    let name = request.headers().get("x-filename").and_then(|v| v.to_str().ok()).unwrap_or("paste.png");
    // shortcut: files are never cleaned up (the OS temp cleaner removes them eventually); prune old ones here if the folder grows.
    let dir = std::env::temp_dir().join("subterm-paste");
    std::fs::create_dir_all(&dir).map_err(|e| format!("Failed to create {:?}: {}", dir, e))?;
    let path = dir.join(safe_file_name(name));
    std::fs::write(&path, bytes).map_err(|e| format!("Failed to write {:?}: {}", path, e))?;
    Ok(path.to_string_lossy().to_string())
}

/// Open a file picker and verify the chosen file looks like a Submarine
/// vault (right header bytes). We do NOT decrypt — that requires the
/// profile password, which the user enters after import via the regular
/// unlock flow.
///
/// Returns `(source_path, suggested_name)` so the UI can confirm or rename
/// before committing the copy.
#[tauri::command]
pub(crate) async fn import_profile_pick() -> Result<Option<(String, String)>, String> {
    #[cfg(mobile)]
    {
        return Err("Profile import is not available on Android.".into());
    }
    #[cfg(desktop)]
    {
        let picked = rfd::FileDialog::new()
            .set_title("Import SubTerm Profile")
            .add_filter("SubTerm profile (*.subterm, *.submarine)", &["subterm", "submarine"])
            .pick_file();

        let path = match picked {
            Some(p) => p,
            None => return Ok(None),
        };

        // Cheap header check (no decryption). If the file isn't a vault we want
        // to fail before the user picks a name and gets a confusing error later.
        let mut header = [0u8; 5];
        let mut f = fs::File::open(&path).map_err(|e| format!("[FILE] IMPORT_OPEN_FAILED: {}", e))?;
        use std::io::Read;
        let n = f.read(&mut header).map_err(|e| format!("[FILE] IMPORT_READ_FAILED: {}", e))?;
        if n < 5 || &header[..4] != VAULT_MAGIC {
            return Err("Selected file is not a SubTerm profile (bad header).".into());
        }
        if header[4] != VAULT_VERSION {
            return Err(format!(
                "Profile uses an unsupported vault version ({}). Update SubTerm first.",
                header[4]
            ));
        }

        // Suggest a name from the file stem, sanitized to our profile-name rules
        // so the user can hit Enter without re-typing in the common case.
        let suggested = path
            .file_stem()
            .and_then(|s| s.to_str())
            .map(|s| {
                s.chars()
                    .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
                    .take(32)
                    .collect::<String>()
            })
            .unwrap_or_else(|| "imported".to_string());

        Ok(Some((path.to_string_lossy().to_string(), suggested)))
    }
}

/// Commit a picked vault file into the profiles dir under `name`. Refuses
/// to overwrite an existing profile — the UI must prompt the user to pick
/// a different name (or delete the existing one) in that case.
#[tauri::command]
pub(crate) async fn import_profile_save(
    app_handle: tauri::AppHandle,
    source_path: String,
    name: String,
) -> Result<(), String> {
    validate_profile_name(&name)?;
    let src = PathBuf::from(&source_path);
    if !src.exists() {
        return Err("Source file no longer exists.".into());
    }

    let dir = profiles_dir(&app_handle)?;
    fs::create_dir_all(&dir).map_err(|e| format!("[FILE] MKDIR_FAILED: {}", e))?;
    let dst = profile_path(&app_handle, &name)?;
    if dst.exists() {
        return Err(format!("Profile '{}' already exists", name));
    }

    // Single-read import: load the file into memory ONCE, validate the
    // header on the in-memory bytes, then write to the destination. The
    // previous "read 5 bytes to validate, then fs::copy" was TOCTOU —
    // an attacker (or a script running in parallel) could swap the file
    // between the header read and the copy and we'd import garbage.
    let bytes = fs::read(&src).map_err(|e| format!("[FILE] IMPORT_READ_FAILED: {}", e))?;
    if bytes.len() < 5 || &bytes[..4] != VAULT_MAGIC || bytes[4] != VAULT_VERSION {
        return Err("Source file is no longer a valid SubTerm profile.".into());
    }
    if bytes.len() < HEADER_LEN + NONCE_LEN + 16 {
        return Err("Source file is truncated — header is valid but the body is too small.".into());
    }

    fs::write(&dst, &bytes)
        .map_err(|e| format!("[FILE] IMPORT_WRITE_FAILED to {:?}: {}", dst, e))?;
    Ok(())
}

/// Whether the *currently selected* profile's encrypted file exists on
/// disk. Returns false if no profile is selected — that signals the UI to
/// stay on the picker instead of jumping to the password prompt.
#[tauri::command]
pub(crate) async fn check_db_exists(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, DbState>,
) -> Result<bool, String> {
    let name = state.active_profile.lock()
        .map_err(|_| "[STATE] LOCK_FAILED_PROFILE")?
        .clone();
    let Some(name) = name else { return Ok(false) };
    Ok(profile_path(&app_handle, &name)?.exists())
}

#[tauri::command]
pub(crate) async fn setup_master_db(app_handle: tauri::AppHandle, password: String, state: tauri::State<'_, DbState>) -> Result<(), String> {
    // Every path that reaches here from the UI is the user CHOOSING a password
    // (create a profile, or unlock an existing one), so the strength floor
    // applies. `restore_personal_profile` is the one caller that doesn't get to
    // choose — see `enforce_strength` below.
    setup_master_db_inner(app_handle, password, state, true).await
}

/// `enforce_strength = false` is for restoring a profile that ALREADY exists in
/// the cloud. The password isn't being chosen — it was chosen long ago, and the
/// cloud copy is already sealed under it. Rejecting it as "too weak" wouldn't
/// make anything safer; it would just lock the owner out of their own data on a
/// new device while the old device keeps opening it fine. The floor belongs on
/// creation, where the choice is actually being made.
pub(crate) async fn setup_master_db_inner(
    app_handle: tauri::AppHandle,
    mut password: String,
    state: tauri::State<'_, DbState>,
    enforce_strength: bool,
) -> Result<(), String> {
    let password_to_cache = password.clone();
    // The active profile must be picked before this command — the UI does
    // it from the picker screen. Refuse early instead of silently writing
    // to a default path.
    let profile_name = state.active_profile.lock()
        .map_err(|_| "[STATE] LOCK_FAILED_PROFILE")?
        .clone()
        .ok_or("[STATE] NO_PROFILE_SELECTED")?;

    let dir = profiles_dir(&app_handle)?;
    if !dir.exists() {
        fs::create_dir_all(&dir).map_err(|e| format!("[FILE] DIR_CREATION_FAILED: {}", e))?;
    }

    let path = profile_path(&app_handle, &profile_name)?;
    let mut conn;
    let salt_bytes: [u8; SALT_LEN];
    // Wrap the derived AES key so it's wiped on every early-return path
    // and at the natural end of this function. Once it lands in DbState
    // the StdMutex<Option<Zeroizing<...>>> takes over the same guarantee.
    let key: Zeroizing<[u8; 32]>;
    let mut needs_resave;

    if path.exists() {
        let encrypted_data = fs::read(&path)
            .map_err(|e| format!("[FILE] VAULT_READ_FAILED: {}", e))?;
        let (parsed_salt, nonce, ciphertext) = parse_vault_blob(&encrypted_data)?;
        // Normalise the Vec<u8> salt into a fixed-size array up front so we
        // can copy it into both the spawn_blocking closure (move-by-Copy) and
        // the salt_bytes slot later, without juggling clones or lifetimes.
        let mut salt_fixed = [0u8; SALT_LEN];
        salt_fixed.copy_from_slice(&parsed_salt);
        // Argon2id with m=64MiB is CPU-heavy (≈0.5–2s depending on hardware).
        // Running it directly on the async runtime thread blocks every other
        // Tauri command for that duration — UI freezes, IPC backs up. Hand
        // it off to the blocking pool so the runtime stays responsive. The
        // closure also zeroizes the password buffer once the derivation is
        // done, preserving the secret-hygiene the original sync path had.
        let mut password_owned = std::mem::take(&mut password);
        let derived = tokio::task::spawn_blocking(move || {
            let res = derive_key(&password_owned, &salt_fixed);
            password_owned.zeroize();
            res
        })
            .await
            .map_err(|e| format!("[CRYPTO] KDF_JOIN: {}", e))??;
        key = Zeroizing::new(derived);
        let raw = Zeroizing::new(decrypt_with_key(&ciphertext, &nonce, &key)?);
        let decrypted_data = Zeroizing::new(vault_decompress(&raw)?);

        salt_bytes = salt_fixed;
        needs_resave = false;

        conn = Connection::open_in_memory()
            .map_err(|e| format!("[DATABASE] MEM_INIT_FAILED: {}", e))?;
        let owned = to_sqlite_owned(&decrypted_data)?;
        conn.deserialize(DatabaseName::Main, owned, false)
            .map_err(|e| format!("[DATABASE] DESERIALIZE_FAILED: {}", e))?;
        // Schema migration for vaults created before the Notes feature shipped.
        // Existing tables are untouched; only the new ones get materialised.
        // Idempotent — running it on a fresh vault that already has `notes`
        // (from the schema batch below) is a no-op.
        conn.execute(
            "CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, body TEXT)",
            [],
        ).map_err(|e| format!("[DATABASE] NOTES_MIGRATION_FAILED: {}", e))?;
        // Schema migration for the autostart-on-launch flag added later. We
        // can't use `IF NOT EXISTS` on ALTER, so swallow the "duplicate
        // column" error specifically — anything else propagates.
        if let Err(e) = conn.execute(
            "ALTER TABLE servers ADD COLUMN autostart INTEGER NOT NULL DEFAULT 0",
            [],
        ) {
            let s = e.to_string();
            if !s.contains("duplicate column name") {
                return Err(format!("[DATABASE] AUTOSTART_MIGRATION_FAILED: {}", s));
            }
        }
        // Schema migration for the mirror-config column.
        if let Err(e) = conn.execute(
            "ALTER TABLE servers ADD COLUMN mirrors TEXT NOT NULL DEFAULT '[]'",
            [],
        ) {
            let s = e.to_string();
            if !s.contains("duplicate column name") {
                return Err(format!("[DATABASE] MIRRORS_MIGRATION_FAILED: {}", s));
            }
        }
        // Schema version metadata. A single-row `schema_meta` table records
        // the highest column-migration the running binary knows about. If a
        // user opens an older binary against a newer vault, we surface a
        // clear warning instead of silently swallowing "duplicate column"
        // errors and risking write-side schema drift. Bump SCHEMA_VERSION
        // here every time a new ALTER lands in this block.
        conn.execute(
            "CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
            [],
        ).map_err(|e| format!("[DATABASE] META_TABLE_FAILED: {}", e))?;
        // v5 — command history table for the Ctrl+R overlay. Best-effort
        // captured per-Enter by TerminalView; unencrypted-within-vault since
        // it's not a secret (the vault itself is encrypted at rest).
        conn.execute(
            "CREATE TABLE IF NOT EXISTS cmd_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                server_id INTEGER,
                server_name TEXT,
                command TEXT NOT NULL,
                ts INTEGER NOT NULL,
                exit_code INTEGER
            )",
            [],
        ).map_err(|e| format!("[DATABASE] CMD_HISTORY_TABLE_FAILED: {}", e))?;
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_cmd_history_ts ON cmd_history(ts DESC)",
            [],
        ).map_err(|e| format!("[DATABASE] CMD_HISTORY_INDEX_FAILED: {}", e))?;
        const SCHEMA_VERSION: i64 = 6;
        let stored: i64 = conn.query_row(
            "SELECT CAST(value AS INTEGER) FROM schema_meta WHERE key = 'schema_version'",
            [],
            |row| row.get(0),
        ).unwrap_or(0);
        if stored > SCHEMA_VERSION {
            return Err(format!(
                "[DATABASE] SCHEMA_AHEAD_OF_BINARY: vault was written by a newer build (schema v{}), this binary only understands v{}. Upgrade the app before opening this profile.",
                stored, SCHEMA_VERSION,
            ));
        }
        conn.execute(
            "INSERT INTO schema_meta (key, value) VALUES ('schema_version', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            rusqlite::params![SCHEMA_VERSION.to_string()],
        ).map_err(|e| format!("[DATABASE] META_WRITE_FAILED: {}", e))?;

        // Schema migrations for the per-node and per-folder colour bar. NULL
        // means "use the default ring" — the UI treats absence as the same
        // visual as before this column existed.
        for stmt in [
            "ALTER TABLE servers ADD COLUMN color TEXT",
            "ALTER TABLE folders ADD COLUMN color TEXT",
            // v4: per-node free-form description / runbook. Defaults to empty
            // so existing rows don't need backfill. NOT NULL keeps the read
            // path branchless.
            "ALTER TABLE servers ADD COLUMN notes TEXT NOT NULL DEFAULT ''",
            // Commands auto-typed into the FIRST terminal on the INITIAL
            // connect (never on reconnect / extra shells). Empty = nothing.
            "ALTER TABLE servers ADD COLUMN run_on_connect TEXT NOT NULL DEFAULT ''",
            // ProxyJump: optional id of another server to bounce through. NULL
            // = connect directly. Nullable + additive so old binaries ignore
            // it (no SCHEMA_VERSION bump, matching run_on_connect above).
            "ALTER TABLE servers ADD COLUMN jump_host_id INTEGER",
            // Per-algorithm host-key tracking. Legacy rows keep key_type NULL
            // (treated conservatively as "same type" so a real key rotation is
            // never downgraded to a benign first-time prompt); rows recorded
            // after this migration store the host-key algorithm so a server
            // ADDING a new algorithm no longer looks like a MITM key change.
            "ALTER TABLE known_hosts ADD COLUMN key_type TEXT",
            // Per-entity sync columns (schema v6). Nullable uuid/updated_at get
            // backfilled row-by-row just below; deleted is a plain constant
            // default so it's a safe single-statement ADD.
            "ALTER TABLE folders ADD COLUMN uuid TEXT",
            "ALTER TABLE folders ADD COLUMN updated_at TEXT",
            "ALTER TABLE folders ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0",
            "ALTER TABLE ssh_keys ADD COLUMN uuid TEXT",
            "ALTER TABLE ssh_keys ADD COLUMN updated_at TEXT",
            "ALTER TABLE ssh_keys ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0",
            "ALTER TABLE credentials ADD COLUMN uuid TEXT",
            "ALTER TABLE credentials ADD COLUMN updated_at TEXT",
            "ALTER TABLE credentials ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0",
            "ALTER TABLE servers ADD COLUMN uuid TEXT",
            "ALTER TABLE servers ADD COLUMN updated_at TEXT",
            "ALTER TABLE servers ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0",
            "ALTER TABLE commands ADD COLUMN uuid TEXT",
            "ALTER TABLE commands ADD COLUMN updated_at TEXT",
            "ALTER TABLE commands ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0",
            "ALTER TABLE notes ADD COLUMN uuid TEXT",
            "ALTER TABLE notes ADD COLUMN updated_at TEXT",
            "ALTER TABLE notes ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0",
            "ALTER TABLE monitor_configs ADD COLUMN uuid TEXT",
            "ALTER TABLE monitor_configs ADD COLUMN updated_at TEXT",
            "ALTER TABLE monitor_configs ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0",
            // Per-person attribution (schema v6+). The auto-stamp triggers set
            // this to the editor label at mutation time; NULL on legacy rows.
            "ALTER TABLE folders ADD COLUMN edited_by TEXT",
            "ALTER TABLE ssh_keys ADD COLUMN edited_by TEXT",
            "ALTER TABLE credentials ADD COLUMN edited_by TEXT",
            "ALTER TABLE servers ADD COLUMN edited_by TEXT",
            "ALTER TABLE commands ADD COLUMN edited_by TEXT",
            "ALTER TABLE notes ADD COLUMN edited_by TEXT",
            "ALTER TABLE monitor_configs ADD COLUMN edited_by TEXT",
            // Manual drag-to-reorder of the node grid. Default 0 keeps the
            // pre-existing implicit rowid order until the user first reorders;
            // `get_servers` sorts by (position, id) so ties fall back to id.
            // Synced (it's in the servers ENTITIES cols), so order LWW-merges.
            "ALTER TABLE servers ADD COLUMN position INTEGER NOT NULL DEFAULT 0",
            "ALTER TABLE servers ADD COLUMN is_production INTEGER NOT NULL DEFAULT 0",
            "ALTER TABLE servers ADD COLUMN icon TEXT DEFAULT 'server'",
            "ALTER TABLE servers ADD COLUMN os_info TEXT DEFAULT ''",
            // SSH agent forwarding (-A): a per-server-connection preference
            // (whether to expose the local agent to whatever the user does
            // on the remote end — ssh to a further host, git, etc.), not a
            // property of a reusable saved login, so it lives on `servers`
            // only, orthogonal to auth_type/credential_id.
            "ALTER TABLE servers ADD COLUMN forward_agent INTEGER NOT NULL DEFAULT 0",
            // Connection protocol: NULL / 'ssh' = SSH (every row that existed
            // before this column), 'rdp' = launch the system Remote Desktop
            // client. Nullable on purpose: it is a synced column, and a record
            // from an older peer omits it - NULL must read as plain SSH.
            "ALTER TABLE servers ADD COLUMN protocol TEXT DEFAULT 'ssh'",
            // Server-specific snippets: NULL server_id keeps a command in the
            // global library (today's only behavior); set it to scope a
            // command to one server's Command Palette / library view. tags is
            // a plain comma-separated string, not JSON — simple labels don't
            // need a parser, and an empty default keeps old rows unaffected.
            "ALTER TABLE commands ADD COLUMN server_id INTEGER",
            "ALTER TABLE commands ADD COLUMN tags TEXT NOT NULL DEFAULT ''",
        ] {
            if let Err(e) = conn.execute(stmt, []) {
                let s = e.to_string();
                if !s.contains("duplicate column name") {
                    return Err(format!("[DATABASE] COLUMN_MIGRATION_FAILED: {}", s));
                }
            }
        }
    } else {
        // Master-password strength floor — enforced ONLY at vault CREATION, not
        // on unlock (an existing vault with a short password must still open).
        // This password is the single cryptographic root protecting every
        // stored credential and private key, so a trivial one is a real risk.
        // Count Unicode scalar values, not bytes, so non-Latin passwords aren't
        // over-counted. 8 is a floor, not a ceiling — the UI should also nudge.
        // Skipped when restoring an existing cloud profile (see the caller doc).
        if enforce_strength && password.chars().count() < 8 {
            password.zeroize();
            return Err("[CRYPTO] WEAK_MASTER_PASSWORD: choose at least 8 characters — this password protects every saved credential.".into());
        }
        let mut fresh = [0u8; SALT_LEN];
        rand::thread_rng().fill(&mut fresh);
        salt_bytes = fresh;
        // Same reasoning as the unlock path above — keep the async runtime
        // unblocked during the Argon2 derivation on fresh-profile creation.
        let mut password_owned = std::mem::take(&mut password);
        let derived = tokio::task::spawn_blocking(move || {
            let res = derive_key(&password_owned, &salt_bytes);
            password_owned.zeroize();
            res
        })
            .await
            .map_err(|e| format!("[CRYPTO] KDF_JOIN: {}", e))??;
        key = Zeroizing::new(derived);
        needs_resave = true;

        conn = Connection::open_in_memory()
            .map_err(|e| format!("[DATABASE] MEM_INIT_FAILED: {}", e))?;
        conn.execute_batch(
            "CREATE TABLE folders (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, parent_id INTEGER, color TEXT, uuid TEXT, updated_at TEXT, deleted INTEGER NOT NULL DEFAULT 0, edited_by TEXT);
             CREATE TABLE ssh_keys (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, public_key TEXT, private_key TEXT, passphrase TEXT, uuid TEXT, updated_at TEXT, deleted INTEGER NOT NULL DEFAULT 0, edited_by TEXT);
             CREATE TABLE credentials (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, auth_type TEXT, username TEXT, password TEXT, key_id INTEGER, uuid TEXT, updated_at TEXT, deleted INTEGER NOT NULL DEFAULT 0, edited_by TEXT, FOREIGN KEY(key_id) REFERENCES ssh_keys(id));
             CREATE TABLE servers (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, host TEXT, port INTEGER, username TEXT, password TEXT, credential_id INTEGER, folder_id INTEGER, proxy_type TEXT DEFAULT 'none', proxy_host TEXT, proxy_port INTEGER, tunnels TEXT, auth_type TEXT DEFAULT 'vault', key_id INTEGER, autostart INTEGER NOT NULL DEFAULT 0, mirrors TEXT NOT NULL DEFAULT '[]', color TEXT, notes TEXT NOT NULL DEFAULT '', run_on_connect TEXT NOT NULL DEFAULT '', jump_host_id INTEGER, position INTEGER NOT NULL DEFAULT 0, is_production INTEGER NOT NULL DEFAULT 0, icon TEXT DEFAULT 'server', os_info TEXT DEFAULT '', forward_agent INTEGER NOT NULL DEFAULT 0, uuid TEXT, updated_at TEXT, deleted INTEGER NOT NULL DEFAULT 0, edited_by TEXT, FOREIGN KEY(folder_id) REFERENCES folders(id));
             CREATE TABLE commands (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, content TEXT, server_id INTEGER, tags TEXT NOT NULL DEFAULT '', uuid TEXT, updated_at TEXT, deleted INTEGER NOT NULL DEFAULT 0, edited_by TEXT);
             CREATE TABLE notes (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, body TEXT, uuid TEXT, updated_at TEXT, deleted INTEGER NOT NULL DEFAULT 0, edited_by TEXT);
             CREATE TABLE known_hosts (id INTEGER PRIMARY KEY AUTOINCREMENT, host TEXT, port INTEGER, fingerprint TEXT, key_type TEXT);
             CREATE TABLE monitor_configs (node_id INTEGER PRIMARY KEY, enabled_metrics TEXT NOT NULL DEFAULT '[\"cpu\",\"mem\",\"disk\",\"load\"]', custom_metrics TEXT NOT NULL DEFAULT '[]', paused INTEGER NOT NULL DEFAULT 1, uuid TEXT, updated_at TEXT, deleted INTEGER NOT NULL DEFAULT 0, edited_by TEXT, FOREIGN KEY(node_id) REFERENCES servers(id) ON DELETE CASCADE);
             CREATE TABLE monitor_settings (id INTEGER PRIMARY KEY, json TEXT NOT NULL);
             CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
             CREATE TABLE cmd_history (id INTEGER PRIMARY KEY AUTOINCREMENT, server_id INTEGER, server_name TEXT, command TEXT NOT NULL, ts INTEGER NOT NULL, exit_code INTEGER);
             CREATE INDEX idx_cmd_history_ts ON cmd_history(ts DESC);
             INSERT INTO schema_meta (key, value) VALUES ('schema_version', '6');"
        ).map_err(|e| format!("[DATABASE] SCHEMA_CREATION_FAILED: {}", e))?;
    }

    conn.execute("PRAGMA foreign_keys = ON", []).map_err(|e| format!("[DATABASE] PRAGMA_FAILED: {}", e))?;

    // Customised keyboard shortcuts, synced (see commands::servers::set_synced_shortcuts).
    // Created for new and existing vaults alike, before the sync triggers below.
    conn.execute(
        "CREATE TABLE IF NOT EXISTS shortcuts (id INTEGER PRIMARY KEY AUTOINCREMENT, platform TEXT NOT NULL, action TEXT NOT NULL, combo TEXT NOT NULL, uuid TEXT, updated_at TEXT, deleted INTEGER NOT NULL DEFAULT 0, edited_by TEXT, UNIQUE(platform, action))",
        [],
    )
    .map_err(|e| format!("[DATABASE] SHORTCUTS_MIGRATION_FAILED: {}", e))?;

    // AI providers for the assistant panel. Local to this vault and not synced:
    // `api_key` is a secret only commands::ai reads; it is never returned over IPC.
    conn.execute(
        "CREATE TABLE IF NOT EXISTS ai_providers (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, kind TEXT NOT NULL, base_url TEXT NOT NULL, model TEXT NOT NULL DEFAULT '', api_key TEXT)",
        [],
    )
    .map_err(|e| format!("[DATABASE] AI_PROVIDERS_MIGRATION_FAILED: {}", e))?;

    // ---- Per-entity sync instrumentation (schema v6) ----
    // A per-profile Hybrid Logical Clock backs the `hlc_now()` SQL function so
    // every row mutation auto-stamps `updated_at`. Seed the clock past the
    // newest stamp already in the vault so a freshly-started process never
    // issues one that sorts before data it already holds.
    let sync_node_id = commands::sync::sync_device_node_id(&app_handle);
    let seed_ms: u64 = conn
        .query_row(
            "SELECT COALESCE(MAX(updated_at),'') FROM (
               SELECT updated_at FROM servers UNION ALL SELECT updated_at FROM credentials
               UNION ALL SELECT updated_at FROM ssh_keys UNION ALL SELECT updated_at FROM folders
               UNION ALL SELECT updated_at FROM commands UNION ALL SELECT updated_at FROM notes
               UNION ALL SELECT updated_at FROM monitor_configs UNION ALL SELECT updated_at FROM shortcuts)",
            [],
            |r| r.get::<_, String>(0),
        )
        .ok()
        .map(|s| hlc::Hlc::phys_of(&s))
        .unwrap_or(0);
    let hlc_arc = std::sync::Arc::new(hlc::Hlc::new(sync_node_id, seed_ms));
    commands::sync::register_sync_functions(&conn, &hlc_arc)?;
    // Backfill rows that predate the sync columns (no-op on a fresh vault, and
    // a no-op on every open after the first). Run it BEFORE creating triggers so
    // the backfill UPDATEs can't fire them.
    if commands::sync::backfill_sync_columns(&conn, &hlc_arc)? {
        needs_resave = true;
    }
    commands::sync::create_sync_triggers(&conn)?;

    // Per-profile sync metadata (the DEK, and later the identity/grant state).
    // Created here so an existing vault gains it on first open under a v6 build.
    conn.execute(
        "CREATE TABLE IF NOT EXISTS sync_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
        [],
    )
    .map_err(|e| format!("[SHARE] SYNC_META_TABLE: {e}"))?;
    // Mint the profile's Data Encryption Key eagerly and persist it, so it can
    // never drift from blobs already pushed (which would happen if a sync
    // created it in-memory but crashed before saving). No-op after the first.
    if get_or_create_dek(&conn)?.1 {
        needs_resave = true;
    }

    // Reset every monitor to paused on profile open. Pollers don't survive
    // app restart, so a row with `paused=0` left over from the previous
    // session would advertise itself as "running" in the UI while no actual
    // backend task is spinning. Forcing pause makes the displayed state
    // truthful and matches the user's preference for explicit start.
    let _ = conn.execute("UPDATE monitor_configs SET paused = 1", []);

    // Acquire all four slot locks FIRST, then populate them in one go.
    // The previous "lock-populate, lock-populate, ..." pattern could
    // leave DbState half-initialised on a poisoned-mutex error from any
    // step but the first — later commands would see e.g. db_path set
    // but no master_key and fail in save_vault_internal with a
    // confusing MISSING_REQUIRED_RESOURCES error.
    let mut conn_guard = state.conn.lock().map_err(|_| "[STATE] LOCK_FAILED_CONN")?;
    let mut key_guard = state.master_key.lock().map_err(|_| "[STATE] LOCK_FAILED_KEY")?;
    let mut salt_guard = state.salt.lock().map_err(|_| "[STATE] LOCK_FAILED_SALT")?;
    let mut path_guard = state.db_path.lock().map_err(|_| "[STATE] LOCK_FAILED_PATH")?;
    let mut hlc_guard = state.hlc.lock().map_err(|_| "[STATE] LOCK_FAILED_HLC")?;
    *conn_guard = Some(conn);
    *key_guard = Some(key);
    *salt_guard = Some(salt_bytes);
    *path_guard = Some(path);
    *hlc_guard = Some(hlc_arc);
    drop(hlc_guard);
    drop(path_guard);
    drop(salt_guard);
    drop(key_guard);
    drop(conn_guard);

    if needs_resave {
        save_vault_internal(&state)?;
    }

    if let Ok(mut sp_guard) = state.session_password.lock() {
        *sp_guard = Some(Zeroizing::new(password_to_cache));
    }

    Ok(())
}

/// Flush the in-memory vault to disk. Used by the frontend after a successful
/// SSH connection so any `known_hosts` row that `check_server_key` inserted
/// during the handshake survives an app restart — otherwise the user would
/// see the same fingerprint prompt every time they reconnect.
#[tauri::command]
pub(crate) async fn persist_vault(state: tauri::State<'_, DbState>) -> Result<(), String> {
    save_vault_async(&state).await
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct KnownHostRecord {
    pub id: i64,
    pub host: String,
    pub port: i32,
    pub fingerprint: String,
    pub key_type: String,
}

/// Retrieve all trusted host keys and fingerprints recorded in the active vault.
#[tauri::command]
pub(crate) async fn get_known_hosts(state: tauri::State<'_, DbState>) -> Result<Vec<KnownHostRecord>, String> {
    let conn_guard = state.conn.lock().map_err(|_| "[STATE] LOCK_FAILED")?;
    let conn = conn_guard.as_ref().ok_or("[STATE] DATABASE_NOT_INITIALIZED")?;
    let mut stmt = conn
        .prepare("SELECT id, host, port, fingerprint, key_type FROM known_hosts ORDER BY host, port")
        .map_err(|e| format!("[DATABASE] PREPARE_FAILED: {}", e))?;
    let rows = stmt
        .query_map([], |row| {
            Ok(KnownHostRecord {
                id: row.get(0)?,
                host: row.get(1)?,
                port: row.get(2)?,
                fingerprint: row.get(3)?,
                key_type: row.get::<_, Option<String>>(4)?.unwrap_or_else(|| "ssh-ed25519".to_string()),
            })
        })
        .map_err(|e| format!("[DATABASE] QUERY_FAILED: {}", e))?;

    let mut result = Vec::new();
    for r in rows {
        if let Ok(rec) = r {
            result.push(rec);
        }
    }
    Ok(result)
}

/// Delete a specific known host fingerprint from the active vault.
#[tauri::command]
pub(crate) async fn delete_known_host(state: tauri::State<'_, DbState>, id: i64) -> Result<(), String> {
    {
        let conn_guard = state.conn.lock().map_err(|_| "[STATE] LOCK_FAILED")?;
        let conn = conn_guard.as_ref().ok_or("[STATE] DATABASE_NOT_INITIALIZED")?;
        conn.execute("DELETE FROM known_hosts WHERE id = ?1", rusqlite::params![id])
            .map_err(|e| format!("[DATABASE] DELETE_FAILED: {}", e))?;
    }
    save_vault_async(&state).await
}

/// Clear all trusted host fingerprints from the active vault.
#[tauri::command]
pub(crate) async fn clear_all_known_hosts(state: tauri::State<'_, DbState>) -> Result<(), String> {
    {
        let conn_guard = state.conn.lock().map_err(|_| "[STATE] LOCK_FAILED")?;
        let conn = conn_guard.as_ref().ok_or("[STATE] DATABASE_NOT_INITIALIZED")?;
        conn.execute("DELETE FROM known_hosts", [])
            .map_err(|e| format!("[DATABASE] CLEAR_FAILED: {}", e))?;
    }
    save_vault_async(&state).await
}

/// Create a brand-new profile, encrypted with `password`, and select it as
/// the active profile so the app can proceed directly into the main view
/// without bouncing back through `select_profile + setup_master_db`.
/// Rejected if a profile with the same name already exists — the picker
/// surfaces existing names so a clobber would be the user's mistake to
/// recover from, not something we should silently do.
#[tauri::command]
pub(crate) async fn create_profile(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, DbState>,
    name: String,
    password: Option<String>,
) -> Result<(), String> {
    validate_profile_name(&name)?;
    let actual_pw = match password.filter(|p| !p.trim().is_empty()) {
        Some(p) => p,
        None => {
            let guard = state.session_password.lock().map_err(|_| "[STATE] LOCK_FAILED")?;
            match guard.as_ref() {
                Some(p) => (**p).clone(),
                None => return Err("Password cannot be empty (no master session active)".into()),
            }
        }
    };
    let dir = profiles_dir(&app_handle)?;
    fs::create_dir_all(&dir).map_err(|e| format!("[FILE] MKDIR_FAILED: {}", e))?;
    let path = profile_path(&app_handle, &name)?;
    if path.exists() {
        return Err(format!("Profile '{}' already exists", name));
    }
    *state.active_profile.lock().map_err(|_| "[STATE] LOCK_FAILED")? = Some(name);
    // Reuse setup_master_db's fresh-schema branch by deferring to it. Empty
    // profile starts with the same migrations the legacy path would do.
    setup_master_db(app_handle.clone(), actual_pw, state).await?;

    // New profile: mint a stable UUID and partition its cloud sync by that UUID
    // rather than its name. Two vaults that happen to share a display name then
    // land in SEPARATE server partitions with separate keys — no cross-decrypt
    // failures, no silently merged records. Legacy `main` predates this and
    // keeps its name partition (untouched); only profiles born here get a UUID.
    // The human-readable name still reaches the server via sync_now's `name`.
    use tauri::Manager as _;
    let db_state = app_handle.state::<DbState>();
    {
        let conn_g = db_state.conn.lock().map_err(|_| "[STATE] LOCK_CONN")?;
        let conn = conn_g.as_ref().ok_or("[STATE] DB_NOT_OPEN")?;
        let mut pid = [0u8; 16];
        rand::thread_rng().fill(&mut pid);
        let pid_hex = hex::encode(pid); // 32 hex chars — fits the server's 32-char partition column
        // DO NOTHING (never overwrite): a fresh vault has neither key, but this
        // must never repartition a profile if it somehow re-runs.
        conn.execute(
            "INSERT INTO sync_meta(key,value) VALUES('profile_id',?1) ON CONFLICT(key) DO NOTHING",
            [&pid_hex],
        )
        .map_err(|e| format!("[STATE] PROFILE_ID_STORE: {e}"))?;
        conn.execute(
            "INSERT INTO sync_meta(key,value) VALUES('cloud_profile',?1) ON CONFLICT(key) DO NOTHING",
            [&pid_hex],
        )
        .map_err(|e| format!("[STATE] CLOUD_PROFILE_STORE: {e}"))?;
    }
    save_vault_internal(&db_state)?;
    Ok(())
}

#[cfg(test)]
mod safe_file_name_tests {
    use super::safe_file_name;

    #[test]
    fn keeps_recordings_inside_the_folder() {
        assert_eq!(safe_file_name("session-web-1-2026.cast"), "session-web-1-2026.cast");
        assert_eq!(safe_file_name("../../evil.cast"), "_.._evil.cast");
        assert_eq!(safe_file_name(r"a/b\c:d.cast"), "a_b_c_d.cast");
        assert_eq!(safe_file_name("..."), "recording.cast");
    }
}
