use std::collections::HashMap;
use std::sync::Arc;
use tauri::Emitter;
use crate::ssh_manager::{ClientHandler, SshState};
use crate::tunnel::{self, ActiveTunnel, ForwardedTargets, TunnelSpec, TunnelStatus};
use crate::{save_vault_internal, DbState};

/// Resolve the SSH transport a session's tunnels should ride: the dedicated
/// `::fwd` connection when the per-tab toggle has one up, else the primary.
/// The forwarded-targets map MUST belong to the same connection as the handle
/// — for R tunnels the server pushes `forwarded-tcpip` channels back on the
/// connection that sent `tcpip_forward`, and its ClientHandler consults only
/// its own map (ssh_manager.rs::server_channel_open_forwarded_tcpip).
pub async fn resolve_tunnel_transport(
    state: &SshState,
    session_id: &str,
) -> Result<
    (
        Arc<tokio::sync::Mutex<russh::client::Handle<ClientHandler>>>,
        ForwardedTargets,
    ),
    String,
> {
    let fwd_key = format!("{}::fwd", session_id);
    let (primary, dedicated) = {
        let conns = state.connections.lock().await;
        (
            conns.get(session_id).cloned(),
            if session_id.contains("::") {
                None
            } else {
                conns.get(&fwd_key).cloned()
            },
        )
    };
    let targets_map = state.forwarded_targets.lock().await;
    if let Some(h) = dedicated {
        // The `::fwd` entry's forwarded-targets map is created by its own
        // initiate_connection; if it's somehow missing, fall through to the
        // primary rather than starting an R tunnel whose inbound channels
        // would never resolve.
        if let Some(t) = targets_map.get(&fwd_key) {
            return Ok((h, Arc::clone(t)));
        }
    }
    let h = primary.ok_or_else(|| "Session not connected".to_string())?;
    let t = targets_map
        .get(session_id)
        .cloned()
        .ok_or_else(|| "Session forwarded-targets map missing — reconnect first".to_string())?;
    Ok((h, t))
}

/// Start every spec in `specs` that isn't already running under `sid`'s tag,
/// on the given transport. Successes are recorded into the session's replay
/// list; failures are logged to the session log and the poison spec is
/// stripped from the replay list so auto-retry cycles don't error-loop on it.
/// Used by the `::fwd` migration (connect success), the fallback/restore
/// command, and shares its semantics with the primary's auto-start.
pub async fn start_tunnel_specs_on(
    app: &tauri::AppHandle,
    sid: &str,
    handle: &Arc<tokio::sync::Mutex<russh::client::Handle<ClientHandler>>>,
    targets: &ForwardedTargets,
    tunnels: &Arc<tokio::sync::Mutex<HashMap<String, ActiveTunnel>>>,
    specs_map: &Arc<tokio::sync::Mutex<HashMap<String, Vec<TunnelSpec>>>>,
    specs: Vec<TunnelSpec>,
) {
    let emit_log = |msg: &str, log_type: &str| {
        let _ = app.emit(
            &format!("session-log-{}", sid),
            serde_json::json!({ "msg": msg, "type": log_type }),
        );
    };
    // Snapshot running specs for this tag. Two-phase (ids under the map lock,
    // status after releasing it) to respect the same lock-ordering rule as
    // tunnel::stop_all_for_session.
    let candidates: Vec<(TunnelSpec, Arc<tokio::sync::Mutex<TunnelStatus>>)> = {
        let map = tunnels.lock().await;
        map.values().map(|t| (t.spec.clone(), Arc::clone(&t.status))).collect()
    };
    let mut running: Vec<TunnelSpec> = Vec::new();
    for (spec, status) in candidates {
        if status.lock().await.session_id == sid {
            running.push(spec);
        }
    }
    for spec in specs {
        if running.contains(&spec) {
            continue;
        }
        match tunnel::start_tunnel(
            app.clone(),
            sid.to_string(),
            Arc::clone(handle),
            Arc::clone(tunnels),
            Arc::clone(targets),
            spec.clone(),
        )
        .await
        {
            Ok(id) => {
                emit_log(&format!("Tunnel started [{}]: {} {}", id, spec.kind, spec.local), "info");
                let mut map = specs_map.lock().await;
                let entry = map.entry(sid.to_string()).or_insert_with(Vec::new);
                if !entry.contains(&spec) {
                    entry.push(spec);
                }
            }
            Err(e) => {
                // KEEP the spec so the next reconnect retries it — never strip a
                // user's tunnel on a transient restore failure (see the matching
                // inline-restore comment; the old strip caused permanent loss of
                // forwards on flaky networks). Ensure it's present in the replay
                // list so a spec seeded from the DB (not yet recorded) survives.
                emit_log(
                    &format!(
                        "Tunnel start failed ({} {}): {} — will retry on next reconnect",
                        spec.kind, spec.local, e
                    ),
                    "error",
                );
                let mut map = specs_map.lock().await;
                let entry = map.entry(sid.to_string()).or_insert_with(Vec::new);
                if !entry.contains(&spec) {
                    entry.push(spec);
                }
            }
        }
    }
}

#[tauri::command]
pub async fn start_tunnel(
    app: tauri::AppHandle,
    state: tauri::State<'_, SshState>,
    session_id: String,
    spec: TunnelSpec,
) -> Result<String, String> {
    // Dedicated-transport aware: rides the `::fwd` connection when one is up,
    // the primary otherwise. The tunnel is TAGGED under the plain session id
    // either way, so the Tunnels panel / list / teardown never re-key.
    let (handle, forwarded) = resolve_tunnel_transport(state.inner(), &session_id).await?;
    let id = tunnel::start_tunnel(
        app,
        session_id.clone(),
        handle,
        Arc::clone(&state.tunnels),
        forwarded,
        spec.clone(),
    )
    .await?;
    // Record this ad-hoc spec against the session so a future reconnect can
    // re-open it. Dedup against (kind, local, remote) so toggling the same
    // tunnel off-and-on doesn't accumulate duplicates.
    {
        let mut map = state.session_tunnel_specs.lock().await;
        let entry = map.entry(session_id).or_insert_with(Vec::new);
        if !entry.contains(&spec) {
            entry.push(spec);
        }
    }
    Ok(id)
}

#[tauri::command]
pub async fn stop_tunnel(
    state: tauri::State<'_, SshState>,
    tunnel_id: String,
) -> Result<(), String> {
    // Snapshot spec + session BEFORE stop — the listener task removes itself
    // from the tunnels map on exit, racing this lookup. With the snapshot in
    // hand we can drop the matching entry from the session's replay list so
    // a user who explicitly stopped a tunnel doesn't see it return on the
    // next reconnect.
    let snapshot = {
        let map = state.tunnels.lock().await;
        match map.get(&tunnel_id) {
            Some(t) => {
                let status = t.status.lock().await;
                Some((t.spec.clone(), status.session_id.clone()))
            }
            None => None,
        }
    };
    tunnel::stop_tunnel(&state.tunnels, &tunnel_id).await?;
    if let Some((spec, sid)) = snapshot {
        let mut map = state.session_tunnel_specs.lock().await;
        if let Some(list) = map.get_mut(&sid) {
            list.retain(|s| s != &spec);
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn list_tunnels(
    state: tauri::State<'_, SshState>,
    session_id: Option<String>,
) -> Result<Vec<TunnelStatus>, String> {
    Ok(tunnel::list_tunnels(&state.tunnels, session_id.as_deref()).await)
}

/// Persist the session's current live tunnel set to the node's saved `tunnels`
/// column so ad-hoc port-forwards a user adds (or removes) during a session
/// survive to the next time the node is opened. The Tunnels panel calls this
/// after a successful start/stop. A quick-connect session (server_id <= 0) has
/// no node to save to, so it's a no-op.
#[tauri::command]
pub async fn persist_session_tunnels(
    state: tauri::State<'_, SshState>,
    db_state: tauri::State<'_, DbState>,
    session_id: String,
    server_id: i32,
) -> Result<(), String> {
    if server_id <= 0 {
        return Ok(());
    }
    let specs = state
        .session_tunnel_specs
        .lock()
        .await
        .get(&session_id)
        .cloned()
        .unwrap_or_default();
    let json = serde_json::to_string(&specs).unwrap_or_else(|_| "[]".to_string());
    {
        // Scoped so the non-Send rusqlite guard drops before save_vault_internal.
        let conn_guard = db_state.conn.lock().map_err(|_| "[STATE] LOCK_FAILED")?;
        let conn = conn_guard.as_ref().ok_or("[STATE] DATABASE_NOT_INITIALIZED")?;
        conn.execute(
            "UPDATE servers SET tunnels=?1 WHERE id=?2",
            rusqlite::params![json, server_id],
        )
        .map_err(|e| format!("[DATABASE] TUNNELS_SAVE_FAILED: SQL_ERROR={}", e))?;
    }
    save_vault_internal(&db_state)?;
    Ok(())
}

/// (Re)start every tunnel the session should have — the in-memory replay list
/// when it's non-empty, else the node's saved tunnels JSON — on the best
/// available transport (`::fwd` when the dedicated connection is up, primary
/// otherwise). Idempotent: specs already running under the session's tag are
/// skipped. The frontend calls this to restore forwarding after the dedicated
/// connection fails or is toggled off, so tunnels always land somewhere.
#[tauri::command]
pub async fn restart_session_tunnels(
    app: tauri::AppHandle,
    state: tauri::State<'_, SshState>,
    db_state: tauri::State<'_, DbState>,
    session_id: String,
    server_id: i32,
) -> Result<(), String> {
    // In-memory replay list first — it carries ad-hoc tunnels too. A PRESENT
    // list (even empty) is authoritative (user stopped everything); only seed
    // from the node's saved tunnels when the key is ABSENT (first engagement),
    // so explicitly-stopped tunnels don't resurrect on a restore.
    let existing: Option<Vec<TunnelSpec>> =
        state.session_tunnel_specs.lock().await.get(&session_id).cloned();
    let mut specs: Vec<TunnelSpec> = existing.clone().unwrap_or_default();
    if existing.is_none() && server_id > 0 {
        // Nested block so the non-Send rusqlite guard drops before any await.
        let tunnels_json: String = {
            let conn_guard = db_state.conn.lock().map_err(|_| "[STATE] LOCK_FAILED")?;
            let conn = conn_guard.as_ref().ok_or("[STATE] DATABASE_NOT_INITIALIZED")?;
            let mut stmt = conn
                .prepare("SELECT tunnels FROM servers WHERE id=?1")
                .map_err(|e| e.to_string())?;
            let mut rows = stmt.query([server_id]).map_err(|e| e.to_string())?;
            match rows.next().map_err(|e| e.to_string())? {
                Some(row) => row
                    .get::<_, Option<String>>(0)
                    .unwrap_or_default()
                    .unwrap_or_else(|| "[]".to_string()),
                None => "[]".to_string(),
            }
        };
        specs = serde_json::from_str(&tunnels_json).unwrap_or_default();
        if !specs.is_empty() {
            state
                .session_tunnel_specs
                .lock()
                .await
                .insert(session_id.clone(), specs.clone());
        }
    }
    if specs.is_empty() {
        return Ok(());
    }

    let (handle, targets) = resolve_tunnel_transport(state.inner(), &session_id).await?;
    start_tunnel_specs_on(
        &app,
        &session_id,
        &handle,
        &targets,
        &state.tunnels,
        &state.session_tunnel_specs,
        specs,
    )
    .await;
    Ok(())
}
