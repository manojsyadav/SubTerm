// Monitor config bridging: resolves per-node auth bundles and enabled/custom
// metric lists out of SQLite, and exposes the Tauri commands the Monitoring
// panel calls to list/add/remove/pause/resume pollers. The actual polling
// loop and live state (`MonitorMap`) live in the top-level `monitor` module;
// this is the DB <-> poller glue.

use crate::monitor::{self, MonitorMap, SharedSettings};
use crate::vault::save_vault_internal;
use crate::DbState;

/// Pulls the auth bundle needed to open a monitor session for a node. Returns
/// the resolved (username, password, key_pem, passphrase) following the same
/// "vault vs custom_*" rule the interactive connect path uses — so monitor
/// auth never silently diverges from what the user sees in the form.
fn resolve_node_auth_for_monitor(
    conn: &rusqlite::Connection,
    node_id: i32,
) -> Result<monitor::NodeAuth, String> {
    let mut stmt = conn.prepare("
        SELECT s.host, s.port,
               s.username, c.username,
               s.password, c.password,
               s.key_id,   c.key_id,
               s.auth_type, c.auth_type as cred_auth_type,
               s.proxy_type, s.proxy_host, s.proxy_port
        FROM servers s
        LEFT JOIN credentials c ON s.credential_id = c.id
        WHERE s.id = ?1
    ").map_err(|e| e.to_string())?;
    let mut rows = stmt.query([node_id]).map_err(|e| e.to_string())?;
    let row = rows.next().map_err(|e| e.to_string())?.ok_or("node not found")?;

    let host: String = row.get::<_, String>(0).map_err(|e| e.to_string())?;
    let port: i32 = row.get::<_, i32>(1).map_err(|e| e.to_string())?;
    let s_user: Option<String> = row.get(2).ok().flatten();
    let c_user: Option<String> = row.get(3).ok().flatten();
    let s_pass: Option<String> = row.get(4).ok().flatten();
    let c_pass: Option<String> = row.get(5).ok().flatten();
    let s_key:  Option<i32>    = row.get(6).ok().flatten();
    let c_key:  Option<i32>    = row.get(7).ok().flatten();
    let auth_type: String = row.get::<_, Option<String>>(8).ok().flatten().unwrap_or_else(|| "vault".into());
    let cred_auth_type: Option<String> = row.get(9).ok().flatten();
    let proxy_type: String = row.get::<_, Option<String>>(10).ok().flatten().unwrap_or_else(|| "none".into());
    let proxy_host: Option<String> = row.get(11).ok().flatten();
    let proxy_port: Option<i32> = row.get(12).ok().flatten();

    let (username, password, key_id) = if auth_type == "vault" {
        (c_user.unwrap_or_default(), c_pass, c_key)
    } else {
        (s_user.unwrap_or_default(), s_pass, s_key)
    };
    let effective_key_id = if auth_type == "vault" {
        if cred_auth_type.as_deref() == Some("key") { key_id } else { None }
    } else if auth_type == "custom_key" {
        key_id
    } else {
        None
    };

    let (private_key, passphrase) = if let Some(kid) = effective_key_id {
        let mut key_stmt = conn.prepare("SELECT private_key, passphrase FROM ssh_keys WHERE id = ?1")
            .map_err(|e| e.to_string())?;
        let mut krows = key_stmt.query([kid]).map_err(|e| e.to_string())?;
        if let Some(r) = krows.next().map_err(|e| e.to_string())? {
            let pk: String = r.get(0).map_err(|e| e.to_string())?;
            let pp: Option<String> = r.get(1).ok().flatten();
            (Some(pk), pp)
        } else {
            (None, None)
        }
    } else {
        (None, None)
    };

    Ok(monitor::NodeAuth {
        host,
        port: port as u16,
        username: if username.trim().is_empty() { "root".into() } else { username },
        password,
        private_key,
        passphrase,
        proxy_type,
        proxy_host: proxy_host.filter(|s| !s.is_empty()),
        proxy_port: proxy_port.map(|p| p as u16),
    })
}

fn default_metrics() -> Vec<String> {
    vec!["cpu".into(), "mem".into(), "disk".into(), "load".into()]
}

/// Look up just the display name for a node. Used by the monitor's
/// outage/recovered event payloads so the frontend can show a meaningful
/// toast ("web-01 is offline") without doing another round-trip.
fn fetch_node_name(conn: &rusqlite::Connection, node_id: i32) -> String {
    conn.query_row("SELECT name FROM servers WHERE id = ?1", [node_id], |r| r.get::<_, String>(0))
        .unwrap_or_else(|_| format!("node-{}", node_id))
}

fn load_monitor_config(
    conn: &rusqlite::Connection,
    node_id: i32,
) -> Option<(Vec<String>, Vec<monitor::CustomMetric>, bool)> {
    let mut stmt = conn.prepare("SELECT enabled_metrics, custom_metrics, paused FROM monitor_configs WHERE node_id = ?1").ok()?;
    let mut rows = stmt.query([node_id]).ok()?;
    let row = rows.next().ok()??;
    let json_metrics: String = row.get(0).ok()?;
    let json_customs: String = row.get(1).ok().unwrap_or_else(|| "[]".into());
    let paused: i32 = row.get(2).ok()?;
    let metrics: Vec<String> = serde_json::from_str(&json_metrics).unwrap_or_else(|_| default_metrics());
    let customs: Vec<monitor::CustomMetric> = serde_json::from_str(&json_customs).unwrap_or_default();
    Some((metrics, customs, paused != 0))
}

fn upsert_monitor_config(
    conn: &rusqlite::Connection,
    node_id: i32,
    metrics: &[String],
    customs: &[monitor::CustomMetric],
    paused: bool,
) -> Result<(), String> {
    let json_metrics = serde_json::to_string(metrics).map_err(|e| e.to_string())?;
    let json_customs = serde_json::to_string(customs).map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO monitor_configs (node_id, enabled_metrics, custom_metrics, paused) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(node_id) DO UPDATE SET enabled_metrics=excluded.enabled_metrics, custom_metrics=excluded.custom_metrics, paused=excluded.paused",
        rusqlite::params![node_id, json_metrics, json_customs, if paused { 1 } else { 0 }],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

/// Frontend shape: monitor_list returns this for each known monitor (whether
/// it's been started in the live MonitorMap yet or not). UI uses it to
/// render the sidebar even before the first sample arrives.
#[derive(serde::Serialize)]
pub(crate) struct MonitorRow {
    node_id: i32,
    name: String,
    host: String,
    port: i32,
    enabled_metrics: Vec<String>,
    custom_metrics: Vec<monitor::CustomMetric>,
    paused: bool,
    connected: bool,
    last_error: Option<String>,
    last_sample_ts: Option<u64>,
}

fn load_settings_from_db(conn: &rusqlite::Connection) -> monitor::MonitorSettings {
    let mut stmt = match conn.prepare("SELECT json FROM monitor_settings WHERE id = 1") {
        Ok(s) => s,
        Err(_) => return monitor::MonitorSettings::default(),
    };
    let mut rows = match stmt.query([]) {
        Ok(r) => r,
        Err(_) => return monitor::MonitorSettings::default(),
    };
    if let Ok(Some(row)) = rows.next() {
        if let Ok(json) = row.get::<_, String>(0) {
            if let Ok(s) = serde_json::from_str::<monitor::MonitorSettings>(&json) {
                return s.sanitized();
            }
        }
    }
    monitor::MonitorSettings::default()
}

#[tauri::command]
pub(crate) async fn monitor_get_settings(
    db_state: tauri::State<'_, DbState>,
    settings: tauri::State<'_, SharedSettings>,
) -> Result<monitor::MonitorSettings, String> {
    // First-call lazy-load: if the in-memory copy is still at defaults but
    // the DB has saved values, hydrate the in-memory copy so all pollers
    // pick them up immediately. We can't tell "default vs default-saved"
    // perfectly but the worst case is idempotent.
    // Compute the DB-saved value first, then drop the std::sync::Mutex
    // guard *before* awaiting on the tokio Mutex — otherwise the future
    // captures a non-Send guard and won't compile.
    let from_db_opt: Option<monitor::MonitorSettings> = {
        let guard = db_state.conn.lock().map_err(|_| "lock")?;
        guard.as_ref().map(|conn| load_settings_from_db(conn))
    };
    if let Some(from_db) = from_db_opt {
        let mut cur = settings.lock().await;
        if *cur == monitor::MonitorSettings::default() {
            *cur = from_db;
        }
    }
    Ok(settings.lock().await.clone())
}

#[tauri::command]
pub(crate) async fn monitor_set_settings(
    db_state: tauri::State<'_, DbState>,
    settings: tauri::State<'_, SharedSettings>,
    new_settings: monitor::MonitorSettings,
) -> Result<monitor::MonitorSettings, String> {
    let sane = new_settings.sanitized();
    {
        let guard = db_state.conn.lock().map_err(|_| "lock")?;
        let conn = guard.as_ref().ok_or("db not ready")?;
        let json = serde_json::to_string(&sane).map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO monitor_settings (id, json) VALUES (1, ?1)
             ON CONFLICT(id) DO UPDATE SET json = excluded.json",
            rusqlite::params![json],
        ).map_err(|e| e.to_string())?;
    }
    save_vault_internal(&db_state)?;
    *settings.lock().await = sane.clone();
    Ok(sane)
}

#[tauri::command]
pub(crate) async fn monitor_list(
    db_state: tauri::State<'_, DbState>,
    map: tauri::State<'_, MonitorMap>,
) -> Result<Vec<MonitorRow>, String> {
    // Pull DB rows first so we always include configured-but-paused entries
    // even if they have no live MonitorEntry yet.
    let configs: Vec<(i32, String, String, i32, Vec<String>, Vec<monitor::CustomMetric>, bool)> = {
        let guard = db_state.conn.lock().map_err(|_| "lock")?;
        let conn = guard.as_ref().ok_or("db not ready")?;
        let mut stmt = conn.prepare("
            SELECT mc.node_id, s.name, s.host, s.port, mc.enabled_metrics, mc.custom_metrics, mc.paused
            FROM monitor_configs mc
            JOIN servers s ON s.id = mc.node_id
            ORDER BY s.name COLLATE NOCASE
        ").map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], |r| {
            let metrics_json: String = r.get(4)?;
            let metrics: Vec<String> = serde_json::from_str(&metrics_json).unwrap_or_else(|_| default_metrics());
            let customs_json: String = r.get(5).unwrap_or_else(|_| "[]".into());
            let customs: Vec<monitor::CustomMetric> = serde_json::from_str(&customs_json).unwrap_or_default();
            let paused: i32 = r.get(6)?;
            Ok((r.get::<_, i32>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, i32>(3)?, metrics, customs, paused != 0))
        }).map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for row in rows { if let Ok(v) = row { out.push(v); } }
        out
    };

    // Merge live state from MonitorMap on top.
    let live = monitor::list(map.inner().clone()).await;
    let live_by_id: std::collections::HashMap<i32, monitor::MonitorInfo> =
        live.into_iter().map(|m| (m.node_id, m)).collect();

    Ok(configs.into_iter().map(|(node_id, name, host, port, metrics, customs, paused)| {
        let live = live_by_id.get(&node_id);
        MonitorRow {
            node_id,
            name, host, port,
            enabled_metrics: metrics,
            custom_metrics: customs,
            paused,
            connected: live.map(|l| l.connected).unwrap_or(false),
            last_error: live.and_then(|l| l.last_error.clone()),
            last_sample_ts: live.and_then(|l| l.last_sample_ts),
        }
    }).collect())
}

#[tauri::command]
pub(crate) async fn monitor_add(
    db_state: tauri::State<'_, DbState>,
    node_id: i32,
) -> Result<(), String> {
    // Persist the config row only; the poller doesn't spawn until the user
    // explicitly clicks Resume (per the "no auto-start" rule). We still
    // resolve the auth bundle once here so adding a node with broken auth
    // fails fast instead of silently sitting in a paused state forever.
    {
        let guard = db_state.conn.lock().map_err(|_| "lock")?;
        let conn = guard.as_ref().ok_or("db not ready")?;
        let _ = resolve_node_auth_for_monitor(conn, node_id)?;
        upsert_monitor_config(conn, node_id, &default_metrics(), &[], true)?;
    }
    save_vault_internal(&db_state)?;
    Ok(())
}

#[tauri::command]
pub(crate) async fn monitor_remove(
    db_state: tauri::State<'_, DbState>,
    map: tauri::State<'_, MonitorMap>,
    node_id: i32,
) -> Result<(), String> {
    monitor::stop_monitor(map.inner().clone(), node_id).await;
    {
        let guard = db_state.conn.lock().map_err(|_| "lock")?;
        let conn = guard.as_ref().ok_or("db not ready")?;
        conn.execute("DELETE FROM monitor_configs WHERE node_id=?1", [node_id])
            .map_err(|e| e.to_string())?;
    }
    save_vault_internal(&db_state)?;
    Ok(())
}

#[tauri::command]
pub(crate) async fn monitor_set_metrics(
    db_state: tauri::State<'_, DbState>,
    map: tauri::State<'_, MonitorMap>,
    node_id: i32,
    metrics: Vec<String>,
) -> Result<(), String> {
    {
        let guard = db_state.conn.lock().map_err(|_| "lock")?;
        let conn = guard.as_ref().ok_or("db not ready")?;
        // Preserve current pause state + custom list from row.
        let (_, customs, paused) = load_monitor_config(conn, node_id)
            .unwrap_or((default_metrics(), vec![], true));
        upsert_monitor_config(conn, node_id, &metrics, &customs, paused)?;
    }
    save_vault_internal(&db_state)?;
    // If a live poller exists, hot-update it; otherwise it'll pick up on resume.
    let _ = monitor::set_enabled_metrics(map.inner().clone(), node_id, metrics).await;
    Ok(())
}

#[tauri::command]
pub(crate) async fn monitor_set_custom_metrics(
    db_state: tauri::State<'_, DbState>,
    map: tauri::State<'_, MonitorMap>,
    node_id: i32,
    customs: Vec<monitor::CustomMetric>,
) -> Result<(), String> {
    {
        let guard = db_state.conn.lock().map_err(|_| "lock")?;
        let conn = guard.as_ref().ok_or("db not ready")?;
        let (metrics, _, paused) = load_monitor_config(conn, node_id)
            .unwrap_or((default_metrics(), vec![], true));
        upsert_monitor_config(conn, node_id, &metrics, &customs, paused)?;
    }
    save_vault_internal(&db_state)?;
    let _ = monitor::set_custom_metrics(map.inner().clone(), node_id, customs).await;
    Ok(())
}

#[tauri::command]
pub(crate) async fn monitor_resume(
    app: tauri::AppHandle,
    db_state: tauri::State<'_, DbState>,
    map: tauri::State<'_, MonitorMap>,
    settings: tauri::State<'_, SharedSettings>,
    node_id: i32,
) -> Result<(), String> {
    let (auth, metrics, customs, name) = {
        let guard = db_state.conn.lock().map_err(|_| "lock")?;
        let conn = guard.as_ref().ok_or("db not ready")?;
        let (metrics, customs, _) = load_monitor_config(conn, node_id)
            .ok_or_else(|| format!("Node {} is not in the monitor list", node_id))?;
        upsert_monitor_config(conn, node_id, &metrics, &customs, false)?;
        let name = fetch_node_name(conn, node_id);
        (resolve_node_auth_for_monitor(conn, node_id)?, metrics, customs, name)
    };
    save_vault_internal(&db_state)?;

    // If a poller already exists, just hot-flip paused; otherwise spawn one.
    if monitor::set_paused(map.inner().clone(), node_id, false).await.is_err() {
        let db_arc = std::sync::Arc::clone(&db_state.conn);
        let settings_arc: SharedSettings = (*settings.inner()).clone();
        monitor::start_monitor(
            app,
            map.inner().clone(),
            db_arc,
            settings_arc,
            node_id,
            name,
            auth,
            metrics,
            customs,
            false,
        ).await;
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn monitor_pause(
    db_state: tauri::State<'_, DbState>,
    map: tauri::State<'_, MonitorMap>,
    node_id: i32,
) -> Result<(), String> {
    {
        let guard = db_state.conn.lock().map_err(|_| "lock")?;
        let conn = guard.as_ref().ok_or("db not ready")?;
        if let Some((metrics, customs, _)) = load_monitor_config(conn, node_id) {
            upsert_monitor_config(conn, node_id, &metrics, &customs, true)?;
        }
    }
    save_vault_internal(&db_state)?;
    let _ = monitor::set_paused(map.inner().clone(), node_id, true).await;
    Ok(())
}

#[tauri::command]
pub(crate) async fn monitor_pause_all(
    db_state: tauri::State<'_, DbState>,
    map: tauri::State<'_, MonitorMap>,
) -> Result<(), String> {
    {
        let guard = db_state.conn.lock().map_err(|_| "lock")?;
        let conn = guard.as_ref().ok_or("db not ready")?;
        conn.execute("UPDATE monitor_configs SET paused = 1", [])
            .map_err(|e| e.to_string())?;
    }
    save_vault_internal(&db_state)?;
    monitor::pause_all(map.inner().clone()).await;
    Ok(())
}

#[tauri::command]
pub(crate) async fn monitor_resume_all(
    app: tauri::AppHandle,
    db_state: tauri::State<'_, DbState>,
    map: tauri::State<'_, MonitorMap>,
    settings: tauri::State<'_, SharedSettings>,
) -> Result<(), String> {
    // Persist all to unpaused first.
    let node_ids: Vec<i32> = {
        let guard = db_state.conn.lock().map_err(|_| "lock")?;
        let conn = guard.as_ref().ok_or("db not ready")?;
        conn.execute("UPDATE monitor_configs SET paused = 0", [])
            .map_err(|e| e.to_string())?;
        let mut stmt = conn.prepare("SELECT node_id FROM monitor_configs").map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], |r| r.get::<_, i32>(0)).map_err(|e| e.to_string())?;
        rows.filter_map(|r| r.ok()).collect()
    };
    save_vault_internal(&db_state)?;

    // Start (or hot-resume) each one.
    for node_id in node_ids {
        if monitor::set_paused(map.inner().clone(), node_id, false).await.is_err() {
            let (auth, metrics, customs, name) = {
                let guard = db_state.conn.lock().map_err(|_| "lock")?;
                let conn = guard.as_ref().ok_or("db not ready")?;
                let (metrics, customs, _) = load_monitor_config(conn, node_id)
                    .unwrap_or((default_metrics(), vec![], false));
                let name = fetch_node_name(conn, node_id);
                (resolve_node_auth_for_monitor(conn, node_id)?, metrics, customs, name)
            };
            let db_arc = std::sync::Arc::clone(&db_state.conn);
            let settings_arc: SharedSettings = (*settings.inner()).clone();
            monitor::start_monitor(
                app.clone(),
                map.inner().clone(),
                db_arc,
                settings_arc,
                node_id,
                name,
                auth,
                metrics,
                customs,
                false,
            ).await;
        }
    }
    Ok(())
}
