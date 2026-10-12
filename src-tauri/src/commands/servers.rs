use serde_json::json;
use ssh_key::{self, private::Ed25519Keypair, rand_core::OsRng, PrivateKey};
use crate::ssh_manager::SshState;
use crate::{monitor, save_vault_internal, DbState, MonitorMap};

/// One-shot inline auth bundle for "quick connect" — connecting to a host
/// without saving anything in the vault. Mirrors the subset of node fields
/// that the connection flow actually needs: address, identity, and either
/// a password or a PEM key body. Proxy + tunnel auto-start are deliberately
/// omitted; the user can save a real node if they need those.
#[derive(Debug, Clone, serde::Deserialize)]
pub struct QuickAuth {
    pub host: String,
    pub port: i32,
    pub username: String,
    #[serde(default)]
    pub password: Option<String>,
    #[serde(default)]
    pub private_key: Option<String>,
    #[serde(default)]
    pub passphrase: Option<String>,
}

#[tauri::command]
pub async fn generate_ssh_key(state: tauri::State<'_, DbState>, name: String) -> Result<(), String> {
    let keypair = Ed25519Keypair::random(&mut OsRng);
    let priv_key = PrivateKey::from(keypair);
    let pub_ssh = priv_key.public_key().to_openssh()
        .map_err(|e| format!("[SSH] PUB_EXPORT_FAILED: {}", e))?;
    let priv_ssh = priv_key.to_openssh(ssh_key::LineEnding::LF)
        .map_err(|e| format!("[SSH] PRIV_EXPORT_FAILED: {}", e))?.to_string();

    let conn_guard = state.conn.lock().map_err(|_| "[STATE] LOCK_FAILED")?;
    let conn = conn_guard.as_ref().ok_or("[STATE] DATABASE_NOT_INITIALIZED")?;
    
    conn.execute("INSERT INTO ssh_keys (name, public_key, private_key) VALUES (?1, ?2, ?3)", rusqlite::params![name, pub_ssh, priv_ssh])
        .map_err(|e| format!("[DATABASE] KEY_INSERT_FAILED: {}", e))?;
    
    drop(conn_guard);
    save_vault_internal(&state)?;
    Ok(())
}

/// Reject key formats the SSH client cannot use, so failures surface when the
/// user enters the key rather than when they try to connect.
fn validate_ssh_private_key(private_key: &str) -> Result<(), String> {
    let trimmed = private_key.trim();

    // PKCS#1 / PKCS#8 / SEC1 PEM headers. Whether we accept these depends on
    // whether the build has russh's OpenSSL backend wired in — see the
    // matching gate in the connect path.
    if trimmed.starts_with("-----BEGIN RSA PRIVATE KEY-----") {
        #[cfg(feature = "full-ssh-algos")]
        {
            return Ok(());
        }
        #[cfg(not(feature = "full-ssh-algos"))]
        {
            return Err("[SSH] UNSUPPORTED_KEY_FORMAT_DEV: RSA keys aren't available in this debug build. Either build with --features full-ssh-algos (requires Perl) or install a release build from GitHub — both support RSA. Ed25519 keys work everywhere.".into());
        }
    }
    if trimmed.starts_with("-----BEGIN DSA PRIVATE KEY-----")
        || trimmed.starts_with("-----BEGIN EC PRIVATE KEY-----")
    {
        // DSA is dead; ECDSA in PEM (SEC1) needs an extra conversion russh
        // doesn't do for us. Tell the user to convert and retry rather than
        // pretending the format is fine.
        return Err("[SSH] UNSUPPORTED_KEY_FORMAT: DSA / SEC1 ECDSA PEM keys aren't supported. Convert to OpenSSH format with `ssh-keygen -p -m PEM -f <file>` and re-import, or generate a fresh Ed25519 key.".into());
    }

    if trimmed.starts_with("-----BEGIN OPENSSH PRIVATE KEY-----") {
        // Inspect the algorithm without requiring the passphrase — the algorithm
        // header is unencrypted even when the body is encrypted.
        if let Ok(parsed) = ssh_key::PrivateKey::from_openssh(trimmed) {
            match parsed.algorithm() {
                ssh_key::Algorithm::Ed25519 => {}
                ssh_key::Algorithm::Rsa { .. } | ssh_key::Algorithm::Ecdsa { .. } => {
                    #[cfg(not(feature = "full-ssh-algos"))]
                    {
                        return Err(format!(
                            "[SSH] UNSUPPORTED_KEY_TYPE_DEV: {} keys need a release build (or local build with --features full-ssh-algos). Ed25519 works everywhere.",
                            parsed.algorithm().as_str()
                        ));
                    }
                }
                other => {
                    return Err(format!(
                        "[SSH] UNSUPPORTED_KEY_TYPE: {} keys are not supported.",
                        other.as_str()
                    ));
                }
            }
        }
        // If parsing fails entirely (unexpected header layout), let it through;
        // the connect path will surface a clearer error.
        return Ok(());
    }

    Err("[SSH] UNRECOGNIZED_KEY_FORMAT: Expected an OpenSSH-format private key (begins with -----BEGIN OPENSSH PRIVATE KEY-----) or RSA PEM.".into())
}

#[tauri::command]
pub async fn add_ssh_key(state: tauri::State<'_, DbState>, name: String, public_key: String, private_key: String, passphrase: Option<String>) -> Result<(), String> {
    validate_ssh_private_key(&private_key)?;

    let conn_guard = state.conn.lock().map_err(|_| "[STATE] LOCK_FAILED")?;
    let conn = conn_guard.as_ref().ok_or("[STATE] DATABASE_NOT_INITIALIZED")?;

    conn.execute("INSERT INTO ssh_keys (name, public_key, private_key, passphrase) VALUES (?1, ?2, ?3, ?4)", rusqlite::params![name, public_key, private_key, passphrase])
        .map_err(|e| format!("[DATABASE] KEY_INSERT_FAILED: {}", e))?;

    drop(conn_guard);
    save_vault_internal(&state)?;
    Ok(())
}

#[tauri::command]
pub async fn edit_ssh_key(state: tauri::State<'_, DbState>, id: i32, name: String, public_key: String, private_key: String, passphrase: Option<String>) -> Result<(), String> {
    validate_ssh_private_key(&private_key)?;

    let conn_guard = state.conn.lock().map_err(|_| "[STATE] LOCK_FAILED")?;
    let conn = conn_guard.as_ref().ok_or("[STATE] DATABASE_NOT_INITIALIZED")?;

    conn.execute("UPDATE ssh_keys SET name=?1, public_key=?2, private_key=?3, passphrase=?4 WHERE id=?5", rusqlite::params![name, public_key, private_key, passphrase, id])
        .map_err(|e| format!("[DATABASE] KEY_UPDATE_FAILED: {}", e))?;

    drop(conn_guard);
    save_vault_internal(&state)?;
    Ok(())
}

#[tauri::command]
pub async fn delete_ssh_key(state: tauri::State<'_, DbState>, id: i32) -> Result<(), String> {
    let conn_guard = state.conn.lock().map_err(|_| "[STATE] LOCK_FAILED")?;
    let conn = conn_guard.as_ref().ok_or("[STATE] DATABASE_NOT_INITIALIZED")?;
    
    conn.execute("DELETE FROM ssh_keys WHERE id=?1", rusqlite::params![id])
        .map_err(|e| format!("[DATABASE] KEY_DELETE_FAILED: {}", e))?;
    
    drop(conn_guard);
    save_vault_internal(&state)?;
    Ok(())
}

/// Canonicalize a node row's identity fields based on the chosen auth_type.
/// The principle: a node either authenticates via a vault credential OR via
/// inline node-level fields — never a hybrid. Storing only the relevant
/// fields makes the connection-time resolution unambiguous and keeps the DB
/// honest about which mode a node really uses.
fn normalize_server_identity(
    auth_type: &str,
    username: Option<String>,
    password: Option<String>,
    key_id: Option<i32>,
    credential_id: Option<i32>,
) -> (Option<String>, Option<String>, Option<i32>, Option<i32>) {
    // Treat empty / whitespace-only usernames as absent so the DB stays clean.
    let username = username.and_then(|s| {
        let t = s.trim();
        if t.is_empty() { None } else { Some(t.to_string()) }
    });
    match auth_type {
        "vault" => {
            // Credential carries everything; the node row stores only the link.
            (None, None, None, credential_id)
        }
        "custom_key" => {
            // No password, no credential link — node owns username + key.
            (username, None, key_id, None)
        }
        // "custom_pass" and any unknown fallback: node owns username + password.
        _ => (username, password, None, None),
    }
}

#[tauri::command]
pub async fn add_server(
    state: tauri::State<'_, DbState>,
    name: String,
    host: String,
    port: i32,
    username: Option<String>,
    password: Option<String>,
    credential_id: Option<i32>,
    folder_id: Option<i32>,
    proxy_type: String,
    proxy_host: String,
    proxy_port: i32,
    tunnels: Vec<serde_json::Value>,
    auth_type: String,
    key_id: Option<i32>,
    autostart: Option<bool>,
    mirrors: Option<Vec<serde_json::Value>>,
    color: Option<String>,
    forward_agent: Option<bool>,
) -> Result<i64, String> {
    let conn_guard = state.conn.lock().map_err(|_| "[STATE] LOCK_FAILED")?;
    let conn = conn_guard.as_ref().ok_or("[STATE] DATABASE_NOT_INITIALIZED")?;

    let tunnels_json = serde_json::to_string(&tunnels).unwrap_or_else(|_| "[]".to_string());
    let mirrors_json = mirrors.as_ref()
        .map(|m| serde_json::to_string(m).unwrap_or_else(|_| "[]".into()))
        .unwrap_or_else(|| "[]".into());

    // Enforce the "one source of truth" rule at write time: in vault mode the
    // node row carries no identity at all; in custom_* mode the credential
    // link is dropped. This keeps the DB self-consistent even if a future
    // caller forgets to nil out the fields.
    let (db_username, db_password, db_key_id, db_credential_id) = normalize_server_identity(
        &auth_type, username, password, key_id, credential_id,
    );

    let autostart_i: i32 = if autostart.unwrap_or(false) { 1 } else { 0 };
    let forward_agent_i: i32 = if forward_agent.unwrap_or(false) { 1 } else { 0 };
    let res = conn.execute(
        "INSERT INTO servers (name, host, port, username, password, credential_id, folder_id, proxy_type, proxy_host, proxy_port, tunnels, auth_type, key_id, autostart, mirrors, color, forward_agent) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)",
        rusqlite::params![name, host, port, db_username, db_password, db_credential_id, folder_id, proxy_type, proxy_host, proxy_port, tunnels_json, auth_type, db_key_id, autostart_i, mirrors_json, color, forward_agent_i],
    ).map_err(|e| format!("[DATABASE] SERVER_INSERT_FAILED: SQL_ERROR={}", e))?;

    if res == 0 {
        return Err("[DATABASE] SERVER_INSERT_FAILED: No rows affected".into());
    }

    let new_id = conn.last_insert_rowid();
    // Append to the bottom of its folder's manual order: one past the current
    // max position among the folder's other rows (`IS ?2` is NULL-safe so the
    // root folder groups correctly). Without this a new node would inherit the
    // default position 0 and jump to the TOP of a folder the user reordered.
    let _ = conn.execute(
        "UPDATE servers SET position = COALESCE((SELECT MAX(position) FROM servers WHERE id != ?1 AND folder_id IS ?2), -1) + 1 WHERE id = ?1",
        rusqlite::params![new_id, folder_id],
    );
    drop(conn_guard);
    save_vault_internal(&state)?;
    Ok(new_id)
}

/// Persist a Quick Connect target as a reusable node in the ROOT directory
/// (folder_id NULL). Quick Connect is otherwise ephemeral; this leaves behind a
/// saved profile the user can reconnect to later without re-typing credentials.
/// Deduplicates by (host, port, username) among root nodes so repeatedly
/// quick-connecting to the same host doesn't pile up identical rows — the
/// existing node's id is returned instead. Password targets are stored as
/// `custom_pass` (inline username + password); key targets save the private key
/// into `ssh_keys` (public_key left empty — the connect path derives everything
/// it needs from the private key via decode_secret_key, see the custom_key
/// branch in initiate_connection) and reference it as `custom_key`.
#[tauri::command]
pub async fn save_quick_connect_node(
    state: tauri::State<'_, DbState>,
    auth: QuickAuth,
) -> Result<i64, String> {
    let conn_guard = state.conn.lock().map_err(|_| "[STATE] LOCK_FAILED")?;
    let conn = conn_guard.as_ref().ok_or("[STATE] DATABASE_NOT_INITIALIZED")?;

    let username = {
        let t = auth.username.trim();
        if t.is_empty() { "root".to_string() } else { t.to_string() }
    };

    // Dedup against existing, non-deleted ROOT nodes with the same identity so
    // the grid doesn't fill with duplicates on repeated quick connects.
    let existing = conn.query_row(
        "SELECT id FROM servers WHERE deleted = 0 AND folder_id IS NULL AND host = ?1 AND port = ?2 AND COALESCE(username,'') = ?3 LIMIT 1",
        rusqlite::params![auth.host, auth.port, username],
        |r| r.get::<_, i64>(0),
    );
    match existing {
        Ok(id) => return Ok(id),
        Err(rusqlite::Error::QueryReturnedNoRows) => {}
        Err(e) => return Err(format!("[DATABASE] QUICK_NODE_LOOKUP_FAILED: {}", e)),
    }

    let name = format!("{}@{}", username, auth.host);

    // A private key wins over a password if both somehow arrived.
    let (auth_type, db_password, db_key_id): (&str, Option<String>, Option<i64>) =
        if let Some(pem) = auth.private_key.as_ref().filter(|s| !s.trim().is_empty()) {
            validate_ssh_private_key(pem)?;
            conn.execute(
                "INSERT INTO ssh_keys (name, public_key, private_key, passphrase) VALUES (?1, ?2, ?3, ?4)",
                rusqlite::params![name, "", pem, auth.passphrase],
            ).map_err(|e| format!("[DATABASE] QUICK_KEY_INSERT_FAILED: {}", e))?;
            ("custom_key", None, Some(conn.last_insert_rowid()))
        } else {
            ("custom_pass", auth.password.clone(), None)
        };

    conn.execute(
        "INSERT INTO servers (name, host, port, username, password, credential_id, folder_id, proxy_type, proxy_host, proxy_port, tunnels, auth_type, key_id, autostart, mirrors, color) \
         VALUES (?1, ?2, ?3, ?4, ?5, NULL, NULL, 'none', '', 1080, '[]', ?6, ?7, 0, '[]', NULL)",
        rusqlite::params![name, auth.host, auth.port, username, db_password, auth_type, db_key_id],
    ).map_err(|e| format!("[DATABASE] QUICK_NODE_INSERT_FAILED: {}", e))?;

    let new_id = conn.last_insert_rowid();
    // Append to the bottom of the root order (mirrors add_server's position calc).
    let _ = conn.execute(
        "UPDATE servers SET position = COALESCE((SELECT MAX(position) FROM servers WHERE id != ?1 AND folder_id IS NULL), -1) + 1 WHERE id = ?1",
        rusqlite::params![new_id],
    );

    drop(conn_guard);
    save_vault_internal(&state)?;
    Ok(new_id)
}

#[tauri::command]
pub async fn edit_server(
    state: tauri::State<'_, DbState>,
    ssh_state: tauri::State<'_, SshState>,
    id: i32,
    name: String,
    host: String,
    port: i32,
    username: Option<String>,
    password: Option<String>,
    credential_id: Option<i32>,
    folder_id: Option<i32>,
    proxy_type: String,
    proxy_host: String,
    proxy_port: i32,
    tunnels: Vec<serde_json::Value>,
    auth_type: String,
    key_id: Option<i32>,
    autostart: Option<bool>,
    mirrors: Option<Vec<serde_json::Value>>,
    color: Option<String>,
    forward_agent: Option<bool>,
    // Frontend opt-out for password persistence. When the user opens the
    // edit sheet, we call `reveal_server_password` to populate the form;
    // if that call ever fails (transient DB error / migration mid-flight)
    // the form would have a blank password and a naive save would wipe
    // the stored secret. The frontend sends `preserve_password=true`
    // whenever the password field wasn't touched, and the SQL below uses
    // COALESCE(?, password) so the existing column survives.
    preserve_password: Option<bool>,
) -> Result<(), String> {
    let tunnels_json = serde_json::to_string(&tunnels).unwrap_or_else(|_| "[]".to_string());
    let mirrors_json = mirrors.as_ref()
        .map(|m| serde_json::to_string(m).unwrap_or_else(|_| "[]".into()))
        .unwrap_or_else(|| "[]".into());

    let (db_username, db_password, db_key_id, db_credential_id) = normalize_server_identity(
        &auth_type, username, password, key_id, credential_id,
    );
    let autostart_i: i32 = if autostart.unwrap_or(false) { 1 } else { 0 };
    let forward_agent_i: i32 = if forward_agent.unwrap_or(false) { 1 } else { 0 };

    // All SQLite work is scoped so the non-Send connection guard is fully
    // dropped before the async cache-invalidation await below — Tauri requires
    // the command future to be Send. Returns whether the forwarding rules
    // changed: if they did, the node's saved rules become the new source of
    // truth and the live session's cached replay list must be dropped (below).
    // Otherwise a session that already seeded its specs, or had them stripped
    // to an empty list by a failed bind, keeps using the stale set and never
    // re-reads the edited rules — the "changed the port but the forward never
    // comes up" bug.
    let tunnels_changed = {
        let conn_guard = state.conn.lock().map_err(|_| "[STATE] LOCK_FAILED")?;
        let conn = conn_guard.as_ref().ok_or("[STATE] DATABASE_NOT_INITIALIZED")?;

        let old_tunnels_json: String = conn
            .query_row("SELECT COALESCE(tunnels,'[]') FROM servers WHERE id=?1", [id], |r| r.get(0))
            .unwrap_or_else(|_| "[]".to_string());

        // Capture the current folder so we can detect a move below and re-rank.
        let old_folder_id: Option<i32> = conn
            .query_row("SELECT folder_id FROM servers WHERE id=?1", [id], |r| r.get::<_, Option<i32>>(0))
            .ok()
            .flatten();

        // Two-flavour UPDATE: with `preserve_password`, the password column is
        // wrapped in COALESCE(?, password) so a NULL bind keeps the existing
        // value. Without it, the password column is overwritten the usual way.
        // The behaviour difference matters only when the auth path is custom_pass
        // because normalize_server_identity zeros password for the other modes.
        if preserve_password.unwrap_or(false) && auth_type == "custom_pass" {
            conn.execute(
                "UPDATE servers SET name=?1, host=?2, port=?3, username=?4, password=COALESCE(?5, password), credential_id=?6, folder_id=?7, proxy_type=?8, proxy_host=?9, proxy_port=?10, tunnels=?11, auth_type=?12, key_id=?13, autostart=?14, mirrors=?15, color=?16, forward_agent=?17 WHERE id=?18",
                rusqlite::params![name, host, port, db_username, db_password, db_credential_id, folder_id, proxy_type, proxy_host, proxy_port, tunnels_json, auth_type, db_key_id, autostart_i, mirrors_json, color, forward_agent_i, id],
            ).map_err(|e| format!("[DATABASE] SERVER_UPDATE_FAILED: SQL_ERROR={}", e))?;
        } else {
            conn.execute(
                "UPDATE servers SET name=?1, host=?2, port=?3, username=?4, password=?5, credential_id=?6, folder_id=?7, proxy_type=?8, proxy_host=?9, proxy_port=?10, tunnels=?11, auth_type=?12, key_id=?13, autostart=?14, mirrors=?15, color=?16, forward_agent=?17 WHERE id=?18",
                rusqlite::params![name, host, port, db_username, db_password, db_credential_id, folder_id, proxy_type, proxy_host, proxy_port, tunnels_json, auth_type, db_key_id, autostart_i, mirrors_json, color, forward_agent_i, id],
            ).map_err(|e| format!("[DATABASE] SERVER_UPDATE_FAILED: SQL_ERROR={}", e))?;
        }

        // Folder changed → re-append to the bottom of the destination folder's
        // manual order (mirrors add_server). Otherwise the row keeps its stale
        // rank from the old folder and can collide at the top of the new one.
        if old_folder_id != folder_id {
            let _ = conn.execute(
                "UPDATE servers SET position = COALESCE((SELECT MAX(position) FROM servers WHERE id != ?1 AND folder_id IS ?2), -1) + 1 WHERE id = ?1",
                rusqlite::params![id, folder_id],
            );
        }

        old_tunnels_json != tunnels_json
    };

    save_vault_internal(&state)?;

    // Forwarding rules changed → drop this server's live tunnel replay cache so
    // every (re)connect / restore path re-seeds from the freshly-saved DB rules
    // instead of clinging to a stale (or failure-emptied) in-memory list. All
    // those paths seed from the node's `tunnels` JSON precisely when the key is
    // ABSENT, so removing it is what lets the edit take effect. Session ids are
    // `session-{server_id}` (see openServer in the frontend).
    if tunnels_changed {
        ssh_state
            .session_tunnel_specs
            .lock()
            .await
            .remove(&format!("session-{}", id));
    }
    Ok(())
}

/// Append a single mirror spec to a saved server's mirrors column.
///
/// Exists so the live MirrorsPanel's "new mirror" flow can persist the
/// mirror it just started without round-tripping the whole edit_server
/// payload (which would force the panel to know about every other
/// node field — username, tunnels, auth_type, etc.). Pairs with
/// re-encrypting the vault on the way out, the same as the full edit
/// path does. Duplicate (local, remote) entries are coalesced so
/// hitting "Start mirror" twice on the same pair doesn't bloat the row.
#[tauri::command]
pub async fn add_mirror_to_server(
    state: tauri::State<'_, DbState>,
    server_id: i32,
    mirror: serde_json::Value,
) -> Result<(), String> {
    let conn_guard = state.conn.lock().map_err(|_| "[STATE] LOCK_FAILED")?;
    let conn = conn_guard.as_ref().ok_or("[STATE] DATABASE_NOT_INITIALIZED")?;

    let existing: String = conn.query_row(
        "SELECT mirrors FROM servers WHERE id = ?1",
        rusqlite::params![server_id],
        |row| row.get::<_, Option<String>>(0).map(|v| v.unwrap_or_else(|| "[]".into())),
    ).map_err(|e| format!("[DATABASE] SERVER_LOOKUP_FAILED: {}", e))?;

    let mut list: Vec<serde_json::Value> = serde_json::from_str(&existing).unwrap_or_default();
    let local  = mirror.get("local").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let remote = mirror.get("remote").and_then(|v| v.as_str()).unwrap_or("").to_string();
    if local.is_empty() || remote.is_empty() {
        return Err("mirror needs both local and remote paths".into());
    }
    // Replace any prior entry for the same (local, remote) pair so the
    // latest spec (e.g. updated excludes / conflict mode) wins instead of
    // piling a duplicate row beside it.
    list.retain(|m| {
        m.get("local").and_then(|v| v.as_str()) != Some(&local)
            || m.get("remote").and_then(|v| v.as_str()) != Some(&remote)
    });
    list.push(mirror);

    let next = serde_json::to_string(&list).map_err(|e| format!("[DATABASE] SERIALIZE_FAILED: {}", e))?;
    conn.execute(
        "UPDATE servers SET mirrors = ?1 WHERE id = ?2",
        rusqlite::params![next, server_id],
    ).map_err(|e| format!("[DATABASE] MIRROR_SAVE_FAILED: {}", e))?;

    drop(conn_guard);
    save_vault_internal(&state)?;
    Ok(())
}

/// Reveal the plaintext password for a single server row. Used by the edit
/// panel — only the row the user is editing has its secret crossing IPC.
/// Returns `Ok(None)` if the server uses a vault credential (no inline
/// password) or the password column is empty.
#[tauri::command]
pub async fn reveal_server_password(state: tauri::State<'_, DbState>, id: i32) -> Result<Option<String>, String> {
    let conn_guard = state.conn.lock().map_err(|_| "[STATE] LOCK_FAILED")?;
    let conn = conn_guard.as_ref().ok_or("[STATE] DATABASE_NOT_INITIALIZED")?;
    conn.query_row(
        "SELECT password FROM servers WHERE id = ?1",
        rusqlite::params![id],
        |row| row.get::<_, Option<String>>(0),
    ).map_err(|e| format!("[DATABASE] REVEAL_FAILED: {}", e))
}

/// Reveal the plaintext password for a single saved credential. Same shape
/// and rationale as `reveal_server_password`.
#[tauri::command]
pub async fn reveal_credential_password(state: tauri::State<'_, DbState>, id: i32) -> Result<Option<String>, String> {
    let conn_guard = state.conn.lock().map_err(|_| "[STATE] LOCK_FAILED")?;
    let conn = conn_guard.as_ref().ok_or("[STATE] DATABASE_NOT_INITIALIZED")?;
    conn.query_row(
        "SELECT password FROM credentials WHERE id = ?1",
        rusqlite::params![id],
        |row| row.get::<_, Option<String>>(0),
    ).map_err(|e| format!("[DATABASE] REVEAL_FAILED: {}", e))
}

/// Reveal the stored private key + passphrase for an SSH key entry. Used
/// by the key editor and by any future "show key" affordance. The list
/// view never sees these fields.
#[tauri::command]
pub async fn reveal_ssh_key(state: tauri::State<'_, DbState>, id: i32) -> Result<serde_json::Value, String> {
    let conn_guard = state.conn.lock().map_err(|_| "[STATE] LOCK_FAILED")?;
    let conn = conn_guard.as_ref().ok_or("[STATE] DATABASE_NOT_INITIALIZED")?;
    conn.query_row(
        "SELECT private_key, passphrase FROM ssh_keys WHERE id = ?1",
        rusqlite::params![id],
        |row| {
            Ok(json!({
                "private_key": row.get::<_, Option<String>>(0)?,
                "passphrase": row.get::<_, Option<String>>(1)?,
            }))
        },
    ).map_err(|e| format!("[DATABASE] REVEAL_FAILED: {}", e))
}

/// Light-weight colour write — used by the NodeGrid swatch picker so the
/// caller doesn't have to round-trip the whole edit_server payload just to
/// change one tag. Pass `None` to clear back to the default ring.
#[tauri::command]
pub async fn set_server_color(state: tauri::State<'_, DbState>, id: i32, color: Option<String>) -> Result<(), String> {
    let conn_guard = state.conn.lock().map_err(|_| "[STATE] LOCK_FAILED")?;
    let conn = conn_guard.as_ref().ok_or("[STATE] DATABASE_NOT_INITIALIZED")?;
    conn.execute(
        "UPDATE servers SET color=?1 WHERE id=?2",
        rusqlite::params![color, id],
    ).map_err(|e| format!("[DATABASE] SERVER_COLOR_FAILED: {}", e))?;
    drop(conn_guard);
    save_vault_internal(&state)?;
    Ok(())
}

/// Persist a manual drag-to-reorder of the node grid. `ids` is the full list
/// of server ids in their new visual order (typically the servers of one
/// folder); we write each id's index as its `position`, so `get_servers`'
/// `ORDER BY position, id` reproduces the arrangement. The AFTER-UPDATE trigger
/// stamps updated_at/edited_by, so the new order LWW-syncs to other devices
/// like any other edited field. Writing 0..n only for the passed ids is safe:
/// positions are compared within a folder after `get_servers` filters, and id
/// breaks any cross-folder ties.
#[tauri::command]
pub async fn reorder_servers(state: tauri::State<'_, DbState>, ids: Vec<i32>) -> Result<(), String> {
    {
        let conn_guard = state.conn.lock().map_err(|_| "[STATE] LOCK_FAILED")?;
        let conn = conn_guard.as_ref().ok_or("[STATE] DATABASE_NOT_INITIALIZED")?;
        for (idx, id) in ids.iter().enumerate() {
            // Only touch rows whose position actually changes. The AFTER-UPDATE
            // trigger stamps updated_at unconditionally on any matched row, and
            // sync is whole-row LWW — so updating every folder member on each
            // reorder would bump their updated_at and could clobber a field
            // (password/host) edited concurrently on another device. Guarding on
            // a real change limits that blast radius to the genuinely-moved rows.
            conn.execute(
                "UPDATE servers SET position=?1 WHERE id=?2 AND (position IS NULL OR position<>?1)",
                rusqlite::params![idx as i64, id],
            ).map_err(|e| format!("[DATABASE] SERVER_REORDER_FAILED: {}", e))?;
        }
    }
    save_vault_internal(&state)?;
    Ok(())
}

#[tauri::command]
pub async fn set_folder_color(state: tauri::State<'_, DbState>, id: i32, color: Option<String>) -> Result<(), String> {
    let conn_guard = state.conn.lock().map_err(|_| "[STATE] LOCK_FAILED")?;
    let conn = conn_guard.as_ref().ok_or("[STATE] DATABASE_NOT_INITIALIZED")?;
    conn.execute(
        "UPDATE folders SET color=?1 WHERE id=?2",
        rusqlite::params![color, id],
    ).map_err(|e| format!("[DATABASE] FOLDER_COLOR_FAILED: {}", e))?;
    drop(conn_guard);
    save_vault_internal(&state)?;
    Ok(())
}

/// Update the free-form notes / description blob attached to a node. Stored
/// as plain text in the `notes` column; the UI renders it monospace and lets
/// the user dump runbook snippets, contact info, alerts to remember, etc.
#[tauri::command]
pub async fn set_server_notes(state: tauri::State<'_, DbState>, id: i32, notes: String) -> Result<(), String> {
    let conn_guard = state.conn.lock().map_err(|_| "[STATE] LOCK_FAILED")?;
    let conn = conn_guard.as_ref().ok_or("[STATE] DATABASE_NOT_INITIALIZED")?;
    conn.execute(
        "UPDATE servers SET notes=?1 WHERE id=?2",
        rusqlite::params![notes, id],
    ).map_err(|e| format!("[DATABASE] SERVER_NOTES_FAILED: {}", e))?;
    drop(conn_guard);
    save_vault_internal(&state)?;
    Ok(())
}

/// Per-server commands auto-typed into the first terminal on initial connect.
/// Stored as a single blob (newline-separated lines); the frontend sends them
/// only for `-term-0` and only on the first open, never on reconnect. Written
/// through its own command (like set_server_notes) so it doesn't have to be
/// threaded through add_server / edit_server's positional parameter lists.
#[tauri::command]
pub async fn set_server_run_on_connect(state: tauri::State<'_, DbState>, id: i32, value: String) -> Result<(), String> {
    let conn_guard = state.conn.lock().map_err(|_| "[STATE] LOCK_FAILED")?;
    let conn = conn_guard.as_ref().ok_or("[STATE] DATABASE_NOT_INITIALIZED")?;
    conn.execute(
        "UPDATE servers SET run_on_connect=?1 WHERE id=?2",
        rusqlite::params![value, id],
    ).map_err(|e| format!("[DATABASE] SERVER_RUN_ON_CONNECT_FAILED: {}", e))?;
    drop(conn_guard);
    save_vault_internal(&state)?;
    Ok(())
}

/// ProxyJump target for a node: `Some(other_server_id)` to bounce through that
/// server, or `None` to connect directly. Written through its own command
/// (like set_server_notes / set_server_run_on_connect) so it stays out of
/// add_server / edit_server's positional parameter lists.
#[tauri::command]
pub async fn set_server_jump_host(state: tauri::State<'_, DbState>, id: i32, value: Option<i32>) -> Result<(), String> {
    let conn_guard = state.conn.lock().map_err(|_| "[STATE] LOCK_FAILED")?;
    let conn = conn_guard.as_ref().ok_or("[STATE] DATABASE_NOT_INITIALIZED")?;
    conn.execute(
        "UPDATE servers SET jump_host_id=?1 WHERE id=?2",
        rusqlite::params![value, id],
    ).map_err(|e| format!("[DATABASE] SERVER_JUMP_HOST_FAILED: {}", e))?;
    drop(conn_guard);
    save_vault_internal(&state)?;
    Ok(())
}

#[tauri::command]
pub async fn set_server_is_production(state: tauri::State<'_, DbState>, id: i32, value: bool) -> Result<(), String> {
    let conn_guard = state.conn.lock().map_err(|_| "[STATE] LOCK_FAILED")?;
    let conn = conn_guard.as_ref().ok_or("[STATE] DATABASE_NOT_INITIALIZED")?;
    let val_i: i32 = if value { 1 } else { 0 };
    conn.execute(
        "UPDATE servers SET is_production=?1 WHERE id=?2",
        rusqlite::params![val_i, id],
    ).map_err(|e| format!("[DATABASE] SERVER_IS_PRODUCTION_FAILED: {}", e))?;
    drop(conn_guard);
    save_vault_internal(&state)?;
    Ok(())
}

#[tauri::command]
pub async fn set_server_icon(state: tauri::State<'_, DbState>, id: i32, icon: Option<String>) -> Result<(), String> {
    let conn_guard = state.conn.lock().map_err(|_| "[STATE] LOCK_FAILED")?;
    let conn = conn_guard.as_ref().ok_or("[STATE] DATABASE_NOT_INITIALIZED")?;
    let icon_val = icon.filter(|s| !s.trim().is_empty());
    conn.execute(
        "UPDATE servers SET icon=?1 WHERE id=?2",
        rusqlite::params![icon_val, id],
    ).map_err(|e| format!("[DATABASE] SERVER_ICON_FAILED: {}", e))?;
    drop(conn_guard);
    save_vault_internal(&state)?;
    Ok(())
}

/// Switch a server between SSH and RDP. Anything but "rdp" is stored as "ssh".
#[tauri::command]
pub async fn set_server_protocol(state: tauri::State<'_, DbState>, id: i32, value: String) -> Result<(), String> {
    let conn_guard = state.conn.lock().map_err(|_| "[STATE] LOCK_FAILED")?;
    let conn = conn_guard.as_ref().ok_or("[STATE] DATABASE_NOT_INITIALIZED")?;
    let protocol = if value == "rdp" { "rdp" } else { "ssh" };
    conn.execute("UPDATE servers SET protocol=?1 WHERE id=?2", rusqlite::params![protocol, id])
        .map_err(|e| format!("[DATABASE] SERVER_PROTOCOL_FAILED: {}", e))?;
    drop(conn_guard);
    save_vault_internal(&state)?;
    Ok(())
}

/// Duplicate a server row verbatim — including credentials linkage, tunnels,
/// mirrors, proxy config, colour. The clone gets a "{name} (copy)" suffix so
/// it shows up beside the original in the grid; everything else is identical
/// so the user can connect to the same target with a different label or
/// tweak one field without retyping the rest.
#[tauri::command]
pub async fn clone_server(state: tauri::State<'_, DbState>, id: i32) -> Result<i64, String> {
    let conn_guard = state.conn.lock().map_err(|_| "[STATE] LOCK_FAILED")?;
    let conn = conn_guard.as_ref().ok_or("[STATE] DATABASE_NOT_INITIALIZED")?;
    let affected = conn.execute(
        "INSERT INTO servers (name, host, port, username, password, credential_id, folder_id, proxy_type, proxy_host, proxy_port, tunnels, auth_type, key_id, autostart, mirrors, color, notes, run_on_connect, jump_host_id, is_production, icon, protocol)
         SELECT name || ' (copy)', host, port, username, password, credential_id, folder_id, proxy_type, proxy_host, proxy_port, tunnels, auth_type, key_id, 0, mirrors, color, notes, run_on_connect, jump_host_id, is_production, icon, protocol
         FROM servers WHERE id = ?1",
        rusqlite::params![id],
    ).map_err(|e| format!("[DATABASE] SERVER_CLONE_FAILED: {}", e))?;
    if affected == 0 {
        return Err(format!("[DATABASE] SERVER_CLONE_FAILED: no row with id {}", id));
    }
    let new_id = conn.last_insert_rowid();
    // Place the clone at the bottom of its folder's manual order (the INSERT
    // above doesn't copy `position`, so without this it would default to 0 and
    // jump to the top). Same append logic as add_server, folder taken from the
    // clone's own row.
    let _ = conn.execute(
        "UPDATE servers SET position = COALESCE((SELECT MAX(position) FROM servers s2 WHERE s2.id != servers.id AND s2.folder_id IS servers.folder_id), -1) + 1 WHERE id = ?1",
        rusqlite::params![new_id],
    );
    drop(conn_guard);
    save_vault_internal(&state)?;
    Ok(new_id)
}

#[tauri::command]
pub async fn delete_server(
    state: tauri::State<'_, DbState>,
    map: tauri::State<'_, MonitorMap>,
    id: i32,
) -> Result<(), String> {
    // Stop the poller BEFORE the row goes away. The monitor_configs row does
    // cascade-delete with the server, but that only removes the config — the
    // spawned poller lives in MonitorMap and would keep opening SSH connections
    // to the host on its interval, using credentials the user just deleted.
    // Worse, it becomes unreachable: monitor_list JOINs servers, so the node
    // vanishes from the UI and monitor_remove (the only other caller of
    // stop_monitor) can no longer be invoked for it. Only an app restart
    // stopped it.
    monitor::stop_monitor(map.inner().clone(), id).await;

    let conn_guard = state.conn.lock().map_err(|_| "[STATE] LOCK_FAILED")?;
    let conn = conn_guard.as_ref().ok_or("[STATE] DATABASE_NOT_INITIALIZED")?;

    conn.execute("DELETE FROM servers WHERE id=?1", rusqlite::params![id])
        .map_err(|e| format!("[DATABASE] SERVER_DELETE_FAILED: {}", e))?;

    drop(conn_guard);
    save_vault_internal(&state)?;
    Ok(())
}

#[tauri::command]
pub async fn get_servers(state: tauri::State<'_, DbState>) -> Result<Vec<serde_json::Value>, String> {
    let conn_guard = state.conn.lock().map_err(|_| "[STATE] LOCK_FAILED")?;
    let conn = conn_guard.as_ref().ok_or("[STATE] DATABASE_NOT_INITIALIZED")?;
    // Secrets stay server-side: this listing returns `has_password` instead
    // of the plaintext column, so the password never crosses the IPC bridge
    // unless someone explicitly invokes `reveal_server_password`. The edit
    // panel calls reveal on open, but the cards / sidebar / quick-connect
    // grid never see the plaintext.
    // ORDER BY (position, id): `position` is the manual drag-to-reorder rank
    // (default 0 for never-reordered rows), and id breaks ties so the order is
    // stable and, before any reorder, identical to the old rowid order.
    let mut stmt = conn.prepare("SELECT id, name, host, port, username, password, credential_id, folder_id, proxy_type, proxy_host, proxy_port, tunnels, auth_type, key_id, autostart, mirrors, color, notes, run_on_connect, jump_host_id, updated_at, edited_by, position, is_production, icon, os_info, forward_agent, protocol FROM servers ORDER BY position, id")
        .map_err(|e| format!("[DATABASE] PREPARE_FAILED: {}", e))?;

    let rows = stmt.query_map([], |row| {
        let pw: Option<String> = row.get::<_, Option<String>>(5)?;
        Ok(json!({
            "id": row.get::<_, i32>(0)?,
            "name": row.get::<_, String>(1)?,
            "host": row.get::<_, String>(2)?,
            "port": row.get::<_, i32>(3)?,
            "username": row.get::<_, Option<String>>(4)?.unwrap_or_default(),
            "has_password": pw.as_deref().map(|s| !s.is_empty()).unwrap_or(false),
            "credential_id": row.get::<_, Option<i32>>(6)?,
            "folder_id": row.get::<_, Option<i32>>(7)?,
            "proxy_type": row.get::<_, Option<String>>(8)?.unwrap_or_else(|| "none".to_string()),
            "proxy_host": row.get::<_, Option<String>>(9)?.unwrap_or_default(),
            "proxy_port": row.get::<_, Option<i32>>(10)?.unwrap_or(1080),
            "tunnels": row.get::<_, Option<String>>(11)?.unwrap_or_else(|| "[]".to_string()),
            "auth_type": row.get::<_, Option<String>>(12)?.unwrap_or_else(|| "vault".to_string()),
            "key_id": row.get::<_, Option<i32>>(13)?,
            "autostart": row.get::<_, i32>(14).unwrap_or(0) != 0,
            "mirrors": row.get::<_, Option<String>>(15)?.unwrap_or_else(|| "[]".to_string()),
            "color": row.get::<_, Option<String>>(16)?,
            "notes": row.get::<_, Option<String>>(17)?.unwrap_or_default(),
            "run_on_connect": row.get::<_, Option<String>>(18)?.unwrap_or_default(),
            "jump_host_id": row.get::<_, Option<i32>>(19)?,
            // Attribution: HLC stamp (encodes last-edit time) + who last edited.
            "updated_at": row.get::<_, Option<String>>(20)?,
            "edited_by": row.get::<_, Option<String>>(21)?,
            // Manual drag-to-reorder rank (see ORDER BY above).
            "position": row.get::<_, i64>(22).unwrap_or(0),
            "is_production": row.get::<_, Option<i32>>(23)?.unwrap_or(0) != 0,
            "icon": row.get::<_, Option<String>>(24)?.unwrap_or_else(|| "server".to_string()),
            "os_info": row.get::<_, Option<String>>(25)?.unwrap_or_default(),
            "forward_agent": row.get::<_, Option<i32>>(26)?.unwrap_or(0) != 0,
            "protocol": row.get::<_, Option<String>>(27)?.unwrap_or_else(|| "ssh".to_string()),
        }))
    }).map_err(|e| format!("[DATABASE] QUERY_MAPPING_FAILED: {}", e))?;

    let mut list = Vec::new();
    for r in rows {
        list.push(r.map_err(|e| format!("[DATABASE] ROW_FETCH_FAILED: {}", e))?);
    }
    Ok(list)
}

#[tauri::command]
pub async fn get_ssh_keys(state: tauri::State<'_, DbState>) -> Result<Vec<serde_json::Value>, String> {
    let conn_guard = state.conn.lock().map_err(|_| "[STATE] LOCK_FAILED")?;
    let conn = conn_guard.as_ref().ok_or("[STATE] DATABASE_NOT_INITIALIZED")?;
    // Private key + passphrase do NOT cross IPC in the listing — only the
    // public key (which is safe by definition) and presence flags. The edit
    // sheet calls `reveal_ssh_key` when it needs the secrets to display.
    let mut stmt = conn.prepare("SELECT id, name, public_key, private_key, passphrase FROM ssh_keys").map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], |row| {
        let priv_present: Option<String> = row.get::<_, Option<String>>(3)?;
        let pp_present: Option<String> = row.get::<_, Option<String>>(4)?;
        Ok(json!({
            "id": row.get::<_, i32>(0)?,
            "name": row.get::<_, String>(1)?,
            "public_key": row.get::<_, String>(2)?,
            "has_private_key": priv_present.as_deref().map(|s| !s.is_empty()).unwrap_or(false),
            "has_passphrase": pp_present.as_deref().map(|s| !s.is_empty()).unwrap_or(false),
        }))
    }).map_err(|e| e.to_string())?;
    
    let mut list = Vec::new();
    for r in rows {
        list.push(r.map_err(|e| format!("[DATABASE] ROW_FETCH_FAILED: {}", e))?);
    }
    Ok(list)
}

#[tauri::command]
pub async fn get_credentials(state: tauri::State<'_, DbState>) -> Result<Vec<serde_json::Value>, String> {
    let conn_guard = state.conn.lock().map_err(|_| "[STATE] LOCK_FAILED")?;
    let conn = conn_guard.as_ref().ok_or("[STATE] DATABASE_NOT_INITIALIZED")?;
    // Same pattern as get_servers / get_ssh_keys: only `has_password` is
    // listed. The credential edit panel reveals on open via the dedicated
    // command.
    let mut stmt = conn.prepare("SELECT id, name, auth_type, username, password, key_id FROM credentials").map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], |row| {
        let pw: Option<String> = row.get::<_, Option<String>>(4)?;
        Ok(json!({
            "id": row.get::<_, i32>(0)?,
            "name": row.get::<_, String>(1)?,
            "auth_type": row.get::<_, String>(2)?,
            "username": row.get::<_, String>(3)?,
            "has_password": pw.as_deref().map(|s| !s.is_empty()).unwrap_or(false),
            "key_id": row.get::<_, Option<i32>>(5)?
        }))
    }).map_err(|e| e.to_string())?;
    
    let mut list = Vec::new();
    for r in rows {
        list.push(r.map_err(|e| format!("[DATABASE] ROW_FETCH_FAILED: {}", e))?);
    }
    Ok(list)
}

#[tauri::command]
pub async fn add_credential(state: tauri::State<'_, DbState>, name: String, auth_type: String, username: String, password: Option<String>, key_id: Option<i32>) -> Result<(), String> {
    let conn_guard = state.conn.lock().map_err(|_| "[STATE] LOCK_FAILED")?;
    let conn = conn_guard.as_ref().ok_or("[STATE] DATABASE_NOT_INITIALIZED")?;
    
    conn.execute("INSERT INTO credentials (name, auth_type, username, password, key_id) VALUES (?1, ?2, ?3, ?4, ?5)", rusqlite::params![name, auth_type, username, password, key_id])
        .map_err(|e| format!("[DATABASE] CREDENTIAL_INSERT_FAILED: {}", e))?;
    
    drop(conn_guard);
    save_vault_internal(&state)?;
    Ok(())
}

#[tauri::command]
pub async fn edit_credential(state: tauri::State<'_, DbState>, id: i32, name: String, auth_type: String, username: String, password: Option<String>, key_id: Option<i32>) -> Result<(), String> {
    let conn_guard = state.conn.lock().map_err(|_| "[STATE] LOCK_FAILED")?;
    let conn = conn_guard.as_ref().ok_or("[STATE] DATABASE_NOT_INITIALIZED")?;
    
    conn.execute("UPDATE credentials SET name=?1, auth_type=?2, username=?3, password=?4, key_id=?5 WHERE id=?6", rusqlite::params![name, auth_type, username, password, key_id, id])
        .map_err(|e| format!("[DATABASE] CREDENTIAL_UPDATE_FAILED: {}", e))?;
    
    drop(conn_guard);
    save_vault_internal(&state)?;
    Ok(())
}

#[tauri::command]
pub async fn delete_credential(state: tauri::State<'_, DbState>, id: i32) -> Result<(), String> {
    let conn_guard = state.conn.lock().map_err(|_| "[STATE] LOCK_FAILED")?;
    let conn = conn_guard.as_ref().ok_or("[STATE] DATABASE_NOT_INITIALIZED")?;
    
    conn.execute("DELETE FROM credentials WHERE id=?1", rusqlite::params![id])
        .map_err(|e| format!("[DATABASE] CREDENTIAL_DELETE_FAILED: {}", e))?;
    
    drop(conn_guard);
    save_vault_internal(&state)?;
    Ok(())
}

#[tauri::command]
pub async fn add_folder(state: tauri::State<'_, DbState>, name: String, parent_id: Option<i32>) -> Result<(), String> {
    let conn_guard = state.conn.lock().map_err(|_| "[STATE] LOCK_FAILED")?;
    let conn = conn_guard.as_ref().ok_or("[STATE] DATABASE_NOT_INITIALIZED")?;
    
    conn.execute(
        "INSERT INTO folders (name, parent_id) VALUES (?1, ?2)",
        rusqlite::params![name, parent_id],
    ).map_err(|e| format!("[DATABASE] FOLDER_INSERT_FAILED: {}", e))?;
    
    drop(conn_guard);
    save_vault_internal(&state)?;
    Ok(())
}

#[tauri::command]
pub async fn rename_folder(state: tauri::State<'_, DbState>, id: i32, name: String) -> Result<(), String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("[VALIDATION] FOLDER_NAME_EMPTY".into());
    }
    let conn_guard = state.conn.lock().map_err(|_| "[STATE] LOCK_FAILED")?;
    let conn = conn_guard.as_ref().ok_or("[STATE] DATABASE_NOT_INITIALIZED")?;
    let affected = conn.execute(
        "UPDATE folders SET name=?1 WHERE id=?2",
        rusqlite::params![trimmed, id],
    ).map_err(|e| format!("[DATABASE] FOLDER_RENAME_FAILED: {}", e))?;
    if affected == 0 {
        return Err(format!("[DATABASE] FOLDER_RENAME_FAILED: no folder with id {}", id));
    }
    drop(conn_guard);
    save_vault_internal(&state)?;
    Ok(())
}

#[tauri::command]
pub async fn delete_folder(
    state: tauri::State<'_, DbState>,
    map: tauri::State<'_, MonitorMap>,
    id: i32,
) -> Result<(), String> {
    // Same orphaned-poller problem as delete_server, one level up: this deletes
    // every server in the folder, so every one of their monitors has to be
    // stopped first. Collect the ids while the rows still exist.
    let doomed: Vec<i32> = {
        let conn_guard = state.conn.lock().map_err(|_| "[STATE] LOCK_FAILED")?;
        let conn = conn_guard.as_ref().ok_or("[STATE] DATABASE_NOT_INITIALIZED")?;
        let mut stmt = conn
            .prepare("SELECT id FROM servers WHERE folder_id=?1")
            .map_err(|e| format!("[DATABASE] FOLDER_SERVERS_QUERY_FAILED: {}", e))?;
        let rows = stmt
            .query_map(rusqlite::params![id], |r| r.get::<_, i32>(0))
            .map_err(|e| format!("[DATABASE] FOLDER_SERVERS_QUERY_FAILED: {}", e))?;
        rows.filter_map(|r| r.ok()).collect()
    };
    for node_id in doomed {
        monitor::stop_monitor(map.inner().clone(), node_id).await;
    }

    let conn_guard = state.conn.lock().map_err(|_| "[STATE] LOCK_FAILED")?;
    let conn = conn_guard.as_ref().ok_or("[STATE] DATABASE_NOT_INITIALIZED")?;

    // First, delete all servers in this folder
    conn.execute("DELETE FROM servers WHERE folder_id=?1", rusqlite::params![id])
        .map_err(|e| format!("[DATABASE] FOLDER_SERVERS_DELETE_FAILED: {}", e))?;

    // Then delete the folder
    conn.execute("DELETE FROM folders WHERE id=?1", rusqlite::params![id])
        .map_err(|e| format!("[DATABASE] FOLDER_DELETE_FAILED: {}", e))?;

    drop(conn_guard);
    save_vault_internal(&state)?;
    Ok(())
}

#[tauri::command]
pub async fn get_folders(state: tauri::State<'_, DbState>) -> Result<Vec<serde_json::Value>, String> {
    let conn_guard = state.conn.lock().map_err(|_| "[STATE] LOCK_FAILED")?;
    let conn = conn_guard.as_ref().ok_or("[STATE] DATABASE_NOT_INITIALIZED")?;
    let mut stmt = conn.prepare("SELECT id, name, parent_id, color FROM folders").map_err(|e| e.to_string())?;

    let rows = stmt.query_map([], |row| {
        Ok(json!({
            "id": row.get::<_, i32>(0)?,
            "name": row.get::<_, String>(1)?,
            "parent_id": row.get::<_, Option<i32>>(2)?,
            "color": row.get::<_, Option<String>>(3)?,
        }))
    }).map_err(|e| e.to_string())?;
    
    let mut list = Vec::new();
    for r in rows {
        list.push(r.map_err(|e| format!("[DATABASE] ROW_FETCH_FAILED: {}", e))?);
    }
    Ok(list)
}

#[tauri::command]
pub async fn add_command(state: tauri::State<'_, DbState>, title: String, content: String, server_id: Option<i32>, tags: Option<String>) -> Result<(), String> {
    let conn_guard = state.conn.lock().map_err(|_| "[STATE] LOCK_FAILED")?;
    let conn = conn_guard.as_ref().ok_or("[STATE] DATABASE_NOT_INITIALIZED")?;

    conn.execute(
        "INSERT INTO commands (title, content, server_id, tags) VALUES (?1, ?2, ?3, ?4)",
        rusqlite::params![title, content, server_id, tags.unwrap_or_default()],
    ).map_err(|e| format!("[DATABASE] COMMAND_INSERT_FAILED: {}", e))?;

    drop(conn_guard);
    save_vault_internal(&state)?;
    Ok(())
}

#[tauri::command]
pub async fn edit_command(state: tauri::State<'_, DbState>, id: i32, title: String, content: String, server_id: Option<i32>, tags: Option<String>) -> Result<(), String> {
    let conn_guard = state.conn.lock().map_err(|_| "[STATE] LOCK_FAILED")?;
    let conn = conn_guard.as_ref().ok_or("[STATE] DATABASE_NOT_INITIALIZED")?;

    conn.execute(
        "UPDATE commands SET title=?1, content=?2, server_id=?3, tags=?4 WHERE id=?5",
        rusqlite::params![title, content, server_id, tags.unwrap_or_default(), id],
    ).map_err(|e| format!("[DATABASE] COMMAND_UPDATE_FAILED: {}", e))?;

    drop(conn_guard);
    save_vault_internal(&state)?;
    Ok(())
}

#[tauri::command]
pub async fn delete_command(state: tauri::State<'_, DbState>, id: i32) -> Result<(), String> {
    let conn_guard = state.conn.lock().map_err(|_| "[STATE] LOCK_FAILED")?;
    let conn = conn_guard.as_ref().ok_or("[STATE] DATABASE_NOT_INITIALIZED")?;
    
    conn.execute(
        "DELETE FROM commands WHERE id=?1",
        rusqlite::params![id],
    ).map_err(|e| format!("[DATABASE] COMMAND_DELETE_FAILED: {}", e))?;
    
    drop(conn_guard);
    save_vault_internal(&state)?;
    Ok(())
}

#[tauri::command]
pub async fn get_commands(state: tauri::State<'_, DbState>) -> Result<Vec<serde_json::Value>, String> {
    let conn_guard = state.conn.lock().map_err(|_| "[STATE] LOCK_FAILED")?;
    let conn = conn_guard.as_ref().ok_or("[STATE] DATABASE_NOT_INITIALIZED")?;
    let mut stmt = conn.prepare("SELECT id, title, content, server_id, tags FROM commands").map_err(|e| e.to_string())?;

    let rows = stmt.query_map([], |row| {
        Ok(json!({
            "id": row.get::<_, i32>(0)?,
            "title": row.get::<_, String>(1)?,
            "content": row.get::<_, String>(2)?,
            "serverId": row.get::<_, Option<i32>>(3)?,
            "tags": row.get::<_, String>(4)?,
        }))
    }).map_err(|e| e.to_string())?;
    
    let mut list = Vec::new();
    for r in rows {
        list.push(r.map_err(|e| format!("[DATABASE] ROW_FETCH_FAILED: {}", e))?);
    }
    Ok(list)
}

// ───────────────────────── Command History ─────────────────────────
// Ctrl+R-style rolling log of commands the user typed into any terminal.
// Populated best-effort by TerminalView (buffered keystrokes → Enter →
// insert). Read by HistorySearchOverlay through the three commands below.
// Capped at 1000 rows — dropping the oldest — so a chatty user can't blow
// the vault size up over months of use.

const CMD_HISTORY_CAP: i64 = 1000;

#[tauri::command]
pub async fn cmd_history_add(
    state: tauri::State<'_, DbState>,
    server_id: Option<i32>,
    server_name: String,
    command: String,
) -> Result<i64, String> {
    let trimmed = command.trim().to_string();
    if trimmed.is_empty() {
        return Err("[HISTORY] EMPTY_COMMAND".into());
    }
    let ts: i64 = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);

    let conn_guard = state.conn.lock().map_err(|_| "[STATE] LOCK_FAILED")?;
    let conn = conn_guard.as_ref().ok_or("[STATE] DATABASE_NOT_INITIALIZED")?;

    // De-dupe against the immediately-previous row for the same server so a
    // user re-running `ls` five times in a row doesn't fill five slots. Match
    // by (server_id, command); leave older reruns alone so search still finds
    // "ran this yesterday morning too".
    let last: Option<(i64, String, Option<i32>)> = conn.query_row(
        "SELECT id, command, server_id FROM cmd_history ORDER BY ts DESC LIMIT 1",
        [],
        |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?, row.get::<_, Option<i32>>(2)?)),
    ).ok();
    if let Some((id, prev_cmd, prev_sid)) = last {
        if prev_cmd == trimmed && prev_sid == server_id {
            // Refresh the timestamp on the existing row instead of writing a
            // duplicate — keeps the "most recent first" ordering honest.
            let _ = conn.execute(
                "UPDATE cmd_history SET ts = ?1 WHERE id = ?2",
                rusqlite::params![ts, id],
            );
            return Ok(id);
        }
    }

    conn.execute(
        "INSERT INTO cmd_history (server_id, server_name, command, ts) VALUES (?1, ?2, ?3, ?4)",
        rusqlite::params![server_id, server_name, trimmed, ts],
    ).map_err(|e| format!("[DATABASE] CMD_HISTORY_INSERT_FAILED: {}", e))?;

    let new_id = conn.last_insert_rowid();

    // Prune the tail so the table stays bounded. LIMIT/OFFSET in a subquery
    // gives us "keep the newest N, drop everything older".
    let _ = conn.execute(
        "DELETE FROM cmd_history WHERE id IN (
            SELECT id FROM cmd_history ORDER BY ts DESC LIMIT -1 OFFSET ?1
        )",
        rusqlite::params![CMD_HISTORY_CAP],
    );

    // History isn't secret but the encrypted vault is the only place it can
    // land; we DO NOT call save_vault_internal on every keystroke — that'd
    // fsync per command and thrash disk. The next save_vault_* call (any
    // node edit, key add, etc., or profile-close teardown) picks it up.
    Ok(new_id)
}

#[tauri::command]
pub async fn cmd_history_list(
    state: tauri::State<'_, DbState>,
    query: Option<String>,
    limit: Option<u32>,
) -> Result<Vec<serde_json::Value>, String> {
    let conn_guard = state.conn.lock().map_err(|_| "[STATE] LOCK_FAILED")?;
    let conn = conn_guard.as_ref().ok_or("[STATE] DATABASE_NOT_INITIALIZED")?;

    let lim = limit.unwrap_or(200).min(1000) as i64;
    let q = query.unwrap_or_default();
    let q_trimmed = q.trim();

    let rows: Vec<serde_json::Value> = if q_trimmed.is_empty() {
        let mut stmt = conn.prepare(
            "SELECT id, server_id, server_name, command, ts, exit_code
             FROM cmd_history
             ORDER BY ts DESC LIMIT ?1"
        ).map_err(|e| format!("[DATABASE] CMD_HISTORY_PREP_FAILED: {}", e))?;
        let mapped = stmt.query_map(rusqlite::params![lim], |row| {
            Ok(json!({
                "id": row.get::<_, i64>(0)?,
                "server_id": row.get::<_, Option<i32>>(1)?,
                "server_name": row.get::<_, Option<String>>(2)?,
                "command": row.get::<_, String>(3)?,
                "ts": row.get::<_, i64>(4)?,
                "exit_code": row.get::<_, Option<i32>>(5)?,
            }))
        }).map_err(|e| format!("[DATABASE] CMD_HISTORY_QUERY_FAILED: {}", e))?;
        let mut out = Vec::new();
        for r in mapped {
            out.push(r.map_err(|e| format!("[DATABASE] CMD_HISTORY_ROW_FAILED: {}", e))?);
        }
        out
    } else {
        // Escape LIKE metacharacters (%, _, backslash) so the user's raw
        // input matches literally. Uses `\` as the escape character.
        let escaped = q_trimmed
            .replace('\\', "\\\\")
            .replace('%', "\\%")
            .replace('_', "\\_");
        let like = format!("%{}%", escaped);
        let mut stmt = conn.prepare(
            "SELECT id, server_id, server_name, command, ts, exit_code
             FROM cmd_history
             WHERE command LIKE ?1 ESCAPE '\\'
             ORDER BY ts DESC LIMIT ?2"
        ).map_err(|e| format!("[DATABASE] CMD_HISTORY_PREP_FAILED: {}", e))?;
        let mapped = stmt.query_map(rusqlite::params![like, lim], |row| {
            Ok(json!({
                "id": row.get::<_, i64>(0)?,
                "server_id": row.get::<_, Option<i32>>(1)?,
                "server_name": row.get::<_, Option<String>>(2)?,
                "command": row.get::<_, String>(3)?,
                "ts": row.get::<_, i64>(4)?,
                "exit_code": row.get::<_, Option<i32>>(5)?,
            }))
        }).map_err(|e| format!("[DATABASE] CMD_HISTORY_QUERY_FAILED: {}", e))?;
        let mut out = Vec::new();
        for r in mapped {
            out.push(r.map_err(|e| format!("[DATABASE] CMD_HISTORY_ROW_FAILED: {}", e))?);
        }
        out
    };
    Ok(rows)
}

#[tauri::command]
pub async fn cmd_history_clear(state: tauri::State<'_, DbState>) -> Result<(), String> {
    let conn_guard = state.conn.lock().map_err(|_| "[STATE] LOCK_FAILED")?;
    let conn = conn_guard.as_ref().ok_or("[STATE] DATABASE_NOT_INITIALIZED")?;
    conn.execute("DELETE FROM cmd_history", [])
        .map_err(|e| format!("[DATABASE] CMD_HISTORY_CLEAR_FAILED: {}", e))?;
    drop(conn_guard);
    save_vault_internal(&state)?;
    Ok(())
}

// ───────────────────────── Notes ─────────────────────────
// Free-form text notes stored alongside the rest of the profile. Mirrors the
// commands CRUD shape exactly — title + body, no FK, no timestamps. Search
// is done client-side over the returned list so the user can match against
// title and body in one go without us pushing a LIKE query through SQLite.

#[tauri::command]
pub async fn add_note(state: tauri::State<'_, DbState>, title: String, body: String) -> Result<(), String> {
    let conn_guard = state.conn.lock().map_err(|_| "[STATE] LOCK_FAILED")?;
    let conn = conn_guard.as_ref().ok_or("[STATE] DATABASE_NOT_INITIALIZED")?;

    conn.execute(
        "INSERT INTO notes (title, body) VALUES (?1, ?2)",
        rusqlite::params![title, body],
    ).map_err(|e| format!("[DATABASE] NOTE_INSERT_FAILED: {}", e))?;

    drop(conn_guard);
    save_vault_internal(&state)?;
    Ok(())
}

#[tauri::command]
pub async fn edit_note(state: tauri::State<'_, DbState>, id: i32, title: String, body: String) -> Result<(), String> {
    let conn_guard = state.conn.lock().map_err(|_| "[STATE] LOCK_FAILED")?;
    let conn = conn_guard.as_ref().ok_or("[STATE] DATABASE_NOT_INITIALIZED")?;

    conn.execute(
        "UPDATE notes SET title=?1, body=?2 WHERE id=?3",
        rusqlite::params![title, body, id],
    ).map_err(|e| format!("[DATABASE] NOTE_UPDATE_FAILED: {}", e))?;

    drop(conn_guard);
    save_vault_internal(&state)?;
    Ok(())
}

#[tauri::command]
pub async fn delete_note(state: tauri::State<'_, DbState>, id: i32) -> Result<(), String> {
    let conn_guard = state.conn.lock().map_err(|_| "[STATE] LOCK_FAILED")?;
    let conn = conn_guard.as_ref().ok_or("[STATE] DATABASE_NOT_INITIALIZED")?;

    conn.execute(
        "DELETE FROM notes WHERE id=?1",
        rusqlite::params![id],
    ).map_err(|e| format!("[DATABASE] NOTE_DELETE_FAILED: {}", e))?;

    drop(conn_guard);
    save_vault_internal(&state)?;
    Ok(())
}

#[tauri::command]
pub async fn get_notes(state: tauri::State<'_, DbState>) -> Result<Vec<serde_json::Value>, String> {
    let conn_guard = state.conn.lock().map_err(|_| "[STATE] LOCK_FAILED")?;
    let conn = conn_guard.as_ref().ok_or("[STATE] DATABASE_NOT_INITIALIZED")?;
    // Newest first — matches how users think about notes (last-touched up top).
    let mut stmt = conn.prepare("SELECT id, title, body FROM notes ORDER BY id DESC").map_err(|e| e.to_string())?;

    let rows = stmt.query_map([], |row| {
        Ok(json!({
            "id": row.get::<_, i32>(0)?,
            "title": row.get::<_, String>(1)?,
            "body": row.get::<_, String>(2)?
        }))
    }).map_err(|e| e.to_string())?;

    let mut list = Vec::new();
    for r in rows {
        list.push(r.map_err(|e| format!("[DATABASE] ROW_FETCH_FAILED: {}", e))?);
    }
    Ok(list)
}

#[tauri::command]
pub async fn update_server_os_info(
    state: tauri::State<'_, DbState>,
    id: i32,
    os_info: String,
) -> Result<(), String> {
    let conn_guard = state.conn.lock().map_err(|_| "[STATE] LOCK_FAILED")?;
    let conn = conn_guard.as_ref().ok_or("[STATE] DATABASE_NOT_INITIALIZED")?;
    conn.execute(
        "UPDATE servers SET os_info = ?1 WHERE id = ?2",
        rusqlite::params![os_info, id],
    )
    .map_err(|e| format!("[DATABASE] UPDATE_SERVER_OS_INFO_FAILED: {}", e))?;
    drop(conn_guard);
    save_vault_internal(&state)?;
    Ok(())
}

/// Result of resolving a typed `ssh`/`sftp` target against `~/.ssh/config`.
#[derive(serde::Serialize)]
pub struct ResolvedSshTarget {
    pub host: String,
    pub port: i32,
    pub username: String,
    /// PEM body of the identity file, only when it exists and is not
    /// passphrase-protected; otherwise the UI asks for a password.
    pub private_key: Option<String>,
    /// True when the user typed a user name (`user@`/`-l`) or `~/.ssh/config` sets one;
    /// false when `username` is only the local-account fallback. Saved-server matching
    /// ignores the user in that case.
    pub user_explicit: bool,
}

/// Resolve what the user typed in a local shell (`ssh [-p N] [-i key] [user@]host`)
/// into a connectable target. Explicit command-line values win over
/// `~/.ssh/config`; the config only fills the gaps (alias -> HostName, User,
/// Port, IdentityFile). Targets that go through ProxyJump are rejected because
/// Quick Connect cannot represent them. Best-effort: a missing/unreadable
/// config just means the typed values are used as-is.
#[tauri::command]
pub fn resolve_ssh_target(
    host: String,
    username: Option<String>,
    port: Option<u16>,
    identity_file: Option<String>,
) -> Result<ResolvedSshTarget, String> {
    let cfg = crate::commands::sftp::parse_ssh_config(None)
        .ok()
        .and_then(|hosts| hosts.into_iter().find(|h| h.host_alias == host));

    if cfg.as_ref().and_then(|c| c.proxy_jump.as_ref()).is_some() {
        return Err("Host uses ProxyJump, which Quick Connect cannot represent".into());
    }

    let real_host = cfg.as_ref().map(|c| c.hostname.clone()).unwrap_or_else(|| host.clone());
    let port = port.or_else(|| cfg.as_ref().map(|c| c.port)).unwrap_or(22);
    let explicit_user = username
        .filter(|u| !u.trim().is_empty())
        .or_else(|| cfg.as_ref().map(|c| c.user.clone()).filter(|u| !u.trim().is_empty()));
    let user_explicit = explicit_user.is_some();
    let username = explicit_user
        .or_else(|| std::env::var("USERNAME").or_else(|_| std::env::var("USER")).ok())
        .unwrap_or_else(|| "root".to_string());

    let key_path = identity_file
        .filter(|p| !p.trim().is_empty())
        .or_else(|| cfg.as_ref().and_then(|c| c.identity_file.clone()));
    let private_key = key_path.and_then(|p| {
        let expanded = if let Some(rest) = p.strip_prefix("~/").or_else(|| p.strip_prefix("~\\")) {
            directories::UserDirs::new()?.home_dir().join(rest)
        } else {
            std::path::PathBuf::from(&p)
        };
        let pem = std::fs::read_to_string(expanded).ok()?;
        let looks_valid = pem.contains("PRIVATE KEY");
        // Encrypted keys need a passphrase we do not have.
        let encrypted = pem.contains("ENCRYPTED") || pem.contains("Proc-Type: 4,ENCRYPTED");
        (looks_valid && !encrypted && validate_ssh_private_key(&pem).is_ok()).then_some(pem)
    });

    Ok(ResolvedSshTarget { host: real_host, port: port as i32, username, private_key, user_explicit })
}

#[derive(serde::Serialize)]
pub struct SavedServerMatch {
    pub id: i32,
    pub name: String,
    pub host: String,
    pub port: i32,
    pub username: String,
}

/// Saved SSH servers that a typed `ssh` target refers to: same port and the host
/// equals the resolved host or the typed alias (or the alias equals the node's
/// name), case-insensitively. When `username` is given the node's user must match
/// too, unless the node stores none (credential-based). RDP nodes are excluded.
#[tauri::command]
pub async fn find_saved_servers(
    state: tauri::State<'_, DbState>,
    host: String,
    alias: Option<String>,
    port: i32,
    username: Option<String>,
) -> Result<Vec<SavedServerMatch>, String> {
    let conn_guard = state.conn.lock().map_err(|_| "[STATE] LOCK_FAILED")?;
    let conn = conn_guard.as_ref().ok_or("[STATE] DATABASE_NOT_INITIALIZED")?;
    find_saved_servers_in(conn, &host, alias.as_deref(), port, username.as_deref())
}

fn find_saved_servers_in(
    conn: &rusqlite::Connection,
    host: &str,
    alias: Option<&str>,
    port: i32,
    username: Option<&str>,
) -> Result<Vec<SavedServerMatch>, String> {
    let alias = alias.unwrap_or(host);
    let mut stmt = conn
        .prepare(
            "SELECT id, name, host, port, COALESCE(username,'') FROM servers              WHERE deleted = 0 AND COALESCE(protocol,'ssh') != 'rdp' AND port = ?1                AND (LOWER(host) = LOWER(?2) OR LOWER(host) = LOWER(?3) OR LOWER(name) = LOWER(?3))              ORDER BY position, id",
        )
        .map_err(|e| format!("[DATABASE] SAVED_LOOKUP_FAILED: {}", e))?;
    let rows = stmt
        .query_map(rusqlite::params![port, host, alias], |r| {
            Ok(SavedServerMatch { id: r.get(0)?, name: r.get(1)?, host: r.get(2)?, port: r.get(3)?, username: r.get(4)? })
        })
        .map_err(|e| format!("[DATABASE] SAVED_LOOKUP_FAILED: {}", e))?;
    let want = username.filter(|u| !u.trim().is_empty());
    Ok(rows
        .filter_map(|r| r.ok())
        .filter(|m| match want {
            Some(u) => m.username.is_empty() || m.username == u,
            None => true,
        })
        .collect())
}

#[cfg(test)]
mod saved_server_lookup_tests {
    use super::*;

    fn db() -> rusqlite::Connection {
        let c = rusqlite::Connection::open_in_memory().unwrap();
        c.execute_batch(
            "CREATE TABLE servers (id INTEGER PRIMARY KEY, name TEXT, host TEXT, port INTEGER, username TEXT,                 protocol TEXT, deleted INTEGER DEFAULT 0, position INTEGER DEFAULT 0);
             INSERT INTO servers (id,name,host,port,username,protocol) VALUES
               (1,'web','10.0.0.11',22,'root','ssh'),
               (2,'web-alt','10.0.0.11',22,'deploy','ssh'),
               (3,'db','10.0.0.12',2222,'','ssh'),
               (4,'win','10.0.0.13',3389,'admin','rdp'),
               (5,'old','10.0.0.14',22,'root','ssh');
             UPDATE servers SET deleted = 1 WHERE id = 5;",
        )
        .unwrap();
        c
    }

    fn ids(v: Vec<SavedServerMatch>) -> Vec<i32> { v.into_iter().map(|m| m.id).collect() }

    #[test]
    fn matches_by_host_and_ignores_user_when_not_typed() {
        assert_eq!(ids(find_saved_servers_in(&db(), "10.0.0.11", None, 22, None).unwrap()), vec![1, 2]);
    }

    #[test]
    fn typed_user_must_match() {
        assert_eq!(ids(find_saved_servers_in(&db(), "10.0.0.11", None, 22, Some("deploy")).unwrap()), vec![2]);
        assert!(find_saved_servers_in(&db(), "10.0.0.11", None, 22, Some("nobody")).unwrap().is_empty());
    }

    #[test]
    fn node_without_a_stored_user_matches_any_typed_user() {
        assert_eq!(ids(find_saved_servers_in(&db(), "10.0.0.12", None, 2222, Some("bob")).unwrap()), vec![3]);
    }

    #[test]
    fn matches_alias_to_node_name_and_is_case_insensitive() {
        assert_eq!(ids(find_saved_servers_in(&db(), "10.0.0.11", Some("WEB"), 22, Some("root")).unwrap()), vec![1]);
    }

    #[test]
    fn port_must_match_and_rdp_and_deleted_are_excluded() {
        assert!(find_saved_servers_in(&db(), "10.0.0.11", None, 2200, None).unwrap().is_empty());
        assert!(find_saved_servers_in(&db(), "10.0.0.13", None, 3389, None).unwrap().is_empty());
        assert!(find_saved_servers_in(&db(), "10.0.0.14", None, 22, None).unwrap().is_empty());
    }
}
