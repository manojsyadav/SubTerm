use std::sync::Arc;
use std::path::PathBuf;
use std::fs;
use rand::Rng;
use tokio::io::AsyncReadExt;
use crate::ssh_manager::SshState;

#[derive(serde::Serialize)]
pub struct SftpFileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub permissions: Option<u32>,
    pub uid: Option<u32>,
    pub gid: Option<u32>,
    pub modified: Option<u64>,
}

#[derive(serde::Serialize)]
pub struct SftpListResult {
    pub current_path: String,
    pub entries: Vec<SftpFileEntry>,
}

pub async fn get_sftp_session(
    state: &SshState,
    session_id: &str,
) -> Result<Arc<russh_sftp::client::SftpSession>, String> {
    // Reuse one SFTP subsystem per SSH session to avoid leaking server-side
    // channels.
    if let Some(s) = state.sftp_sessions.lock().await.get(session_id) {
        return Ok(Arc::clone(s));
    }

    // Transport preference: when a dedicated `::sftp` connection exists for
    // this session (the per-tab "Dedicated session" toggle), the SFTP
    // subsystem rides IT — but the cache stays keyed by the plain session id,
    // so the frontend never has to re-key anything. The dedicated connection
    // is a pure transport: it appearing/disappearing just invalidates this
    // cache (see the `::sftp` lifecycle hooks) and the next file operation
    // re-opens the subsystem on whatever transport is available.
    let (transport_key, session_arc) = {
        let connections = state.connections.lock().await;
        let dedicated_key = format!("{}::sftp", session_id);
        if !session_id.contains("::") && connections.contains_key(&dedicated_key) {
            (dedicated_key.clone(), Arc::clone(connections.get(&dedicated_key).unwrap()))
        } else if let Some(sess) = connections.get(session_id) {
            (session_id.to_string(), Arc::clone(sess))
        } else {
            return Err("Session not connected".into());
        }
    };

    let channel = {
        let session = session_arc.lock().await;
        session.channel_open_session().await.map_err(|e| e.to_string())?
    };
    channel.request_subsystem(true, "sftp").await.map_err(|e| e.to_string())?;
    let sftp = match tokio::time::timeout(
        std::time::Duration::from_secs(3),
        russh_sftp::client::SftpSession::new(channel.into_stream())
    ).await {
        Ok(Ok(s)) => s,
        Ok(Err(e)) => return Err(format!("SFTP handshake error: {}", e)),
        Err(_) => return Err("SFTP initialization timed out (subsystem not available on host)".into()),
    };
    let arc = Arc::new(sftp);

    let mut cache = state.sftp_sessions.lock().await;
    if let Some(existing) = cache.get(session_id) {
        // Another caller raced us; keep the existing one and drop ours.
        return Ok(Arc::clone(existing));
    }
    // Guard against two races before caching: (a) a reconnect replaced/removed
    // the transport handle while we were opening the subsystem (stale handle),
    // and (b) a dedicated `::sftp` transport APPEARED meanwhile — which changes
    // the preferred transport, so caching this primary-backed subsystem would
    // permanently bypass the dedicated connection. Require both the recomputed
    // preference AND the handle identity to still match the key we opened on.
    let still_current = {
        let connections = state.connections.lock().await;
        let dedicated_key = format!("{}::sftp", session_id);
        let preferred: &str = if !session_id.contains("::") && connections.contains_key(&dedicated_key) {
            dedicated_key.as_str()
        } else {
            session_id
        };
        transport_key.as_str() == preferred
            && connections.get(&transport_key)
                .map(|c| Arc::ptr_eq(c, &session_arc))
                .unwrap_or(false)
    };
    if !still_current {
        return Err("Session reconnected while opening SFTP — try again".into());
    }
    cache.insert(session_id.to_string(), Arc::clone(&arc));
    Ok(arc)
}

/// Fallback command runner directly over an SSH channel without needing the SFTP subsystem.
pub async fn exec_ssh_cmd(
    state: &SshState,
    session_id: &str,
    command: &str,
) -> Result<String, String> {
    use tokio::io::AsyncReadExt;
    let connections = state.connections.lock().await;
    let session_arc = connections
        .get(session_id)
        .cloned()
        .ok_or_else(|| "Session not found".to_string())?;
    drop(connections);

    let channel = {
        let session = session_arc.lock().await;
        session.channel_open_session().await.map_err(|e| e.to_string())?
    };
    channel.exec(true, command.as_bytes()).await.map_err(|e| e.to_string())?;
    let mut stream = channel.into_stream();
    let mut output = Vec::new();
    let mut buf = [0u8; 4096];
    while let Ok(n) = tokio::time::timeout(std::time::Duration::from_secs(6), stream.read(&mut buf)).await {
        match n {
            Ok(0) => break,
            Ok(bytes_read) => {
                output.extend_from_slice(&buf[..bytes_read]);
                if output.len() > 4 * 1024 * 1024 { break; }
            }
            Err(_) => break,
        }
    }
    Ok(String::from_utf8_lossy(&output).to_string())
}

#[tauri::command]
pub async fn sftp_list_dir(
    state: tauri::State<'_, SshState>,
    session_id: String,
    path: String,
) -> Result<SftpListResult, String> {
    // 1. Try SFTP if available with a 3-second timeout
    let sftp_attempt: Result<SftpListResult, String> = async {
        let sftp = get_sftp_session(&state, &session_id).await?;
        let target_path = if path.is_empty() { ".".to_string() } else { path.clone() };
        let canonical_path = tokio::time::timeout(std::time::Duration::from_secs(3), sftp.canonicalize(&target_path))
            .await
            .map_err(|_| "Canonicalize timeout".to_string())?
            .map_err(|e| e.to_string())?;
        
        let mut read_dir = tokio::time::timeout(std::time::Duration::from_secs(3), sftp.read_dir(&canonical_path))
            .await
            .map_err(|_| "Read dir timeout".to_string())?
            .map_err(|e| e.to_string())?;
        let mut entries = Vec::new();
        while let Some(entry) = read_dir.next() {
            let name = entry.file_name();
            if name == "." || name == ".." {
                continue;
            }
            let is_dir = entry.file_type().is_dir();
            let metadata = entry.metadata();
            let size = metadata.size.unwrap_or(0);
            let permissions = metadata.permissions;
            let uid = metadata.uid;
            let gid = metadata.gid;
            let modified = metadata.mtime.map(|t| t as u64);
            
            let entry_path = if canonical_path.ends_with('/') {
                format!("{}{}", canonical_path, name)
            } else {
                format!("{}/{}", canonical_path, name)
            };
            
            entries.push(SftpFileEntry {
                name,
                path: entry_path,
                is_dir,
                size,
                permissions,
                uid,
                gid,
                modified,
            });
        }
        
        entries.sort_by(|a, b| {
            if a.is_dir != b.is_dir {
                b.is_dir.cmp(&a.is_dir)
            } else {
                a.name.to_lowercase().cmp(&b.name.to_lowercase())
            }
        });
        
        Ok(SftpListResult {
            current_path: canonical_path,
            entries,
        })
    }.await;

    if let Ok(res) = sftp_attempt {
        return Ok(res);
    }

    // 2. Fallback to SSH command execution (ls -la)
    // Works reliably on any Linux/Unix machine even without sftp-server installed
    let target = if path.is_empty() || path == "." { "" } else { path.as_str() };
    let escaped = target.replace('"', "\\\"").replace('$', "\\$").replace('`', "\\`");
    let cmd = format!(
        "TARGET=\"{}\"; [ -n \"$TARGET\" ] && cd \"$TARGET\" 2>/dev/null; echo \"__SUBTERM_CWD__$(pwd)\"; ls -la --time-style=+%s 2>/dev/null || ls -la",
        escaped
    );
    let output = exec_ssh_cmd(&state, &session_id, &cmd).await?;
    
    let mut current_path = if !path.is_empty() { path.clone() } else { "/".to_string() };
    let mut entries = Vec::new();

    for line in output.lines() {
        let t = line.trim();
        if t.is_empty() { continue; }
        if let Some(cwd_str) = t.strip_prefix("__SUBTERM_CWD__") {
            let p = cwd_str.trim();
            if !p.is_empty() {
                current_path = p.to_string();
            }
            continue;
        }
        if t.starts_with("total ") {
            continue;
        }

        let parts: Vec<&str> = t.split_whitespace().collect();
        if parts.len() < 8 { continue; }
        let perms = parts[0];
        let is_dir = perms.starts_with('d');
        let size = parts[4].parse::<u64>().unwrap_or(0);
        
        let name = if parts.len() >= 7 && parts[5].chars().all(|c| c.is_ascii_digit()) {
            parts[6..].join(" ")
        } else if parts.len() >= 9 {
            parts[8..].join(" ")
        } else {
            parts.last().copied().unwrap_or("").to_string()
        };

        if name == "." || name == ".." || name.is_empty() {
            continue;
        }

        let entry_path = if current_path.ends_with('/') {
            format!("{}{}", current_path, name)
        } else {
            format!("{}/{}", current_path, name)
        };

        entries.push(SftpFileEntry {
            name,
            path: entry_path,
            is_dir,
            size,
            permissions: None,
            uid: None,
            gid: None,
            modified: None,
        });
    }

    entries.sort_by(|a, b| {
        if a.is_dir != b.is_dir {
            b.is_dir.cmp(&a.is_dir)
        } else {
            a.name.to_lowercase().cmp(&b.name.to_lowercase())
        }
    });

    Ok(SftpListResult {
        current_path,
        entries,
    })
}

#[tauri::command]
pub async fn sftp_create_dir(
    state: tauri::State<'_, SshState>,
    session_id: String,
    path: String,
) -> Result<(), String> {
    let sftp = get_sftp_session(&state, &session_id).await?;
    sftp.create_dir(path).await.map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn sftp_remove_file(
    state: tauri::State<'_, SshState>,
    session_id: String,
    path: String,
) -> Result<(), String> {
    let sftp = get_sftp_session(&state, &session_id).await?;
    sftp.remove_file(path).await.map_err(|e| e.to_string())?;
    Ok(())
}

pub(crate) fn is_no_such_file(err: &russh_sftp::client::error::Error) -> bool {
    use russh_sftp::client::error::Error;
    use russh_sftp::protocol::StatusCode;
    matches!(err, Error::Status(status) if status.status_code == StatusCode::NoSuchFile)
}

fn removable_dir_path(path: &str) -> Result<&str, String> {
    let trimmed = path.trim_end_matches(['/', '\\']);
    let steps: Vec<&str> = trimmed.split(['/', '\\']).collect();
    let is_root = steps.len() < 2 || (steps.len() == 2 && steps[1].ends_with(':'));
    let steps_up = steps.iter().any(|step| *step == "." || *step == "..");
    if !trimmed.starts_with('/') || is_root || steps_up {
        return Err(format!("refusing to delete {:?}", path));
    }
    Ok(trimmed)
}

fn is_child_name(name: &str) -> bool {
    !name.is_empty() && !name.contains('/') && !name.split('\\').any(|step| step == "..")
}

fn gone_is_ok(result: Result<(), russh_sftp::client::error::Error>) -> Result<(), russh_sftp::client::error::Error> {
    match result {
        Err(e) if is_no_such_file(&e) => Ok(()),
        other => other,
    }
}

async fn entry_is_dir(
    sftp: &russh_sftp::client::SftpSession,
    full: &str,
    listed: russh_sftp::protocol::FileType,
) -> Result<Option<bool>, String> {
    if listed.is_file() || listed.is_symlink() {
        return Ok(Some(false));
    }
    match sftp.symlink_metadata(full).await {
        Ok(meta) => Ok(Some(meta.file_type().is_dir())),
        Err(e) if is_no_such_file(&e) => Ok(None),
        Err(e) => Err(format!("stat {}: {}", full, e)),
    }
}

pub(crate) async fn sftp_remove_tree(sftp: &russh_sftp::client::SftpSession, path: &str) -> Result<(), String> {
    let mut stack = vec![removable_dir_path(path)?.to_string()];
    let mut dirs = Vec::new();
    while let Some(dir) = stack.pop() {
        let read = match sftp.read_dir(&dir).await {
            Ok(read) => read,
            Err(e) if is_no_such_file(&e) => continue,
            Err(e) => return Err(format!("read_dir {}: {}", dir, e)),
        };
        for entry in read {
            let name = entry.file_name();
            if name == "." || name == ".." { continue; }
            if !is_child_name(&name) {
                return Err(format!("{}: the server listed an unsafe entry name {:?}", dir, name));
            }
            let full = format!("{}/{}", dir, name);
            match entry_is_dir(sftp, &full, entry.file_type()).await? {
                Some(true) => stack.push(full),
                Some(false) => gone_is_ok(sftp.remove_file(&full).await).map_err(|e| format!("remove {}: {}", full, e))?,
                None => {}
            }
        }
        dirs.push(dir);
    }
    for dir in dirs.iter().rev() {
        gone_is_ok(sftp.remove_dir(dir).await).map_err(|e| format!("rmdir {}: {}", dir, e))?;
    }
    Ok(())
}

#[tauri::command]
pub async fn sftp_remove_dir(
    state: tauri::State<'_, SshState>,
    session_id: String,
    path: String,
) -> Result<(), String> {
    let path = removable_dir_path(&path)?;
    let sftp = get_sftp_session(&state, &session_id).await?;
    let meta = match sftp.symlink_metadata(path).await {
        Ok(meta) => meta,
        Err(e) if is_no_such_file(&e) => return Ok(()),
        Err(e) => return Err(format!("stat {}: {}", path, e)),
    };
    if meta.file_type().is_symlink() {
        return sftp.remove_file(path).await.map_err(|e| format!("remove {}: {}", path, e));
    }
    sftp_remove_tree(&sftp, path).await
}

#[tauri::command]
pub async fn sftp_rename(
    state: tauri::State<'_, SshState>,
    session_id: String,
    oldpath: String,
    newpath: String,
) -> Result<(), String> {
    let sftp = get_sftp_session(&state, &session_id).await?;

    // First try the rename as-is — the common case is the target's parent
    // already exists.
    if let Err(first_err) = sftp.rename(&oldpath, &newpath).await {
        // SSH_FX_FAILURE on rename is most commonly "destination parent
        // directory doesn't exist" — user types a path into a subfolder
        // they haven't created yet. Pre-check the parent explicitly so
        // we don't paper over real errors (permission denied, destination
        // already exists, cross-filesystem) with a silent retry that
        // would just swap one confusing message for another.
        let parent_str = std::path::Path::new(&newpath)
            .parent()
            .map(|p| p.to_string_lossy().replace('\\', "/"))
            .filter(|s| !s.is_empty() && s != "/");
        let needs_mkdir = match &parent_str {
            Some(p) => sftp.metadata(p.as_str()).await.is_err(),
            None => false,
        };
        if !needs_mkdir {
            return Err(format!("rename '{}' -> '{}': {}", oldpath, newpath, first_err));
        }
        // mkdir -p the missing chain. AlreadyExists is treated as success
        // so a parallel rename racing into the same tree doesn't break us.
        let p = parent_str.unwrap();
        let parts: Vec<&str> = p.trim_start_matches('/').split('/').filter(|s| !s.is_empty()).collect();
        let mut cur = String::from("/");
        for part in parts {
            if cur != "/" { cur.push('/'); }
            cur.push_str(part);
            if sftp.metadata(cur.as_str()).await.is_ok() { continue; }
            if let Err(e) = sftp.create_dir(&cur).await {
                let msg = e.to_string().to_lowercase();
                if msg.contains("exist") { continue; }
                return Err(format!("create destination parent '{}': {}", cur, e));
            }
        }
        sftp.rename(&oldpath, &newpath).await
            .map_err(|e| format!("rename '{}' -> '{}' (after creating parent): {}", oldpath, newpath, e))?;
    }
    Ok(())
}

#[tauri::command]
pub async fn sftp_set_permissions(
    state: tauri::State<'_, SshState>,
    session_id: String,
    path: String,
    permissions: u32,
) -> Result<(), String> {
    let sftp = get_sftp_session(&state, &session_id).await?;
    // Send ONLY the permissions attribute. Echoing back the full stat result
    // makes the server apply every field in it, and the size one turns into
    // truncate(2) — which fails with EISDIR on a directory, surfacing as a
    // bare SSH_FX_FAILURE. Omitted fields are left untouched by the server,
    // so ownership and timestamps can't be clobbered either.
    let metadata = russh_sftp::protocol::FileAttributes {
        permissions: Some(permissions),
        ..Default::default()
    };
    sftp.set_metadata(path, metadata).await.map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn sftp_set_owner(
    state: tauri::State<'_, SshState>,
    session_id: String,
    path: String,
    uid: Option<u32>,
    gid: Option<u32>,
) -> Result<(), String> {
    let sftp = get_sftp_session(&state, &session_id).await?;
    // uid and gid travel as a pair on the wire, so a missing half has to be
    // filled from the current owner rather than defaulting to 0 (root).
    // Propagate the stat error for the same reason.
    let (uid, gid) = match (uid, gid) {
        (Some(u), Some(g)) => (u, g),
        _ => {
            let current = sftp.metadata(&path).await
                .map_err(|e| format!("[SFTP] METADATA_READ_FAILED: {}", e))?;
            match (uid.or(current.uid), gid.or(current.gid)) {
                (Some(u), Some(g)) => (u, g),
                _ => return Err("[SFTP] METADATA_READ_FAILED: server did not report owner".into()),
            }
        }
    };
    // Only the owner fields — see sftp_set_permissions for why size must
    // not be sent (truncate on a directory fails).
    let metadata = russh_sftp::protocol::FileAttributes {
        uid: Some(uid),
        gid: Some(gid),
        ..Default::default()
    };
    sftp.set_metadata(path, metadata).await.map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn sftp_download_file(
    app: tauri::AppHandle,
    state: tauri::State<'_, SshState>,
    session_id: String,
    remote_path: String,
    local_path: String,
    overwrite: Option<bool>,
) -> Result<(), String> {
    use tauri::Emitter;
    use tokio::io::AsyncReadExt;
    use std::sync::atomic::{AtomicBool, Ordering};

    // Overwrite protection: when the caller has NOT explicitly opted in
    // (overwrite==Some(true)), refuse to clobber an existing local file.
    // The sentinel error string `EXISTS:<path>` lets the frontend tell
    // the difference between "real failure" and "you would have replaced
    // something" and surface the apply-to-all confirmation modal.
    if overwrite != Some(true) && std::path::Path::new(&local_path).exists() {
        return Err(format!("EXISTS:{}", local_path));
    }

    // Validate the destination BEFORE touching the network. A compromised
    // renderer (or a malicious SFTP server name in the UI) could otherwise
    // request a download into a system directory like `/etc` or
    // `C:\Windows\System32\…`. allow_nonexistent=true because the
    // destination file is being created right now.
    let _guarded_local = guard_local_path(&local_path, true)?;

    let sftp = get_sftp_session(&state, &session_id).await?;

    // Stat first so we can report a progress percentage. If the server doesn't
    // know the size (some edge SFTP servers omit it), we still report bytes
    // transferred so the UI can show throughput at least.
    let total = match sftp.metadata(&remote_path).await {
        Ok(m) => m.size.unwrap_or(0),
        Err(_) => 0,
    };
    let name = std::path::Path::new(&remote_path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("file")
        .to_string();
    let id = transfer_id();
    let event_name = format!("sftp-transfer-{}", session_id);
    let emit_progress = |bytes: u64, status: &str, error: Option<String>| {
        let _ = app.emit(
            &event_name,
            serde_json::json!({
                "id": id, "name": name, "kind": "download",
                "bytes": bytes, "total": total,
                "status": status, "error": error,
            }),
        );
    };

    // Register a cancel flag the user can flip via `sftp_cancel_transfer`.
    // RAII-removed at the end so the map doesn't pile up across many
    // sequential transfers.
    let cancel = Arc::new(AtomicBool::new(false));
    let cancels_map = Arc::clone(&state.transfer_cancels);
    cancels_map.lock().await.insert(id.clone(), Arc::clone(&cancel));
    struct CancelGuard {
        map: Arc<tokio::sync::Mutex<std::collections::HashMap<String, Arc<AtomicBool>>>>,
        id: String,
    }
    impl Drop for CancelGuard {
        fn drop(&mut self) {
            // Best-effort cleanup; if the lock is contended we'd rather leak
            // a slot than block the drop, but in practice this never blocks.
            if let Ok(mut g) = self.map.try_lock() {
                g.remove(&self.id);
            }
        }
    }
    let _guard = CancelGuard { map: Arc::clone(&cancels_map), id: id.clone() };

    emit_progress(0, "progress", None);

    let mut remote_file = sftp
        .open(&remote_path)
        .await
        .map_err(|e| { emit_progress(0, "error", Some(e.to_string())); format!("Failed to open remote file: {}", e) })?;
    let mut local_file = tokio::fs::File::create(&local_path)
        .await
        .map_err(|e| { emit_progress(0, "error", Some(e.to_string())); format!("Failed to create local file: {}", e) })?;

    // 256 KiB chunks: large enough to keep the SSH window pipelined on
    // high-latency links (with window_size=8 MiB we want ~16+ chunks in
    // flight), small enough to keep per-iteration latency low for the
    // progress meter (and the cancel poll).
    let mut buf = vec![0u8; 256 * 1024];
    let mut transferred: u64 = 0;
    let mut last_report = std::time::Instant::now();
    use tokio::io::AsyncWriteExt;
    loop {
        if cancel.load(Ordering::Relaxed) {
            // Drop the partial local file so we don't leave a half-baked
            // download behind; ignore errors (e.g. on Windows file-locking).
            drop(local_file);
            let _ = tokio::fs::remove_file(&local_path).await;
            emit_progress(transferred, "cancelled", None);
            return Err("cancelled".into());
        }
        let n = remote_file
            .read(&mut buf)
            .await
            .map_err(|e| { emit_progress(transferred, "error", Some(e.to_string())); format!("read: {}", e) })?;
        if n == 0 { break; }
        local_file
            .write_all(&buf[..n])
            .await
            .map_err(|e| { emit_progress(transferred, "error", Some(e.to_string())); format!("write: {}", e) })?;
        transferred += n as u64;
        // Throttle progress events: each one crosses the IPC boundary, and
        // 10 Hz is more than enough for a smooth progress bar.
        if last_report.elapsed() >= std::time::Duration::from_millis(100) {
            emit_progress(transferred, "progress", None);
            last_report = std::time::Instant::now();
        }
    }
    local_file.flush().await.map_err(|e| format!("flush: {}", e))?;
    emit_progress(transferred, "done", None);
    Ok(())
}

#[allow(dead_code)]
fn run_local_tar_extract(archive_path: &std::path::Path, target_dir: &std::path::Path) -> Result<(), String> {
    let mut cmd = std::process::Command::new("tar");
    cmd.arg("-xzf").arg(archive_path).arg("-C").arg(target_dir);
    #[cfg(target_os = "windows")]
    {
        #[allow(unused_imports)]
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }
    let status = cmd.status().map_err(|e| format!("Failed to spawn local tar: {}", e))?;
    if !status.success() {
        return Err(format!("Local tar extract exited with code: {:?}", status.code()));
    }
    Ok(())
}

#[allow(dead_code)]
fn run_local_tar_create(archive_path: &std::path::Path, parent_dir: &std::path::Path, folder_name: &str) -> Result<(), String> {
    let mut cmd = std::process::Command::new("tar");
    cmd.arg("-czf").arg(archive_path).arg("-C").arg(parent_dir).arg(folder_name);
    #[cfg(target_os = "windows")]
    {
        #[allow(unused_imports)]
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }
    let status = cmd.status().map_err(|e| format!("Failed to spawn local tar: {}", e))?;
    if !status.success() {
        return Err(format!("Local tar create exited with code: {:?}", status.code()));
    }
    Ok(())
}

pub async fn exec_ssh_command_helper(
    state: &SshState,
    session_id: &str,
    command: &str,
) -> Result<String, String> {
    use tokio::io::AsyncReadExt;
    let connections = state.connections.lock().await;
    let session_arc = connections
        .get(session_id)
        .cloned()
        .ok_or_else(|| "Session not found".to_string())?;
    drop(connections);

    let channel = {
        let session = session_arc.lock().await;
        session.channel_open_session().await.map_err(|e| e.to_string())?
    };
    channel.exec(true, command.as_bytes()).await.map_err(|e| e.to_string())?;
    let mut stream = channel.into_stream();
    let mut output = Vec::new();
    let mut buf = [0u8; 4096];
    while let Ok(n) = stream.read(&mut buf).await {
        if n == 0 { break; }
        output.extend_from_slice(&buf[..n]);
        if output.len() > 1024 * 1024 { break; }
    }
    Ok(String::from_utf8_lossy(&output).to_string())
}

/// Recursive remote directory download. Walks the remote tree under
/// `remote_path`, mirrors its structure into `local_path/{basename}`, and
/// streams every file across with progress events aggregated under a SINGLE
/// transfer id — so the UI shows one "folder of N files" card instead of one
/// card per file. Cancellation uses the same `transfer_cancels` map as
/// single-file downloads, so the user's Cancel button works identically.
#[tauri::command]
pub async fn sftp_download_dir(
    app: tauri::AppHandle,
    state: tauri::State<'_, SshState>,
    session_id: String,
    remote_path: String,
    local_path: String,
    overwrite: Option<bool>,
) -> Result<(), String> {
    use tauri::Emitter;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use std::sync::atomic::{AtomicBool, Ordering};

    // Destination is the PARENT directory. We'll create remote_path's
    // basename underneath it so the user gets `local/{folder}/...`,
    // matching scp -r and rsync semantics.
    let _guarded_local = guard_local_path(&local_path, true)?;

    // Overwrite protection for the destination folder: if the target
    // `local_path/{folder}` already exists, refuse unless explicitly
    // allowed. Per-file confirmation inside the tree would be unworkable
    // for the bulk path — the user picks once at the directory level.
    {
        let folder_name = remote_path
            .trim_end_matches('/')
            .rsplit('/')
            .next()
            .unwrap_or("folder");
        let dst_root = std::path::PathBuf::from(&local_path).join(folder_name);
        if overwrite != Some(true) && dst_root.exists() {
            return Err(format!("EXISTS:{}", dst_root.to_string_lossy()));
        }
    }

    let sftp = get_sftp_session(&state, &session_id).await?;

    // Compute the folder name from the remote path. Strip trailing slashes
    // first so `/home/user/data/` still yields `data`, not "".
    let folder_name = remote_path
        .trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or("folder")
        .to_string();
    let folder_name = if folder_name.is_empty() { "folder".to_string() } else { folder_name };

    let id = transfer_id();
    let event_name = format!("sftp-transfer-{}", session_id);

    // Register cancel flag early so the user can abort even during the
    // enumeration phase (which can be slow on a deep tree with many dirs).
    let cancel = Arc::new(AtomicBool::new(false));
    let cancels_map = Arc::clone(&state.transfer_cancels);
    cancels_map.lock().await.insert(id.clone(), Arc::clone(&cancel));
    struct CancelGuard {
        map: Arc<tokio::sync::Mutex<std::collections::HashMap<String, Arc<AtomicBool>>>>,
        id: String,
    }
    impl Drop for CancelGuard {
        fn drop(&mut self) {
            if let Ok(mut g) = self.map.try_lock() {
                g.remove(&self.id);
            }
        }
    }
    let _guard = CancelGuard { map: Arc::clone(&cancels_map), id: id.clone() };

    let emit_progress = |bytes: u64, total: u64, status: &str, error: Option<String>| {
        let _ = app.emit(
            &event_name,
            serde_json::json!({
                "id": &id, "name": &folder_name, "kind": "download",
                "bytes": bytes, "total": total,
                "status": status, "error": error,
            }),
        );
    };

    emit_progress(0, 0, "progress", None);

    // Phase 0: Smart Tar Acceleration (50x-100x Faster SFTP Directory Transfer)
    // Avoids thousands of sequential SFTP network round trips by creating a single
    // compressed tar stream on the remote server and unpacking locally.
    let smart_tar_success = {
        let parent_remote = if let Some((p, _)) = remote_path.trim_end_matches('/').rsplit_once('/') {
            if p.is_empty() { "/" } else { p }
        } else {
            "/"
        };
        let tmp_remote_tar = format!("/tmp/_subterm_dl_{}.tar.gz", &id);
        let tar_cmd = format!(
            "tar -czf \"{}\" -C \"{}\" \"{}\"",
            tmp_remote_tar.replace('"', "\\\""),
            parent_remote.replace('"', "\\\""),
            folder_name.replace('"', "\\\"")
        );

        if exec_ssh_command_helper(&state, &session_id, &tar_cmd).await.is_ok() {
            if let Ok(meta) = sftp.metadata(&tmp_remote_tar).await {
                let archive_size = meta.size.unwrap_or(0);
                if archive_size > 0 {
                    let local_tmp_tar = std::env::temp_dir().join(format!("_subterm_dl_{}.tar.gz", &id));
                    let download_res = async {
                        let mut remote_file = sftp.open(&tmp_remote_tar).await.map_err(|e| e.to_string())?;
                        let mut local_file = tokio::fs::File::create(&local_tmp_tar).await.map_err(|e| e.to_string())?;
                        let mut transferred = 0u64;
                        let mut buf = vec![0u8; 128 * 1024];

                        while transferred < archive_size {
                            if cancel.load(Ordering::Relaxed) {
                                return Err("cancelled".to_string());
                            }
                            let n = remote_file.read(&mut buf).await.map_err(|e| e.to_string())?;
                            if n == 0 { break; }
                            local_file.write_all(&buf[..n]).await.map_err(|e| e.to_string())?;
                            transferred += n as u64;
                            emit_progress(transferred, archive_size, "progress", None);
                        }
                        local_file.flush().await.map_err(|e| e.to_string())?;
                        Ok::<(), String>(())
                    }.await;

                    let mut unpacked = false;
                    if download_res.is_ok() {
                        let dst_parent = std::path::PathBuf::from(&local_path);
                        if run_local_tar_extract(&local_tmp_tar, &dst_parent).is_ok() {
                            unpacked = true;
                        }
                    }

                    let _ = tokio::fs::remove_file(&local_tmp_tar).await;
                    let _ = exec_ssh_command_helper(&state, &session_id, &format!("rm -f \"{}\"", tmp_remote_tar)).await;

                    if unpacked {
                        emit_progress(archive_size, archive_size, "done", None);
                        true
                    } else {
                        false
                    }
                } else {
                    let _ = exec_ssh_command_helper(&state, &session_id, &format!("rm -f \"{}\"", tmp_remote_tar)).await;
                    false
                }
            } else {
                false
            }
        } else {
            false
        }
    };

    if smart_tar_success {
        return Ok(());
    }

    // Phase 1: enumerate. Collect every file under remote_path along with
    // its relative path (so we can preserve the tree on the local side) and
    // its size (so the progress bar has a meaningful total). Tracked
    // iteratively with an explicit stack so we don't blow the async-recursion
    // budget on pathological trees.
    let remote_root = remote_path.trim_end_matches('/').to_string();
    let mut files: Vec<(String, String, u64)> = Vec::new(); // (remote, rel, size)
    let mut total_bytes: u64 = 0;
    let mut stack: Vec<String> = vec![remote_root.clone()];

    while let Some(dir) = stack.pop() {
        if cancel.load(Ordering::Relaxed) {
            emit_progress(0, total_bytes, "cancelled", None);
            return Err("cancelled".into());
        }
        let read = match sftp.read_dir(&dir).await {
            Ok(r) => r,
            Err(e) => {
                emit_progress(0, total_bytes, "error", Some(format!("read_dir {}: {}", dir, e)));
                return Err(format!("read_dir {}: {}", dir, e));
            }
        };
        for entry in read {
            let name = entry.file_name();
            // Skip any entry whose name isn't a single plain component. A
            // hostile SFTP server can return `../../x` or `..\x` here; joining
            // that onto local_root below would escape the chosen folder
            // (zip-slip → arbitrary local write). See is_safe_dir_entry_name.
            if !is_safe_dir_entry_name(&name) { continue; }
            let full = format!("{}/{}", dir.trim_end_matches('/'), name);
            if entry.file_type().is_dir() {
                stack.push(full);
            } else if entry.file_type().is_file() {
                let size = entry.metadata().size.unwrap_or(0);
                let rel = full.strip_prefix(&remote_root)
                    .map(|s| s.trim_start_matches('/').to_string())
                    .unwrap_or_else(|| name.clone());
                total_bytes = total_bytes.saturating_add(size);
                files.push((full, rel, size));
            }
            // Symlinks and other types skipped — same conservative policy
            // as the mirror module.
        }
    }

    if files.is_empty() {
        // Still create the (empty) destination folder so the UI sees the
        // shape — otherwise the user sees "done" with nothing to show for it.
        let local_root = std::path::PathBuf::from(&local_path).join(&folder_name);
        let _ = tokio::fs::create_dir_all(&local_root).await;
        emit_progress(0, 0, "done", None);
        return Ok(());
    }

    // Phase 2: download. The local destination tree is rooted at
    // {local_path}/{folder_name}/... so multi-level files preserve their
    // structure. Create each parent directory lazily right before we open
    // the file.
    let local_root = std::path::PathBuf::from(&local_path).join(&folder_name);
    if let Err(e) = tokio::fs::create_dir_all(&local_root).await {
        emit_progress(0, total_bytes, "error", Some(format!("create {}: {}", local_root.display(), e)));
        return Err(format!("create root: {}", e));
    }

    let mut transferred: u64 = 0;
    let mut last_report = std::time::Instant::now();
    let mut buf = vec![0u8; 256 * 1024];

    for (remote_file_path, rel, _size) in &files {
        if cancel.load(Ordering::Relaxed) {
            emit_progress(transferred, total_bytes, "cancelled", None);
            return Err("cancelled".into());
        }

        // Normalise the relative path's separators for the local OS. On
        // Unix this is a no-op; on Windows we replace `/` so create_dir_all
        // produces real nested directories instead of one literal name
        // containing slashes.
        let rel_local = if cfg!(windows) { rel.replace('/', "\\") } else { rel.clone() };
        let dest = local_root.join(&rel_local);
        if let Some(parent) = dest.parent() {
            if let Err(e) = tokio::fs::create_dir_all(parent).await {
                emit_progress(transferred, total_bytes, "error",
                    Some(format!("mkdir {}: {}", parent.display(), e)));
                return Err(format!("mkdir {}: {}", parent.display(), e));
            }
        }

        let mut remote_file = match sftp.open(remote_file_path).await {
            Ok(f) => f,
            Err(e) => {
                emit_progress(transferred, total_bytes, "error",
                    Some(format!("open {}: {}", remote_file_path, e)));
                return Err(format!("open {}: {}", remote_file_path, e));
            }
        };
        let mut local_file = match tokio::fs::File::create(&dest).await {
            Ok(f) => f,
            Err(e) => {
                emit_progress(transferred, total_bytes, "error",
                    Some(format!("create {}: {}", dest.display(), e)));
                return Err(format!("create {}: {}", dest.display(), e));
            }
        };

        loop {
            if cancel.load(Ordering::Relaxed) {
                drop(local_file);
                let _ = tokio::fs::remove_file(&dest).await;
                emit_progress(transferred, total_bytes, "cancelled", None);
                return Err("cancelled".into());
            }
            let n = remote_file.read(&mut buf).await
                .map_err(|e| {
                    emit_progress(transferred, total_bytes, "error",
                        Some(format!("read {}: {}", remote_file_path, e)));
                    format!("read {}: {}", remote_file_path, e)
                })?;
            if n == 0 { break; }
            local_file.write_all(&buf[..n]).await
                .map_err(|e| {
                    emit_progress(transferred, total_bytes, "error",
                        Some(format!("write {}: {}", dest.display(), e)));
                    format!("write {}: {}", dest.display(), e)
                })?;
            transferred = transferred.saturating_add(n as u64);
            if last_report.elapsed() >= std::time::Duration::from_millis(100) {
                emit_progress(transferred, total_bytes, "progress", None);
                last_report = std::time::Instant::now();
            }
        }
        local_file.flush().await.map_err(|e| format!("flush {}: {}", dest.display(), e))?;
    }

    emit_progress(transferred, total_bytes, "done", None);
    Ok(())
}

async fn open_upload_target(
    sftp: &russh_sftp::client::SftpSession,
    remote_path: &str,
) -> Result<(russh_sftp::client::fs::File, bool), russh_sftp::client::error::Error> {
    use russh_sftp::protocol::OpenFlags;
    let overwrite = OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::TRUNCATE;
    if let Ok(file) = sftp.open_with_flags(remote_path, overwrite | OpenFlags::EXCLUDE).await {
        return Ok((file, true));
    }
    let file = sftp.open_with_flags(remote_path, overwrite).await?;
    Ok((file, false))
}

async fn finish_cancelled_upload(
    sftp: Arc<russh_sftp::client::SftpSession>,
    mut remote_file: russh_sftp::client::fs::File,
    remote_path: String,
    created: bool,
) -> Option<String> {
    use tokio::io::AsyncWriteExt;
    let cleanup = tokio::spawn(async move {
        let _ = remote_file.shutdown().await;
        if !created {
            return None;
        }
        let removed = sftp.remove_file(remote_path).await;
        removed.err().map(|e| format!("The partial file is still on the server: {}", e))
    });
    if !created {
        return Some("The file on the server was overwritten and is now incomplete".to_string());
    }
    match tokio::time::timeout(std::time::Duration::from_secs(5), cleanup).await {
        Ok(Ok(note)) => note,
        Ok(Err(e)) => Some(format!("The partial file may still be on the server: {}", e)),
        Err(_) => Some("The partial file is still being removed from the server".to_string()),
    }
}

#[tauri::command]
pub async fn sftp_upload_file(
    app: tauri::AppHandle,
    state: tauri::State<'_, SshState>,
    session_id: String,
    local_path: String,
    remote_path: String,
    overwrite: Option<bool>,
) -> Result<(), String> {
    use tauri::Emitter;
    use tokio::io::AsyncWriteExt;
    use std::sync::atomic::{AtomicBool, Ordering};

    // Overwrite protection: stat the remote target first; refuse if it
    // exists and the caller hasn't explicitly opted in. Same `EXISTS:<path>`
    // sentinel as the download path.
    let sftp = get_sftp_session(&state, &session_id).await?;
    if overwrite != Some(true) {
        if sftp.metadata(&remote_path).await.is_ok() {
            return Err(format!("EXISTS:{}", remote_path));
        }
    }

    // Source must exist and live in a path the user could plausibly own —
    // refuses an SFTP push that would exfiltrate /etc/shadow or the SAM
    // hive if the renderer ever gets coerced.
    let _guarded_local = guard_local_path(&local_path, false)?;

    let total = std::fs::metadata(&local_path)
        .map(|m| m.len())
        .unwrap_or(0);
    let name = std::path::Path::new(&local_path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("file")
        .to_string();
    let id = transfer_id();
    let event_name = format!("sftp-transfer-{}", session_id);
    let emit_progress = |bytes: u64, status: &str, error: Option<String>| {
        let _ = app.emit(
            &event_name,
            serde_json::json!({
                "id": id, "name": name, "kind": "upload",
                "bytes": bytes, "total": total,
                "status": status, "error": error,
            }),
        );
    };

    // Symmetric to sftp_download_file: register a cancel flag and clean it
    // up via RAII so a long-running upload can be stopped from the UI.
    let cancel = Arc::new(AtomicBool::new(false));
    let cancels_map = Arc::clone(&state.transfer_cancels);
    cancels_map.lock().await.insert(id.clone(), Arc::clone(&cancel));
    struct CancelGuard {
        map: Arc<tokio::sync::Mutex<std::collections::HashMap<String, Arc<AtomicBool>>>>,
        id: String,
    }
    impl Drop for CancelGuard {
        fn drop(&mut self) {
            if let Ok(mut g) = self.map.try_lock() {
                g.remove(&self.id);
            }
        }
    }
    let _guard = CancelGuard { map: Arc::clone(&cancels_map), id: id.clone() };

    emit_progress(0, "progress", None);

    // Stream the file from disk in chunks rather than slurping the whole thing
    // into a Vec — keeps memory bounded for multi-GB transfers and lets us
    // emit progress along the way.
    let mut local_file = tokio::fs::File::open(&local_path)
        .await
        .map_err(|e| { emit_progress(0, "error", Some(e.to_string())); format!("Failed to read local file: {}", e) })?;
    let (mut remote_file, creates_file) = open_upload_target(&sftp, &remote_path)
        .await
        .map_err(|e| { emit_progress(0, "error", Some(e.to_string())); format!("Failed to open remote file: {}", e) })?;

    // See sftp_download_file — 256 KiB matches the bigger SSH window.
    let mut buf = vec![0u8; 256 * 1024];
    let mut transferred: u64 = 0;
    let mut last_report = std::time::Instant::now();
    use tokio::io::AsyncReadExt;
    loop {
        if cancel.load(Ordering::Relaxed) {
            let note = finish_cancelled_upload(Arc::clone(&sftp), remote_file, remote_path.clone(), creates_file).await;
            emit_progress(transferred, "cancelled", note);
            return Err("cancelled".into());
        }
        let n = local_file
            .read(&mut buf)
            .await
            .map_err(|e| { emit_progress(transferred, "error", Some(e.to_string())); format!("read: {}", e) })?;
        if n == 0 { break; }
        remote_file
            .write_all(&buf[..n])
            .await
            .map_err(|e| { emit_progress(transferred, "error", Some(e.to_string())); format!("write: {}", e) })?;
        transferred += n as u64;
        if last_report.elapsed() >= std::time::Duration::from_millis(100) {
            emit_progress(transferred, "progress", None);
            last_report = std::time::Instant::now();
        }
    }
    remote_file
        .shutdown()
        .await
        .map_err(|e| format!("Failed to close remote file: {}", e))?;
    emit_progress(transferred, "done", None);
    Ok(())
}

/// Recursive directory upload — mirror of sftp_download_dir. Walks the local
/// tree, mkdirs each subdirectory on the remote, then streams every file
/// through the same flags+chunk logic as sftp_upload_file. Cancel flag and
/// EXISTS sentinel match the download path so the UI can reuse its prompt /
/// progress / abort hooks unchanged.
#[tauri::command]
pub async fn sftp_upload_dir(
    app: tauri::AppHandle,
    state: tauri::State<'_, SshState>,
    session_id: String,
    local_path: String,
    remote_path: String,
    overwrite: Option<bool>,
) -> Result<(), String> {
    use tauri::Emitter;
    use tokio::io::AsyncWriteExt;
    use std::sync::atomic::{AtomicBool, Ordering};

    // remote_path is the PARENT directory; we hang the basename of
    // local_path underneath it. Matches scp -r / sftp_download_dir.
    let _guarded_local = guard_local_path(&local_path, false)?;

    let local_root = std::path::PathBuf::from(&local_path);
    let folder_name = local_root
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("folder")
        .to_string();
    let folder_name = if folder_name.is_empty() { "folder".to_string() } else { folder_name };

    let sftp = get_sftp_session(&state, &session_id).await?;

    // Overwrite gate on the destination folder. Refuse unless the caller
    // explicitly opted in — symmetric with sftp_download_dir.
    let remote_root = format!("{}/{}",
        remote_path.trim_end_matches('/'),
        folder_name);
    if overwrite != Some(true) {
        if sftp.metadata(&remote_root).await.is_ok() {
            return Err(format!("EXISTS:{}", remote_root));
        }
    }

    let id = transfer_id();
    let event_name = format!("sftp-transfer-{}", session_id);

    // Cancel flag registered before the slow enumeration so the user can
    // abort even while we're walking a deep tree.
    let cancel = Arc::new(AtomicBool::new(false));
    let cancels_map = Arc::clone(&state.transfer_cancels);
    cancels_map.lock().await.insert(id.clone(), Arc::clone(&cancel));
    struct CancelGuard {
        map: Arc<tokio::sync::Mutex<std::collections::HashMap<String, Arc<AtomicBool>>>>,
        id: String,
    }
    impl Drop for CancelGuard {
        fn drop(&mut self) {
            if let Ok(mut g) = self.map.try_lock() {
                g.remove(&self.id);
            }
        }
    }
    let _guard = CancelGuard { map: Arc::clone(&cancels_map), id: id.clone() };

    let emit_progress = |bytes: u64, total: u64, status: &str, error: Option<String>| {
        let _ = app.emit(
            &event_name,
            serde_json::json!({
                "id": &id, "name": &folder_name, "kind": "upload",
                "bytes": bytes, "total": total,
                "status": status, "error": error,
            }),
        );
    };

    emit_progress(0, 0, "progress", None);

    // Phase 0: Smart Tar Acceleration for Uploads (50x-100x Faster SFTP Directory Upload)
    let smart_tar_upload_success = {
        let local_parent = local_root.parent().unwrap_or(&local_root);
        let local_tmp_tar = std::env::temp_dir().join(format!("_subterm_up_{}.tar.gz", &id));

        if run_local_tar_create(&local_tmp_tar, local_parent, &folder_name).is_ok() {
            let upload_res = async {
                let local_file = tokio::fs::File::open(&local_tmp_tar).await.map_err(|e| e.to_string())?;
                let archive_size = local_file.metadata().await.map_err(|e| e.to_string())?.len();
                let tmp_remote_tar = format!("/tmp/_subterm_up_{}.tar.gz", &id);
                let mut remote_file = sftp.create(&tmp_remote_tar).await.map_err(|e| e.to_string())?;
                let mut reader = tokio::io::BufReader::with_capacity(128 * 1024, local_file);
                let mut transferred = 0u64;
                let mut buf = vec![0u8; 128 * 1024];

                while transferred < archive_size {
                    if cancel.load(Ordering::Relaxed) {
                        drop(remote_file);
                        let _ = exec_ssh_command_helper(&state, &session_id, &format!("rm -f \"{}\"", tmp_remote_tar)).await;
                        return Err("cancelled".to_string());
                    }
                    let n = tokio::io::AsyncReadExt::read(&mut reader, &mut buf).await.map_err(|e| e.to_string())?;
                    if n == 0 { break; }
                    remote_file.write_all(&buf[..n]).await.map_err(|e| e.to_string())?;
                    transferred += n as u64;
                    emit_progress(transferred, archive_size, "progress", None);
                }
                drop(remote_file);

                // Unpack on remote server
                let unpack_cmd = format!(
                    "tar -xzf \"{}\" -C \"{}\" && rm -f \"{}\"",
                    tmp_remote_tar.replace('"', "\\\""),
                    remote_path.replace('"', "\\\""),
                    tmp_remote_tar.replace('"', "\\\"")
                );
                exec_ssh_command_helper(&state, &session_id, &unpack_cmd).await?;
                Ok::<u64, String>(archive_size)
            }.await;

            let _ = tokio::fs::remove_file(&local_tmp_tar).await;
            if let Ok(archive_size) = upload_res {
                emit_progress(archive_size, archive_size, "done", None);
                true
            } else {
                false
            }
        } else {
            false
        }
    };

    if smart_tar_upload_success {
        return Ok(());
    }

    // Phase 1: enumerate. Collect every local file under local_root along
    // with its relative path (POSIX-style for the remote side) and size.
    // Iterative walk with an explicit stack so we never overflow async
    // recursion on pathological trees.
    let mut files: Vec<(std::path::PathBuf, String, u64)> = Vec::new();
    let mut dirs: Vec<String> = Vec::new(); // relative dir paths (POSIX) to mkdir on remote
    let mut total_bytes: u64 = 0;
    let mut stack: Vec<std::path::PathBuf> = vec![local_root.clone()];

    while let Some(dir) = stack.pop() {
        if cancel.load(Ordering::Relaxed) {
            emit_progress(0, total_bytes, "cancelled", None);
            return Err("cancelled".into());
        }
        let read = match std::fs::read_dir(&dir) {
            Ok(r) => r,
            Err(e) => {
                emit_progress(0, total_bytes, "error", Some(format!("read_dir {:?}: {}", dir, e)));
                return Err(format!("read_dir {:?}: {}", dir, e));
            }
        };
        for entry in read {
            let entry = match entry {
                Ok(e) => e,
                Err(_) => continue,
            };
            let path = entry.path();
            let ft = match entry.file_type() {
                Ok(ft) => ft,
                Err(_) => continue,
            };
            let rel = path
                .strip_prefix(&local_root)
                .map(|p| p.to_string_lossy().replace('\\', "/"))
                .unwrap_or_default();
            if ft.is_dir() {
                dirs.push(rel);
                stack.push(path);
            } else if ft.is_file() {
                let size = path.metadata().map(|m| m.len()).unwrap_or(0);
                total_bytes = total_bytes.saturating_add(size);
                files.push((path, rel, size));
            }
            // Symlinks and other types skipped — same as sftp_download_dir.
        }
    }

    // Phase 2: mkdir the destination folder, then each enumerated subdir.
    // SFTP's mkdir is per-level; we already collected them in pre-order from
    // the stack walk but order isn't guaranteed shallow-first, so re-sort
    // by path depth to make sure parents are created before children.
    let _ = sftp.create_dir(&remote_root).await;
    dirs.sort_by_key(|d| d.matches('/').count());
    for rel in &dirs {
        if cancel.load(Ordering::Relaxed) {
            emit_progress(0, total_bytes, "cancelled", None);
            return Err("cancelled".into());
        }
        let full = format!("{}/{}", remote_root.trim_end_matches('/'), rel);
        // Tolerate already-exists — a parallel mkdir or an earlier partial
        // run shouldn't abort the whole upload.
        if sftp.metadata(&full).await.is_err() {
            if let Err(e) = sftp.create_dir(&full).await {
                emit_progress(0, total_bytes, "error", Some(format!("mkdir {}: {}", full, e)));
                return Err(format!("mkdir {}: {}", full, e));
            }
        }
    }

    if files.is_empty() {
        emit_progress(0, 0, "done", None);
        return Ok(());
    }

    // Phase 3: stream each file up. Same chunked loop as sftp_upload_file,
    // looped over the file list with a shared progress counter.
    let mut transferred: u64 = 0;
    let mut last_report = std::time::Instant::now();
    let mut buf = vec![0u8; 256 * 1024];
    use tokio::io::AsyncReadExt;

    for (local_file_path, rel, _size) in &files {
        if cancel.load(Ordering::Relaxed) {
            emit_progress(transferred, total_bytes, "cancelled", None);
            return Err("cancelled".into());
        }
        let remote_full = format!("{}/{}", remote_root.trim_end_matches('/'), rel);

        let mut local_file = match tokio::fs::File::open(local_file_path).await {
            Ok(f) => f,
            Err(e) => {
                emit_progress(transferred, total_bytes, "error",
                    Some(format!("open {:?}: {}", local_file_path, e)));
                return Err(format!("open {:?}: {}", local_file_path, e));
            }
        };
        let (mut remote_file, creates_file) = match open_upload_target(&sftp, &remote_full).await {
            Ok(opened) => opened,
            Err(e) => {
                emit_progress(transferred, total_bytes, "error",
                    Some(format!("open remote {}: {}", remote_full, e)));
                return Err(format!("open remote {}: {}", remote_full, e));
            }
        };

        loop {
            if cancel.load(Ordering::Relaxed) {
                let note = finish_cancelled_upload(Arc::clone(&sftp), remote_file, remote_full.clone(), creates_file).await;
                emit_progress(transferred, total_bytes, "cancelled", note);
                return Err("cancelled".into());
            }
            let n = local_file.read(&mut buf).await
                .map_err(|e| {
                    emit_progress(transferred, total_bytes, "error",
                        Some(format!("read {:?}: {}", local_file_path, e)));
                    format!("read {:?}: {}", local_file_path, e)
                })?;
            if n == 0 { break; }
            remote_file.write_all(&buf[..n]).await
                .map_err(|e| {
                    emit_progress(transferred, total_bytes, "error",
                        Some(format!("write {}: {}", remote_full, e)));
                    format!("write {}: {}", remote_full, e)
                })?;
            transferred = transferred.saturating_add(n as u64);
            if last_report.elapsed() >= std::time::Duration::from_millis(100) {
                emit_progress(transferred, total_bytes, "progress", None);
                last_report = std::time::Instant::now();
            }
        }
        remote_file.shutdown().await
            .map_err(|e| format!("shutdown {}: {}", remote_full, e))?;
    }

    emit_progress(transferred, total_bytes, "done", None);
    Ok(())
}

/// Flip the cancel flag for an in-flight SFTP transfer. The download / upload
/// loop polls the flag every chunk (every ~256 KiB) and exits with a
/// "cancelled" status event as soon as it sees true. Unknown ids are a no-op
/// — by the time the UI's stop button click reaches us the transfer may have
/// already finished on its own.
#[tauri::command]
pub async fn sftp_cancel_transfer(
    state: tauri::State<'_, SshState>,
    transfer_id: String,
) -> Result<(), String> {
    if let Some(flag) = state.transfer_cancels.lock().await.get(&transfer_id) {
        flag.store(true, std::sync::atomic::Ordering::Relaxed);
    }
    Ok(())
}

// Monotonically-increasing per-transfer id. The frontend uses it to group
// progress events into one updatable card per transfer.
fn transfer_id() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let seq = COUNTER.fetch_add(1, Ordering::Relaxed);
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    format!("{}-{}", ts, seq)
}

/// Process-global, UNPREDICTABLE temp root for SFTP live-edit / drag staging,
/// created once with a random name (and 0700 on Unix). The old code used a
/// fully predictable `submarine_sftp_<session_id>` directory directly in the
/// world-writable, sticky-bit /tmp — on a shared host a local attacker could
/// pre-create it (owning it) before the victim opened a remote file, capturing
/// the downloaded (possibly sensitive) contents or redirecting the write via a
/// planted symlink. A random, non-guessable root the attacker cannot pre-create
/// closes that; per-session subdirs live under it and are removed by name.
fn app_temp_root() -> &'static std::path::PathBuf {
    static ROOT: std::sync::OnceLock<std::path::PathBuf> = std::sync::OnceLock::new();
    ROOT.get_or_init(|| {
        let mut bytes = [0u8; 12];
        rand::thread_rng().fill(&mut bytes);
        let root = std::env::temp_dir().join(format!("submarine-{}", hex::encode(bytes)));
        let _ = std::fs::create_dir_all(&root);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700));
        }
        root
    })
}

/// Per-session live-edit staging dir, under the unpredictable root.
pub(crate) fn session_sftp_dir(session_id: &str) -> std::path::PathBuf {
    app_temp_root().join(format!("sftp_{}", session_id))
}

/// Per-session drag staging dir, under the unpredictable root.
pub(crate) fn session_drag_dir(session_id: &str) -> std::path::PathBuf {
    app_temp_root().join(format!("drag_{}", session_id))
}

/// Reduce a server-controlled remote path to a safe LOCAL leaf filename for
/// temp staging. Rejects empty / "." / ".." and any name containing a path
/// separator, a drive marker (`:`), or NUL — the exact set that would let a
/// hostile/compromised SFTP server escape the per-session temp dir. On Windows
/// a leaf like "C:evil.txt" is drive-relative: `PathBuf::join` discards the
/// base and resolves it against the process CWD, writing (and auto-opening)
/// attacker bytes outside the sandbox. One gate for both live-edit and drag.
fn safe_temp_leaf_name(remote_path: &str) -> Result<String, String> {
    let raw = std::path::Path::new(remote_path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("");
    let bad = |c: char| matches!(c, '/' | '\\' | ':' | '\0');
    if raw.is_empty() || raw == "." || raw == ".." || raw.contains(bad) {
        return Err(format!("refusing file with unsafe name: {:?}", raw));
    }
    Ok(raw.to_string())
}

#[tauri::command]
pub async fn sftp_open_remote_file(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, SshState>,
    session_id: String,
    remote_path: String,
) -> Result<(), String> {
    use tauri::Emitter;

    let sftp = get_sftp_session(&state, &session_id).await?;
    let filename = safe_temp_leaf_name(&remote_path)?;

    // Read file data
    let data = sftp.read(&remote_path).await.map_err(|e| format!("Failed to read remote file: {}", e))?;

    // Per-session subdirectory so we can sweep everything cleanly on
    // disconnect rather than leaving loose `submarine_sftp_*` files in the global
    // temp dir. The directory is also a smaller blast radius for any path-
    // related shenanigans (each editor sees only files from one session).
    let session_temp_dir = session_sftp_dir(&session_id);
    std::fs::create_dir_all(&session_temp_dir)
        .map_err(|e| format!("Failed to create temp dir: {}", e))?;
    let temp_file_path = session_temp_dir.join(&filename);
    std::fs::write(&temp_file_path, &data).map_err(|e| format!("Failed to write temporary file: {}", e))?;

    // Open local temp file in system default application. The whole
    // live-edit-in-default-editor feature is desktop-only — Android's
    // intent-based "open with" model would need a Tauri plugin instead,
    // and saving back through SAF doesn't fit the temp-file pattern we
    // depend on. Refuse cleanly so the UI can surface a polite message.
    #[cfg(target_os = "android")]
    {
        let _ = &temp_file_path;
        return Err("Live edit in system editor is not available on Android.".into());
    }
    #[cfg(not(target_os = "android"))]
    {
        let open_res = open::that(&temp_file_path);
        if let Err(e) = open_res {
            return Err(format!("Failed to open file: {}", e));
        }
    }

    // Spawn modification watcher task in background
    let connections_clone = Arc::clone(&state.connections);
    let app_handle_clone = app_handle.clone();
    let session_id_clone = session_id.clone();
    let remote_path_clone = remote_path.clone();
    let filename_clone = filename.clone();
    let temp_file_path_clone = temp_file_path.clone();

    tokio::spawn(async move {
        // Notify-driven save detection instead of the old 1.5s poll. Wires
        // the same `notify-debouncer-mini` crate the mirror module uses:
        //   - std::mpsc::Sender feeds the debouncer (a blocking pool task
        //     forwards into a tokio mpsc so this async loop can await it)
        //   - 750ms debounce coalesces an editor's swap-then-rename
        //     save pattern (vim, vscode) into one upload instead of
        //     several. The previous polling burned a syscall every
        //     1.5s for up to 4800 iterations per open file.
        use notify_debouncer_mini::{new_debouncer, notify::RecursiveMode, DebouncedEventKind};
        let (raw_tx, raw_rx) = std::sync::mpsc::channel();
        let (tok_tx, mut tok_rx) = tokio::sync::mpsc::channel::<()>(8);
        let mut debouncer = match new_debouncer(std::time::Duration::from_millis(750), raw_tx) {
            Ok(d) => d,
            Err(e) => {
                eprintln!("[sftp-live-edit] debouncer init failed: {} — falling back to no autosync", e);
                let _ = std::fs::remove_file(&temp_file_path_clone);
                return;
            }
        };
        if let Err(e) = debouncer.watcher().watch(&temp_file_path_clone, RecursiveMode::NonRecursive) {
            eprintln!("[sftp-live-edit] watch failed: {} — falling back to no autosync", e);
            let _ = std::fs::remove_file(&temp_file_path_clone);
            return;
        }
        // Forward bridge: std::mpsc::recv blocks, so it has to live on the
        // blocking pool.
        tokio::task::spawn_blocking(move || {
            while let Ok(res) = raw_rx.recv() {
                if let Ok(events) = res {
                    if events.iter().any(|ev| matches!(ev.kind, DebouncedEventKind::Any | DebouncedEventKind::AnyContinuous)) {
                        if tok_tx.blocking_send(()).is_err() { break; }
                    }
                }
            }
        });

        // Overall 2-hour ceiling so an editor left open forever doesn't
        // keep the watcher alive past any reasonable session.
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(2 * 60 * 60);
        loop {
            let wait = tokio::time::sleep_until(deadline);
            tokio::select! {
                _ = wait => break,
                maybe = tok_rx.recv() => {
                    if maybe.is_none() { break; }
                    if !temp_file_path_clone.exists() { break; }
                    // Cheap pre-check: if the session is gone we exit the
                    // watcher entirely instead of looping and spamming
                    // "Auto-sync failed" toasts on every subsequent save.
                    {
                        let connections = connections_clone.lock().await;
                        if !connections.contains_key(&session_id_clone) {
                            let _ = app_handle_clone.emit(
                                &format!("sftp-sync-status-{}", session_id_clone),
                                serde_json::json!({
                                    "status": "error",
                                    "message": format!("Auto-sync stopped — session for {} is gone", filename_clone),
                                }),
                            );
                            break;
                        }
                    }
                    let upload_res = async {
                    let session_arc = {
                        let connections = connections_clone.lock().await;
                        connections.get(&session_id_clone).map(|sess| Arc::clone(sess))
                    };

                    let session_arc = match session_arc {
                        Some(sess) => sess,
                        None => return Err("SSH session disconnected".to_string()),
                    };

                    // Open the SFTP subsystem, then IMMEDIATELY drop the
                    // session mutex. Holding it across the whole write serialises
                    // every open_terminal / cold-cache SFTP-bootstrap request on
                    // the same session behind this one save — visible as a UI
                    // freeze whenever the user Ctrl-S's a large remote file.
                    let sftp = {
                        let session = session_arc.lock().await;
                        let channel = session.channel_open_session().await.map_err(|e| e.to_string())?;
                        channel.request_subsystem(true, "sftp").await.map_err(|e| e.to_string())?;
                        let s = russh_sftp::client::SftpSession::new(channel.into_stream()).await.map_err(|e| e.to_string())?;
                        drop(session);
                        s
                    };

                    use russh_sftp::protocol::OpenFlags;
                    use tokio::io::AsyncWriteExt;
                    let content = std::fs::read(&temp_file_path_clone).map_err(|e| format!("Failed to read file: {}", e))?;
                    // Truncate so shortening the file doesn't leave the old
                    // tail behind on the server.
                    let mut remote_file = sftp
                        .open_with_flags(
                            &remote_path_clone,
                            OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::TRUNCATE,
                        )
                        .await
                        .map_err(|e| format!("Failed to open remote file: {}", e))?;
                    remote_file
                        .write_all(&content)
                        .await
                        .map_err(|e| format!("Failed to write to remote: {}", e))?;
                    remote_file
                        .shutdown()
                        .await
                        .map_err(|e| format!("Failed to close remote file: {}", e))?;
                    Ok::<(), String>(())
                    }.await;

                    if let Err(e) = upload_res {
                        let _ = app_handle_clone.emit(
                            &format!("sftp-sync-status-{}", session_id_clone),
                            serde_json::json!({ "status": "error", "message": format!("Auto-sync failed: {}", e) })
                        );
                    } else {
                        let _ = app_handle_clone.emit(
                            &format!("sftp-sync-status-{}", session_id_clone),
                            serde_json::json!({ "status": "success", "message": format!("Auto-synced {}", filename_clone) })
                        );
                    }
                }
            }
        }
        // The watcher exited (timeout, file disappeared, or session gone).
        // Wipe the temp file so the remote contents aren't left lying around
        // in OS temp once editing is done. Errors are intentionally ignored
        // — on Windows the editor may still hold a lock on the file, and the
        // worst case is the file persists until the OS cleans temp.
        drop(debouncer);
        let _ = std::fs::remove_file(&temp_file_path_clone);
    });

    Ok(())
}

#[tauri::command]
pub async fn sftp_prepare_drag(
    state: tauri::State<'_, SshState>,
    session_id: String,
    remote_path: String,
) -> Result<String, String> {
    let sftp = get_sftp_session(&state, &session_id).await?;
    let mut file = sftp.open(&remote_path).await.map_err(|e| e.to_string())?;
    
    // Read remote file data
    let mut data = Vec::new();
    let mut buffer = vec![0u8; 32768];
    loop {
        let n = file.read(&mut buffer).await.map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        data.extend_from_slice(&buffer[..n]);
    }
    
    // Sanitize the filename: a hostile (or compromised) SFTP server picks
    // remote_path, and we used to drop the basename straight into the OS
    // temp dir. safe_temp_leaf_name restricts to a safe leaf (no separators,
    // no `..`, no drive markers) and we scope to a per-session subdir so
    // parallel drags don't clobber each other.
    let raw_name = safe_temp_leaf_name(&remote_path)?;
    let session_dir = session_drag_dir(&session_id);
    std::fs::create_dir_all(&session_dir)
        .map_err(|e| format!("Failed to create drag staging dir: {}", e))?;
    let temp_file_path = session_dir.join(&raw_name);
    std::fs::write(&temp_file_path, &data).map_err(|e| format!("Failed to write temporary file: {}", e))?;

    Ok(temp_file_path.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn local_open_file(local_path: String) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        let _ = local_path;
        return Err("Open-with is not available on Android.".into());
    }
    #[cfg(not(target_os = "android"))]
    {
        let safe = guard_local_path(&local_path, false)?;
        open::that(&safe).map_err(|e| format!("Failed to open local file: {}", e))?;
        Ok(())
    }
}

#[tauri::command]
pub async fn local_open_in_explorer(local_path: String) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        let _ = local_path;
        return Err("Open-in-Explorer is not available on Android.".into());
    }
    #[cfg(not(target_os = "android"))]
    {
        let safe = guard_local_path(&local_path, false)?;
        if safe.is_dir() {
            open::that(&safe).map_err(|e| format!("Failed to open folder: {}", e))?;
        } else if let Some(parent) = safe.parent() {
            open::that(parent).map_err(|e| format!("Failed to open folder: {}", e))?;
        }
        Ok(())
    }
}

#[tauri::command]
pub async fn sftp_read_file_text(
    state: tauri::State<'_, SshState>,
    session_id: String,
    remote_path: String,
    max_bytes: Option<usize>,
) -> Result<String, String> {
    let limit = max_bytes.unwrap_or(2 * 1024 * 1024);

    // 1. Try SFTP with a 3-second timeout
    let sftp_attempt: Result<String, String> = async {
        let sftp = get_sftp_session(&state, &session_id).await?;
        let data = tokio::time::timeout(std::time::Duration::from_secs(3), sftp.read(&remote_path))
            .await
            .map_err(|_| "SFTP read timed out".to_string())?
            .map_err(|e| format!("Failed to read remote file: {}", e))?;
        if data.len() > limit {
            return Err(format!("File is too large ({} bytes, limit is {} bytes)", data.len(), limit));
        }
        String::from_utf8(data).map_err(|_| "File contains binary data and cannot be opened as text.".to_string())
    }.await;

    if let Ok(text) = sftp_attempt {
        return Ok(text);
    }

    // 2. Fallback to SSH command execution (cat / base64)
    let escaped = remote_path.replace('"', "\\\"").replace('$', "\\$").replace('`', "\\`");
    let cmd = format!(
        "FILE=\"{}\"; if [ ! -e \"$FILE\" ] && [ -e \"$HOME/$FILE\" ]; then FILE=\"$HOME/$FILE\"; fi; if [ -e \"$FILE\" ]; then echo \"__SUBTERM_FILE_FOUND__\"; if command -v base64 >/dev/null 2>&1; then echo \"__SUBTERM_B64__\"; base64 -w 0 \"$FILE\" 2>/dev/null; else echo \"__SUBTERM_RAW__\"; cat \"$FILE\" 2>/dev/null; fi; else echo \"__SUBTERM_NOT_FOUND__\"; fi",
        escaped
    );
    let output = exec_ssh_cmd(&state, &session_id, &cmd).await?;
    
    if output.contains("__SUBTERM_NOT_FOUND__") {
        return Err(format!("File '{}' not found on remote server", remote_path));
    }

    if let Some(idx) = output.find("__SUBTERM_B64__") {
        let b64_part = &output[idx + "__SUBTERM_B64__".len()..];
        let cleaned = b64_part.trim().replace("\r", "").replace("\n", "");
        use base64::Engine;
        if let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(cleaned) {
            if bytes.len() > limit {
                return Err(format!("File is too large ({} bytes, limit is {} bytes)", bytes.len(), limit));
            }
            return String::from_utf8(bytes).map_err(|_| "File contains binary data and cannot be opened as text.".to_string());
        }
    }

    if let Some(idx) = output.find("__SUBTERM_RAW__") {
        let raw_part = &output[idx + "__SUBTERM_RAW__".len()..];
        if raw_part.len() > limit {
            return Err(format!("File is too large ({} bytes, limit is {} bytes)", raw_part.len(), limit));
        }
        return Ok(raw_part.to_string());
    }

    // Fallback: If output has content
    if output.contains("__SUBTERM_FILE_FOUND__") {
        return Ok(String::new()); // Legitimately empty file
    }

    Err(format!("Could not read file: {}", remote_path))
}

#[tauri::command]
pub async fn sftp_write_file_text(
    state: tauri::State<'_, SshState>,
    session_id: String,
    remote_path: String,
    content: String,
) -> Result<(), String> {
    // 1. Try SFTP with a 3-second timeout
    let sftp_attempt: Result<(), String> = async {
        use russh_sftp::protocol::OpenFlags;
        use tokio::io::AsyncWriteExt;
        let sftp = get_sftp_session(&state, &session_id).await?;
        tokio::time::timeout(std::time::Duration::from_secs(3), async {
            let mut remote_file = sftp
                .open_with_flags(
                    &remote_path,
                    OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::TRUNCATE,
                )
                .await
                .map_err(|e| format!("Failed to open remote file: {}", e))?;
            remote_file
                .write_all(content.as_bytes())
                .await
                .map_err(|e| format!("Failed to write to remote: {}", e))?;
            remote_file
                .shutdown()
                .await
                .map_err(|e| format!("Failed to flush remote file: {}", e))?;
            Ok::<(), String>(())
        })
        .await
        .map_err(|_| "SFTP write timed out".to_string())?
    }.await;

    if sftp_attempt.is_ok() {
        return Ok(());
    }

    // 2. Fallback to SSH command execution via base64 pipe
    use base64::Engine;
    let b64 = base64::engine::general_purpose::STANDARD.encode(content.as_bytes());
    let escaped = remote_path.replace('"', "\\\"").replace('$', "\\$").replace('`', "\\`");
    let cmd = format!(
        "FILE=\"{}\"; if [ ! -e \"$FILE\" ] && [ -e \"$HOME/$FILE\" ]; then FILE=\"$HOME/$FILE\"; fi; echo \"{}\" | base64 -d > \"$FILE\"",
        escaped, b64
    );
    exec_ssh_cmd(&state, &session_id, &cmd).await.map(|_| ())
}

#[tauri::command]
pub async fn local_read_file_text(
    local_path: String,
    max_bytes: Option<usize>,
) -> Result<String, String> {
    let safe = guard_local_path(&local_path, false)?;
    let limit = max_bytes.unwrap_or(2 * 1024 * 1024);
    let meta = std::fs::metadata(&safe).map_err(|e| e.to_string())?;
    if meta.len() as usize > limit {
        return Err(format!("File is too large ({} bytes, limit is {} bytes)", meta.len(), limit));
    }
    let data = std::fs::read(&safe).map_err(|e| e.to_string())?;
    String::from_utf8(data).map_err(|_| "File contains binary data and cannot be opened as text.".to_string())
}

#[tauri::command]
pub async fn local_write_file_text(
    local_path: String,
    content: String,
) -> Result<(), String> {
    let safe = guard_local_path(&local_path, true)?;
    std::fs::write(&safe, content.as_bytes()).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn sftp_exec_command(
    state: tauri::State<'_, SshState>,
    session_id: String,
    command: String,
) -> Result<String, String> {
    exec_ssh_cmd(&state, &session_id, &command).await
}

#[derive(serde::Serialize)]
pub struct LocalFileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub modified: Option<u64>,
}

#[tauri::command]
pub async fn local_home_dir(app: tauri::AppHandle) -> Result<String, String> {
    #[cfg(target_os = "android")]
    {
        // Android has no "home directory" in the desktop sense — the
        // `directories` crate returns nothing meaningful here. Fall back to
        // whatever the quick-dirs probe picked (Downloads if writable, else
        // app-scoped external storage) so the callers that want *some*
        // starting point still get one instead of an error.
        let dir = android_default_local_dir(app).await?;
        if !dir.is_empty() { return Ok(dir); }
        return Err("Could not resolve home directory".into());
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        directories::UserDirs::new()
            .and_then(|d| d.home_dir().to_str().map(String::from))
            .ok_or_else(|| "Could not resolve home directory".into())
    }
}

#[tauri::command]
pub async fn local_desktop_dir(app: tauri::AppHandle) -> Result<String, String> {
    #[cfg(target_os = "android")]
    {
        // No Desktop concept on Android — reuse the writable-probe default
        // instead of erroring, so `FilePanel.homePath()` lands somewhere
        // useful on first load.
        let dir = android_default_local_dir(app).await?;
        if !dir.is_empty() { return Ok(dir); }
        return Err("Could not resolve default directory".into());
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        // Falls back to the home directory if a Desktop folder isn't configured
        // for the user (rare on desktop OSes but possible on Linux without XDG).
        if let Some(dirs) = directories::UserDirs::new() {
            if let Some(d) = dirs.desktop_dir().and_then(|p| p.to_str()) {
                return Ok(d.to_string());
            }
            if let Some(h) = dirs.home_dir().to_str() {
                return Ok(h.to_string());
            }
        }
        Err("Could not resolve Desktop directory".into())
    }
}

/// Test whether a directory is actually writable by the current process.
/// On Android, scoped storage means many paths appear readable via
/// `Path::exists()` but writes fail with EACCES — so we probe with a real
/// touch + delete. The probe filename is a random UUID-style token so
/// concurrent runs don't collide, and we tolerate `AlreadyExists` because
/// that still proves the parent is writable. Only called from the Android
/// quick-dirs picker today; the `#[allow]` keeps the desktop build quiet.
#[allow(dead_code)]
fn is_dir_writable(p: &std::path::Path) -> bool {
    if !p.is_dir() { return false; }
    let seq = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let probe = p.join(format!(".submarine-probe-{}", seq));
    match std::fs::write(&probe, b"") {
        Ok(_) => {
            let _ = std::fs::remove_file(&probe);
            true
        }
        Err(_) => false,
    }
}

/// Labeled quick-pick entries for the local file picker on Android.
/// Only writable paths are returned — the frontend uses this to populate a
/// small popover instead of the native rfd picker (which doesn't exist on
/// Android). Order is by preference: user-visible storage first (Downloads,
/// Documents), then app-scoped fallbacks that always work under scoped
/// storage. All returned paths are already canonical, so they pass
/// `guard_local_path` without further massaging.
#[derive(serde::Serialize)]
pub struct AndroidQuickDir {
    pub label: String,
    pub path: String,
}

#[tauri::command]
pub async fn android_quick_dirs(app: tauri::AppHandle) -> Result<Vec<AndroidQuickDir>, String> {
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        return Ok(Vec::new());
    }
    #[cfg(target_os = "android")]
    {
        // Build the candidate list up front (label + path pairs), then run
        // the writability probe + dedupe in a plain loop. The earlier
        // closure-based version couldn't coexist with the later
        // `out.is_empty()` re-borrow because the closure held a mutable
        // borrow of `out` for the whole function scope.
        let mut candidates: Vec<(String, std::path::PathBuf)> = vec![
            ("Downloads".into(),  std::path::PathBuf::from("/storage/emulated/0/Download")),
            ("Documents".into(),  std::path::PathBuf::from("/storage/emulated/0/Documents")),
            ("DCIM".into(),       std::path::PathBuf::from("/storage/emulated/0/DCIM")),
            ("Pictures".into(),   std::path::PathBuf::from("/storage/emulated/0/Pictures")),
            ("Movies".into(),     std::path::PathBuf::from("/storage/emulated/0/Movies")),
            ("Music".into(),      std::path::PathBuf::from("/storage/emulated/0/Music")),
            ("SD card".into(),    std::path::PathBuf::from("/storage/emulated/0")),
        ];
        // App-scoped external files dir — always writable, survives reboots,
        // and visible to the user through any file manager under
        // Android/data/com.submarine.app/files. This is the fallback default
        // when everything shared is locked down.
        if let Ok(dir) = app.path().app_local_data_dir() {
            candidates.push(("App storage".into(), dir));
        }
        let mut out: Vec<AndroidQuickDir> = Vec::new();
        let mut seen = std::collections::HashSet::<String>::new();
        for (label, path) in candidates {
            if !is_dir_writable(&path) { continue; }
            let s = path.to_string_lossy().into_owned();
            if seen.insert(s.clone()) {
                out.push(AndroidQuickDir { label, path: s });
            }
        }
        // Internal cache — last-resort, still writable but hidden from the
        // user in most stock file managers. We only add it when nothing else
        // survived the writability probe above.
        if out.is_empty() {
            if let Ok(dir) = app.path().app_cache_dir() {
                if is_dir_writable(&dir) {
                    let s = dir.to_string_lossy().into_owned();
                    out.push(AndroidQuickDir { label: "App cache".into(), path: s });
                }
            }
        }
        Ok(out)
    }
}

/// Preferred default working directory on Android — first writable entry
/// from `android_quick_dirs`. FilePanel calls this on mount so the local
/// pane opens somewhere useful instead of `/` (which lists nothing under
/// scoped storage). Empty string means "leave the current path alone" and
/// is treated as a no-op by the frontend.
#[tauri::command]
pub async fn android_default_local_dir(app: tauri::AppHandle) -> Result<String, String> {
    let dirs = android_quick_dirs(app).await?;
    Ok(dirs.into_iter().next().map(|d| d.path).unwrap_or_default())
}

/// One resolved entry from an OpenSSH client config `Host` block. The
/// frontend picks a subset of these and turns each into a fresh server row
/// via the existing `add_server` command — password/key are left blank so
/// the user configures those after import.
#[derive(serde::Serialize)]
pub struct ImportedHost {
    /// The alias the user actually types (`ssh <alias>`) — becomes the
    /// server's display name after import.
    pub host_alias: String,
    /// Resolved `HostName`, or the alias itself if the block didn't set one
    /// (matches OpenSSH's own behaviour when HostName is omitted).
    pub hostname: String,
    /// Resolved `Port`, defaulting to the standard SSH port.
    pub port: u16,
    /// Resolved `User`. Empty string when unset — the frontend can fall
    /// back to whatever it uses elsewhere.
    pub user: String,
    /// Resolved `IdentityFile`. Purely informational for now — the import
    /// flow doesn't auto-attach keys because we'd need to also read and
    /// register them in the vault, which is a separate feature.
    pub identity_file: Option<String>,
    /// Resolved `ProxyJump`. Informational only; live proxy config still
    /// happens in the Server details panel.
    pub proxy_jump: Option<String>,
}

/// Read the user's OpenSSH client config (default `~/.ssh/config`) and
/// return one `ImportedHost` per non-wildcard alias so the UI can offer a
/// checkbox picker. We deliberately keep the parser dumb: no macro
/// expansion, no `Include` recursion, no token substitution (`%h`/`%u`),
/// no `Match` blocks. Anything we don't understand is skipped silently
/// rather than surfaced as an error — a user's config often has many
/// directives (ForwardAgent, LogLevel, etc.) that are irrelevant to
/// picking a host to import.
///
/// Desktop-only. Android has no meaningful `~/.ssh/config` path and its
/// import story goes through profile export/import instead — we return a
/// clear message rather than pretending to look somewhere.
#[tauri::command]
pub fn parse_ssh_config(path: Option<String>) -> Result<Vec<ImportedHost>, String> {
    #[cfg(target_os = "android")]
    {
        let _ = path;
        Err("Not available on Android — use export/import instead".into())
    }
    #[cfg(not(target_os = "android"))]
    {
        // One in-progress Host block. We accumulate resolved fields as we
        // walk the file and emit one ImportedHost per alias when the block
        // ends (either the next `Host` line or EOF).
        struct Block {
            aliases: Vec<String>,
            hostname: Option<String>,
            port: Option<u16>,
            user: Option<String>,
            identity_file: Option<String>,
            proxy_jump: Option<String>,
        }

        // Split `Directive value...` into (directive, rest). OpenSSH treats
        // `=` and whitespace as equivalent separators between the directive
        // name and its argument, so both `Port 2222` and `Port=2222` parse
        // the same way.
        fn split_directive(line: &str) -> (&str, &str) {
            match line.find(|c: char| c.is_whitespace() || c == '=') {
                Some(i) => {
                    let key = &line[..i];
                    let rest = line[i..]
                        .trim_start_matches(|c: char| c.is_whitespace() || c == '=');
                    (key, rest)
                }
                None => (line, ""),
            }
        }

        // Emit one ImportedHost per non-wildcard alias in the block. Wildcard
        // (`*` / `?`) and negation (`!prefix`) aliases are OpenSSH's template
        // mechanism — they don't correspond to a single server the user
        // would want as a row, so we skip them silently.
        fn flush_block(b: &Block, out: &mut Vec<ImportedHost>) {
            for alias in &b.aliases {
                if alias.contains('*') || alias.contains('?') || alias.starts_with('!') {
                    continue;
                }
                out.push(ImportedHost {
                    host_alias: alias.clone(),
                    hostname: b.hostname.clone().unwrap_or_else(|| alias.clone()),
                    port: b.port.unwrap_or(22),
                    user: b.user.clone().unwrap_or_default(),
                    identity_file: b.identity_file.clone(),
                    proxy_jump: b.proxy_jump.clone(),
                });
            }
        }

        let config_path: PathBuf = match path {
            Some(p) if !p.trim().is_empty() => PathBuf::from(p),
            _ => directories::UserDirs::new()
                .map(|u| u.home_dir().join(".ssh").join("config"))
                .ok_or_else(|| "Could not resolve home directory".to_string())?,
        };

        if !config_path.exists() {
            return Err(format!(
                "SSH config file not found at {}",
                config_path.display()
            ));
        }

        let contents = fs::read_to_string(&config_path).map_err(|e| {
            format!("Failed to read {}: {}", config_path.display(), e)
        })?;

        let mut out: Vec<ImportedHost> = Vec::new();
        let mut cur: Option<Block> = None;

        for raw_line in contents.lines() {
            let line = raw_line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            let (key, rest) = split_directive(line);
            let key_lc = key.to_ascii_lowercase();
            match key_lc.as_str() {
                "host" => {
                    // Close out the previous block before starting a new one.
                    if let Some(prev) = cur.take() {
                        flush_block(&prev, &mut out);
                    }
                    let mut b = Block {
                        aliases: Vec::new(),
                        hostname: None,
                        port: None,
                        user: None,
                        identity_file: None,
                        proxy_jump: None,
                    };
                    for a in rest.split_whitespace() {
                        b.aliases.push(a.trim_matches('"').to_string());
                    }
                    cur = Some(b);
                }
                "hostname" | "port" | "user" | "identityfile" | "proxyjump" => {
                    if let Some(b) = cur.as_mut() {
                        let val = rest.trim().trim_matches('"');
                        if val.is_empty() {
                            continue;
                        }
                        match key_lc.as_str() {
                            "hostname" => b.hostname = Some(val.to_string()),
                            "port" => {
                                if let Ok(p) = val.parse::<u16>() {
                                    b.port = Some(p);
                                }
                            }
                            "user" => b.user = Some(val.to_string()),
                            "identityfile" => b.identity_file = Some(val.to_string()),
                            "proxyjump" => b.proxy_jump = Some(val.to_string()),
                            _ => {}
                        }
                    }
                }
                // Include chains, Match blocks, and every other directive
                // are v1-out-of-scope. Ignoring them keeps the parser
                // predictable for the "flat list of hosts" use case.
                _ => {}
            }
        }
        if let Some(last) = cur.take() {
            flush_block(&last, &mut out);
        }

        Ok(out)
    }
}

/// Parse a blob of text pasted from another SSH client's export and return
/// the same `ImportedHost` shape as `parse_ssh_config`. Auto-detects the
/// format so the frontend only needs one "Paste your export" text area
/// instead of a picker-per-format:
///
///   • Windows Regedit `.reg` export of PuTTY sessions
///     (`HKEY_CURRENT_USER\Software\SimonTatham\PuTTY\Sessions\...`) —
///     detected by the file's `Windows Registry Editor` header. Each
///     `[HKEY_...\Sessions\<name>]` block becomes one host; HostName,
///     PortNumber, and UserName are decoded from the `"key"=dword:` /
///     `"key"="value"` entries. Percent-decoded so aliases with spaces
///     ("My Prod Box") round-trip.
///
///   • JSON array — either
///     `[{"name":"foo","host":"1.2.3.4","port":22,"user":"root"}, …]`
///     or the Termius-style
///     `[{"label":"foo","address":"1.2.3.4","port":22,"username":"root"}, …]`.
///     Any missing field defaults to the OpenSSH convention.
///
///   • MobaXterm `.mxtsessions` INI (partial) — sessions live under
///     `[Bookmarks_<n>]` with `SessionName=…` and comma-separated fields
///     `HostName,Port,UserName,…`. Best-effort — MobaXterm's schema has
///     drifted across releases so we only trust the first four fields.
///
/// Anything the parser can't recognise is a soft-fail: the returned
/// `Vec` is what we DID find, the message describes what got skipped.
/// The command is desktop+Android — no filesystem access, just text.
#[tauri::command]
pub fn parse_client_import(text: String) -> Result<Vec<ImportedHost>, String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Err("Paste an exported session block first.".into());
    }

    // ── JSON array — the most permissive path, so try it first. Two
    //    supported field-name variants (see doc comment). We accept a
    //    generic `serde_json::Value` array rather than a strict struct
    //    so a stray extra field doesn't kill the whole import.
    if trimmed.starts_with('[') {
        let arr: Vec<serde_json::Value> = serde_json::from_str(trimmed)
            .map_err(|e| format!("JSON parse failed: {}", e))?;
        let mut out = Vec::with_capacity(arr.len());
        for (i, v) in arr.iter().enumerate() {
            let obj = v.as_object().ok_or_else(|| {
                format!("Entry #{} is not an object", i + 1)
            })?;
            let get_str = |keys: &[&str]| -> Option<String> {
                for k in keys {
                    if let Some(s) = obj.get(*k).and_then(|x| x.as_str()) {
                        if !s.is_empty() { return Some(s.to_string()); }
                    }
                }
                None
            };
            let get_u16 = |keys: &[&str]| -> Option<u16> {
                for k in keys {
                    if let Some(n) = obj.get(*k).and_then(|x| x.as_u64()) {
                        return u16::try_from(n).ok();
                    }
                    if let Some(s) = obj.get(*k).and_then(|x| x.as_str()) {
                        if let Ok(p) = s.parse::<u16>() { return Some(p); }
                    }
                }
                None
            };
            let alias = get_str(&["name", "label", "title", "alias", "host_alias"])
                .or_else(|| get_str(&["host", "hostname", "address"]))
                .unwrap_or_else(|| format!("imported-{}", i + 1));
            let hostname = get_str(&["host", "hostname", "address"]).unwrap_or_else(|| alias.clone());
            let port = get_u16(&["port"]).unwrap_or(22);
            let user = get_str(&["user", "username"]).unwrap_or_default();
            let identity_file = get_str(&["identity_file", "identityFile", "key", "privateKey"]);
            let proxy_jump = get_str(&["proxy_jump", "proxyJump", "jump"]);
            out.push(ImportedHost {
                host_alias: alias,
                hostname,
                port,
                user,
                identity_file,
                proxy_jump,
            });
        }
        if out.is_empty() {
            return Err("JSON array was valid but contained no entries.".into());
        }
        return Ok(out);
    }

    // ── PuTTY .reg export
    if trimmed.to_ascii_lowercase().contains("windows registry editor")
        || trimmed.contains("[HKEY_CURRENT_USER\\Software\\SimonTatham\\PuTTY\\Sessions")
        || trimmed.contains("[HKEY_USERS\\") && trimmed.contains("SimonTatham\\PuTTY\\Sessions")
    {
        return parse_putty_reg(trimmed);
    }

    // ── MobaXterm .mxtsessions
    if trimmed.contains("[Bookmarks") || trimmed.contains(";SessionName") {
        return parse_mobaxterm_sessions(trimmed);
    }

    Err("Unrecognised format — paste a JSON array, a PuTTY .reg export, or a MobaXterm .mxtsessions block.".into())
}

/// Parse `regedit /e` output of PuTTY's session key. The format is
/// deterministic (one `[...]` header line per session, then `"key"=type:val`
/// lines) so a line-oriented walk covers it. We only pull the three fields
/// that translate to a Submarine row: HostName, PortNumber, UserName.
/// Session-name percent-escapes (%20 for space, etc.) are undone so the
/// alias reads naturally.
fn parse_putty_reg(text: &str) -> Result<Vec<ImportedHost>, String> {
    let mut out: Vec<ImportedHost> = Vec::new();
    let mut current: Option<(String, String, u16, String)> = None; // (alias, host, port, user)
    let close = |cur: &mut Option<(String, String, u16, String)>, out: &mut Vec<ImportedHost>| {
        if let Some((alias, host, port, user)) = cur.take() {
            if !host.is_empty() || !alias.is_empty() {
                out.push(ImportedHost {
                    host_alias: alias.clone(),
                    hostname: if host.is_empty() { alias } else { host },
                    port: if port == 0 { 22 } else { port },
                    user,
                    identity_file: None,
                    proxy_jump: None,
                });
            }
        }
    };
    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() { continue; }
        if line.starts_with('[') && line.ends_with(']') {
            close(&mut current, &mut out);
            // Only sessions — skip other PuTTY keys (SshHostKeys, Jumplist).
            let inner = &line[1..line.len() - 1];
            let Some(idx) = inner.rfind("\\Sessions\\") else { continue; };
            let name_raw = &inner[idx + "\\Sessions\\".len()..];
            let name = putty_unescape(name_raw);
            if name.is_empty() { continue; }
            current = Some((name, String::new(), 0, String::new()));
            continue;
        }
        let Some((key, val_raw)) = line.split_once('=') else { continue; };
        let Some(cur) = current.as_mut() else { continue; };
        let key = key.trim().trim_matches('"');
        let val = val_raw.trim();
        match key {
            "HostName" => {
                if let Some(v) = strip_reg_string(val) { cur.1 = v; }
            }
            "PortNumber" => {
                if let Some(n) = strip_reg_dword(val) {
                    if let Ok(p) = u16::try_from(n) { cur.2 = p; }
                }
            }
            "UserName" => {
                if let Some(v) = strip_reg_string(val) { cur.3 = v; }
            }
            _ => {}
        }
    }
    close(&mut current, &mut out);
    if out.is_empty() {
        return Err("No PuTTY sessions found in the pasted text.".into());
    }
    Ok(out)
}

/// PuTTY registry keys with special characters (space, backslash, non-
/// ASCII) are percent-escaped in the exported name. `%20` → space,
/// `%25` → `%`. Anything else is passed through as-is. Not a full URL
/// decoder — PuTTY's escape table is narrower.
fn putty_unescape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        // Only treat `%HH` as an escape when both following bytes are ASCII
        // hex digits. The is_ascii_hexdigit guard also keeps the `&s[..]`
        // slice on char boundaries — without it, a `%` before a multi-byte
        // UTF-8 char (e.g. `%€`) would slice mid-codepoint and panic.
        if bytes[i] == b'%'
            && i + 2 < bytes.len()
            && bytes[i + 1].is_ascii_hexdigit()
            && bytes[i + 2].is_ascii_hexdigit()
        {
            let hex = &s[i + 1..i + 3];
            if let Ok(n) = u8::from_str_radix(hex, 16) {
                out.push(n as char);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i] as char);
        i += 1;
    }
    out
}

/// `.reg` string entries look like `"HostName"="1.2.3.4"`. Strip the
/// surrounding quotes and unescape the two sequences .reg uses (`\\` and
/// `\"`). Returns None if the value isn't a quoted string.
fn strip_reg_string(val: &str) -> Option<String> {
    let s = val.trim();
    if !s.starts_with('"') || !s.ends_with('"') || s.len() < 2 { return None; }
    let inner = &s[1..s.len() - 1];
    let mut out = String::with_capacity(inner.len());
    let mut chars = inner.chars();
    while let Some(c) = chars.next() {
        if c == '\\' {
            if let Some(next) = chars.next() { out.push(next); }
        } else {
            out.push(c);
        }
    }
    Some(out)
}

/// `.reg` DWORD entries look like `"PortNumber"=dword:00000016`. The
/// `dword:` prefix is followed by exactly 8 hex chars. Anything else
/// (missing prefix, non-hex, wrong length) returns None so the caller
/// can leave the field at its default rather than propagating an error.
fn strip_reg_dword(val: &str) -> Option<u32> {
    let s = val.trim();
    let stripped = s.strip_prefix("dword:")?;
    u32::from_str_radix(stripped, 16).ok()
}

/// Parse a MobaXterm `.mxtsessions` INI-ish blob. MobaXterm stores each
/// session as one line under a `[Bookmarks_N]` group, formatted roughly
/// `<Title>=#109#0%<hostname>%<port>%<username>%…` with a variable trail
/// of feature flags. We only decode the first three fields — anything
/// past that is version-specific and not worth the complexity for an
/// import flow that leaves password/key blank anyway.
fn parse_mobaxterm_sessions(text: &str) -> Result<Vec<ImportedHost>, String> {
    let mut out: Vec<ImportedHost> = Vec::new();
    let mut in_bookmarks = false;
    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with(';') { continue; }
        if line.starts_with('[') {
            in_bookmarks = line.starts_with("[Bookmarks");
            continue;
        }
        if !in_bookmarks { continue; }
        let Some((title, val)) = line.split_once('=') else { continue; };
        // MobaXterm SSH sessions start with `#109#`. Non-SSH bookmark
        // types (telnet, RDP, sftp-only) use different numbers — we
        // don't want to blindly import those as SSH rows.
        if !val.starts_with("#109#") { continue; }
        // Skip the `#109#<N>%` framing and split the payload on `%`.
        let payload = val.split_once('%').map(|(_, rest)| rest).unwrap_or(val);
        let parts: Vec<&str> = payload.split('%').collect();
        if parts.len() < 3 { continue; }
        let hostname = parts[0].trim();
        let port = parts[1].trim().parse::<u16>().unwrap_or(22);
        let user = parts[2].trim().to_string();
        if hostname.is_empty() { continue; }
        out.push(ImportedHost {
            host_alias: title.trim().to_string(),
            hostname: hostname.to_string(),
            port,
            user,
            identity_file: None,
            proxy_jump: None,
        });
    }
    if out.is_empty() {
        return Err("No MobaXterm sessions found in the pasted text.".into());
    }
    Ok(out)
}

/// Defense-in-depth guard for the local-FS commands the frontend can invoke.
/// We can't lock everything down to a sandbox (the local file browser
/// legitimately needs to roam the user's disk to pick uploads), but we CAN
/// refuse the obviously destructive cases: the filesystem root, OS system
/// directories, and unresolvable paths. If the renderer is ever compromised
/// (XSS via terminal output, a future feature, etc.) this stops
/// `local_remove("C:\\")` cold.
/// True when a single SFTP directory-entry name is a plain, safe filename —
/// i.e. one that can be joined onto a local root without escaping it.
///
/// `read_dir` entry names come straight off the SFTP wire, so a malicious or
/// compromised server can return a name that contains path separators or `..`
/// (e.g. `../../../.config/autostart/x.desktop`, or `..\..\Startup\x.bat`).
/// Joining such a name onto the download root resolves OUTSIDE it — a zip-slip
/// arbitrary-write primitive. A genuine filesystem entry name is always a
/// single component: it never contains `/` (the POSIX/SFTP separator), `\` (a
/// separator once the rel path is split for a Windows client), or a NUL, and is
/// never `.`/`..`. Rejecting anything else costs nothing on a well-behaved
/// server and stops the traversal at the point the untrusted name first enters
/// our local-path building. Callers skip (or abort on) a rejected entry.
pub fn is_safe_dir_entry_name(name: &str) -> bool {
    !name.is_empty()
        && name != "."
        && name != ".."
        && !name.contains('/')
        && !name.contains('\\')
        && !name.contains('\0')
}

fn guard_local_path(path: &str, allow_nonexistent: bool) -> Result<std::path::PathBuf, String> {
    let p = std::path::Path::new(path);
    let canonical = match p.canonicalize() {
        Ok(c) => c,
        Err(e) => {
            if allow_nonexistent {
                let parent = p.parent()
                    .ok_or_else(|| format!("Invalid path: {}", path))?;
                let canon_parent = parent.canonicalize()
                    .map_err(|e| format!("Invalid parent directory: {}", e))?;
                let file = p.file_name()
                    .ok_or_else(|| format!("Invalid path: {}", path))?;
                canon_parent.join(file)
            } else {
                return Err(format!("Invalid path: {}", e));
            }
        }
    };

    // Refuse the filesystem root itself (`/`, `C:\`, etc.).
    if canonical.parent().is_none() {
        return Err(format!("Refusing to operate on filesystem root: {}", canonical.display()));
    }

    let mut canon_norm = canonical.to_string_lossy().to_lowercase().replace('\\', "/");
    // On Windows, std::fs::canonicalize returns a `\\?\`-prefixed *verbatim*
    // path, e.g. `\\?\C:\Windows\System32`. After the `\` -> `/` normalization
    // above that becomes `//?/c:/windows/system32`, which never matches the
    // blocklist entries `c:/windows`, `c:/program files`, etc. — silently
    // defeating this guard for every Windows system directory. Strip the
    // verbatim prefix (and its `\\?\UNC\` variant for UNC paths) so the
    // subsequent prefix match sees a normal drive-letter path. Also strip the
    // NT-device `\\.\` prefix on the off chance a caller hands us one.
    if let Some(rest) = canon_norm.strip_prefix("//?/unc/") {
        canon_norm = format!("//{}", rest);
    } else if let Some(rest) = canon_norm.strip_prefix("//?/") {
        canon_norm = rest.to_string();
    } else if let Some(rest) = canon_norm.strip_prefix("//./") {
        canon_norm = rest.to_string();
    }
    // Trim trailing slash for clean prefix matches.
    let canon_norm = canon_norm.trim_end_matches('/').to_string();

    let blocked: &[&str] = if cfg!(windows) {
        &[
            "c:/windows", "c:/program files", "c:/program files (x86)",
            "c:/programdata", "c:/system volume information", "c:/$recycle.bin",
        ]
    } else {
        &[
            "/etc", "/usr", "/bin", "/sbin", "/lib", "/lib64", "/boot",
            "/sys", "/proc", "/dev", "/var/log", "/var/run", "/root",
        ]
    };
    for prefix in blocked {
        let pfx = prefix.to_lowercase();
        if canon_norm == pfx || canon_norm.starts_with(&format!("{}/", pfx)) {
            return Err(format!("Refusing operation on system path: {}", canonical.display()));
        }
    }

    // Auto-run / login-persistence locations. Unlike the fixed system-dir
    // prefixes above, these sit inside the per-user profile
    // (C:\Users\<name>\AppData\..., ~/Library/..., ~/.config/...) so no static
    // prefix catches them — match on a path tail instead. Blocking them stops
    // a download destination (or any local op) from dropping an executable
    // into a folder the OS auto-runs at next login. The markers are
    // platform-specific strings that simply never match on the wrong OS, so a
    // single unconditional loop is fine.
    const PERSIST_MARKERS: &[&str] = &[
        "/start menu/programs/startup",        // Windows Startup (per-user & all-users)
        "/appdata/roaming/microsoft/windows",  // Windows autorun / machine-managed
        "/appdata/local/microsoft/windows",
        "/library/launchagents",               // macOS per-user launch agents
        "/library/launchdaemons",              // macOS launch daemons
        "/.config/autostart",                  // Linux XDG autostart
    ];
    for marker in PERSIST_MARKERS {
        if canon_norm.contains(marker) {
            return Err(format!("Refusing operation on auto-run / persistence path: {}", canonical.display()));
        }
    }

    Ok(canonical)
}

#[tauri::command]
pub async fn local_create_dir(path: String) -> Result<(), String> {
    let safe = guard_local_path(&path, true)?;
    std::fs::create_dir_all(&safe).map_err(|e| format!("Failed to create directory: {}", e))
}

#[tauri::command]
pub async fn local_remove(path: String, is_dir: bool) -> Result<(), String> {
    let safe = guard_local_path(&path, false)?;
    if is_dir {
        std::fs::remove_dir_all(&safe).map_err(|e| format!("Failed to remove directory: {}", e))
    } else {
        std::fs::remove_file(&safe).map_err(|e| format!("Failed to remove file: {}", e))
    }
}

#[tauri::command]
pub async fn local_rename(from: String, to: String) -> Result<(), String> {
    let safe_from = guard_local_path(&from, false)?;
    let safe_to = guard_local_path(&to, true)?;
    // Same auto-mkdir-parent UX as sftp_rename: moving a file into a
    // subfolder that doesn't exist yet would otherwise fail with a
    // confusing "system cannot find the path specified" / ENOENT.
    if let Some(parent) = safe_to.parent() {
        if !parent.as_os_str().is_empty() && !parent.exists() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("create destination parent {:?}: {}", parent, e))?;
        }
    }
    std::fs::rename(&safe_from, &safe_to)
        .map_err(|e| format!("rename {:?} -> {:?}: {}", safe_from, safe_to, e))
}

fn copy_dir_all(src: &std::path::Path, dst: &std::path::Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let ty = entry.file_type()?;
        if ty.is_dir() {
            copy_dir_all(&entry.path(), &dst.join(entry.file_name()))?;
        } else {
            std::fs::copy(entry.path(), dst.join(entry.file_name()))?;
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn local_copy_entry(src: String, dest: String, is_dir: bool) -> Result<(), String> {
    let safe_src = guard_local_path(&src, false)?;
    let safe_dest = guard_local_path(&dest, true)?;
    if is_dir {
        copy_dir_all(&safe_src, &safe_dest)
            .map_err(|e| format!("copy dir {:?} -> {:?}: {}", safe_src, safe_dest, e))
    } else {
        if let Some(parent) = safe_dest.parent() {
            if !parent.as_os_str().is_empty() && !parent.exists() {
                let _ = std::fs::create_dir_all(parent);
            }
        }
        std::fs::copy(&safe_src, &safe_dest)
            .map(|_| ())
            .map_err(|e| format!("copy file {:?} -> {:?}: {}", safe_src, safe_dest, e))
    }
}

#[tauri::command]
pub async fn select_local_folder() -> Result<Option<String>, String> {
    #[cfg(target_os = "android")]
    {
        return Err("Folder picker not available on Android.".into());
    }
    #[cfg(not(target_os = "android"))]
    {
        let folder = rfd::FileDialog::new()
            .set_title("Choose Local Directory")
            .pick_folder();
        Ok(folder.map(|p| p.to_string_lossy().to_string()))
    }
}

#[tauri::command]
pub async fn local_list_dir(path: String) -> Result<Vec<LocalFileEntry>, String> {
    let safe = guard_local_path(&path, false)?;
    if !safe.is_dir() {
        return Err("Path is not a directory".into());
    }

    let mut entries = Vec::new();
    let read_dir = std::fs::read_dir(&safe).map_err(|e| format!("Failed to read directory: {}", e))?;

    for entry in read_dir {
        if let Ok(entry) = entry {
            let metadata = entry.metadata().ok();
            let is_dir = metadata.as_ref().map(|m| m.is_dir()).unwrap_or(false);
            let size = metadata.as_ref().map(|m| m.len()).unwrap_or(0);
            let name = entry.file_name().to_string_lossy().to_string();
            let full_path = entry.path().to_string_lossy().to_string();
            
            let modified = metadata.as_ref()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(std::time::SystemTime::UNIX_EPOCH).ok())
                .map(|d| d.as_secs());

            entries.push(LocalFileEntry {
                name,
                path: full_path,
                is_dir,
                size,
                modified,
            });
        }
    }

    // Sort: directories first, then alphabetically
    entries.sort_by(|a, b| {
        if a.is_dir != b.is_dir {
            b.is_dir.cmp(&a.is_dir)
        } else {
            a.name.to_lowercase().cmp(&b.name.to_lowercase())
        }
    });

    Ok(entries)
}
