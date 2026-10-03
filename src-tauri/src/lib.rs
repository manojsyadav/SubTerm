// windows_subsystem is bin-only; the matching attribute lives in main.rs.

use zeroize::{Zeroize, Zeroizing};
use rand::Rng;
use rusqlite::{Connection, DatabaseName};
use std::sync::Mutex as StdMutex;
use std::path::PathBuf;
use std::fs;
use tauri::Manager;
mod ssh_manager;
mod tunnel;
mod monitor;
mod cloud;
mod cloud_config;
mod about;
mod mirror;
mod docker;
mod hlc;
mod identity;
mod vault;
mod commands;
pub use commands::tunnels::start_tunnel_specs_on;
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

// ---------------------------------------------------------------------------
// Per-entity sync foundation (uuid + HLC + tombstone)
// ---------------------------------------------------------------------------

/// The vault tables that participate in per-entity Last-Write-Wins sync. Each
/// carries the `uuid` (portable identity) / `updated_at` (HLC) / `deleted`
/// (tombstone) columns. `known_hosts`, `cmd_history`, `monitor_settings`, and
/// `schema_meta` are intentionally device-local and NOT synced.
const SYNCED_TABLES: &[&str] = &[
    "folders", "ssh_keys", "credentials", "servers", "commands", "notes", "monitor_configs",
];

/// Opaque 128-bit hex id for a synced row. Not RFC-4122 formatted — we only
/// need global uniqueness, and this matches the app's existing random-id idiom
/// (see `app_temp_root`).
fn new_entity_uuid() -> String {
    let mut bytes = [0u8; 16];
    rand::thread_rng().fill(&mut bytes);
    hex::encode(bytes)
}

/// Load — or generate once — this device's stable sync node id. Stored in a
/// device-local sidecar next to the cloud token, deliberately OUTSIDE the vault
/// so it never travels when a vault is copied/restored to another device (two
/// devices sharing a node id would make HLC tie-breaks collide and corrupt the
/// causal order).
fn sync_device_node_id(app: &tauri::AppHandle) -> String {
    use tauri::Manager as _;
    let fresh = || {
        let mut b = [0u8; 8];
        rand::thread_rng().fill(&mut b);
        hex::encode(b)
    };
    let Ok(dir) = app.path().app_data_dir() else { return fresh() };
    let path = dir.join("sync_device.json");
    if let Ok(bytes) = std::fs::read(&path) {
        if let Ok(v) = serde_json::from_slice::<serde_json::Value>(&bytes) {
            if let Some(id) = v.get("node_id").and_then(|x| x.as_str()) {
                if !id.is_empty() {
                    return id.to_string();
                }
            }
        }
    }
    let id = fresh();
    let _ = std::fs::create_dir_all(&dir);
    let _ = std::fs::write(&path, serde_json::json!({ "node_id": id }).to_string());
    id
}

/// Stamp given to every backfilled row: the floor of the clock, not `now`.
///
/// A row with `uuid IS NULL` has never taken part in sync, so we know nothing
/// about when it was last edited — only that it predates the sync era. Stamping
/// it `now` (which is what we used to do) told the merge engine the exact
/// opposite: that a vault which had been sitting untouched on a shelf held the
/// freshest copy of every row in it. Opening an old backup on a second device
/// was then enough to have it overwrite current data everywhere.
///
/// The floor is the honest answer: these rows lose every LWW comparison against
/// anything that has actually been synced, and win only against nothing at all
/// (a first-ever sync, where they upload unopposed). One tick above the reserved
/// escrow stamp so the escrow record still sorts first.
const BACKFILL_UAT: &str = "000000000000001:00000:backfill";

/// Columns that identify a row well enough to recognise "the same thing" in a
/// copy of this vault sitting on another device. Used only by the backfill —
/// see `derived_entity_uuid`.
fn backfill_identity_cols(table: &str) -> &'static [&'static str] {
    match table {
        "folders" => &["name"],
        "ssh_keys" => &["name", "public_key"],
        "credentials" => &["name", "username", "auth_type"],
        "servers" => &["name", "host", "port", "username"],
        "commands" => &["title", "content"],
        "notes" => &["title"],
        // monitor_configs hangs off a server; its identity is that server's.
        "monitor_configs" => &[],
        _ => &[],
    }
}

/// Deterministic 128-bit id derived from a row's identifying content.
///
/// Random ids were the second half of the same bug as `BACKFILL_UAT`. Two
/// devices holding copies of the same pre-sync vault would each mint a DIFFERENT
/// uuid for what is plainly the same server, so the merge engine saw two
/// unrelated entities and kept both: every row duplicated, and rows deleted on
/// one device came back from the other because the tombstone was keyed to a uuid
/// the second device had never heard of.
///
/// Hashing the identifying columns instead makes both devices arrive at the same
/// id independently, so the row merges (and its tombstone applies) as intended.
/// A hash collision means two rows agreeing on every identifying field, which is
/// the case where merging them is correct anyway — and the caller still falls
/// back to a random id if two rows in the SAME table derive the same uuid, so a
/// collision can never silently fuse two local rows into one.
fn derived_entity_uuid(table: &str, values: &[Option<String>]) -> Option<String> {
    use sha2::{Digest, Sha256};
    // Nothing identifying to hash (all NULL/empty) → caller uses a random id.
    if values.iter().all(|v| v.as_deref().unwrap_or("").is_empty()) {
        return None;
    }
    let mut h = Sha256::new();
    h.update(b"submarine-backfill-v1\0");
    h.update(table.as_bytes());
    for v in values {
        h.update(b"\0");
        h.update(v.as_deref().unwrap_or("").as_bytes());
    }
    Some(hex::encode(&h.finalize()[..16]))
}

/// One-time backfill: give a uuid + HLC stamp to every existing synced row that
/// predates the sync columns (i.e. `uuid IS NULL`). Idempotent. Returns whether
/// anything changed, so the caller can force a resave to persist the ids.
///
/// Both the id and the stamp are chosen so that adopting an OLD copy of a vault
/// is a safe, boring operation — see `derived_entity_uuid` and `BACKFILL_UAT`.
fn backfill_sync_columns(conn: &Connection, _hlc: &hlc::Hlc) -> Result<bool, String> {
    let mut changed = false;
    for table in SYNCED_TABLES {
        let pk = if *table == "monitor_configs" { "node_id" } else { "id" };
        let idcols = backfill_identity_cols(table);
        // monitor_configs inherits its server's identity; servers are backfilled
        // earlier in SYNCED_TABLES, so that uuid is already in place here.
        let select_ids = if *table == "monitor_configs" {
            "(SELECT s.uuid FROM servers s WHERE s.id = t.node_id)".to_string()
        } else if idcols.is_empty() {
            "NULL".to_string()
        } else {
            idcols.iter().map(|c| format!("t.{c}")).collect::<Vec<_>>().join(", ")
        };
        let ncols = if *table == "monitor_configs" || idcols.is_empty() { 1 } else { idcols.len() };

        // Snapshot the PKs + identity values first — can't hold the SELECT
        // statement open across the per-row UPDATE on the same connection.
        let rows: Vec<(i64, Vec<Option<String>>)> = {
            let mut stmt = conn
                .prepare(&format!(
                    "SELECT t.{pk}, {select_ids} FROM {table} t WHERE t.uuid IS NULL ORDER BY t.{pk}"
                ))
                .map_err(|e| format!("[SYNC] BACKFILL_SELECT {table}: {e}"))?;
            let mapped = stmt
                .query_map([], |r| {
                    let id: i64 = r.get(0)?;
                    let mut vals = Vec::with_capacity(ncols);
                    for i in 0..ncols {
                        // Read as a value first so INTEGER columns (servers.port)
                        // don't fail the String conversion.
                        vals.push(match r.get_ref(i + 1)? {
                            rusqlite::types::ValueRef::Null => None,
                            other => Some(match other {
                                rusqlite::types::ValueRef::Integer(n) => n.to_string(),
                                rusqlite::types::ValueRef::Real(f) => f.to_string(),
                                v => String::from_utf8_lossy(v.as_bytes().unwrap_or(b"")).into_owned(),
                            }),
                        });
                    }
                    Ok((id, vals))
                })
                .map_err(|e| format!("[SYNC] BACKFILL_QUERY {table}: {e}"))?;
            mapped.filter_map(|r| r.ok()).collect()
        };

        let mut used: std::collections::HashSet<String> = std::collections::HashSet::new();
        for (id, vals) in rows {
            // Derived id when the row has identifying content and no other row in
            // this table already claimed it; a random one otherwise. Falling back
            // costs us a duplicate on the next device, which is recoverable —
            // fusing two distinct rows would not be.
            let uuid = derived_entity_uuid(table, &vals)
                .filter(|u| !used.contains(u))
                .unwrap_or_else(new_entity_uuid);
            used.insert(uuid.clone());
            conn.execute(
                &format!("UPDATE {table} SET uuid=?1, updated_at=?2 WHERE {pk}=?3"),
                rusqlite::params![uuid, BACKFILL_UAT, id],
            )
            .map_err(|e| format!("[SYNC] BACKFILL_UPDATE {table}: {e}"))?;
            changed = true;
        }
    }
    Ok(changed)
}

/// Register the SQLite custom functions the auto-stamp triggers call. Must run
/// on every freshly-opened connection — custom functions are per-connection
/// state, not stored in the serialized DB, whereas the triggers (which call
/// them) ARE serialized and survive across opens. `hlc_now()` returns this
/// profile's next monotonic stamp; `sync_new_uuid()` mints a fresh row id.
fn register_sync_functions(conn: &Connection, hlc: &std::sync::Arc<hlc::Hlc>) -> Result<(), String> {
    use rusqlite::functions::FunctionFlags;
    let h = hlc.clone();
    conn.create_scalar_function("hlc_now", 0, FunctionFlags::empty(), move |_| Ok(h.tick()))
        .map_err(|e| format!("[SYNC] FN_HLC: {e}"))?;
    conn.create_scalar_function("sync_new_uuid", 0, FunctionFlags::empty(), move |_| Ok(new_entity_uuid()))
        .map_err(|e| format!("[SYNC] FN_UUID: {e}"))?;
    // Deterministic id for a row whose identity is really its parent's.
    // `monitor_configs` is 1:1 with a server, so two devices that each switch
    // monitoring on for the same server must arrive at the SAME id — otherwise
    // they'd be two unrelated configs fighting over one `node_id` primary key.
    // Hashed with the table name so it can never collide with the server's own
    // uuid in the cloud's record store.
    conn.create_scalar_function("sync_derived_uuid", 2, FunctionFlags::empty(), move |ctx| {
        let table = ctx.get::<String>(0).unwrap_or_default();
        let seed = ctx.get::<Option<String>>(1).ok().flatten();
        // No parent uuid to derive from (a server that predates the backfill) —
        // a random id is the safe fallback, same reasoning as the backfill's.
        Ok(derived_entity_uuid(&table, &[seed]).unwrap_or_else(new_entity_uuid))
    })
    .map_err(|e| format!("[SYNC] FN_DERIVED_UUID: {e}"))?;
    Ok(())
}

/// Create the tombstone side-table + the per-table auto-stamp triggers
/// (idempotent). This is the whole per-entity instrumentation, centralised:
///   - AFTER INSERT  → assign a uuid + HLC stamp (skipped when the row already
///     carries a uuid — i.e. the merge engine applying a remote insert).
///   - AFTER UPDATE  → bump the HLC, UNLESS the caller set `updated_at` itself
///     (again: the merge engine applying a remote change keeps the remote stamp).
///   - AFTER DELETE  → record a tombstone so the deletion propagates. Fires for
///     FK-cascade deletes too (monitor_configs), which the map flagged as the
///     one path that bypassed Rust. Rows are still HARD-deleted, so every
///     existing `SELECT` is untouched — the tombstone lives only in the side
///     table the sync layer reads.
/// `monitor_configs` gets a column-aware UPDATE guard so the per-open `paused`
/// reset (device-local housekeeping) never churns the stamp.
fn create_sync_triggers(conn: &Connection) -> Result<(), String> {
    conn.execute(
        "CREATE TABLE IF NOT EXISTS sync_tombstones (uuid TEXT PRIMARY KEY, entity_type TEXT NOT NULL, updated_at TEXT NOT NULL)",
        [],
    )
    .map_err(|e| format!("[SYNC] TOMBSTONE_TABLE: {e}"))?;
    // Device-local operational flags. `merge` is set to 1 while the sync engine
    // applies remote records, which the auto-stamp triggers check so they don't
    // overwrite the incoming HLC stamps with fresh local ones.
    conn.execute(
        "CREATE TABLE IF NOT EXISTS sync_flags (key TEXT PRIMARY KEY, val INTEGER NOT NULL)",
        [],
    )
    .map_err(|e| format!("[SYNC] FLAGS_TABLE: {e}"))?;
    // Ensure sync_meta exists before the triggers (which read editor_label from
    // it) are created — the convergence path also creates it, but tests call
    // create_sync_triggers directly.
    conn.execute(
        "CREATE TABLE IF NOT EXISTS sync_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
        [],
    )
    .map_err(|e| format!("[SYNC] SYNC_META_TABLE: {e}"))?;
    // Guard shared by the stamp/tombstone triggers: suppress them while merging.
    const GUARD: &str = "COALESCE((SELECT val FROM sync_flags WHERE key='merge'),0)=0";
    // The editor label stamped onto edited_by at mutation time (email when known,
    // else NULL). Kept as a subquery so it always reflects the latest value.
    const EDITOR: &str = "(SELECT value FROM sync_meta WHERE key='editor_label')";
    for t in SYNCED_TABLES {
        let au_extra = if *t == "monitor_configs" {
            " AND (NEW.enabled_metrics IS NOT OLD.enabled_metrics OR NEW.custom_metrics IS NOT OLD.custom_metrics OR NEW.deleted IS NOT OLD.deleted)"
        } else {
            ""
        };
        // A monitor config's identity is its server's, derived — see
        // `sync_derived_uuid`. Everything else mints a fresh random id.
        let new_uuid_expr = if *t == "monitor_configs" {
            "sync_derived_uuid('monitor_configs', (SELECT uuid FROM servers WHERE id = NEW.node_id))"
        } else {
            "sync_new_uuid()"
        };
        // Drop-then-create so the definition is always current across app
        // versions (CREATE IF NOT EXISTS would keep a stale earlier trigger).
        let ddl = format!(
            "DROP TRIGGER IF EXISTS {t}_sync_ai;
             DROP TRIGGER IF EXISTS {t}_sync_au;
             DROP TRIGGER IF EXISTS {t}_sync_ad;
             CREATE TRIGGER {t}_sync_ai AFTER INSERT ON {t} FOR EACH ROW WHEN NEW.uuid IS NULL AND {GUARD}
               BEGIN UPDATE {t} SET uuid = {new_uuid_expr}, updated_at = hlc_now(), edited_by = {EDITOR} WHERE rowid = NEW.rowid; END;
             CREATE TRIGGER {t}_sync_au AFTER UPDATE ON {t} FOR EACH ROW
               WHEN NEW.updated_at IS OLD.updated_at{au_extra} AND {GUARD}
               BEGIN UPDATE {t} SET updated_at = hlc_now(), edited_by = {EDITOR} WHERE rowid = NEW.rowid; END;
             CREATE TRIGGER {t}_sync_ad AFTER DELETE ON {t} FOR EACH ROW WHEN OLD.uuid IS NOT NULL AND {GUARD}
               BEGIN INSERT INTO sync_tombstones(uuid, entity_type, updated_at) VALUES (OLD.uuid, '{t}', hlc_now())
                     ON CONFLICT(uuid) DO UPDATE SET updated_at = excluded.updated_at, entity_type = excluded.entity_type; END;"
        );
        conn.execute_batch(&ddl)
            .map_err(|e| format!("[SYNC] TRIGGER {t}: {e}"))?;
        // Unique index on uuid enables ON CONFLICT(uuid) upserts in the merge
        // engine. NOT partial — SQLite treats NULLs as distinct, so pre-backfill
        // NULL uuids coexist fine, and a plain index (unlike a partial one) is a
        // valid ON CONFLICT target.
        conn.execute(
            &format!("CREATE UNIQUE INDEX IF NOT EXISTS ux_{t}_uuid ON {t}(uuid)"),
            [],
        )
        .map_err(|e| format!("[SYNC] UUID_INDEX {t}: {e}"))?;
    }
    Ok(())
}

#[cfg(test)]
mod sync_trigger_tests {
    use super::*;
    use rusqlite::Connection;

    fn setup() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        // Minimal stand-ins for the synced tables — only the columns the
        // triggers touch. monitor_configs keeps enabled_metrics/custom_metrics
        // so the column-aware UPDATE guard can be exercised.
        conn.execute_batch(
            "CREATE TABLE folders(id INTEGER PRIMARY KEY, name TEXT, uuid TEXT, updated_at TEXT, deleted INTEGER NOT NULL DEFAULT 0, edited_by TEXT);
             CREATE TABLE ssh_keys(id INTEGER PRIMARY KEY, name TEXT, uuid TEXT, updated_at TEXT, deleted INTEGER NOT NULL DEFAULT 0, edited_by TEXT);
             CREATE TABLE credentials(id INTEGER PRIMARY KEY, name TEXT, uuid TEXT, updated_at TEXT, deleted INTEGER NOT NULL DEFAULT 0, edited_by TEXT);
             CREATE TABLE servers(id INTEGER PRIMARY KEY, name TEXT, uuid TEXT, updated_at TEXT, deleted INTEGER NOT NULL DEFAULT 0, edited_by TEXT);
             CREATE TABLE commands(id INTEGER PRIMARY KEY, title TEXT, uuid TEXT, updated_at TEXT, deleted INTEGER NOT NULL DEFAULT 0, edited_by TEXT);
             CREATE TABLE notes(id INTEGER PRIMARY KEY, title TEXT, uuid TEXT, updated_at TEXT, deleted INTEGER NOT NULL DEFAULT 0, edited_by TEXT);
             CREATE TABLE monitor_configs(node_id INTEGER PRIMARY KEY, enabled_metrics TEXT, custom_metrics TEXT, paused INTEGER NOT NULL DEFAULT 1, uuid TEXT, updated_at TEXT, deleted INTEGER NOT NULL DEFAULT 0, edited_by TEXT);",
        ).unwrap();
        let hlc = std::sync::Arc::new(hlc::Hlc::new("testnode".into(), 0));
        register_sync_functions(&conn, &hlc).unwrap();
        create_sync_triggers(&conn).unwrap();
        conn
    }
    fn ua(conn: &Connection, name: &str) -> String {
        conn.query_row("SELECT updated_at FROM servers WHERE name=?1", [name], |r| r.get(0)).unwrap()
    }

    #[test]
    fn insert_auto_stamps_uuid_and_updated_at() {
        let conn = setup();
        conn.execute("INSERT INTO servers(name) VALUES('a')", []).unwrap();
        let (uuid, at): (Option<String>, Option<String>) = conn
            .query_row("SELECT uuid, updated_at FROM servers WHERE name='a'", [], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap();
        assert!(uuid.as_deref().map(|s| !s.is_empty()).unwrap_or(false), "uuid must be stamped");
        assert!(at.as_deref().map(|s| !s.is_empty()).unwrap_or(false), "updated_at must be stamped");
    }

    #[test]
    fn edit_bumps_stamp_but_merge_apply_is_preserved() {
        let conn = setup();
        conn.execute("INSERT INTO servers(name) VALUES('a')", []).unwrap();
        let t1 = ua(&conn, "a");
        conn.execute("UPDATE servers SET name='b' WHERE name='a'", []).unwrap();
        let t2 = ua(&conn, "b");
        assert!(t2 > t1, "a normal edit must bump the stamp");
        // The merge engine applies a remote change by setting updated_at itself;
        // the trigger must NOT overwrite it with a fresh local stamp.
        conn.execute(
            "UPDATE servers SET name='c', updated_at='999999999999999:00000:remote' WHERE name='b'",
            [],
        ).unwrap();
        assert_eq!(ua(&conn, "c"), "999999999999999:00000:remote", "merge-applied stamp must survive");
    }

    #[test]
    fn delete_leaves_a_tombstone_and_hard_deletes() {
        let conn = setup();
        conn.execute("INSERT INTO servers(name) VALUES('a')", []).unwrap();
        let uuid: String = conn.query_row("SELECT uuid FROM servers WHERE name='a'", [], |r| r.get(0)).unwrap();
        conn.execute("DELETE FROM servers WHERE name='a'", []).unwrap();
        let tombs: i64 = conn
            .query_row("SELECT COUNT(*) FROM sync_tombstones WHERE uuid=?1 AND entity_type='servers'", [&uuid], |r| r.get(0))
            .unwrap();
        assert_eq!(tombs, 1, "delete must record a tombstone");
        let rows: i64 = conn.query_row("SELECT COUNT(*) FROM servers WHERE name='a'", [], |r| r.get(0)).unwrap();
        assert_eq!(rows, 0, "row must be hard-deleted so existing SELECTs are unaffected");
    }

    #[test]
    fn monitor_paused_reset_does_not_churn_but_real_change_stamps() {
        let conn = setup();
        conn.execute("INSERT INTO monitor_configs(node_id, enabled_metrics, custom_metrics) VALUES(1,'[]','[]')", []).unwrap();
        let t1: String = conn.query_row("SELECT updated_at FROM monitor_configs WHERE node_id=1", [], |r| r.get(0)).unwrap();
        conn.execute("UPDATE monitor_configs SET paused=1", []).unwrap();
        let t2: String = conn.query_row("SELECT updated_at FROM monitor_configs WHERE node_id=1", [], |r| r.get(0)).unwrap();
        assert_eq!(t1, t2, "device-local paused reset must not churn the sync stamp");
        conn.execute("UPDATE monitor_configs SET enabled_metrics='[\"cpu\"]' WHERE node_id=1", []).unwrap();
        let t3: String = conn.query_row("SELECT updated_at FROM monitor_configs WHERE node_id=1", [], |r| r.get(0)).unwrap();
        assert!(t3 > t2, "a real config change must stamp");
    }
}

// ---------------------------------------------------------------------------
// Sync engine: per-entity serialize (FK int -> uuid) + LWW merge apply
// ---------------------------------------------------------------------------

/// One record as it travels to/from the server: metadata in the clear (so the
/// server can LWW-order without decrypting) + an encrypted payload blob. A
/// tombstone is `deleted: true` with no blob.
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct SyncRecord {
    pub uuid: String,
    pub entity_type: String,
    pub updated_at: String,
    pub deleted: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blob: Option<String>,
}

struct Fk {
    key: &'static str,       // payload key holding the referenced row's uuid
    col: &'static str,       // local FK int column
    ref_table: &'static str, // table the FK points at
    /// An optional FK whose referent hasn't arrived yet is written NULL and
    /// repaired by the deferred fixup pass. A REQUIRED one can't be: for
    /// `monitor_configs.node_id` the foreign key IS the primary key, so writing
    /// NULL would have SQLite mint a fresh rowid and silently attach the config
    /// to a different server. The record is skipped instead — a monitor config
    /// without its server means nothing, and it arrives with the next sync once
    /// the server does.
    required: bool,
}
struct EntitySpec {
    table: &'static str,
    cols: &'static [&'static str], // content columns synced verbatim
    fks: &'static [Fk],
}

/// Applied in this order so most FK referents already exist on merge; the two
/// self-referential FKs (folders.parent_id, servers.jump_host_id) are resolved
/// in a deferred fixup pass afterwards.
// `edited_by` rides along as a normal column on every spec: the auto-stamp
// triggers set it to the current editor label at mutation time, so it flows
// through collect + apply for free and records WHO last changed each entity
// (zero-knowledge — it's inside the encrypted blob, never seen by the server).
const ENTITIES: &[EntitySpec] = &[
    EntitySpec { table: "ssh_keys", cols: &["name", "public_key", "private_key", "passphrase", "edited_by"], fks: &[] },
    EntitySpec { table: "folders", cols: &["name", "color", "edited_by"], fks: &[Fk { key: "parent_uuid", col: "parent_id", ref_table: "folders", required: false }] },
    EntitySpec { table: "credentials", cols: &["name", "auth_type", "username", "password", "edited_by"], fks: &[Fk { key: "key_uuid", col: "key_id", ref_table: "ssh_keys", required: false }] },
    EntitySpec {
        table: "servers",
        cols: &["name", "host", "port", "username", "password", "proxy_type", "proxy_host", "proxy_port", "tunnels", "auth_type", "autostart", "mirrors", "color", "notes", "run_on_connect", "position", "edited_by"],
        fks: &[
            Fk { key: "credential_uuid", col: "credential_id", ref_table: "credentials", required: false },
            Fk { key: "folder_uuid", col: "folder_id", ref_table: "folders", required: false },
            Fk { key: "key_uuid", col: "key_id", ref_table: "ssh_keys", required: false },
            Fk { key: "jump_uuid", col: "jump_host_id", ref_table: "servers", required: false },
        ],
    },
    EntitySpec { table: "commands", cols: &["title", "content", "edited_by"], fks: &[] },
    EntitySpec { table: "notes", cols: &["title", "body", "edited_by"], fks: &[] },
    // Must come after `servers`: its node_id is resolved from the server's uuid,
    // so the server has to already be in place when this is applied.
    //
    // `paused` is deliberately NOT synced. It records whether polling is running
    // on THIS device — pausing monitoring on the laptop shouldn't stop it on the
    // desktop — and the profile-open housekeeping resets it, which would
    // otherwise churn. The UPDATE trigger's column guard already limits stamping
    // to exactly the two columns below, so the two agree.
    EntitySpec {
        table: "monitor_configs",
        cols: &["enabled_metrics", "custom_metrics", "edited_by"],
        fks: &[Fk { key: "node_uuid", col: "node_id", ref_table: "servers", required: true }],
    },
];

/// AES-256-GCM a per-entity payload with the profile key; frame is `nonce || ct`
/// hex-encoded. Same key that protects the whole vault, so the server stays
/// zero-knowledge.
fn encrypt_entity(plaintext: &[u8], key: &[u8; 32]) -> Result<String, String> {
    let (ct, nonce) = encrypt_with_key(plaintext, key)?;
    let mut out = Vec::with_capacity(NONCE_LEN + ct.len());
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&ct);
    Ok(hex::encode(out))
}
fn decrypt_entity(blob_hex: &str, key: &[u8; 32]) -> Result<Vec<u8>, String> {
    let raw = hex::decode(blob_hex).map_err(|e| format!("[SYNC] BLOB_HEX: {e}"))?;
    if raw.len() < NONCE_LEN + 16 {
        return Err("[SYNC] BLOB_TOO_SHORT".into());
    }
    decrypt_with_key(&raw[NONCE_LEN..], &raw[..NONCE_LEN], key)
}

fn json_to_sql(v: Option<&serde_json::Value>) -> Box<dyn rusqlite::types::ToSql> {
    use serde_json::Value;
    match v {
        None | Some(Value::Null) => Box::new(rusqlite::types::Null),
        Some(Value::String(s)) => Box::new(s.clone()),
        Some(Value::Bool(b)) => Box::new(*b as i64),
        Some(Value::Number(n)) => {
            if let Some(i) = n.as_i64() {
                Box::new(i)
            } else {
                Box::new(n.as_f64().unwrap_or(0.0))
            }
        }
        // arrays/objects (shouldn't occur — tunnels/mirrors are TEXT) → JSON text
        Some(other) => Box::new(other.to_string()),
    }
}

/// Serialize every synced entity + tombstone changed since `since` (empty = all)
/// into encrypted records. FK ints are translated to the referenced row's uuid
/// via SQL subqueries so the payload is portable across devices.
fn collect_local_records(conn: &Connection, key: &[u8; 32], since: &str) -> Result<Vec<SyncRecord>, String> {
    let mut out = Vec::new();
    for spec in ENTITIES {
        let mut pairs: Vec<String> = spec.cols.iter().map(|c| format!("'{c}', t.{c}")).collect();
        for fk in spec.fks {
            pairs.push(format!("'{}', (SELECT uuid FROM {} WHERE id = t.{})", fk.key, fk.ref_table, fk.col));
        }
        let sql = format!(
            "SELECT t.uuid, t.updated_at, json_object({}) FROM {} t WHERE t.uuid IS NOT NULL AND t.updated_at > ?1",
            pairs.join(", "),
            spec.table
        );
        let mut stmt = conn.prepare(&sql).map_err(|e| format!("[SYNC] SER_PREP {}: {e}", spec.table))?;
        let rows = stmt
            .query_map([since], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?)))
            .map_err(|e| format!("[SYNC] SER_QUERY {}: {e}", spec.table))?;
        for row in rows {
            let (uuid, updated_at, payload) = row.map_err(|e| format!("[SYNC] SER_ROW {}: {e}", spec.table))?;
            out.push(SyncRecord {
                uuid,
                entity_type: spec.table.to_string(),
                updated_at,
                deleted: false,
                blob: Some(encrypt_entity(payload.as_bytes(), key)?),
            });
        }
    }
    let mut stmt = conn
        .prepare("SELECT uuid, entity_type, updated_at FROM sync_tombstones WHERE updated_at > ?1")
        .map_err(|e| format!("[SYNC] SER_TOMB_PREP: {e}"))?;
    let rows = stmt
        .query_map([since], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?)))
        .map_err(|e| format!("[SYNC] SER_TOMB_QUERY: {e}"))?;
    for row in rows {
        let (uuid, entity_type, updated_at) = row.map_err(|e| format!("[SYNC] SER_TOMB_ROW: {e}"))?;
        out.push(SyncRecord { uuid, entity_type, updated_at, deleted: true, blob: None });
    }
    Ok(out)
}

/// Merge incoming records into the local vault, Last-Write-Wins per row. Runs
/// with the auto-stamp triggers suppressed so incoming HLC stamps are written
/// verbatim, and advances the local clock past everything seen.
fn apply_remote_records(conn: &Connection, key: &[u8; 32], records: &[SyncRecord], hlc: &hlc::Hlc) -> Result<(), String> {
    conn.execute("INSERT INTO sync_flags(key,val) VALUES('merge',1) ON CONFLICT(key) DO UPDATE SET val=1", [])
        .map_err(|e| format!("[SYNC] MERGE_ON: {e}"))?;
    let r = apply_remote_inner(conn, key, records, hlc);
    let _ = conn.execute("UPDATE sync_flags SET val=0 WHERE key='merge'", []);
    r
}

/// One deferred foreign-key repair: set `table.fk_col` for the row `uuid` to
/// whatever `ref_table.uuid = ref_uuid` resolves to once the batch is complete.
struct FkFixup {
    table: String,
    uuid: String,
    fk_col: String,
    ref_table: String,
    ref_uuid: String,
}

fn apply_remote_inner(conn: &Connection, key: &[u8; 32], records: &[SyncRecord], hlc: &hlc::Hlc) -> Result<(), String> {
    for rec in records {
        hlc.observe(hlc::Hlc::phys_of(&rec.updated_at));
    }
    // The whole merge runs inside ONE transaction: either every applicable record
    // lands or none does. A failure partway (an I/O error, a commit that won't go
    // through) can never leave the vault half-merged — on any early return `tx`
    // drops uncommitted and SQLite rolls the batch back. This is what keeps a bad
    // sync from corrupting local data.
    let tx = conn.unchecked_transaction().map_err(|e| format!("[SYNC] TX_BEGIN: {e}"))?;
    // FKs to re-resolve once the whole batch has landed. `ref_table` has to ride
    // along: the lookup used to read `SELECT id FROM {table}` — the row's OWN
    // table — which was only ever correct because the sole queued FKs were the
    // self-referential ones (folders.parent_id, servers.jump_host_id), where the
    // two tables happen to be the same. Any cross-table FK looked up the uuid in
    // entirely the wrong table, found nothing, and NULLed a perfectly good link.
    let mut fk_fixups: Vec<FkFixup> = Vec::new();
    // Per-record application is best-effort: a single record that won't decrypt
    // or parse — a corrupt or hostile blob from a broken/compromised server — is
    // logged and skipped, never aborting the merge. One poison record must not be
    // able to block every OTHER record (or every future sync) from applying.
    let mut skipped = 0usize;
    for spec in ENTITIES {
        for rec in records.iter().filter(|r| !r.deleted && r.entity_type == spec.table) {
            if let Err(e) = apply_entity(&tx, key, spec, rec, &mut fk_fixups) {
                skipped += 1;
                eprintln!("[SYNC] skipped record uuid={} type={}: {}", rec.uuid, rec.entity_type, e);
            }
        }
    }
    for rec in records.iter().filter(|r| r.deleted) {
        if let Err(e) = apply_tombstone(&tx, rec) {
            skipped += 1;
            eprintln!("[SYNC] skipped tombstone uuid={} type={}: {}", rec.uuid, rec.entity_type, e);
        }
    }
    // Re-resolve every optional FK against the FINAL state of the batch, now that
    // both the entities and the tombstones have landed.
    for f in fk_fixups {
        let id: Option<i64> = tx
            .query_row(
                &format!("SELECT id FROM {} WHERE uuid=?1", f.ref_table),
                [&f.ref_uuid],
                |r| r.get(0),
            )
            .ok();
        if let Err(e) = tx.execute(
            &format!("UPDATE {} SET {}=?1 WHERE uuid=?2", f.table, f.fk_col),
            rusqlite::params![id, f.uuid],
        ) {
            eprintln!("[SYNC] fk fixup skipped {}.{} uuid={}: {}", f.table, f.fk_col, f.uuid, e);
        }
    }
    tx.commit().map_err(|e| format!("[SYNC] TX_COMMIT: {e}"))?;
    if skipped > 0 {
        eprintln!("[SYNC] merge committed with {skipped} record(s) skipped");
    }
    Ok(())
}

fn apply_entity(conn: &Connection, key: &[u8; 32], spec: &EntitySpec, rec: &SyncRecord, fk_fixups: &mut Vec<FkFixup>) -> Result<(), String> {
    // LWW: keep local if it's newer-or-equal. A deleted row is hard-deleted, so
    // its tombstone carries its only surviving stamp — it has to count as the
    // local side of the comparison. Without it, a batch collected before a
    // delete (sync drops the lock for the network leg, so the user can delete
    // mid-flight) comes back still carrying the row as live, finds no live row
    // to compare against, and re-inserts it — secrets and all.
    let local_ua: Option<String> = conn
        .query_row(&format!("SELECT updated_at FROM {} WHERE uuid=?1", spec.table), [&rec.uuid], |r| r.get(0))
        .ok();
    let tomb_ua: Option<String> = conn
        .query_row(
            "SELECT updated_at FROM sync_tombstones WHERE uuid=?1 AND entity_type=?2",
            rusqlite::params![&rec.uuid, spec.table],
            |r| r.get(0),
        )
        .ok();
    if [local_ua.as_deref(), tomb_ua.as_deref()]
        .into_iter()
        .flatten()
        .any(|l| l >= rec.updated_at.as_str())
    {
        return Ok(());
    }
    let blob = rec.blob.as_deref().ok_or("[SYNC] ENTITY_NO_BLOB")?;
    let plain = decrypt_entity(blob, key)?;
    let payload: serde_json::Value = serde_json::from_slice(&plain).map_err(|e| format!("[SYNC] PAYLOAD_JSON: {e}"))?;
    let obj = payload.as_object().ok_or("[SYNC] PAYLOAD_NOT_OBJ")?;

    let mut columns: Vec<String> = vec!["uuid".into(), "updated_at".into(), "deleted".into()];
    let mut params: Vec<Box<dyn rusqlite::types::ToSql>> =
        vec![Box::new(rec.uuid.clone()), Box::new(rec.updated_at.clone()), Box::new(rec.deleted as i64)];
    // Set when the incoming record omits `position` (a pre-0.3.5 peer). We then
    // preserve the LOCAL rank on the UPDATE arm below instead of overwriting it
    // with the coerced 0 — otherwise an ordinary field edit synced from an old
    // peer would silently reset a manual drag-order on this device.
    let mut preserve_local_position = false;
    for c in spec.cols {
        columns.push((*c).into());
        let val = obj.get(*c);
        // Backward-compat shim: `position` was added to servers' synced cols in
        // 0.3.5. Records from a pre-0.3.5 peer omit the key entirely, so
        // json_to_sql(None) would bind an explicit SQL NULL — which violates
        // `position INTEGER NOT NULL` and makes the whole upsert fail, silently
        // skipping the server row (its SSH credentials with it). Coerce a
        // missing/null position to its default 0 (so an INSERT lands the row)
        // and remember to keep the local rank on UPDATE. Only needed for
        // NOT-NULL columns added to an already-syncing entity after sync shipped.
        if *c == "position" && matches!(val, None | Some(serde_json::Value::Null)) {
            params.push(Box::new(0i64));
            preserve_local_position = true;
        } else {
            params.push(json_to_sql(val));
        }
    }
    for fk in spec.fks {
        let ref_uuid = obj.get(fk.key).and_then(|v| v.as_str());
        let id: Option<i64> = match ref_uuid {
            None => None,
            Some(ru) => {
                let found: Option<i64> = conn
                    .query_row(&format!("SELECT id FROM {} WHERE uuid=?1", fk.ref_table), [ru], |r| r.get(0))
                    .ok();
                if found.is_none() && fk.required {
                    // Can't write this row at all without its referent, and a
                    // later fixup can't rescue it either (the column is the
                    // primary key). Drop the record; it'll come back on the
                    // next sync once the referent lands. Required FKs are also
                    // never queued below — if the referent is deleted later in
                    // this same batch, SQLite's ON DELETE CASCADE removes this
                    // row outright, which is the right answer for a config that
                    // only exists to describe its parent.
                    return Ok(());
                }
                if !fk.required {
                    // Queue EVERY optional FK, not just the ones that failed to
                    // resolve. Tombstones are applied after entities, so a
                    // referent that was still present a moment ago can be gone by
                    // the end of the batch — two devices doing ordinary
                    // independent work (one edits a server, the other deletes
                    // that server's jump host) is enough. Only re-checking the
                    // initially-unresolved ones left the rest pointing at a row
                    // that no longer exists, permanently and silently: the link
                    // surfaced much later as "jump host not found", or as a
                    // folder that had quietly lost its parent.
                    fk_fixups.push(FkFixup {
                        table: spec.table.to_string(),
                        uuid: rec.uuid.clone(),
                        fk_col: fk.col.to_string(),
                        ref_table: fk.ref_table.to_string(),
                        ref_uuid: ru.to_string(),
                    });
                }
                found
            }
        };
        // A required FK with no uuid in the payload at all is equally unusable.
        if id.is_none() && fk.required {
            return Ok(());
        }
        columns.push(fk.col.into());
        params.push(Box::new(id));
    }

    let placeholders = std::iter::repeat("?").take(columns.len()).collect::<Vec<_>>().join(",");
    let update_set: Vec<String> = columns
        .iter()
        .filter(|c| c.as_str() != "uuid")
        .map(|c| {
            if c.as_str() == "position" && preserve_local_position {
                // Peer didn't know about `position` — don't clobber our local
                // drag-order with the coerced 0; keep the existing row value.
                format!("position={}.position", spec.table)
            } else {
                format!("{c}=excluded.{c}")
            }
        })
        .collect();
    let sql = format!(
        "INSERT INTO {} ({}) VALUES ({}) ON CONFLICT(uuid) DO UPDATE SET {}",
        spec.table,
        columns.join(","),
        placeholders,
        update_set.join(",")
    );
    let refs: Vec<&dyn rusqlite::types::ToSql> = params.iter().map(|b| b.as_ref()).collect();
    conn.execute(&sql, refs.as_slice()).map_err(|e| format!("[SYNC] UPSERT {}: {e}", spec.table))?;
    Ok(())
}

fn apply_tombstone(conn: &Connection, rec: &SyncRecord) -> Result<(), String> {
    // Only tombstones for known entity types are meaningful here.
    if !ENTITIES.iter().any(|s| s.table == rec.entity_type) {
        return Ok(());
    }
    conn.execute(
        "INSERT INTO sync_tombstones(uuid, entity_type, updated_at) VALUES (?1,?2,?3)
         ON CONFLICT(uuid) DO UPDATE SET updated_at=excluded.updated_at, entity_type=excluded.entity_type
         WHERE excluded.updated_at > sync_tombstones.updated_at",
        rusqlite::params![rec.uuid, rec.entity_type, rec.updated_at],
    )
    .map_err(|e| format!("[SYNC] TOMB_UPSERT: {e}"))?;
    let local_ua: Option<String> = conn
        .query_row(&format!("SELECT updated_at FROM {} WHERE uuid=?1", rec.entity_type), [&rec.uuid], |r| r.get(0))
        .ok();
    if let Some(l) = local_ua {
        if l.as_str() < rec.updated_at.as_str() {
            // Merge guard is on → the AFTER DELETE trigger won't create a
            // competing tombstone; the explicit upsert above stands.
            conn.execute(&format!("DELETE FROM {} WHERE uuid=?1", rec.entity_type), [&rec.uuid])
                .map_err(|e| format!("[SYNC] TOMB_DELETE: {e}"))?;
        }
    }
    Ok(())
}

#[derive(serde::Serialize)]
struct SyncReport {
    pushed: usize,
    pulled: usize,
}

// A personal profile's DEK, sealed under the profile's OWN password, rides the
// normal /sync stream as one reserved record. That's what lets a fresh device
// bootstrap a personal profile with nothing but the profile password: sign in,
// pull, derive the key from the password + the salt carried in this record, and
// unseal the DEK — no whole-vault blob download, no separate recovery secret,
// no server changes (the /sync table accepts any entity_type ≤24 chars). The
// server stores it as an opaque blob like every other record, so zero-knowledge
// still holds — cracking it costs the same Argon2id work as the vault itself.
// It never matches an ENTITIES spec, so apply naturally ignores it; only the
// restore path reads it. The updated_at is a fixed low sentinel so it sorts
// first and never churns the LWW upsert.
//
// Blob layout (hex): version(1) ‖ salt(SALT_LEN) ‖ nonce(NONCE_LEN) ‖
// AES-256-GCM(master_key, dek). `master_key` is Argon2id(password, salt) — the
// exact same derivation as the on-disk vault — so a device that knows the
// password reproduces it from the embedded salt and decrypts the DEK.
const ESCROW_ETYPE: &str = "dek_escrow";
const ESCROW_UUID: &str = "0000000000000000000000000000dead";
const ESCROW_UAT: &str = "000000000000000:00000:0";
// Version byte fronting the escrow blob. `2` = password-sealed (the format
// below). `1` was the retired identity-sealed sealed-box; no such records were
// ever published to any live account, so there is nothing to migrate — but the
// byte lets the reader reject an unknown/legacy shape cleanly instead of
// mis-parsing it.
const PW_ESCROW_VERSION: u8 = 2;

/// Build the reserved DEK-escrow record: the profile DEK sealed under the
/// profile's master key (Argon2id of its password). `salt` is the vault's own
/// KDF salt, embedded so a fresh device can re-derive `master_key` from just the
/// password.
fn build_pw_escrow_record(
    master_key: &[u8; 32],
    salt: &[u8; SALT_LEN],
    dek: &[u8; 32],
) -> Result<SyncRecord, String> {
    let (ct, nonce) = encrypt_with_key(dek, master_key)?;
    let mut blob = Vec::with_capacity(1 + SALT_LEN + NONCE_LEN + ct.len());
    blob.push(PW_ESCROW_VERSION);
    blob.extend_from_slice(salt);
    blob.extend_from_slice(&nonce);
    blob.extend_from_slice(&ct);
    Ok(SyncRecord {
        uuid: ESCROW_UUID.to_string(),
        entity_type: ESCROW_ETYPE.to_string(),
        updated_at: ESCROW_UAT.to_string(),
        deleted: false,
        blob: Some(hex::encode(blob)),
    })
}

/// Recover a profile's DEK from a password-sealed escrow blob. Runs Argon2id, so
/// callers hand it to the blocking pool. Returns `DECRYPT_FAILURE` (via
/// `decrypt_with_key`) when the password is wrong — the GCM tag won't verify.
fn open_pw_escrow(blob_hex: &str, password: &str) -> Result<[u8; 32], String> {
    let raw = hex::decode(blob_hex).map_err(|_| "[SYNC] ESCROW_BAD_HEX")?;
    let head = 1 + SALT_LEN + NONCE_LEN;
    if raw.len() < head + 16 {
        return Err("[SYNC] ESCROW_TOO_SHORT".into());
    }
    if raw[0] != PW_ESCROW_VERSION {
        return Err(format!("[SYNC] ESCROW_BAD_VERSION: {}", raw[0]));
    }
    let salt = &raw[1..1 + SALT_LEN];
    let nonce = &raw[1 + SALT_LEN..head];
    let ct = &raw[head..];
    let mk = Zeroizing::new(derive_key(password, salt)?);
    let dek_vec = Zeroizing::new(decrypt_with_key(ct, nonce, &mk)?);
    if dek_vec.len() != 32 {
        return Err("[SYNC] ESCROW_BAD_DEK_LEN".into());
    }
    let mut dek = [0u8; 32];
    dek.copy_from_slice(&dek_vec);
    Ok(dek)
}

/// One full per-entity sync of the OPEN profile: collect every local record,
/// exchange with the server (which LWW-merges + returns its view), merge the
/// server's records back, and persist. Full-set each call (the dataset is
/// small — a handful of servers/credentials); a `since` watermark is a later
/// optimisation, not needed for correctness.
#[tauri::command]
async fn sync_now(
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

    // A shared profile's key can change under us: the owner rotates it whenever
    // a member is revoked, so the copy cached at import time goes stale. Refresh
    // it BEFORE serialising anything, or this device would encrypt its push with
    // a key nobody else can open. Cheap (a primary-key point lookup) and
    // best-effort — offline or a hiccup just means we sync with what we have,
    // exactly as before this existed.
    let existing_share: Option<String> = {
        let conn_g = db_state.conn.lock().map_err(|_| "[STATE] LOCK_CONN")?;
        let conn = conn_g.as_ref().ok_or("[STATE] DB_NOT_OPEN")?;
        conn.query_row("SELECT value FROM sync_meta WHERE key='share_id'", [], |r| r.get(0)).ok()
    };
    if let Some(sid) = &existing_share {
        if let Some((_, my_secret)) = cloud.identity().await {
            if let Ok(grant) = cloud::share_dek(&app, &cloud, sid).await {
                if let Ok(raw) = hex::decode(&grant.sealed_dek) {
                    if let Ok(opened) = identity::unseal(&my_secret, &raw) {
                        if opened.len() == 32 {
                            let conn_g = db_state.conn.lock().map_err(|_| "[STATE] LOCK_CONN")?;
                            let conn = conn_g.as_ref().ok_or("[STATE] DB_NOT_OPEN")?;
                            let _ = conn.execute(
                                "INSERT INTO sync_meta(key,value) VALUES('dek',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                                [&hex::encode(&opened)],
                            );
                        }
                    }
                }
            }
        }
    }

    // Snapshot the profile DEK + clock and serialise local records, then DROP
    // all locks before the network round-trip (never hold a std Mutex across
    // .await). Per-entity blobs are encrypted with the DEK — NOT the vault
    // master key — so the same records can be shared with other members, who
    // hold the DEK via a sealed grant without ever knowing this vault's
    // password. The DEK is created + persisted at profile-open, so it already
    // exists here; get_or_create is a defensive fallback only.
    let (records, dek, hlc, share, cloud_profile, master_key, salt) = {
        let conn_g = db_state.conn.lock().map_err(|_| "[STATE] LOCK_CONN")?;
        let conn = conn_g.as_ref().ok_or("[STATE] DB_NOT_OPEN")?;
        let hlc_g = db_state.hlc.lock().map_err(|_| "[STATE] LOCK_HLC")?;
        let hlc = hlc_g.as_ref().ok_or("[SYNC] NO_HLC")?.clone();
        // The session master key + salt (retained in DbState for the vault
        // re-save) let us seal the DEK under the profile's own password with no
        // extra KDF work — copied out here so no guard is held across the await.
        let master_key = db_state
            .master_key
            .lock()
            .map_err(|_| "[STATE] LOCK_KEY")?
            .as_ref()
            .map(|k| **k);
        let salt = *db_state.salt.lock().map_err(|_| "[STATE] LOCK_SALT")?;
        let (dek, _created) = get_or_create_dek(conn)?;
        let records = collect_local_records(conn, &dek, "")?;
        // If this profile is shared, sync_meta carries its share_id + my role;
        // that routes the exchange to /shares/sync instead of personal /sync.
        let share_id: Option<String> = conn
            .query_row("SELECT value FROM sync_meta WHERE key='share_id'", [], |r| r.get(0))
            .ok();
        let share_role: Option<String> = conn
            .query_row("SELECT value FROM sync_meta WHERE key='share_role'", [], |r| r.get(0))
            .ok();
        // Personal /sync is keyed by profile name. A restored profile may carry
        // a different LOCAL name than its cloud key, so it records the cloud
        // name in sync_meta; fall back to the local name for everything else.
        let cloud_profile: String = conn
            .query_row("SELECT value FROM sync_meta WHERE key='cloud_profile'", [], |r| r.get(0))
            .unwrap_or_else(|_| profile.clone());
        // Fail CLOSED on a missing role. The push gate below is `role != "user"`,
        // so defaulting to an empty string would have granted write access to a
        // profile whose role row went missing — the least safe reading of "we
        // don't know". A viewer that should have been an editor is a visible,
        // fixable annoyance; an editor that should have been a viewer is not.
        let share = share_id.map(|s| (s, share_role.unwrap_or_else(|| "user".to_string())));
        (records, dek, hlc, share, cloud_profile, master_key, salt)
    };

    // Shared profile → /shares/sync (role-gated). A viewer ('user') pushes
    // nothing — it can only pull, so sending records would just 403.
    let (remote, pushed) = if let Some((share_id, role)) = &share {
        let to_push: &[SyncRecord] = if role == "user" { &[] } else { &records };
        let remote = cloud::shared_sync_exchange(&app, &cloud, share_id, "", to_push).await?;
        (remote, to_push.len())
    } else {
        // Personal profile: publish (or refresh) the DEK escrow alongside the
        // data so any device that knows this profile's password can bring it
        // down. Sealed under the profile's OWN master key — always-on, no
        // sharing identity or separate recovery secret required.
        let mut to_push = records.clone();
        if let (Some(mk), Some(salt)) = (master_key, salt) {
            to_push.push(build_pw_escrow_record(&mk, &salt, &dek)?);
        }
        // Send the local display name so the server can label this partition —
        // essential once `cloud_profile` is an opaque UUID for new profiles. For
        // legacy `main` the name equals the partition, so it's a harmless echo.
        let remote =
            cloud::sync_exchange(&app, &cloud, &cloud_profile, "", &to_push, Some(profile.as_str())).await?;
        (remote, to_push.len())
    };
    let pulled = remote.len();

    {
        let conn_g = db_state.conn.lock().map_err(|_| "[STATE] LOCK_CONN")?;
        let conn = conn_g.as_ref().ok_or("[STATE] DB_NOT_OPEN")?;
        apply_remote_records(conn, &dek, &remote, &hlc)?;
    }
    // Persist the merged vault so the applied changes survive a restart.
    save_vault_async(&db_state).await?;
    Ok(SyncReport { pushed, pulled })
}

#[derive(serde::Serialize)]
struct RecentEdit {
    name: String,
    edited_by: String,
    updated_at: String,
}

#[derive(serde::Serialize)]
struct SyncDiff {
    in_sync: usize,
    needs_push: usize,
    needs_pull: usize,
    /// Names of local nodes whose local copy differs from the cloud (either an
    /// unpushed local edit, or a cloud copy at a different stamp). Capped.
    out_of_sync_nodes: Vec<String>,
}

#[derive(serde::Serialize)]
struct ProfileSyncStats {
    /// Total synced records held locally (live rows + tombstones).
    total_records: usize,
    /// On-disk size of this profile's encrypted vault, for heaviness awareness.
    vault_bytes: u64,
    /// Last few edited nodes with who touched them — read straight from the
    /// local vault, no network. Always present.
    recent_edits: Vec<RecentEdit>,
    /// Live comparison against the cloud. `None` when offline / not signed in /
    /// never synced — the panel then shows recent edits only.
    diff: Option<SyncDiff>,
}

/// Read-only sync + activity snapshot for the Profile panel. The recent-edits
/// list is local and instant; the cloud diff is a best-effort dry run (an empty
/// push that mutates nothing, then a local comparison) and is omitted on any
/// network/auth failure rather than erroring the whole call.
#[tauri::command]
async fn profile_sync_stats(
    app: tauri::AppHandle,
    db_state: tauri::State<'_, DbState>,
    cloud: tauri::State<'_, std::sync::Arc<cloud::CloudState>>,
) -> Result<ProfileSyncStats, String> {
    let profile = db_state
        .active_profile
        .lock()
        .map_err(|_| "[STATE] LOCK_PROFILE")?
        .clone()
        .ok_or("[SYNC] NO_PROFILE_OPEN")?;

    // Local snapshot under the lock: records, DEK, routing, recent edits, and a
    // uuid→name map for servers so the diff can name what's out of sync.
    let (local, dek, share, cloud_profile, recent_edits, server_names) = {
        let conn_g = db_state.conn.lock().map_err(|_| "[STATE] LOCK_CONN")?;
        let conn = conn_g.as_ref().ok_or("[STATE] DB_NOT_OPEN")?;
        let (dek, _created) = get_or_create_dek(conn)?;
        let local = collect_local_records(conn, &dek, "")?;
        let share_id: Option<String> = conn
            .query_row("SELECT value FROM sync_meta WHERE key='share_id'", [], |r| r.get(0))
            .ok();
        let share_role: Option<String> = conn
            .query_row("SELECT value FROM sync_meta WHERE key='share_role'", [], |r| r.get(0))
            .ok();
        let cloud_profile: String = conn
            .query_row("SELECT value FROM sync_meta WHERE key='cloud_profile'", [], |r| r.get(0))
            .unwrap_or_else(|_| profile.clone());

        let mut recent_edits = Vec::new();
        {
            let mut stmt = conn
                .prepare(
                    "SELECT name, COALESCE(edited_by,''), COALESCE(updated_at,'') FROM servers \
                     WHERE deleted=0 AND updated_at IS NOT NULL ORDER BY updated_at DESC LIMIT 5",
                )
                .map_err(|e| format!("[SYNC] RECENT_PREP: {e}"))?;
            let rows = stmt
                .query_map([], |r| {
                    Ok(RecentEdit {
                        name: r.get(0)?,
                        edited_by: r.get(1)?,
                        updated_at: r.get(2)?,
                    })
                })
                .map_err(|e| format!("[SYNC] RECENT_QUERY: {e}"))?;
            for row in rows {
                recent_edits.push(row.map_err(|e| format!("[SYNC] RECENT_ROW: {e}"))?);
            }
        }

        let mut server_names: std::collections::HashMap<String, String> = std::collections::HashMap::new();
        {
            let mut stmt = conn
                .prepare("SELECT uuid, name FROM servers WHERE uuid IS NOT NULL AND deleted=0")
                .map_err(|e| format!("[SYNC] NAMES_PREP: {e}"))?;
            let rows = stmt
                .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
                .map_err(|e| format!("[SYNC] NAMES_QUERY: {e}"))?;
            for row in rows {
                let (u, n) = row.map_err(|e| format!("[SYNC] NAMES_ROW: {e}"))?;
                server_names.insert(u, n);
            }
        }

        (
            local,
            dek,
            // Fail CLOSED on a missing role. The push gate below is `role != "user"`,
        // so defaulting to an empty string would have granted write access to a
        // profile whose role row went missing — the least safe reading of "we
        // don't know". A viewer that should have been an editor is a visible,
        // fixable annoyance; an editor that should have been a viewer is not.
        share_id.map(|s| (s, share_role.unwrap_or_else(|| "user".to_string()))),
            cloud_profile,
            recent_edits,
            server_names,
        )
    };

    let total_records = local.len();
    let vault_bytes = profile_path(&app, &profile)
        .ok()
        .and_then(|p| std::fs::metadata(&p).ok())
        .map(|m| m.len())
        .unwrap_or(0);
    let _ = &dek; // reserved for future decrypt of incoming node names

    // Best-effort dry run: pure pull (empty push mutates nothing on the server).
    let diff = {
        let pulled = if let Some((share_id, _role)) = &share {
            cloud::shared_sync_exchange(&app, &cloud, share_id, "", &[]).await
        } else {
            cloud::sync_exchange(&app, &cloud, &cloud_profile, "", &[], None).await
        };
        match pulled {
            Ok(server) => {
                use std::collections::HashMap;
                let local_map: HashMap<&str, (&str, &str)> = local
                    .iter()
                    .map(|r| (r.uuid.as_str(), (r.updated_at.as_str(), r.entity_type.as_str())))
                    .collect();
                let server_map: HashMap<&str, (&str, &str)> = server
                    .iter()
                    // The reserved escrow record is bookkeeping, not user data.
                    .filter(|r| r.entity_type != ESCROW_ETYPE)
                    .map(|r| (r.uuid.as_str(), (r.updated_at.as_str(), r.entity_type.as_str())))
                    .collect();

                let mut in_sync = 0usize;
                let mut needs_push = 0usize;
                let mut needs_pull = 0usize;
                let mut out: Vec<String> = Vec::new();

                let mut uuids: std::collections::HashSet<&str> = std::collections::HashSet::new();
                uuids.extend(local_map.keys());
                uuids.extend(server_map.keys());
                for u in uuids {
                    let l = local_map.get(u).map(|(ua, _)| *ua).unwrap_or("");
                    let s = server_map.get(u).map(|(ua, _)| *ua).unwrap_or("");
                    let is_server = local_map.get(u).map(|(_, et)| *et == "servers").unwrap_or(false)
                        || server_map.get(u).map(|(_, et)| *et == "servers").unwrap_or(false);
                    if l == s {
                        in_sync += 1;
                    } else {
                        if l > s {
                            needs_push += 1;
                        } else {
                            needs_pull += 1;
                        }
                        if is_server && out.len() < 20 {
                            if let Some(name) = server_names.get(u) {
                                out.push(name.clone());
                            }
                        }
                    }
                }
                Some(SyncDiff { in_sync, needs_push, needs_pull, out_of_sync_nodes: out })
            }
            Err(_) => None,
        }
    };

    Ok(ProfileSyncStats { total_records, vault_bytes, recent_edits, diff })
}

// ===========================================================================
// Profile sharing commands (E2E). Identity lives in the cloud session; the
// per-profile DEK is what actually gets shared, sealed to each member.
// ===========================================================================

fn hex_to_32(s: &str) -> Result<[u8; 32], String> {
    let raw = hex::decode(s).map_err(|_| "[SHARE] BAD_HEX".to_string())?;
    if raw.len() != 32 {
        return Err("[SHARE] BAD_KEY_LEN".into());
    }
    let mut out = [0u8; 32];
    out.copy_from_slice(&raw);
    Ok(out)
}

#[derive(serde::Serialize)]
struct IdentityStatus {
    exists_on_server: bool,
    unlocked: bool,
    public_key: Option<String>,
}

/// Is a sharing identity set up (server) and/or unlocked (this session)?
#[tauri::command]
async fn identity_status(
    app: tauri::AppHandle,
    cloud: tauri::State<'_, std::sync::Arc<cloud::CloudState>>,
) -> Result<IdentityStatus, String> {
    let unlocked = cloud.identity().await;
    if let Some((pubk, _)) = unlocked {
        return Ok(IdentityStatus { exists_on_server: true, unlocked: true, public_key: Some(hex::encode(pubk)) });
    }
    // Not unlocked — ask the server whether a key exists (requires being signed in).
    if cloud.token().await.is_none() {
        return Ok(IdentityStatus { exists_on_server: false, unlocked: false, public_key: None });
    }
    let keys = cloud::fetch_my_keys(&app, &cloud).await?;
    Ok(IdentityStatus { exists_on_server: keys.exists, unlocked: false, public_key: keys.public_key })
}

/// Set up (first time) or unlock (already exists) the sharing identity from the
/// user's encryption passphrase. Never overwrites an existing key — a wrong
/// passphrase errors instead, so a real key with live grants is never orphaned
/// by a typo. Use `reset_identity` to deliberately regenerate.
#[tauri::command]
async fn setup_identity(
    app: tauri::AppHandle,
    cloud: tauri::State<'_, std::sync::Arc<cloud::CloudState>>,
    enc_passphrase: String,
) -> Result<IdentityStatus, String> {
    if enc_passphrase.is_empty() {
        return Err("[SHARE] EMPTY_PASSPHRASE".into());
    }
    let existing = cloud::fetch_my_keys(&app, &cloud).await?;
    if existing.exists {
        let salt_hex = existing.enc_salt.ok_or("[SHARE] MISSING_SALT")?;
        let wrapped = existing.wrapped_privkey.ok_or("[SHARE] MISSING_WRAPPED")?;
        let pub_hex = existing.public_key.ok_or("[SHARE] MISSING_PUB")?;
        let salt = hex::decode(&salt_hex).map_err(|_| "[SHARE] BAD_SALT")?;
        let secret = identity::unwrap_secret(&enc_passphrase, &salt, &wrapped).map_err(|_| {
            "[SHARE] WRONG_PASSPHRASE: that passphrase doesn't match your sharing identity. If you forgot it, reset your identity (regenerates keys — you'll need to re-share)."
        })?;
        if hex::encode(identity::public_of(&secret)) != pub_hex {
            return Err("[SHARE] KEY_MISMATCH: stored identity is inconsistent — reset your identity to regenerate.".into());
        }
        cloud.set_identity(identity::public_of(&secret), secret).await;
        return Ok(IdentityStatus { exists_on_server: true, unlocked: true, public_key: Some(pub_hex) });
    }
    // First-time setup — generate, wrap, publish. The strength floor belongs
    // HERE, not at the top of the function: this one command serves both
    // "pick your sharing passphrase" and "unlock with the one you already have",
    // and the caller can't tell which until `fetch_my_keys` answers. Checking
    // length before that branch would mean a raised floor (or any future client
    // that provisioned an identity under different rules) rejecting a passphrase
    // that genuinely unwraps a published key — locking someone out of shares
    // they own over a rule that only ever applied at sign-up.
    if enc_passphrase.chars().count() < 8 {
        return Err("[SHARE] WEAK_PASSPHRASE: use at least 8 characters".into());
    }
    let kp = identity::generate_keypair();
    let mut salt = [0u8; 16];
    rand::thread_rng().fill(&mut salt);
    let wrapped = identity::wrap_secret(&enc_passphrase, &salt, &kp.secret)?;
    cloud::publish_identity(&app, &cloud, &hex::encode(kp.public), &wrapped, &hex::encode(salt)).await?;
    cloud.set_identity(kp.public, kp.secret).await;
    Ok(IdentityStatus { exists_on_server: true, unlocked: true, public_key: Some(hex::encode(kp.public)) })
}

/// Deliberately regenerate the sharing identity (e.g. forgotten passphrase).
/// Rotates the published key; grants sealed to the OLD key stop working, so the
/// caller must re-share afterwards. Overwrites unconditionally.
#[tauri::command]
async fn reset_identity(
    app: tauri::AppHandle,
    cloud: tauri::State<'_, std::sync::Arc<cloud::CloudState>>,
    enc_passphrase: String,
) -> Result<IdentityStatus, String> {
    if enc_passphrase.chars().count() < 8 {
        return Err("[SHARE] WEAK_PASSPHRASE: use at least 8 characters".into());
    }
    let kp = identity::generate_keypair();
    let mut salt = [0u8; 16];
    rand::thread_rng().fill(&mut salt);
    let wrapped = identity::wrap_secret(&enc_passphrase, &salt, &kp.secret)?;
    cloud::publish_identity(&app, &cloud, &hex::encode(kp.public), &wrapped, &hex::encode(salt)).await?;
    cloud.set_identity(kp.public, kp.secret).await;
    Ok(IdentityStatus { exists_on_server: true, unlocked: true, public_key: Some(hex::encode(kp.public)) })
}

#[derive(serde::Serialize)]
struct ShareResult {
    share_id: String,
}

/// Owner: turn the OPEN profile into a shared profile. Seals the profile DEK to
/// my own public key and records the share_id locally.
#[tauri::command]
async fn share_current_profile(
    app: tauri::AppHandle,
    db_state: tauri::State<'_, DbState>,
    cloud: tauri::State<'_, std::sync::Arc<cloud::CloudState>>,
    name: String,
) -> Result<ShareResult, String> {
    let name = name.trim().to_string();
    if name.is_empty() || name.chars().count() > 64 {
        return Err("[SHARE] BAD_NAME: 1-64 characters".into());
    }
    let (my_pub, _) = cloud.identity().await.ok_or("[SHARE] IDENTITY_LOCKED: set up your sharing identity first")?;
    let dek = {
        let conn_g = db_state.conn.lock().map_err(|_| "[STATE] LOCK_CONN")?;
        let conn = conn_g.as_ref().ok_or("[STATE] DB_NOT_OPEN")?;
        // Only the UI's hidden button stopped this from running twice. Called
        // again on an already-shared profile it would mint a SECOND share_id,
        // overwrite the local one, and orphan the first — leaving its members
        // syncing against a share this device no longer knows exists, and which
        // nobody can revoke or delete any more.
        let already: Option<String> = conn
            .query_row("SELECT value FROM sync_meta WHERE key='share_id'", [], |r| r.get(0))
            .ok();
        if already.is_some() {
            return Err("[SHARE] ALREADY_SHARED: this profile is already shared — stop sharing first if you want a new share.".into());
        }
        get_or_create_dek(conn)?.0
    };
    let sealed_self = hex::encode(identity::seal_to(&my_pub, &dek)?);
    let share_id = new_entity_uuid(); // 32 hex — within the server's {16,64}
    cloud::create_share(&app, &cloud, &share_id, &name, &sealed_self).await?;
    {
        let conn_g = db_state.conn.lock().map_err(|_| "[STATE] LOCK_CONN")?;
        let conn = conn_g.as_ref().ok_or("[STATE] DB_NOT_OPEN")?;
        conn.execute(
            "INSERT INTO sync_meta(key,value) VALUES('share_id',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            [&share_id],
        )
        .map_err(|e| format!("[SHARE] STORE_SHARE_ID: {e}"))?;
        // Remembered so a later key rotation can re-create the share record with
        // its own name — /shares/create upserts the name, so passing a guess
        // would quietly rename the share for every member.
        conn.execute(
            "INSERT INTO sync_meta(key,value) VALUES('share_name',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            [&name],
        )
        .map_err(|e| format!("[SHARE] STORE_SHARE_NAME: {e}"))?;
        conn.execute(
            "INSERT INTO sync_meta(key,value) VALUES('share_role','owner') ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            [],
        )
        .map_err(|e| format!("[SHARE] STORE_ROLE: {e}"))?;
    }
    save_vault_async(&db_state).await?;
    Ok(ShareResult { share_id })
}

#[derive(serde::Serialize)]
struct InviteResult {
    email: String,
}

/// Owner: invite `email` to a share at `role` (editor|user). Obtains the DEK by
/// unsealing my own grant, then re-seals it to the invitee's public key.
#[tauri::command]
async fn invite_to_share(
    app: tauri::AppHandle,
    cloud: tauri::State<'_, std::sync::Arc<cloud::CloudState>>,
    share_id: String,
    email: String,
    role: String,
) -> Result<InviteResult, String> {
    if role != "editor" && role != "user" {
        return Err("[SHARE] BAD_ROLE: role must be 'editor' or 'user'".into());
    }
    let (_, my_secret) = cloud.identity().await.ok_or("[SHARE] IDENTITY_LOCKED")?;
    // Get the DEK by unsealing my own grant for this share.
    let mine = cloud::share_dek(&app, &cloud, &share_id).await?;
    let dek_bytes = identity::unseal(&my_secret, &hex::decode(&mine.sealed_dek).map_err(|_| "[SHARE] BAD_GRANT")?)
        .map_err(|_| "[SHARE] UNSEAL_SELF: cannot open your own grant — your identity may have changed")?;
    let dek = {
        if dek_bytes.len() != 32 {
            return Err("[SHARE] BAD_DEK_LEN".into());
        }
        let mut d = [0u8; 32];
        d.copy_from_slice(&dek_bytes);
        d
    };
    let info = cloud::lookup_pubkey(&app, &cloud, &email)
        .await?
        .ok_or("[SHARE] NO_ACCOUNT: that email hasn't set up sharing yet")?;
    let invitee_pub = hex_to_32(&info.public_key)?;
    let sealed = hex::encode(identity::seal_to(&invitee_pub, &dek)?);
    cloud::invite_member(&app, &cloud, &share_id, &email, &role, &sealed).await?;
    Ok(InviteResult { email: info.email })
}

/// Every share I'm a member of.
#[tauri::command]
async fn list_shares(
    app: tauri::AppHandle,
    cloud: tauri::State<'_, std::sync::Arc<cloud::CloudState>>,
) -> Result<Vec<cloud::ShareInfo>, String> {
    cloud::list_shares(&app, &cloud).await
}

/// The member roster of a share I belong to.
#[tauri::command]
async fn share_member_list(
    app: tauri::AppHandle,
    cloud: tauri::State<'_, std::sync::Arc<cloud::CloudState>>,
    share_id: String,
) -> Result<Vec<cloud::MemberInfo>, String> {
    cloud::share_members(&app, &cloud, &share_id).await
}

#[derive(serde::Serialize)]
struct AcceptResult {
    role: String,
}

/// Accept a pending invite. Verifies I can unseal the DEK with my identity, then
/// records the share locally. (Materialising it as a syncable local profile is
/// wired in S3c.)
#[tauri::command]
async fn accept_share(
    app: tauri::AppHandle,
    cloud: tauri::State<'_, std::sync::Arc<cloud::CloudState>>,
    share_id: String,
) -> Result<AcceptResult, String> {
    let (_, my_secret) = cloud.identity().await.ok_or("[SHARE] IDENTITY_LOCKED: unlock your sharing identity first")?;
    let resp = cloud::accept_share(&app, &cloud, &share_id).await?;
    let dek = identity::unseal(&my_secret, &hex::decode(&resp.sealed_dek).map_err(|_| "[SHARE] BAD_GRANT")?)
        .map_err(|_| "[SHARE] UNSEAL_FAILED: this invite wasn't sealed to your current identity")?;
    if dek.len() != 32 {
        return Err("[SHARE] BAD_DEK_LEN".into());
    }
    Ok(AcceptResult { role: resp.role })
}

/// Invitee: materialise an accepted share as a local profile and pull its data.
/// Creates a fresh local vault (encrypted at rest with `vault_password`), sets
/// its DEK to the shared data-key unsealed from my grant, records the share,
/// then syncs to populate it. The vault password is local-only and unrelated to
/// the DEK, so each member protects their on-disk copy with their own password.
#[tauri::command]
async fn import_shared_profile(
    app: tauri::AppHandle,
    db_state: tauri::State<'_, DbState>,
    cloud: tauri::State<'_, std::sync::Arc<cloud::CloudState>>,
    share_id: String,
    local_name: String,
    vault_password: String,
) -> Result<SyncReport, String> {
    let (_, my_secret) = cloud.identity().await.ok_or("[SHARE] IDENTITY_LOCKED: unlock your sharing identity first")?;
    let mine = cloud::share_dek(&app, &cloud, &share_id).await?;
    let dek_vec = identity::unseal(&my_secret, &hex::decode(&mine.sealed_dek).map_err(|_| "[SHARE] BAD_GRANT")?)
        .map_err(|_| "[SHARE] UNSEAL_FAILED: this share wasn't sealed to your identity")?;
    if dek_vec.len() != 32 {
        return Err("[SHARE] BAD_DEK_LEN".into());
    }
    let dek_hex = hex::encode(&dek_vec);

    // Create the local vault (fresh profile) — same steps as create_profile.
    validate_profile_name(&local_name)?;
    if vault_password.is_empty() {
        return Err("Password cannot be empty".into());
    }
    let dir = profiles_dir(&app)?;
    fs::create_dir_all(&dir).map_err(|e| format!("[FILE] MKDIR_FAILED: {}", e))?;
    if profile_path(&app, &local_name)?.exists() {
        return Err(format!("Profile '{}' already exists", local_name));
    }
    *db_state.active_profile.lock().map_err(|_| "[STATE] LOCK_FAILED")? = Some(local_name.clone());
    // setup_master_db consumes a State handle; hand it a fresh one from `app` so
    // our own `db_state` stays usable for the sync_meta writes + sync below.
    {
        use tauri::Manager as _;
        if let Err(e) = setup_master_db(app.clone(), vault_password, app.state::<DbState>()).await {
            discard_half_built_profile(&app, &local_name);
            return Err(e);
        }
    }

    // Past this point the vault exists on disk — an import that doesn't finish
    // must leave no trace, or the next attempt hits "already exists" forever.
    // Replace the freshly-minted DEK with the SHARED one + record share meta, so
    // sync_now routes to /shares/sync and decrypts the shared blobs correctly.
    let seeded = (|| -> Result<(), String> {
        let conn_g = db_state.conn.lock().map_err(|_| "[STATE] LOCK_CONN")?;
        let conn = conn_g.as_ref().ok_or("[STATE] DB_NOT_OPEN")?;
        conn.execute(
            "INSERT INTO sync_meta(key,value) VALUES('dek',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            [&dek_hex],
        )
        .map_err(|e| format!("[SHARE] SET_DEK: {e}"))?;
        conn.execute(
            "INSERT INTO sync_meta(key,value) VALUES('share_id',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            [&share_id],
        )
        .map_err(|e| format!("[SHARE] SET_SHARE_ID: {e}"))?;
        conn.execute(
            "INSERT INTO sync_meta(key,value) VALUES('share_role',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            [&mine.role],
        )
        .map_err(|e| format!("[SHARE] SET_ROLE: {e}"))?;
        Ok(())
    })();
    if let Err(e) = seeded {
        discard_half_built_profile(&app, &local_name);
        return Err(e);
    }
    // Pull the shared data into the new profile.
    match sync_now(app.clone(), db_state, cloud).await {
        Ok(report) => Ok(report),
        Err(e) => {
            discard_half_built_profile(&app, &local_name);
            Err(e)
        }
    }
}

/// Undo a profile that was created on disk but never finished being filled.
///
/// Both `restore_personal_profile` and `import_shared_profile` build the local
/// vault BEFORE the network round-trip that populates it, because the vault has
/// to exist for the merge to have somewhere to land. That ordering left a trap:
/// if the pull failed — an expired token on a fresh sign-in, a dropped
/// connection, a 5xx — the command returned an error but the empty vault stayed
/// on disk, sealed under a randomly-minted key that matches nothing in the
/// cloud. Nothing marked it as broken, so the "Profile 'X' already exists" guard
/// treated it as real and every retry bounced off it. The only escape was to
/// spot the phantom in the picker and remove it by hand, which no error message
/// suggested.
///
/// Best-effort by design: we're already returning an error, and the caller's
/// original one is the one worth showing.
fn discard_half_built_profile(app: &tauri::AppHandle, name: &str) {
    use tauri::Manager as _;
    let state = app.state::<DbState>();
    if let Ok(mut g) = state.conn.lock() { *g = None; }
    if let Ok(mut g) = state.master_key.lock() { *g = None; }
    if let Ok(mut g) = state.salt.lock() { *g = None; }
    if let Ok(mut g) = state.db_path.lock() { *g = None; }
    if let Ok(mut g) = state.hlc.lock() { *g = None; }
    if let Ok(mut g) = state.active_profile.lock() { *g = None; }
    if let Ok(p) = profile_path(app, name) {
        let _ = fs::remove_file(p);
    }
}

/// New device: restore one of YOUR OWN personal cloud profiles using nothing but
/// its password. Pulls the profile's /sync stream, unseals its DEK from the
/// reserved escrow record by re-deriving the master key from the password + the
/// salt carried in that record, materialises a fresh local vault under that DEK
/// (protected by the same password), and populates it. This is the
/// personal-profile counterpart to `import_shared_profile` — no whole-vault blob
/// download, no sharing identity, no separate recovery secret. The profile must
/// have been synced at least once since it became password-restorable (so the
/// escrow record exists on the server).
#[tauri::command]
async fn restore_personal_profile(
    app: tauri::AppHandle,
    db_state: tauri::State<'_, DbState>,
    cloud: tauri::State<'_, std::sync::Arc<cloud::CloudState>>,
    cloud_profile: String,
    local_name: String,
    vault_password: String,
) -> Result<SyncReport, String> {
    // Validate up front so a bad name/empty password fails before any network.
    let cloud_profile = cloud_profile.trim().to_string();
    if cloud_profile.is_empty() {
        return Err("[SYNC] NO_PROFILE_NAME".into());
    }
    validate_profile_name(&local_name)?;
    if vault_password.is_empty() {
        return Err("Password cannot be empty".into());
    }

    // Peek at the cloud stream (empty push) and lift the escrow record out.
    let peek = cloud::sync_exchange(&app, &cloud, &cloud_profile, "", &[], None).await?;
    let sealed = peek
        .iter()
        .find(|r| r.entity_type == ESCROW_ETYPE && r.uuid == ESCROW_UUID)
        .and_then(|r| r.blob.clone())
        .ok_or("[SYNC] NO_ESCROW: no restorable copy of that profile in your cloud. Open it on the original device and sync once, then try again.")?;

    // Re-derive the master key from the password (Argon2id → blocking pool) and
    // unseal the DEK. A wrong password fails the GCM tag → surfaced as a wrong
    // password below.
    let pw_for_escrow = vault_password.clone();
    let dek = tokio::task::spawn_blocking(move || open_pw_escrow(&sealed, &pw_for_escrow))
        .await
        .map_err(|e| format!("[SYNC] ESCROW_JOIN: {e}"))?
        .map_err(|_| "[SYNC] ESCROW_UNSEAL_FAILED: wrong password for this profile")?;
    let dek_hex = hex::encode(dek);

    // Create the local vault (fresh profile) — same steps as create_profile.
    let dir = profiles_dir(&app)?;
    fs::create_dir_all(&dir).map_err(|e| format!("[FILE] MKDIR_FAILED: {}", e))?;
    if profile_path(&app, &local_name)?.exists() {
        return Err(format!("Profile '{}' already exists", local_name));
    }
    *db_state.active_profile.lock().map_err(|_| "[STATE] LOCK_FAILED")? = Some(local_name.clone());
    {
        use tauri::Manager as _;
        // No strength floor here: the escrow above already proved this is the
        // profile's real password. A pre-existing short one must still restore.
        if let Err(e) =
            setup_master_db_inner(app.clone(), vault_password, app.state::<DbState>(), false).await
        {
            discard_half_built_profile(&app, &local_name);
            return Err(e);
        }
    }

    // Past this point the vault exists on disk, so every remaining step has to
    // clean up after itself — a restore that didn't finish must leave no trace.
    // Swap the freshly-minted random DEK for the escrowed one, and remember the
    // cloud key in case the local name differs, so sync_now targets the right
    // /sync stream and decrypts the pulled blobs.
    let seeded = (|| -> Result<(), String> {
        let conn_g = db_state.conn.lock().map_err(|_| "[STATE] LOCK_CONN")?;
        let conn = conn_g.as_ref().ok_or("[STATE] DB_NOT_OPEN")?;
        conn.execute(
            "INSERT INTO sync_meta(key,value) VALUES('dek',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            [&dek_hex],
        )
        .map_err(|e| format!("[SYNC] SET_DEK: {e}"))?;
        conn.execute(
            "INSERT INTO sync_meta(key,value) VALUES('cloud_profile',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            [&cloud_profile],
        )
        .map_err(|e| format!("[SYNC] SET_CLOUD_PROFILE: {e}"))?;
        Ok(())
    })();
    if let Err(e) = seeded {
        discard_half_built_profile(&app, &local_name);
        return Err(e);
    }
    match sync_now(app.clone(), db_state, cloud).await {
        Ok(report) => Ok(report),
        Err(e) => {
            discard_half_built_profile(&app, &local_name);
            Err(e)
        }
    }
}

/// Owner: change a member's role.
#[tauri::command]
async fn share_set_role(
    app: tauri::AppHandle,
    cloud: tauri::State<'_, std::sync::Arc<cloud::CloudState>>,
    share_id: String,
    member_user_id: i64,
    role: String,
) -> Result<(), String> {
    if role != "editor" && role != "user" {
        return Err("[SHARE] BAD_ROLE".into());
    }
    cloud::set_member_role(&app, &cloud, &share_id, member_user_id, &role).await
}

/// Mint a fresh DEK for a share and re-seal it to everyone still on the roster.
///
/// Without this, revocation had no cryptographic backing at all: the removed
/// member kept the only key the share ever had, so the entire guarantee rested
/// on the server's access check never having a gap — no defence in depth, and
/// `get_or_create_dek`'s own doc already called rotation "a deliberate, separate
/// action" that was never actually built.
///
/// Both writes reuse existing endpoints, which upsert: `/shares/invite` replaces
/// an existing member's `sealed_dek` without disturbing their `status`, and
/// `/shares/create` replaces the owner's own grant. The owner's next sync
/// re-uploads every record under the new key (pushes are always a full set), and
/// remaining members pick the new key up because `sync_now` now refreshes it
/// before each shared exchange.
async fn rotate_share_dek(
    app: &tauri::AppHandle,
    db_state: &tauri::State<'_, DbState>,
    cloud: &tauri::State<'_, std::sync::Arc<cloud::CloudState>>,
    share_id: &str,
    share_name: &str,
) -> Result<(), String> {
    let (my_pub, _) = cloud.identity().await.ok_or("[SHARE] IDENTITY_LOCKED")?;
    let mut fresh = [0u8; 32];
    rand::thread_rng().fill(&mut fresh);

    // Re-seal to the owner FIRST. If this is the step that fails, nobody's grant
    // has changed yet and the old key is still universally valid — a clean no-op
    // rather than a share whose members hold a key the owner can't open.
    cloud::create_share(app, cloud, share_id, share_name, &hex::encode(identity::seal_to(&my_pub, &fresh)?)).await?;

    let roster = cloud::share_members(app, cloud, share_id).await?;
    for m in roster.iter().filter(|m| m.role != "owner" && m.status != "revoked") {
        let Some(info) = cloud::lookup_pubkey(app, cloud, &m.email).await? else { continue };
        let sealed = hex::encode(identity::seal_to(&hex_to_32(&info.public_key)?, &fresh)?);
        // Best-effort per member: one member whose key lookup fails must not
        // abort the rotation and leave the rest on a key the owner has already
        // replaced. They simply can't decrypt until re-invited, which is the
        // safe direction to fail.
        if let Err(e) = cloud::invite_member(app, cloud, share_id, &m.email, &m.role, &sealed).await {
            eprintln!("[SHARE] re-seal failed for {}: {e}", m.email);
        }
    }

    {
        let conn_g = db_state.conn.lock().map_err(|_| "[STATE] LOCK_CONN")?;
        let conn = conn_g.as_ref().ok_or("[STATE] DB_NOT_OPEN")?;
        conn.execute(
            "INSERT INTO sync_meta(key,value) VALUES('dek',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            [&hex::encode(fresh)],
        )
        .map_err(|e| format!("[SHARE] SET_DEK: {e}"))?;
    }
    save_vault_async(db_state).await
}

/// Owner: remove a member, then rotate the key they walked away with.
#[tauri::command]
async fn share_revoke(
    app: tauri::AppHandle,
    db_state: tauri::State<'_, DbState>,
    cloud: tauri::State<'_, std::sync::Arc<cloud::CloudState>>,
    share_id: String,
    member_user_id: i64,
) -> Result<(), String> {
    cloud::revoke_member(&app, &cloud, &share_id, member_user_id).await?;
    // Revocation itself has succeeded by here. If the rotation leg fails we
    // still report success for the removal — the member IS out — but say plainly
    // that the key wasn't replaced, because that's the part with a security
    // consequence and silently swallowing it would misrepresent what happened.
    let name = {
        let conn_g = db_state.conn.lock().map_err(|_| "[STATE] LOCK_CONN")?;
        let conn = conn_g.as_ref().ok_or("[STATE] DB_NOT_OPEN")?;
        conn.query_row("SELECT value FROM sync_meta WHERE key='share_name'", [], |r| r.get::<_, String>(0))
            .ok()
    };
    let name = match name {
        Some(n) => n,
        None => db_state
            .active_profile
            .lock()
            .map_err(|_| "[STATE] LOCK_FAILED")?
            .clone()
            .unwrap_or_else(|| "profile".to_string()),
    };
    if let Err(e) = rotate_share_dek(&app, &db_state, &cloud, &share_id, &name).await {
        return Err(format!(
            "[SHARE] REVOKED_BUT_KEY_NOT_ROTATED: {} is out of the share, but the shared key could not be replaced ({e}). \
             They can no longer reach the server, but they still hold the old key — retry from the members list to rotate it.",
            member_user_id
        ));
    }
    Ok(())
}

/// Non-owner: leave a share.
#[tauri::command]
async fn share_leave(
    app: tauri::AppHandle,
    cloud: tauri::State<'_, std::sync::Arc<cloud::CloudState>>,
    share_id: String,
) -> Result<(), String> {
    cloud::leave_share(&app, &cloud, &share_id).await
}

/// Owner: delete the whole shared profile.
#[tauri::command]
async fn share_delete(
    app: tauri::AppHandle,
    cloud: tauri::State<'_, std::sync::Arc<cloud::CloudState>>,
    share_id: String,
) -> Result<(), String> {
    cloud::delete_share(&app, &cloud, &share_id).await
}

#[derive(serde::Serialize)]
struct ProfileShareStatus {
    profile: Option<String>,
    share_id: Option<String>,
    role: Option<String>,
    identity_unlocked: bool,
    signed_in: bool,
    email: Option<String>,
}

/// Everything the in-app Profile panel needs about the OPEN profile, read in one
/// shot with no network call so the panel paints instantly: which profile is
/// open, whether it's shared and at what role, and whether the cloud account and
/// sharing identity are ready. The member roster is fetched separately.
#[tauri::command]
async fn profile_share_status(
    db_state: tauri::State<'_, DbState>,
    cloud: tauri::State<'_, std::sync::Arc<cloud::CloudState>>,
) -> Result<ProfileShareStatus, String> {
    // Scoped so both std MutexGuards drop before the awaits below.
    let (profile, share_id, role) = {
        let profile = db_state
            .active_profile
            .lock()
            .map_err(|_| "[STATE] LOCK_FAILED")?
            .clone();
        let conn_g = db_state.conn.lock().map_err(|_| "[STATE] LOCK_CONN")?;
        match conn_g.as_ref() {
            Some(conn) => {
                let sid: Option<String> = conn
                    .query_row("SELECT value FROM sync_meta WHERE key='share_id'", [], |r| r.get(0))
                    .ok();
                let role: Option<String> = conn
                    .query_row("SELECT value FROM sync_meta WHERE key='share_role'", [], |r| r.get(0))
                    .ok();
                (profile, sid, role)
            }
            None => (profile, None, None),
        }
    };
    let st = cloud.status().await;
    Ok(ProfileShareStatus {
        profile,
        share_id,
        role,
        identity_unlocked: cloud.identity().await.is_some(),
        signed_in: st.signed_in,
        email: st.email,
    })
}

/// Stop sharing the OPEN profile. Owner → tears the share down for everyone;
/// member → leaves it. Either way this device keeps its local copy: only the
/// share bookkeeping is cleared, so the profile falls back to syncing on the
/// personal path under the DEK it already holds.
#[tauri::command]
async fn stop_sharing(
    app: tauri::AppHandle,
    db_state: tauri::State<'_, DbState>,
    cloud: tauri::State<'_, std::sync::Arc<cloud::CloudState>>,
) -> Result<(), String> {
    let (share_id, role) = {
        let conn_g = db_state.conn.lock().map_err(|_| "[STATE] LOCK_CONN")?;
        let conn = conn_g.as_ref().ok_or("[STATE] DB_NOT_OPEN")?;
        let sid: Option<String> = conn
            .query_row("SELECT value FROM sync_meta WHERE key='share_id'", [], |r| r.get(0))
            .ok();
        let role: Option<String> = conn
            .query_row("SELECT value FROM sync_meta WHERE key='share_role'", [], |r| r.get(0))
            .ok();
        (
            sid.ok_or("[SHARE] NOT_SHARED: this profile isn't shared")?,
            role.unwrap_or_default(),
        )
    };
    if role == "owner" {
        // The owner is the only one who can manage or delete the share, so if
        // the server never got the message we must NOT forget the share_id —
        // dropping it locally would orphan a live share that members keep
        // syncing against, with nobody left able to shut it down.
        cloud::delete_share(&app, &cloud, &share_id).await?;
    } else {
        // Leaving is the member's own decision about their own device, so it has
        // to succeed locally whatever the server says. It used to abort on any
        // error — which meant a member who had ALREADY been revoked could never
        // leave: the server rightly rejects a leave from a non-member, so the
        // one escape hatch the UI offers failed every single time, and their
        // vault stayed pointed at a dead share that errored on every sync
        // forever. Best-effort tell the server, then clear regardless.
        if let Err(e) = cloud::leave_share(&app, &cloud, &share_id).await {
            eprintln!("[SHARE] leave_share failed, clearing locally anyway: {e}");
        }
    }
    {
        let conn_g = db_state.conn.lock().map_err(|_| "[STATE] LOCK_CONN")?;
        let conn = conn_g.as_ref().ok_or("[STATE] DB_NOT_OPEN")?;
        conn.execute("DELETE FROM sync_meta WHERE key IN ('share_id','share_role','share_name')", [])
            .map_err(|e| format!("[SHARE] CLEAR_META: {e}"))?;
    }
    save_vault_async(&db_state).await
}

/// Set the label stamped onto future local edits (the `edited_by` column). The
/// frontend calls this on unlock with the signed-in cloud email so changes are
/// attributed to a person across shared/multi-device use. An empty label clears
/// it (edits stay unattributed). Local-only — sync_meta never leaves the vault.
#[tauri::command]
async fn set_editor_label(db_state: tauri::State<'_, DbState>, label: String) -> Result<(), String> {
    let label = label.trim().to_string();
    {
        let conn_g = db_state.conn.lock().map_err(|_| "[STATE] LOCK_CONN")?;
        let conn = conn_g.as_ref().ok_or("[STATE] DB_NOT_OPEN")?;
        if label.is_empty() {
            conn.execute("DELETE FROM sync_meta WHERE key='editor_label'", [])
                .map_err(|e| format!("[SYNC] EDITOR_CLEAR: {e}"))?;
        } else {
            conn.execute(
                "INSERT INTO sync_meta(key,value) VALUES('editor_label',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                [&label],
            )
            .map_err(|e| format!("[SYNC] EDITOR_SET: {e}"))?;
        }
    }
    save_vault_async(&db_state).await
}

#[cfg(test)]
mod sync_engine_tests {
    use super::*;
    use rusqlite::Connection;

    const KEY: [u8; 32] = [7u8; 32];

    // The DEK-escrow record round-trips through the sync stream: sealed under
    // the profile's own password on push, recovered on a fresh device from just
    // that password — and it's inert to the merge engine (never a phantom row).
    #[test]
    fn dek_escrow_round_trips_and_apply_ignores_it() {
        let dek: [u8; 32] = KEY;
        let salt = [3u8; SALT_LEN];
        let password = "correct horse battery staple";
        let master_key = derive_key(password, &salt).unwrap();
        let rec = build_pw_escrow_record(&master_key, &salt, &dek).unwrap();
        assert_eq!(rec.entity_type, ESCROW_ETYPE);
        assert_eq!(rec.uuid, ESCROW_UUID);

        // A fresh device recovers the exact DEK from just the password...
        let recovered = open_pw_escrow(rec.blob.as_ref().unwrap(), password).unwrap();
        assert_eq!(recovered, dek, "escrow must recover the exact DEK");
        // ...and the wrong password must not (GCM tag fails).
        assert!(
            open_pw_escrow(rec.blob.as_ref().unwrap(), "wrong password").is_err(),
            "wrong password must not recover the DEK"
        );

        // Applying an escrow record must not create a phantom row anywhere.
        let (b, hb) = device("B");
        apply_remote_records(&b, &KEY, std::slice::from_ref(&rec), &hb).unwrap();
        for spec in ENTITIES {
            let n: i64 = b
                .query_row(&format!("SELECT COUNT(*) FROM {}", spec.table), [], |r| r.get(0))
                .unwrap();
            assert_eq!(n, 0, "escrow record must not land in table {}", spec.table);
        }
    }

    #[test]
    fn edited_by_is_stamped_and_syncs() {
        let (a, _ha) = device("A");
        a.execute("INSERT INTO sync_meta(key,value) VALUES('editor_label','alice@x.com')", []).unwrap();
        a.execute("INSERT INTO servers(name,host,port) VALUES('web','h',22)", []).unwrap();
        let recs = collect_local_records(&a, &KEY, "").unwrap();
        let srv = recs.iter().find(|r| r.entity_type == "servers").unwrap();
        let plain = decrypt_entity(srv.blob.as_ref().unwrap(), &KEY).unwrap();
        let v: serde_json::Value = serde_json::from_slice(&plain).unwrap();
        assert_eq!(v["edited_by"], "alice@x.com", "trigger must stamp the editor label");

        // Cross-device apply preserves who edited it (not overwritten locally).
        let (b, hb) = device("B");
        apply_remote_records(&b, &KEY, &recs, &hb).unwrap();
        let eb: String = b.query_row("SELECT edited_by FROM servers WHERE name='web'", [], |r| r.get(0)).unwrap();
        assert_eq!(eb, "alice@x.com");
    }

    #[test]
    fn dek_is_stable_and_encrypts_blobs() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute("CREATE TABLE sync_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)", [])
            .unwrap();
        let (dek1, created1) = get_or_create_dek(&conn).unwrap();
        assert!(created1, "first call must mint the DEK");
        let (dek2, created2) = get_or_create_dek(&conn).unwrap();
        assert!(!created2, "second call must reuse it");
        assert_eq!(dek1, dek2, "DEK must be stable across opens");
        // A per-entity blob encrypted under the DEK round-trips with the reloaded DEK.
        let blob = encrypt_entity(b"{\"host\":\"h\"}", &dek1).unwrap();
        assert_eq!(decrypt_entity(&blob, &dek2).unwrap(), b"{\"host\":\"h\"}");
    }

    fn device(node: &str) -> (Connection, std::sync::Arc<hlc::Hlc>) {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE folders(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, parent_id INTEGER, color TEXT, uuid TEXT, updated_at TEXT, deleted INTEGER NOT NULL DEFAULT 0, edited_by TEXT);
             CREATE TABLE ssh_keys(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, public_key TEXT, private_key TEXT, passphrase TEXT, uuid TEXT, updated_at TEXT, deleted INTEGER NOT NULL DEFAULT 0, edited_by TEXT);
             CREATE TABLE credentials(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, auth_type TEXT, username TEXT, password TEXT, key_id INTEGER, uuid TEXT, updated_at TEXT, deleted INTEGER NOT NULL DEFAULT 0, edited_by TEXT);
             CREATE TABLE servers(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, host TEXT, port INTEGER, username TEXT, password TEXT, credential_id INTEGER, folder_id INTEGER, proxy_type TEXT, proxy_host TEXT, proxy_port INTEGER, tunnels TEXT, auth_type TEXT, key_id INTEGER, autostart INTEGER, mirrors TEXT, color TEXT, notes TEXT, run_on_connect TEXT, jump_host_id INTEGER, position INTEGER NOT NULL DEFAULT 0, is_production INTEGER NOT NULL DEFAULT 0, icon TEXT DEFAULT 'server', os_info TEXT DEFAULT '', uuid TEXT, updated_at TEXT, deleted INTEGER NOT NULL DEFAULT 0, edited_by TEXT);
             CREATE TABLE commands(id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, content TEXT, uuid TEXT, updated_at TEXT, deleted INTEGER NOT NULL DEFAULT 0, edited_by TEXT);
             CREATE TABLE notes(id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, body TEXT, uuid TEXT, updated_at TEXT, deleted INTEGER NOT NULL DEFAULT 0, edited_by TEXT);
             CREATE TABLE monitor_configs(node_id INTEGER PRIMARY KEY, enabled_metrics TEXT, custom_metrics TEXT, paused INTEGER, uuid TEXT, updated_at TEXT, deleted INTEGER NOT NULL DEFAULT 0, edited_by TEXT);",
        ).unwrap();
        let hlc = std::sync::Arc::new(hlc::Hlc::new(node.into(), 0));
        register_sync_functions(&conn, &hlc).unwrap();
        create_sync_triggers(&conn).unwrap();
        (conn, hlc)
    }

    /// A vault from before the sync era: the same schema, but no triggers have
    /// ever run over it, so every row still has `uuid IS NULL`. Two calls give
    /// two byte-identical copies — i.e. the same vault sitting on two devices.
    fn presync_vault() -> Connection {
        let (conn, _) = device("pre");
        conn.execute_batch(
            "DROP TRIGGER IF EXISTS trg_servers_ai; DROP TRIGGER IF EXISTS trg_servers_au;
             DROP TRIGGER IF EXISTS trg_servers_ad;",
        )
        .unwrap();
        conn.execute("DELETE FROM servers", []).unwrap();
        conn.execute("DELETE FROM sync_tombstones", []).unwrap();
        conn.execute("INSERT INTO servers(id,name,host,port,username) VALUES(1,'web','h1',22,'root')", []).unwrap();
        conn.execute("INSERT INTO servers(id,name,host,port,username) VALUES(2,'old','h9',22,'root')", []).unwrap();
        conn.execute("UPDATE servers SET uuid=NULL, updated_at=NULL", []).unwrap();
        conn
    }

    // The exact incident: an old copy of a vault was opened on a second device.
    // It had never synced, so the backfill had to invent identity for its rows.
    // Inventing a RANDOM uuid + a NOW stamp (what we used to do) meant the stale
    // copy pushed itself as brand-new, freshest-in-the-world entities —
    // duplicating every row and resurrecting everything deleted elsewhere.
    #[test]
    fn an_old_vault_copy_cannot_overwrite_or_resurrect() {
        // Device A: adopted the vault, then did real work — edited one server
        // and deleted the other.
        let a = presync_vault();
        let ha = std::sync::Arc::new(hlc::Hlc::new("A".into(), 0));
        register_sync_functions(&a, &ha).unwrap();
        backfill_sync_columns(&a, &ha).unwrap();
        create_sync_triggers(&a).unwrap();
        a.execute("UPDATE servers SET host='h2' WHERE name='web'", []).unwrap();
        a.execute("DELETE FROM servers WHERE name='old'", []).unwrap();
        let from_a = collect_local_records(&a, &KEY, "").unwrap();

        // Device B: the OLD phone. Same vault, untouched, adopted just now.
        let b = presync_vault();
        let hb = std::sync::Arc::new(hlc::Hlc::new("B".into(), 0));
        register_sync_functions(&b, &hb).unwrap();
        backfill_sync_columns(&b, &hb).unwrap();
        create_sync_triggers(&b).unwrap();
        let from_b = collect_local_records(&b, &KEY, "").unwrap();

        // Both devices independently derived the SAME id for the same row, so
        // the merge sees one entity rather than two unrelated ones.
        let ua: String = a.query_row("SELECT uuid FROM servers WHERE name='web'", [], |r| r.get(0)).unwrap();
        let ub: String = b.query_row("SELECT uuid FROM servers WHERE name='web'", [], |r| r.get(0)).unwrap();
        assert_eq!(ua, ub, "same row on two copies of one vault must derive one uuid");

        // B's untouched rows sit at the clock floor, not at "now".
        let uat: String = b.query_row("SELECT updated_at FROM servers WHERE name='old'", [], |r| r.get(0)).unwrap();
        assert_eq!(uat, BACKFILL_UAT, "a never-synced row must not claim to be fresh");

        // Now the round trip. A's work reaches B...
        apply_remote_records(&b, &KEY, &from_a, &hb).unwrap();
        let host: String = b.query_row("SELECT host FROM servers WHERE name='web'", [], |r| r.get(0)).unwrap();
        assert_eq!(host, "h2", "B must take A's edit");
        let alive: i64 = b
            .query_row("SELECT COUNT(*) FROM servers WHERE name='old' AND deleted=0", [], |r| r.get(0))
            .unwrap();
        assert_eq!(alive, 0, "B must honour A's deletion");

        // ...and B's stale copy reaches A, where it must change nothing.
        apply_remote_records(&a, &KEY, &from_b, &ha).unwrap();
        let host: String = a.query_row("SELECT host FROM servers WHERE name='web'", [], |r| r.get(0)).unwrap();
        assert_eq!(host, "h2", "a stale copy must not overwrite a real edit");
        let alive: i64 = a
            .query_row("SELECT COUNT(*) FROM servers WHERE name='old' AND deleted=0", [], |r| r.get(0))
            .unwrap();
        assert_eq!(alive, 0, "a stale copy must not resurrect a deleted row");
        let total: i64 = a.query_row("SELECT COUNT(*) FROM servers", [], |r| r.get(0)).unwrap();
        assert_eq!(total, 1, "a stale copy must not duplicate rows");
    }

    // Rows with nothing to identify them can't derive a stable id, and two rows
    // that DO collide must not be fused into one — both fall back to random ids.
    #[test]
    fn backfill_falls_back_to_random_ids_rather_than_fusing_rows() {
        assert_eq!(derived_entity_uuid("servers", &[None, Some(String::new())]), None);

        let conn = presync_vault();
        // Two rows identical in every identifying column.
        conn.execute("UPDATE servers SET name='web', host='h1', port=22, username='root' WHERE id=2", []).unwrap();
        let h = std::sync::Arc::new(hlc::Hlc::new("A".into(), 0));
        register_sync_functions(&conn, &h).unwrap();
        backfill_sync_columns(&conn, &h).unwrap();
        let n: i64 = conn
            .query_row("SELECT COUNT(DISTINCT uuid) FROM servers", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 2, "two local rows must never share one uuid");
    }

    // Monitoring config used to be instrumented for sync — triggers, backfill,
    // a uuid index — but was missing from ENTITIES, the list that actually
    // drives push/apply. So it silently never crossed devices.
    #[test]
    fn monitor_config_syncs_and_binds_to_the_right_server() {
        let (a, _ha) = device("A");
        a.execute("INSERT INTO servers(name,host,port) VALUES('web','h',22)", []).unwrap();
        a.execute(
            "INSERT INTO monitor_configs(node_id,enabled_metrics,custom_metrics,paused)
             VALUES((SELECT id FROM servers WHERE name='web'),'[\"cpu\",\"mem\"]','[\"nginx\"]',0)",
            [],
        )
        .unwrap();
        let recs = collect_local_records(&a, &KEY, "").unwrap();
        assert!(
            recs.iter().any(|r| r.entity_type == "monitor_configs"),
            "monitor config must be pushed"
        );

        // B has an unrelated server first, so its rowids differ from A's —
        // binding by uuid rather than by raw id is the whole point.
        let (b, hb) = device("B");
        b.execute("INSERT INTO servers(name,host,port) VALUES('other','o',22)", []).unwrap();
        apply_remote_records(&b, &KEY, &recs, &hb).unwrap();

        let bound: String = b
            .query_row(
                "SELECT s.name FROM monitor_configs mc JOIN servers s ON s.id = mc.node_id",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(bound, "web", "config must attach to the SAME server, not a matching rowid");
        let metrics: String = b
            .query_row("SELECT enabled_metrics FROM monitor_configs", [], |r| r.get(0))
            .unwrap();
        assert_eq!(metrics, "[\"cpu\",\"mem\"]");
    }

    // Both devices enabling monitoring on the same server independently must
    // converge on one config row, not collide over its node_id primary key.
    #[test]
    fn independent_monitor_configs_for_one_server_converge() {
        let mk = |node: &str| {
            let (c, h) = device(node);
            c.execute("INSERT INTO servers(uuid,name,host,port) VALUES('fixedserveruuid00000000000000ab','web','h',22)", []).unwrap();
            c.execute(
                "INSERT INTO monitor_configs(node_id,enabled_metrics,custom_metrics,paused)
                 VALUES((SELECT id FROM servers WHERE name='web'),'[\"cpu\"]','[]',1)",
                [],
            )
            .unwrap();
            (c, h)
        };
        let (a, _ha) = mk("A");
        let (b, hb) = mk("B");

        let ua: String = a.query_row("SELECT uuid FROM monitor_configs", [], |r| r.get(0)).unwrap();
        let ub: String = b.query_row("SELECT uuid FROM monitor_configs", [], |r| r.get(0)).unwrap();
        assert_eq!(ua, ub, "same server ⇒ same config id on both devices");
        assert_ne!(ua, "fixedserveruuid00000000000000ab", "must not reuse the server's own id");

        apply_remote_records(&b, &KEY, &collect_local_records(&a, &KEY, "").unwrap(), &hb).unwrap();
        let n: i64 = b.query_row("SELECT COUNT(*) FROM monitor_configs", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 1, "must converge to one config, not two");
    }

    // A config whose server hasn't arrived yet must be skipped, never written
    // with a NULL node_id — that column is the primary key, so SQLite would mint
    // a rowid and silently bind the config to nothing.
    #[test]
    fn monitor_config_without_its_server_is_skipped() {
        let (a, _ha) = device("A");
        a.execute("INSERT INTO servers(name,host,port) VALUES('web','h',22)", []).unwrap();
        a.execute(
            "INSERT INTO monitor_configs(node_id,enabled_metrics,custom_metrics,paused)
             VALUES((SELECT id FROM servers WHERE name='web'),'[\"cpu\"]','[]',1)",
            [],
        )
        .unwrap();
        let only_config: Vec<SyncRecord> = collect_local_records(&a, &KEY, "")
            .unwrap()
            .into_iter()
            .filter(|r| r.entity_type == "monitor_configs")
            .collect();
        assert_eq!(only_config.len(), 1);

        let (b, hb) = device("B"); // no servers at all
        apply_remote_records(&b, &KEY, &only_config, &hb).unwrap();
        let n: i64 = b.query_row("SELECT COUNT(*) FROM monitor_configs", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 0, "orphan config must be skipped, not bound to a phantom node");
    }

    // Two devices doing ordinary independent work: one edits a server, the other
    // deletes that server's jump host. Both changes arrive in ONE batch. The FK
    // resolved fine while the jump host was still present, then the tombstone
    // removed it — and the fixup pass used to skip anything that had resolved, so
    // the link was left pointing at a row that no longer existed.
    #[test]
    fn a_referent_deleted_in_the_same_batch_clears_the_link() {
        let (a, _ha) = device("A");
        a.execute("INSERT INTO servers(name,host,port) VALUES('bastion','b',22)", []).unwrap();
        a.execute(
            "INSERT INTO servers(name,host,port,jump_host_id) VALUES('app','a',22,(SELECT id FROM servers WHERE name='bastion'))",
            [],
        )
        .unwrap();
        let seed = collect_local_records(&a, &KEY, "").unwrap();

        // Device C starts from the same state, so it holds both servers, linked.
        let (c, hc) = device("C");
        apply_remote_records(&c, &KEY, &seed, &hc).unwrap();
        let linked: i64 = c
            .query_row(
                "SELECT COUNT(*) FROM servers s JOIN servers j ON j.id = s.jump_host_id WHERE s.name='app'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(linked, 1, "precondition: the jump link exists on C");

        // A re-touches 'app' (so it ships as a live record) and deletes the
        // bastion (so a tombstone ships in the SAME batch).
        a.execute("UPDATE servers SET host='a2' WHERE name='app'", []).unwrap();
        a.execute("DELETE FROM servers WHERE name='bastion'", []).unwrap();
        let batch = collect_local_records(&a, &KEY, "").unwrap();
        assert!(batch.iter().any(|r| r.deleted), "batch must carry the tombstone");

        apply_remote_records(&c, &KEY, &batch, &hc).unwrap();
        let dangling: Option<i64> = c
            .query_row("SELECT jump_host_id FROM servers WHERE name='app'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(dangling, None, "the link must be cleared, not left dangling");
    }

    #[test]
    fn round_trip_resolves_fks_across_devices() {
        let (a, _ha) = device("A");
        a.execute("INSERT INTO ssh_keys(name, public_key, private_key) VALUES('k','pub','priv')", []).unwrap();
        a.execute("INSERT INTO credentials(name, auth_type, username, key_id) VALUES('c','key','root',(SELECT id FROM ssh_keys WHERE name='k'))", []).unwrap();
        a.execute("INSERT INTO folders(name) VALUES('f')", []).unwrap();
        a.execute("INSERT INTO servers(name, host, port, credential_id, folder_id) VALUES('s1','h',22,(SELECT id FROM credentials WHERE name='c'),(SELECT id FROM folders WHERE name='f'))", []).unwrap();
        let recs = collect_local_records(&a, &KEY, "").unwrap();

        let (b, hb) = device("B");
        // Unrelated pre-existing row so B's autoincrement ids differ from A's,
        // proving the merge resolves references by uuid, not by raw id.
        b.execute("INSERT INTO folders(name) VALUES('other')", []).unwrap();
        apply_remote_records(&b, &KEY, &recs, &hb).unwrap();

        let (cred, folder): (String, String) = b.query_row(
            "SELECT (SELECT name FROM credentials c WHERE c.id=s.credential_id), (SELECT name FROM folders f WHERE f.id=s.folder_id) FROM servers s WHERE s.name='s1'",
            [], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
        assert_eq!(cred, "c", "server.credential_id must resolve to the right credential on B");
        assert_eq!(folder, "f", "server.folder_id must resolve to the right folder on B");
        let key_name: String = b.query_row("SELECT (SELECT name FROM ssh_keys k WHERE k.id=c.key_id) FROM credentials c WHERE c.name='c'", [], |r| r.get(0)).unwrap();
        assert_eq!(key_name, "k", "credential.key_id must resolve to the right ssh_key on B");
    }

    // Regression: `position` (NOT NULL) was added to servers' synced cols in
    // 0.3.5. A PRE-0.3.5 peer's payload omits the key, so apply_entity used to
    // bind an explicit SQL NULL, hit "NOT NULL constraint failed:
    // servers.position", and silently skip the whole server row — losing its
    // SSH credentials — with no self-heal. The merge must default a missing
    // position to 0 and land the row.
    #[test]
    fn a_pre_0_3_5_peer_server_without_position_still_merges() {
        let (a, _ha) = device("A");
        a.execute("INSERT INTO servers(name, host, password) VALUES('prod','h','SECRET')", []).unwrap();
        let mut recs = collect_local_records(&a, &KEY, "").unwrap();
        // Rewrite the server blob to look like an old peer's: strip `position`.
        for r in recs.iter_mut() {
            if r.entity_type == "servers" {
                let plain = decrypt_entity(r.blob.as_deref().unwrap(), &KEY).unwrap();
                let mut obj: serde_json::Value = serde_json::from_slice(&plain).unwrap();
                obj.as_object_mut().unwrap().remove("position");
                assert!(obj.get("position").is_none(), "test setup: position must be absent");
                let bytes = serde_json::to_vec(&obj).unwrap();
                r.blob = Some(encrypt_entity(&bytes, &KEY).unwrap());
            }
        }

        let (b, hb) = device("B");
        apply_remote_records(&b, &KEY, &recs, &hb).unwrap();

        // Row must exist (not skipped), and the absent position defaults to 0.
        let (host, pos): (String, i64) = b
            .query_row("SELECT host, position FROM servers WHERE name='prod'", [], |r| Ok((r.get(0)?, r.get(1)?)))
            .expect("a server from a pre-0.3.5 peer (no position key) must merge, not be skipped");
        assert_eq!(host, "h");
        assert_eq!(pos, 0, "a missing position must default to 0");
    }

    // Regression for the UPDATE-arm half of the 0.3.5 position shim. The INSERT
    // case above lands a missing position as 0; here the row ALREADY EXISTS with
    // a manual drag-rank when a pre-0.3.5 peer (payload omits `position`) syncs a
    // winning edit to some OTHER field. The merge must apply the edit but KEEP
    // the local rank — binding the coerced 0 into `position=excluded.position`
    // would silently reset a deliberate ordering on every cross-version edit.
    #[test]
    fn a_pre_0_3_5_peer_edit_preserves_local_drag_position() {
        let (a, _ha) = device("A");
        a.execute("INSERT INTO servers(name, host, password) VALUES('prod','h1','SECRET')", []).unwrap();

        // B receives the server, then the user drags it to rank 5.
        let (b, hb) = device("B");
        apply_remote_records(&b, &KEY, &collect_local_records(&a, &KEY, "").unwrap(), &hb).unwrap();
        b.execute("UPDATE servers SET position=5 WHERE name='prod'", []).unwrap();
        let pos_before: i64 = b.query_row("SELECT position FROM servers WHERE name='prod'", [], |r| r.get(0)).unwrap();
        assert_eq!(pos_before, 5, "test setup: B's local rank is 5");

        // A (an old peer) edits the host. Strip `position` from the blob and
        // force a lexically-max HLC stamp ("9"*15 dwarfs any real millis in the
        // `{:015}:{:05}:node` format) so the record deterministically WINS LWW on
        // B and reaches the UPDATE arm — the case this fix guards.
        a.execute("UPDATE servers SET host='h2' WHERE name='prod'", []).unwrap();
        let mut recs = collect_local_records(&a, &KEY, "").unwrap();
        for r in recs.iter_mut() {
            if r.entity_type == "servers" {
                let plain = decrypt_entity(r.blob.as_deref().unwrap(), &KEY).unwrap();
                let mut obj: serde_json::Value = serde_json::from_slice(&plain).unwrap();
                obj.as_object_mut().unwrap().remove("position");
                r.blob = Some(encrypt_entity(&serde_json::to_vec(&obj).unwrap(), &KEY).unwrap());
                r.updated_at = "999999999999999:99999:zzz".to_string();
            }
        }
        apply_remote_records(&b, &KEY, &recs, &hb).unwrap();

        let (host, pos): (String, i64) = b
            .query_row("SELECT host, position FROM servers WHERE name='prod'", [], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap();
        assert_eq!(host, "h2", "the newer remote field edit must apply");
        assert_eq!(pos, 5, "a pre-0.3.5 peer edit must NOT reset the local drag position to 0");
    }

    #[test]
    fn lww_older_remote_does_not_clobber_newer_local() {
        let (a, _ha) = device("A");
        a.execute("INSERT INTO servers(name, host) VALUES('s','h1')", []).unwrap();
        let old = collect_local_records(&a, &KEY, "").unwrap();
        let (b, hb) = device("B");
        apply_remote_records(&b, &KEY, &old, &hb).unwrap();
        b.execute("UPDATE servers SET host='h2-newer' WHERE name='s'", []).unwrap();
        apply_remote_records(&b, &KEY, &old, &hb).unwrap(); // re-apply the STALE version
        let host: String = b.query_row("SELECT host FROM servers WHERE name='s'", [], |r| r.get(0)).unwrap();
        assert_eq!(host, "h2-newer", "an older remote record must not overwrite a newer local edit");
    }

    // `sync_now` snapshots records under the DB lock, then DROPS the lock for
    // the network leg — so the user can delete a node while their own batch is
    // still in flight. The reply is the server's view computed from the
    // PRE-delete push (and `since` is always "", so it echoes everything back),
    // meaning it still carries the deleted node as live. The tombstone is the
    // only thing standing between that reply and a resurrected password.
    #[test]
    fn stale_inflight_batch_does_not_resurrect_a_deleted_row() {
        let (a, ha) = device("A");
        a.execute("INSERT INTO servers(name, host, password) VALUES('prod','h','SUPERSECRET')", []).unwrap();

        // T=0 — sync collects the batch and lets go of the lock.
        let inflight = collect_local_records(&a, &KEY, "").unwrap();

        // T=2s — user deletes the node while the POST is still in flight.
        a.execute("DELETE FROM servers WHERE name='prod'", []).unwrap();

        // T=5s — reply lands, still carrying 'prod' as live at its old stamp.
        apply_remote_records(&a, &KEY, &inflight, &ha).unwrap();

        let live: i64 = a
            .query_row("SELECT COUNT(*) FROM servers WHERE name='prod'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(live, 0, "a stale in-flight batch must not resurrect a deleted row");
    }

    // The mirror case: a delete must not shadow a genuine re-creation. If some
    // other device creates a row again AFTER our delete, its stamp is newer than
    // our tombstone and it has to land.
    #[test]
    fn tombstone_does_not_block_a_newer_recreate() {
        let (a, ha) = device("A");
        a.execute("INSERT INTO servers(name, host) VALUES('s','h1')", []).unwrap();
        let uuid: String = a.query_row("SELECT uuid FROM servers WHERE name='s'", [], |r| r.get(0)).unwrap();
        a.execute("DELETE FROM servers WHERE name='s'", []).unwrap();
        assert_eq!(
            a.query_row("SELECT COUNT(*) FROM sync_tombstones WHERE uuid=?1", [&uuid], |r| r.get::<_, i64>(0)).unwrap(),
            1,
        );

        // Device B re-creates the same uuid later (newer HLC than our tombstone).
        let (b, hb) = device("B");
        b.execute("INSERT INTO servers(name, host) VALUES('s','h2-recreated')", []).unwrap();
        b.execute("UPDATE servers SET uuid=?1, updated_at=hlc_now() WHERE name='s'", [&uuid]).unwrap();
        let recreate = collect_local_records(&b, &KEY, "").unwrap();
        let _ = hb;

        apply_remote_records(&a, &KEY, &recreate, &ha).unwrap();
        let host: Option<String> = a.query_row("SELECT host FROM servers WHERE uuid=?1", [&uuid], |r| r.get(0)).ok();
        assert_eq!(
            host.as_deref(),
            Some("h2-recreated"),
            "a re-create newer than the tombstone must still apply",
        );
    }

    #[test]
    fn delete_propagates_via_tombstone() {
        let (a, _ha) = device("A");
        a.execute("INSERT INTO servers(name, host) VALUES('s','h')", []).unwrap();
        let (b, hb) = device("B");
        apply_remote_records(&b, &KEY, &collect_local_records(&a, &KEY, "").unwrap(), &hb).unwrap();
        assert_eq!(b.query_row("SELECT COUNT(*) FROM servers WHERE name='s'", [], |r| r.get::<_, i64>(0)).unwrap(), 1);
        a.execute("DELETE FROM servers WHERE name='s'", []).unwrap();
        let recs = collect_local_records(&a, &KEY, "").unwrap();
        assert!(recs.iter().any(|r| r.deleted), "delete must produce a tombstone record");
        apply_remote_records(&b, &KEY, &recs, &hb).unwrap();
        assert_eq!(b.query_row("SELECT COUNT(*) FROM servers WHERE name='s'", [], |r| r.get::<_, i64>(0)).unwrap(), 0, "delete must propagate to B");
    }

    // One corrupt / hostile record from a broken (or compromised) server must be
    // skipped, never abort the whole merge — every OTHER record in the same batch
    // still lands. This is the "one poison record can't take sync down" guarantee.
    #[test]
    fn corrupt_record_is_skipped_without_aborting_the_batch() {
        let (a, _ha) = device("A");
        a.execute("INSERT INTO servers(name, host) VALUES('good','h-good')", []).unwrap();
        let mut recs = collect_local_records(&a, &KEY, "").unwrap();

        // A record shaped like a real 'servers' row but whose blob is valid
        // ciphertext under the WRONG key — it can't decrypt under KEY, exactly
        // like a corrupt or tampered blob. Placed FIRST so we prove the good
        // record after it still applies once the poison one is skipped.
        let good = recs.iter().find(|r| r.entity_type == "servers").unwrap().clone();
        let mut poison = good.clone();
        poison.uuid = "ab".repeat(16);
        poison.blob = Some(encrypt_entity(br#"{"host":"h-poison"}"#, &[9u8; 32]).unwrap());
        recs.insert(0, poison);

        let (b, hb) = device("B");
        // Must NOT return Err — the poison record is logged and skipped internally.
        apply_remote_records(&b, &KEY, &recs, &hb).unwrap();

        // The good record landed...
        let host: Option<String> =
            b.query_row("SELECT host FROM servers WHERE name='good'", [], |r| r.get(0)).ok();
        assert_eq!(host.as_deref(), Some("h-good"), "a valid record must apply despite a poison record in the batch");
        // ...and the corrupt record created no row.
        assert_eq!(
            b.query_row("SELECT COUNT(*) FROM servers", [], |r| r.get::<_, i64>(0)).unwrap(),
            1,
            "the corrupt record must be skipped, never inserted",
        );
    }
}

/// Async-friendly vault save. Snapshots the key/salt/path under the sync
/// mutexes, clones the Arc'd connection slot, then hands the whole thing
/// to `spawn_blocking`. The SQLite serialise + zstd + AES-GCM + fsync
/// chain runs on a blocking-pool thread so concurrent terminal output
/// and keystrokes don't stall on the tokio worker pool.
async fn save_vault_async(state: &DbState) -> Result<(), String> {
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
async fn list_profiles(app_handle: tauri::AppHandle) -> Result<Vec<String>, String> {
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
async fn cloud_list_sync_profiles(
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
async fn cloud_delete_profile(
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
async fn force_push_profile(
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
    sync_now(app, db_state, cloud).await
}

/// Mark a profile as the active one. Subsequent `check_db_exists` /
/// `setup_master_db` calls operate against that profile's file. Returns
/// whether the profile's encrypted file already exists (caller uses this
/// to decide between "ask for password" and "this profile is empty / not
/// yet created" flows).
#[tauri::command]
async fn select_profile(
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
async fn teardown_profile_runtime(
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
async fn close_profile(
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
async fn prepare_switch_profile(
    state: tauri::State<'_, DbState>,
    ssh: tauri::State<'_, SshState>,
    monitor_map: tauri::State<'_, MonitorMap>,
) -> Result<(), String> {
    teardown_profile_runtime(&state, &ssh, &monitor_map).await
}

/// Check if a valid master session password is currently cached in memory.
#[tauri::command]
async fn has_session_password(state: tauri::State<'_, DbState>) -> Result<bool, String> {
    let guard = state.session_password.lock().map_err(|_| "[STATE] LOCK_FAILED")?;
    Ok(guard.is_some())
}

/// Switch active profile/workspace directly using the cached session master password.
/// Drops existing SSH connections and runtime state of the active profile,
/// and attempts to open the target profile using the current session's password.
#[tauri::command]
async fn switch_profile_seamless(
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
struct ProfileSyncStatus {
    name: String,
    synced: bool,
}

/// Check which on-disk profiles match the current master session password.
#[tauri::command]
async fn get_profiles_sync_status(
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
async fn sync_profile_password(
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
async fn change_master_password(
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
async fn delete_profile(app_handle: tauri::AppHandle, name: String) -> Result<(), String> {
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
async fn rename_profile(
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
async fn export_profile(
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
    #[cfg(target_os = "android")]
    {
        let _ = src;
        return Err("Profile export is not available on Android.".into());
    }
    #[cfg(not(target_os = "android"))]
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
async fn save_audit_log(
    content: String,
    filename: String,
) -> Result<Option<String>, String> {
    #[cfg(target_os = "android")]
    {
        let _ = (content, filename);
        return Err("Audit log export is not available on Android.".into());
    }
    #[cfg(not(target_os = "android"))]
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

/// Open a file picker and verify the chosen file looks like a Submarine
/// vault (right header bytes). We do NOT decrypt — that requires the
/// profile password, which the user enters after import via the regular
/// unlock flow.
///
/// Returns `(source_path, suggested_name)` so the UI can confirm or rename
/// before committing the copy.
#[tauri::command]
async fn import_profile_pick() -> Result<Option<(String, String)>, String> {
    #[cfg(target_os = "android")]
    {
        return Err("Profile import is not available on Android.".into());
    }
    #[cfg(not(target_os = "android"))]
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
async fn import_profile_save(
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
async fn check_db_exists(
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
async fn setup_master_db(app_handle: tauri::AppHandle, password: String, state: tauri::State<'_, DbState>) -> Result<(), String> {
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
async fn setup_master_db_inner(
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
             CREATE TABLE servers (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, host TEXT, port INTEGER, username TEXT, password TEXT, credential_id INTEGER, folder_id INTEGER, proxy_type TEXT DEFAULT 'none', proxy_host TEXT, proxy_port INTEGER, tunnels TEXT, auth_type TEXT DEFAULT 'vault', key_id INTEGER, autostart INTEGER NOT NULL DEFAULT 0, mirrors TEXT NOT NULL DEFAULT '[]', color TEXT, notes TEXT NOT NULL DEFAULT '', run_on_connect TEXT NOT NULL DEFAULT '', jump_host_id INTEGER, position INTEGER NOT NULL DEFAULT 0, is_production INTEGER NOT NULL DEFAULT 0, icon TEXT DEFAULT 'server', os_info TEXT DEFAULT '', uuid TEXT, updated_at TEXT, deleted INTEGER NOT NULL DEFAULT 0, edited_by TEXT, FOREIGN KEY(folder_id) REFERENCES folders(id));
             CREATE TABLE commands (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, content TEXT, uuid TEXT, updated_at TEXT, deleted INTEGER NOT NULL DEFAULT 0, edited_by TEXT);
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

    // ---- Per-entity sync instrumentation (schema v6) ----
    // A per-profile Hybrid Logical Clock backs the `hlc_now()` SQL function so
    // every row mutation auto-stamps `updated_at`. Seed the clock past the
    // newest stamp already in the vault so a freshly-started process never
    // issues one that sorts before data it already holds.
    let sync_node_id = sync_device_node_id(&app_handle);
    let seed_ms: u64 = conn
        .query_row(
            "SELECT COALESCE(MAX(updated_at),'') FROM (
               SELECT updated_at FROM servers UNION ALL SELECT updated_at FROM credentials
               UNION ALL SELECT updated_at FROM ssh_keys UNION ALL SELECT updated_at FROM folders
               UNION ALL SELECT updated_at FROM commands UNION ALL SELECT updated_at FROM notes
               UNION ALL SELECT updated_at FROM monitor_configs)",
            [],
            |r| r.get::<_, String>(0),
        )
        .ok()
        .map(|s| hlc::Hlc::phys_of(&s))
        .unwrap_or(0);
    let hlc_arc = std::sync::Arc::new(hlc::Hlc::new(sync_node_id, seed_ms));
    register_sync_functions(&conn, &hlc_arc)?;
    // Backfill rows that predate the sync columns (no-op on a fresh vault, and
    // a no-op on every open after the first). Run it BEFORE creating triggers so
    // the backfill UPDATEs can't fire them.
    if backfill_sync_columns(&conn, &hlc_arc)? {
        needs_resave = true;
    }
    create_sync_triggers(&conn)?;

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
async fn persist_vault(state: tauri::State<'_, DbState>) -> Result<(), String> {
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
async fn get_known_hosts(state: tauri::State<'_, DbState>) -> Result<Vec<KnownHostRecord>, String> {
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
async fn delete_known_host(state: tauri::State<'_, DbState>, id: i64) -> Result<(), String> {
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
async fn clear_all_known_hosts(state: tauri::State<'_, DbState>) -> Result<(), String> {
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
async fn create_profile(
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

pub use commands::servers::QuickAuth;


/// Drive keyboard-interactive (RFC 4256) authentication — the method behind
/// most SSH "verification code" / 2FA / OTP setups. The server sends a
/// sequence of `InfoRequest`s (each a set of prompts like "Verification
/// code:"); we relay every prompt to the UI via `kbi-prompt-{session_id}`,
/// wait for the user's answers on a per-nonce oneshot, and send them back.
///
/// Return contract:
///   * `Some(Ok(true))`  — authenticated.
///   * `Some(Ok(false))` — the user answered but the server rejected, OR the
///                         user cancelled / timed out.
///   * `Some(Err(e))`    — transport error talking to the server.
///   * `None`            — the server never actually prompted us (it doesn't
///                         offer keyboard-interactive). The caller keeps its
///                         original, more meaningful auth result instead of
///                         masking it with a generic interactive failure.
///
/// Generic over the handler so both the primary connection (`ClientHandler`)
/// and a ProxyJump intermediate hop can reuse it.
async fn run_keyboard_interactive<H: russh::client::Handler>(
    session: &mut russh::client::Handle<H>,
    user: &str,
    app: &tauri::AppHandle,
    session_id: &str,
    nonce: &str,
    kbi_txs: &std::sync::Arc<
        tokio::sync::Mutex<
            std::collections::HashMap<String, tokio::sync::oneshot::Sender<Option<Vec<String>>>>,
        >,
    >,
) -> Option<Result<bool, russh::Error>> {
    use russh::client::KeyboardInteractiveAuthResponse;
    use tauri::Emitter;

    let log = |msg: &str, ty: &str| {
        println!("[LOG-{}] {}", session_id, msg);
        let _ = app.emit(
            &format!("session-log-{}", session_id),
            serde_json::json!({"msg": msg, "type": ty}),
        );
    };

    log("Attempting Keyboard-Interactive (verification code) authentication...", "info");

    let mut resp = match session
        .authenticate_keyboard_interactive_start(user.to_string(), None)
        .await
    {
        Ok(r) => r,
        Err(e) => return Some(Err(e)),
    };

    // Guards against masking the primary error: only report a definitive
    // result once the server has actually asked us something.
    let mut asked_anything = false;

    loop {
        match resp {
            KeyboardInteractiveAuthResponse::Success => return Some(Ok(true)),
            KeyboardInteractiveAuthResponse::Failure => {
                if !asked_anything {
                    // Server declined the method outright — not really offered.
                    return None;
                }
                log("Verification code rejected by server.", "error");
                return Some(Ok(false));
            }
            KeyboardInteractiveAuthResponse::InfoRequest {
                name,
                instructions,
                prompts,
            } => {
                // A banner-only InfoRequest (zero prompts) needs an empty
                // response set to advance — nothing to ask the user.
                if prompts.is_empty() {
                    resp = match session
                        .authenticate_keyboard_interactive_respond(Vec::new())
                        .await
                    {
                        Ok(r) => r,
                        Err(e) => return Some(Err(e)),
                    };
                    continue;
                }
                asked_anything = true;

                // Fresh oneshot each round — a server may issue several
                // sequential InfoRequests within one auth exchange.
                let (tx, rx) = tokio::sync::oneshot::channel::<Option<Vec<String>>>();
                kbi_txs.lock().await.insert(nonce.to_string(), tx);

                let prompt_payload: Vec<serde_json::Value> = prompts
                    .iter()
                    .map(|p| serde_json::json!({ "prompt": p.prompt, "echo": p.echo }))
                    .collect();
                let _ = app.emit(
                    &format!("kbi-prompt-{}", session_id),
                    serde_json::json!({
                        "nonce": nonce,
                        "name": name,
                        "instructions": instructions,
                        "prompts": prompt_payload,
                    }),
                );

                // 120s: 2FA codes often mean reaching for a phone / authenticator.
                let answers = match tokio::time::timeout(
                    std::time::Duration::from_secs(120),
                    rx,
                )
                .await
                {
                    Ok(Ok(Some(a))) => a,
                    _ => {
                        // Timed out, cancelled, or the channel was dropped.
                        kbi_txs.lock().await.remove(nonce);
                        let _ = app.emit(
                            &format!("kbi-prompt-dismiss-{}", session_id),
                            serde_json::json!({}),
                        );
                        log("Verification prompt cancelled or timed out.", "error");
                        return Some(Ok(false));
                    }
                };
                let _ = app.emit(
                    &format!("kbi-prompt-dismiss-{}", session_id),
                    serde_json::json!({}),
                );

                // The protocol requires exactly one response per prompt.
                // Pad/truncate so a UI/prompt-count mismatch can never desync
                // the SSH auth state machine.
                let mut answers = answers;
                answers.resize(prompts.len(), String::new());

                resp = match session
                    .authenticate_keyboard_interactive_respond(answers)
                    .await
                {
                    Ok(r) => r,
                    Err(e) => return Some(Err(e)),
                };
            }
        }
    }
}

/// OS-level TCP keepalive on an SSH transport socket. Complements the SSH
/// protocol keepalive (`keepalive_interval` below): russh 0.40 has no
/// `keepalive_max`, so an unanswered protocol keepalive never tears the
/// connection down — but with TCP keepalive the kernel itself probes an idle
/// peer (30s idle, then every 10s) and errors the socket when the peer is
/// truly gone, which russh's run loop surfaces as `is_closed()`. That gives
/// dead-link detection during long-idle periods without any SSH traffic, and
/// keeps NAT/firewall mappings warm on flaky consumer networks. Best-effort:
/// failure to set it is never a reason to abort a connect. (`with_retries`
/// is deliberately not used — socket2 doesn't support it on Windows.)
fn apply_tcp_keepalive(stream: &tokio::net::TcpStream) {
    use socket2::{SockRef, TcpKeepalive};
    let ka = TcpKeepalive::new()
        .with_time(std::time::Duration::from_secs(30))
        .with_interval(std::time::Duration::from_secs(10));
    let _ = SockRef::from(stream).set_tcp_keepalive(&ka);
}

pub static SSH_KEEPALIVE_SECS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(20);


/// The russh client config shared by the primary connection and any ProxyJump
/// hop, so both negotiate an identical algorithm set. Extracted verbatim from
/// the inline block `initiate_connection` used to carry.
fn build_ssh_client_config() -> russh::client::Config {
    use tokio::time::Duration;
    let mut config = russh::client::Config::default();
    // Dynamic SSH keepalive interval. The shorter interval matters because most
    // consumer routers drop idle NAT mappings around the 2-minute mark, and
    // many corporate firewalls are stricter still. russh 0.40 has no
    // `keepalive_max` knob, so the watcher loop relies on `is_closed()` to
    // surface drops within a couple of seconds.
    let ka_secs = SSH_KEEPALIVE_SECS.load(std::sync::atomic::Ordering::Relaxed);
    config.keepalive_interval = if ka_secs == 0 { None } else { Some(Duration::from_secs(ka_secs)) };
    // Bigger receive window + max-allowed packet size: lets SFTP/tunnel
    // streams keep the BDP full on high-latency links.
    config.window_size = 8 * 1024 * 1024;
    config.maximum_packet_size = 65535;
    // Widen the negotiation set to match OpenSSH — but only in builds that
    // include the OpenSSL backend (release CI via `full-ssh-algos`). See the
    // long rationale that used to sit inline: legacy DH groups, the full RSA
    // host-key family, and HMAC-SHA1 MAC variants for older/embedded servers.
    #[cfg(feature = "full-ssh-algos")]
    {
        config.preferred = russh::Preferred {
            kex: &[
                russh::kex::CURVE25519,
                russh::kex::CURVE25519_PRE_RFC_8731,
                russh::kex::DH_G14_SHA256,
                russh::kex::DH_G14_SHA1,
                russh::kex::DH_G1_SHA1,
                russh::kex::EXTENSION_SUPPORT_AS_CLIENT,
                russh::kex::EXTENSION_OPENSSH_STRICT_KEX_AS_CLIENT,
            ],
            key: &[
                russh_keys::key::ED25519,
                russh_keys::key::ECDSA_SHA2_NISTP256,
                russh_keys::key::RSA_SHA2_512,
                russh_keys::key::RSA_SHA2_256,
                russh_keys::key::SSH_RSA,
            ],
            cipher: &[
                russh::cipher::CHACHA20_POLY1305,
                russh::cipher::AES_256_GCM,
                russh::cipher::AES_256_CTR,
                russh::cipher::AES_192_CTR,
                russh::cipher::AES_128_CTR,
            ],
            mac: &[
                russh::mac::HMAC_SHA512_ETM,
                russh::mac::HMAC_SHA256_ETM,
                russh::mac::HMAC_SHA512,
                russh::mac::HMAC_SHA256,
                russh::mac::HMAC_SHA1_ETM,
                russh::mac::HMAC_SHA1,
            ],
            compression: &["zlib@openssh.com", "zlib", "none"],
        };
    }
    config
}

/// Minimal auth/identity resolver for a ProxyJump bastion. Mirrors the
/// vault-vs-custom / credential-join / key-loading rules of the main connect
/// path but returns only what a jump hop needs (host, port, user, password,
/// optional key). Deliberately kept separate from `initiate_connection`'s
/// inline resolver so the primary connection path is byte-for-byte untouched.
/// It never reads `jump_host_id`, which makes ProxyJump strictly single-hop —
/// there is no way for it to recurse.
///
/// Runs fully synchronously (no `.await`) so the non-`Send` rusqlite
/// `Connection` never has to be held across a suspension point.
fn resolve_jump_auth(
    conn: &rusqlite::Connection,
    server_id: i32,
) -> Result<
    Option<(String, i32, String, Option<String>, Option<(String, Option<String>)>)>,
    String,
> {
    let mut stmt = conn
        .prepare(
            "
            SELECT s.host, s.port,
                   s.username as s_user, c.username as c_user,
                   s.password as s_pass, c.password as c_pass,
                   s.key_id   as s_key,  c.key_id   as c_key,
                   s.auth_type, c.auth_type as cred_auth_type
            FROM servers s
            LEFT JOIN credentials c ON s.credential_id = c.id
            WHERE s.id=?1
        ",
        )
        .map_err(|e| e.to_string())?;
    let mut rows = stmt.query([server_id]).map_err(|e| e.to_string())?;
    let row = match rows.next().map_err(|e| e.to_string())? {
        Some(r) => r,
        None => return Ok(None),
    };
    let host: String = row.get::<_, String>(0).map_err(|e| format!("[DB] jump host: {}", e))?;
    let port: i32 = row.get::<_, i32>(1).map_err(|e| format!("[DB] jump port: {}", e))?;
    let s_user: Option<String> = row.get::<_, Option<String>>(2).unwrap_or_default();
    let c_user: Option<String> = row.get::<_, Option<String>>(3).unwrap_or_default();
    let s_pass: Option<String> = row.get::<_, Option<String>>(4).unwrap_or_default();
    let c_pass: Option<String> = row.get::<_, Option<String>>(5).unwrap_or_default();
    let s_key: Option<i32> = row.get::<_, Option<i32>>(6).unwrap_or_default();
    let c_key: Option<i32> = row.get::<_, Option<i32>>(7).unwrap_or_default();
    let server_auth_type: String = row
        .get::<_, Option<String>>(8)
        .unwrap_or_default()
        .unwrap_or_else(|| "vault".to_string());
    let cred_auth_type: Option<String> = row.get::<_, Option<String>>(9).unwrap_or_default();

    let (username, password, key_id) = if server_auth_type == "vault" {
        (c_user.unwrap_or_default(), c_pass, c_key)
    } else {
        (s_user.unwrap_or_default(), s_pass, s_key)
    };
    let effective_key_id = if server_auth_type == "vault" {
        if cred_auth_type.as_deref() == Some("key") { key_id } else { None }
    } else if server_auth_type == "custom_key" {
        key_id
    } else {
        None
    };
    let key_data = if let Some(kid) = effective_key_id {
        let mut key_stmt = conn
            .prepare("SELECT private_key, passphrase FROM ssh_keys WHERE id = ?1")
            .map_err(|e| e.to_string())?;
        let mut key_rows = key_stmt.query([kid]).map_err(|e| e.to_string())?;
        if let Some(key_row) = key_rows.next().map_err(|e| e.to_string())? {
            let private_key: String = key_row.get::<_, String>(0).map_err(|e| e.to_string())?;
            let passphrase: Option<String> = key_row.get::<_, Option<String>>(1).map_err(|e| e.to_string())?;
            Some((private_key, passphrase))
        } else {
            None
        }
    } else {
        None
    };

    Ok(Some((host, port, username, password, key_data)))
}

/// Establish + authenticate an SSH connection to a ProxyJump intermediate
/// ("bastion") host and return its live `Handle`. The caller opens a
/// `direct-tcpip` channel over this handle to reach the real target, then keeps
/// the handle alive for the target session's lifetime (see
/// `SshState::jump_connections`).
///
/// The bastion is reached by a DIRECT TCP connection — its own proxy config, if
/// any, is not honored (bastions are normally directly reachable). Its host key
/// is verified through the SAME frontend prompt as the target (events emitted
/// under the target's `session_id`, keyed by a distinct nonce), and it supports
/// the full key → password → keyboard-interactive auth ladder.
async fn connect_jump_host(
    app: &tauri::AppHandle,
    db: &std::sync::Arc<std::sync::Mutex<Option<rusqlite::Connection>>>,
    fp_txs: &std::sync::Arc<
        tokio::sync::Mutex<std::collections::HashMap<String, tokio::sync::oneshot::Sender<bool>>>,
    >,
    kbi_txs: &std::sync::Arc<
        tokio::sync::Mutex<
            std::collections::HashMap<String, tokio::sync::oneshot::Sender<Option<Vec<String>>>>,
        >,
    >,
    session_id: &str,
    jump_server_id: i32,
) -> Result<russh::client::Handle<ssh_manager::ClientHandler>, String> {
    use tokio::time::Duration;
    use tauri::Emitter;

    let log = |msg: &str, ty: &str| {
        println!("[LOG-{}] [jump] {}", session_id, msg);
        let _ = app.emit(
            &format!("session-log-{}", session_id),
            serde_json::json!({"msg": msg, "type": ty}),
        );
    };

    // 1. Resolve the bastion's config synchronously and drop the DB guard
    //    before any await (rusqlite Connection is not Send).
    let (host, port, user, password, key_data) = {
        let guard = db.lock().map_err(|_| "[STATE] LOCK_FAILED".to_string())?;
        let conn = guard
            .as_ref()
            .ok_or_else(|| "[STATE] DATABASE_NOT_INITIALIZED".to_string())?;
        match resolve_jump_auth(conn, jump_server_id)? {
            Some(v) => v,
            None => return Err("jump host not found".into()),
        }
    };
    let effective_user = if user.trim().is_empty() {
        "root".to_string()
    } else {
        user.trim().to_string()
    };

    // 2. Direct TCP to the bastion.
    log(&format!("Connecting to jump host {}:{}...", host, port), "info");
    let tcp = match tokio::time::timeout(
        Duration::from_secs(10),
        tokio::net::TcpStream::connect((host.as_str(), port as u16)),
    )
    .await
    {
        Ok(Ok(s)) => {
            let _ = s.set_nodelay(true);
            apply_tcp_keepalive(&s);
            s
        }
        Ok(Err(e)) => return Err(humanize_network_err(&e.to_string(), &host, port, "Jump host connection")),
        Err(_) => return Err(format!("jump host {}:{} did not respond within 10 seconds", host, port)),
    };

    // 3. Host-key round-trip: own nonce, shared fp_txs map + frontend session.
    let (fp_tx, fp_rx) = tokio::sync::oneshot::channel();
    let jump_nonce: String = {
        let mut bytes = [0u8; 16];
        rand::thread_rng().fill(&mut bytes);
        hex::encode(bytes)
    };
    fp_txs.lock().await.insert(jump_nonce.clone(), fp_tx);
    let fp_outcome = std::sync::Arc::new(std::sync::atomic::AtomicI8::new(-1));

    let handler = ssh_manager::ClientHandler {
        app: app.clone(),
        session_id: session_id.to_string(),
        connect_nonce: jump_nonce.clone(),
        server_host: host.clone(),
        server_port: port as u16,
        db: std::sync::Arc::clone(db),
        fp_rx: Some(fp_rx),
        forwarded_targets: std::sync::Arc::new(tokio::sync::Mutex::new(std::collections::HashMap::new())),
        fp_outcome,
    };

    // 4. Handshake.
    let config = std::sync::Arc::new(build_ssh_client_config());
    log("Jump host: SSH handshake...", "info");
    let connect_res = tokio::time::timeout(
        Duration::from_secs(15),
        russh::client::connect_stream(config, tcp, handler),
    )
    .await;
    // The host-key prompt (if any) is resolved by now — drop the sender.
    fp_txs.lock().await.remove(&jump_nonce);

    let mut session = match connect_res {
        Ok(Ok(s)) => s,
        Ok(Err(e)) => return Err(format!("jump host handshake failed: {}", e)),
        Err(_) => return Err("jump host handshake timed out".into()),
    };

    // 5. Auth ladder: key → password → keyboard-interactive.
    let mut auth_res = if let Some((private_key, passphrase)) = key_data {
        log("Jump host: private key authentication...", "info");
        let normalized_key = private_key.replace("\r\n", "\n");
        match russh_keys::decode_secret_key(&normalized_key, passphrase.as_deref()) {
            Ok(keypair) => session.authenticate_publickey(&effective_user, std::sync::Arc::new(keypair)).await,
            Err(e) => Err(russh::Error::from(std::io::Error::new(std::io::ErrorKind::InvalidData, e.to_string()))),
        }
    } else if let Some(pass) = password {
        log("Jump host: password authentication...", "info");
        session.authenticate_password(&effective_user, pass).await
    } else {
        Ok(false)
    };

    if !matches!(auth_res, Ok(true)) {
        if let Some(kbi_res) =
            run_keyboard_interactive(&mut session, &effective_user, app, session_id, &jump_nonce, kbi_txs).await
        {
            auth_res = kbi_res;
        }
    }
    // Belt-and-suspenders: no dangling interactive sender for this hop.
    kbi_txs.lock().await.remove(&jump_nonce);

    match auth_res {
        Ok(true) => {
            log("Jump host authenticated.", "success");
            Ok(session)
        }
        Ok(false) => Err("jump host authentication failed".into()),
        Err(e) => Err(format!("jump host auth error: {}", e)),
    }
}

/// Fully tear down ONE connection map-entry by its exact key. Used to reap the
/// dedicated `::sftp` / `::fwd` secondary connections the separate-sessions
/// feature spins up, so disconnecting or reconnecting the PRIMARY never orphans
/// them (a leaked secondary would hold a live TCP + SSH session forever). Safe
/// to call on a key that doesn't exist — every step is then a no-op. Bumps the
/// key's generation so the secondary's own health watcher observes the change on
/// its next tick and bows out WITHOUT emitting a `session-disconnected-{key}`.
async fn teardown_connection_key(state: &SshState, mirrors: &MirrorMap, key: &str) {
    // Bump the generation FIRST — before removing the connection — so a connect
    // worker for this key that's still handshaking observes the newer value at
    // its "still wanted?" registration guard and bails instead of registering a
    // zombie. (Worker holds the generation lock across its check+insert, and we
    // bump-then-remove here, so the two orderings can't leave a stray entry.)
    {
        let mut g = state.session_generation.lock().await;
        let next = g.get(key).copied().unwrap_or(0).wrapping_add(1);
        g.insert(key.to_string(), next);
    }
    // Stop forwarders first so their listener sockets release before the SSH
    // handle drops — same ordering rationale as disconnect_session.
    tunnel::stop_all_for_session(&state.tunnels, key).await;
    state.forwarded_targets.lock().await.remove(key);
    state.session_tunnel_specs.lock().await.remove(key);
    mirror::stop_all_for_session(mirrors, key).await;
    state.sftp_sessions.lock().await.remove(key);
    // The base session's cached SFTP subsystem may be riding this dedicated
    // `::sftp` transport — drop it so the next file op re-opens on whatever
    // transport remains instead of erroring on a closed channel.
    if let Some(base) = key.strip_suffix("::sftp") {
        state.sftp_sessions.lock().await.remove(base);
    }
    state.connections.lock().await.remove(key);
    state.jump_connections.lock().await.remove(key);
    // Wipe temp files the secondary's SFTP downloads / drags left behind.
    let td = session_sftp_dir(key);
    if td.exists() {
        let _ = std::fs::remove_dir_all(&td);
    }
    let dd = session_drag_dir(key);
    if dd.exists() {
        let _ = std::fs::remove_dir_all(&dd);
    }
}

#[tauri::command]
async fn initiate_connection(
    app: tauri::AppHandle,
    state: tauri::State<'_, SshState>,
    db_state: tauri::State<'_, DbState>,
    mirrors: tauri::State<'_, MirrorMap>,
    session_id: String,
    server_id: i32,
    custom_password: Option<String>,
    quick_auth: Option<QuickAuth>,
    // Separate-sessions feature (default OFF). `session_role` marks whether this
    // is the primary terminal connection ("primary", the default) or a dedicated
    // secondary connection carved off for SFTP ("sftp") or port-forwarding
    // ("forward"). `separate_sessions` is only meaningful on the PRIMARY call: it
    // tells the primary to NOT auto-start the saved tunnels itself, because the
    // dedicated "forward" connection (opened by the frontend right after) will.
    // See the connection topology notes near the auth block below.
    session_role: Option<String>,
    separate_sessions: Option<bool>,
) -> Result<(), String> {
    use tauri::Emitter;
    use tokio::time::Duration;
    use russh::client;
    use std::sync::Arc;
    use tokio::sync::Mutex;

    // Connection role + topology flags. Kept as plain locals so the whole
    // function (worker included) can branch on them without re-parsing.
    let role: String = session_role
        .as_deref()
        .map(str::to_string)
        .unwrap_or_else(|| "primary".to_string());
    let is_secondary = role != "primary";
    let separate = separate_sessions.unwrap_or(false);
    // Only the PRIMARY drives interactive keyboard-interactive (2FA) auth. A
    // secondary connection that hit a 2FA challenge would emit a `kbi-prompt`
    // the UI isn't wired to answer for the suffixed session id, so it would just
    // hang. Instead we let the secondary fail its auth and the frontend falls
    // back to routing SFTP / forwarding over the primary connection.
    let allow_kbi = !is_secondary;
    // Which connection auto-starts this server's saved tunnels inline:
    //   - primary + shared mode    → yes (unchanged legacy behaviour)
    //   - primary + separate mode  → no  (the "forward" connection takes over)
    //   - "forward" secondary      → never inline; it runs the MIGRATION block
    //     instead (stop anything running under the base tag, then restart the
    //     full replay list on itself, still tagged under the base session id)
    //   - "sftp" secondary         → no
    let start_tunnels_inline = role == "primary" && !separate;

    println!("[BACKEND] initiate_connection invoked for session_id: {} (role: {}, separate: {}), server_id: {}", session_id, role, separate, server_id);

    // Reconnect path: if a previous session under this id is still registered,
    // tear it down before starting the fresh handshake. Without this, the
    // duplicate-detection early-return below would silently drop every
    // reconnect attempt and the UI would just sit on "connecting…" forever.
    // Tunnels + forwarded_targets get the same treatment further down via the
    // stop_all_for_session call, so we don't duplicate that here.
    {
        let mut conns = state.connections.lock().await;
        if conns.remove(&session_id).is_some() {
            println!("[BACKEND] Tearing down stale session for reconnect: {}", session_id);
        }
    }
    // Drop any ProxyJump bastion handle from a prior attempt — dropping it
    // closes the old jump connection so the reconnect opens a fresh one.
    state.jump_connections.lock().await.remove(&session_id);
    state.sftp_sessions.lock().await.remove(&session_id);
    state.session_passwords.lock().await.remove(&session_id);
    // Terminal IDs are `${session_id}-term-N` (see SessionView.tsx), so we
    // sweep every PTY task tied to the old handle. Match by the exact
    // `${session_id}-term-` prefix so id `session-1` doesn't sweep the
    // terminals of `session-10`, `session-11`, ... — a `contains`-based
    // match here silently tore down unrelated live sessions once server
    // IDs (which are SQLite autoincrement ints) crossed 10.
    let term_prefix = format!("{}-term-", session_id);
    state.terminal_txs.lock().await.retain(|k, _| !k.starts_with(&term_prefix));
    state.resize_txs.lock().await.retain(|k, _| !k.starts_with(&term_prefix));
    // Bump the generation so any watcher task still alive from the prior
    // attempt sees a newer value next tick and bails silently instead of
    // racing the new connect to emit `session-disconnected-{id}`.
    let connect_generation: u64 = {
        let mut g = state.session_generation.lock().await;
        let next = g.get(&session_id).copied().unwrap_or(0).wrapping_add(1);
        g.insert(session_id.clone(), next);
        next
    };

    println!("[BACKEND] No duplicates found. Registering oneshot channel and spawning connection worker...");
    let (fp_tx, fp_rx) = tokio::sync::oneshot::channel();
    // Random per-connect nonce — keys the fp_txs map so a stale `accept`
    // for one attempt (frontend bug, malicious IPC call, retry race)
    // cannot satisfy the prompt of a fresh connection. Hex over 16 bytes
    // = 128 bits of entropy, plenty for a single-use guard.
    let connect_nonce: String = {
        let mut bytes = [0u8; 16];
        rand::thread_rng().fill(&mut bytes);
        hex::encode(bytes)
    };
    // NB: the fp_txs insert is deliberately deferred until AFTER the DB
    // resolution below. The resolution block has several `?` early-returns; if
    // we inserted here, any of them would return before the worker (which owns
    // the FpCleanupGuard) is spawned, orphaning the sender in the map forever.

    let session_id_clone = session_id.clone();
    let state_connections = Arc::clone(&state.connections);
    let state_sftp_sessions = Arc::clone(&state.sftp_sessions);
    let state_tunnels = Arc::clone(&state.tunnels);
    let state_session_tunnel_specs = Arc::clone(&state.session_tunnel_specs);
    let state_session_generation = Arc::clone(&state.session_generation);
    let state_session_passwords = Arc::clone(&state.session_passwords);
    let fp_txs_clone = Arc::clone(&state.fp_txs);
    let kbi_txs_clone = Arc::clone(&state.kbi_txs);
    let state_jump_connections = Arc::clone(&state.jump_connections);
    // Second Arc into the DB for the ProxyJump hop — the handler below moves
    // the primary `db_conn_shared`, and the spawned worker needs its own owned
    // handle to resolve the bastion's credentials.
    let db_for_jump = Arc::clone(&db_state.conn);
    let db_conn_shared = Arc::clone(&db_state.conn);

    // Reconnect path: tear down any stale listeners + R-tunnel registrations
    // bound to this session_id. Without this, the old TCP listener stays bound
    // to the local port, the new start_tunnel below hits a bind conflict, and
    // every existing tunnel silently routes traffic into a dead SSH handle.
    // First-connect is a no-op (no entries to remove).
    tunnel::stop_all_for_session(&state.tunnels, &session_id).await;
    state.forwarded_targets.lock().await.remove(&session_id);
    // Same story for mirrors — a reconnect must not inherit a mirror worker
    // that still holds an Arc<SftpSession> pointing at the DEAD handle from
    // the previous attempt. Without this the reconnected session appears
    // fine but the mirror keeps writing upload-fail logs against the old
    // socket forever, and manual Stop is the only way to clear it.
    mirror::stop_all_for_session(&mirrors, &session_id).await;

    // Separate-sessions: a PRIMARY (re)connect must reap any stale dedicated
    // `::sftp` / `::fwd` connections from a previous attempt, so the frontend can
    // re-open fresh ones after this success. Gated to the primary so a secondary
    // connect doesn't try to sweep its own (non-existent) grandchildren. Skipped
    // entirely for keys that already carry a `::` suffix (i.e. this IS a
    // secondary), and a plain no-op on first connect / shared mode.
    if !is_secondary {
        teardown_connection_key(state.inner(), mirrors.inner(), &format!("{}::sftp", session_id)).await;
        teardown_connection_key(state.inner(), mirrors.inner(), &format!("{}::fwd", session_id)).await;
    } else {
        // Dedicated-transport reconnect (manual button / auto-retry) OVER a
        // still-live old handle: the base-tagged tunnels ride this transport and
        // the base SFTP cache points at it, so release them before the new
        // handshake. Otherwise, if the fresh attempt fails, the old tunnels keep
        // running on a connection nobody watches (zombie) and file ops hit a
        // dead subsystem. Mirrors disconnect_session's dedicated-transport hooks.
        if let Some(base) = session_id.strip_suffix("::fwd") {
            tunnel::stop_all_for_session(&state.tunnels, base).await;
        }
        if let Some(base) = session_id.strip_suffix("::sftp") {
            state.sftp_sessions.lock().await.remove(base);
        }
    }

    // Per-session map for R-tunnel target lookups. Created here so the same
    // Arc can be handed to both the ClientHandler (consulted on incoming
    // forwarded-tcpip channels) and to tunnel::start_tunnel (which writes the
    // mapping when a remote tunnel is set up).
    let session_forwarded_targets: tunnel::ForwardedTargets =
        Arc::new(tokio::sync::Mutex::new(std::collections::HashMap::new()));
    state.forwarded_targets.lock().await.insert(
        session_id.clone(),
        Arc::clone(&session_forwarded_targets),
    );

    // Quick connect bypasses the DB lookup entirely — we fabricate the
    // same tuple shape from the inline values so all downstream code
    // (auth, tunnel-start, handler setup) doesn't need to branch.
    let db_res = if let Some(q) = quick_auth.as_ref() {
        let key_data = q.private_key
            .clone()
            .filter(|s| !s.trim().is_empty())
            .map(|pk| (pk, q.passphrase.clone()));
        let auth_type = if key_data.is_some() { "custom_key" } else { "custom_pass" };
        Some((
            q.host.clone(),
            q.port,
            q.username.clone(),
            q.password.clone(),
            key_data,
            "none".to_string(),         // proxy_type — no proxy in quick mode
            None,                       // proxy_host
            None,                       // proxy_port
            auth_type.to_string(),      // server_auth_type
            None,                       // cred_auth_type (unused for custom_*)
            None,                       // db_key_id (debug-log only)
            None,                       // effective_key_id (auth code branches on key_data, not this)
            "[]".to_string(),           // tunnels_json — no auto-start tunnels
            None,                       // jump_host_id — quick connect never bounces through a bastion
        ))
    } else {
    // Fetch DB record inside a nested block to drop non-Send Rows/Statement before any await
    {
        let conn_guard = db_state.conn.lock().map_err(|_| "[STATE] LOCK_FAILED")?;
        let conn = conn_guard.as_ref().ok_or("[STATE] DATABASE_NOT_INITIALIZED")?;
        
        // Pull both server-side and credential-side identity fields separately
        // and resolve in Rust. The previous COALESCE was order-of-precedence
        // magic that hid the actual rule from anyone reading the SQL — now the
        // rule is "vault mode → credential fields; custom_* mode → node fields"
        // and nothing else can mix the two.
        let mut stmt = conn.prepare("
            SELECT s.host, s.port,
                   s.username as s_user, c.username as c_user,
                   s.password as s_pass, c.password as c_pass,
                   s.key_id   as s_key,  c.key_id   as c_key,
                   s.proxy_type, s.proxy_host, s.proxy_port,
                   s.auth_type, c.auth_type as cred_auth_type, s.tunnels,
                   s.jump_host_id
            FROM servers s
            LEFT JOIN credentials c ON s.credential_id = c.id
            WHERE s.id=?1
        ").map_err(|e| e.to_string())?;

        let mut rows = stmt.query([server_id]).map_err(|e| e.to_string())?;
        if let Some(row) = rows.next().map_err(|e| e.to_string())? {
            // host/port are NOT NULL in the schema, but propagating
            // errors instead of `.unwrap()` means a manual DB edit or a
            // future schema relaxation can never silently panic the
            // spawned connection worker — the user gets a clean error.
            let host: String = row.get::<_, String>(0).map_err(|e| format!("[DB] host: {}", e))?;
            let port: i32 = row.get::<_, i32>(1).map_err(|e| format!("[DB] port: {}", e))?;
            let s_user: Option<String> = row.get::<_, Option<String>>(2).unwrap_or_default();
            let c_user: Option<String> = row.get::<_, Option<String>>(3).unwrap_or_default();
            let s_pass: Option<String> = row.get::<_, Option<String>>(4).unwrap_or_default();
            let c_pass: Option<String> = row.get::<_, Option<String>>(5).unwrap_or_default();
            let s_key:  Option<i32>    = row.get::<_, Option<i32>>(6).unwrap_or_default();
            let c_key:  Option<i32>    = row.get::<_, Option<i32>>(7).unwrap_or_default();
            let proxy_type: String = row.get::<_, Option<String>>(8).unwrap_or_default().unwrap_or_else(|| "none".to_string());
            let proxy_host: Option<String> = row.get::<_, Option<String>>(9).unwrap_or_default();
            let proxy_port: Option<i32> = row.get::<_, Option<i32>>(10).unwrap_or_default();
            let server_auth_type: String = row.get::<_, Option<String>>(11).unwrap_or_default().unwrap_or_else(|| "vault".to_string());
            let cred_auth_type: Option<String> = row.get::<_, Option<String>>(12).unwrap_or_default();
            let tunnels_json: String = row.get::<_, Option<String>>(13).unwrap_or_default().unwrap_or_else(|| "[]".to_string());
            let jump_host_id: Option<i32> = row.get::<_, Option<i32>>(14).unwrap_or_default();

            // Single source of truth per auth_type — no field mixing.
            // - vault: identity comes ENTIRELY from the credential row. Any
            //   stale username/password/key on the node row is ignored.
            // - custom_pass / custom_key: identity comes ENTIRELY from the
            //   node row.
            let (username, password, key_id) = if server_auth_type == "vault" {
                (c_user.unwrap_or_default(), c_pass, c_key)
            } else {
                (s_user.unwrap_or_default(), s_pass, s_key)
            };

            // Whether to actually load a key file:
            // - vault: only if the chosen credential is itself key-typed
            // - custom_key: yes, use the node's selected key
            // - custom_pass: no
            let effective_key_id = if server_auth_type == "vault" {
                if cred_auth_type.as_deref() == Some("key") { key_id } else { None }
            } else if server_auth_type == "custom_key" {
                key_id
            } else {
                None
            };

            // Fetch key details if a key is needed
            let key_data = if let Some(kid) = effective_key_id {
                let mut key_stmt = conn.prepare("SELECT private_key, passphrase FROM ssh_keys WHERE id = ?1").map_err(|e| e.to_string())?;
                let mut key_rows = key_stmt.query([kid]).map_err(|e| e.to_string())?;
                if let Some(key_row) = key_rows.next().map_err(|e| e.to_string())? {
                    let private_key: String = key_row.get::<_, String>(0).map_err(|e| e.to_string())?;
                    let passphrase: Option<String> = key_row.get::<_, Option<String>>(1).map_err(|e| e.to_string())?;
                    Some((private_key, passphrase))
                } else {
                    None
                }
            } else {
                None
            };

            Some((host, port, username, password, key_data, proxy_type, proxy_host, proxy_port, server_auth_type, cred_auth_type, key_id, effective_key_id, tunnels_json, jump_host_id))
        } else {
            None
        }
    }
    };

    let (host, port, user, password, key_data, proxy_type, proxy_host, proxy_port, server_auth_type, cred_auth_type, db_key_id, effective_key_id, tunnels_json, jump_host_id) = match db_res {
        Some(val) => val,
        None => {
            return Err("Server not found".into());
        }
    };

    // DB resolution succeeded — now register the fingerprint sender. From here
    // on the worker is always spawned, so its FpCleanupGuard guarantees this
    // entry is removed even on the failure paths.
    state.fp_txs.lock().await.insert(connect_nonce.clone(), fp_tx);

    // Shared between the handler and the connect driver so we can tell host-
    // key timeouts apart from real auth errors on the failure path. See
    // ClientHandler::fp_outcome for the meaning of the values.
    let fp_outcome = std::sync::Arc::new(std::sync::atomic::AtomicI8::new(-1));
    let fp_outcome_for_driver = std::sync::Arc::clone(&fp_outcome);

    let handler = ssh_manager::ClientHandler {
        app: app.clone(),
        session_id: session_id.clone(),
        connect_nonce: connect_nonce.clone(),
        server_host: host.clone(),
        server_port: port as u16,
        db: db_conn_shared,
        fp_rx: Some(fp_rx),
        forwarded_targets: Arc::clone(&session_forwarded_targets),
        fp_outcome: std::sync::Arc::clone(&fp_outcome),
    };

    let cleanup_nonce = connect_nonce.clone();
    // Own an Arc into MirrorMap so the outer spawn (which requires 'static)
    // doesn't try to borrow the caller's `mirrors: State<'_, MirrorMap>`.
    // The Arc is 'static; the State reference is not.
    let mirrors_owned: MirrorMap = mirrors.inner().clone();

    tauri::async_runtime::spawn(async move {
        println!("[BACKEND WORKER] Started connection worker thread for session: {}", session_id_clone);

        struct FpCleanupGuard {
            fp_txs: Arc<Mutex<std::collections::HashMap<String, tokio::sync::oneshot::Sender<bool>>>>,
            kbi_txs: Arc<Mutex<std::collections::HashMap<String, tokio::sync::oneshot::Sender<Option<Vec<String>>>>>>,
            nonce: String,
        }
        impl Drop for FpCleanupGuard {
            fn drop(&mut self) {
                let fp_txs = Arc::clone(&self.fp_txs);
                let kbi_txs = Arc::clone(&self.kbi_txs);
                let nonce = self.nonce.clone();
                tauri::async_runtime::spawn(async move {
                    fp_txs.lock().await.remove(&nonce);
                    // Worker died mid keyboard-interactive prompt — drop any
                    // dangling sender so a late frontend response is a no-op.
                    kbi_txs.lock().await.remove(&nonce);
                });
            }
        }
        let _guard = FpCleanupGuard {
            fp_txs: Arc::clone(&fp_txs_clone),
            kbi_txs: Arc::clone(&kbi_txs_clone),
            nonce: cleanup_nonce.clone(),
        };

        let emit_log = |msg: &str, log_type: &str| {
            println!("[LOG-{}] {}", session_id_clone, msg);
            let _ = app.emit(&format!("session-log-{}", session_id_clone), serde_json::json!({"msg": msg, "type": log_type}));
        };

        let cleanup = || async {
            // Already handled by Drop Guard, but keeping for immediate eviction if needed
            fp_txs_clone.lock().await.remove(&cleanup_nonce);
        };

        emit_log("Initializing SSH connection process...", "info");
        let effective_user = if user.trim().is_empty() {
            emit_log("Username is empty. Defaulting to 'root'.", "info");
            "root".to_string()
        } else {
            user.trim().to_string()
        };
        emit_log(&format!("Server Details -> Host: {}, Port: {}, User: {}", host, port, effective_user), "info");
        emit_log(&format!("[DEBUG] Server Auth Method: {}", server_auth_type), "info");
        if server_auth_type == "vault" {
            emit_log(&format!("[DEBUG] Vault Identity Auth Type: {:?}", cred_auth_type), "info");
        }
        emit_log(&format!("[DEBUG] SQLite DB key_id: {:?}", db_key_id), "info");
        emit_log(&format!("[DEBUG] effective_key_id determined: {:?}", effective_key_id), "info");
        if let Some((ref priv_key, ref passphrase)) = key_data {
            emit_log(&format!("[DEBUG] SSH Key loaded from DB. Private Key length: {} chars, Has Passphrase: {}", priv_key.len(), passphrase.is_some()), "info");
            if priv_key.trim().is_empty() {
                emit_log("[DEBUG] WARNING: SSH Key content is EMPTY!", "error");
            } else {
                let first_line = priv_key.lines().next().unwrap_or("");
                emit_log(&format!("[DEBUG] SSH Key Header: {}", first_line), "info");
            }
        } else {
            emit_log("[DEBUG] No SSH Key was loaded from database for this session.", "info");
        }

        // Set up generic stream based on proxy configuration
        trait AsyncStream: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static {}
        impl<T: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static> AsyncStream for T {}

        struct StreamWrapper(Box<dyn AsyncStream>);
        impl tokio::io::AsyncRead for StreamWrapper {
            fn poll_read(mut self: std::pin::Pin<&mut Self>, cx: &mut std::task::Context<'_>, buf: &mut tokio::io::ReadBuf<'_>) -> std::task::Poll<std::io::Result<()>> {
                std::pin::Pin::new(&mut *self.0).poll_read(cx, buf)
            }
        }
        impl tokio::io::AsyncWrite for StreamWrapper {
            fn poll_write(mut self: std::pin::Pin<&mut Self>, cx: &mut std::task::Context<'_>, buf: &[u8]) -> std::task::Poll<std::io::Result<usize>> {
                std::pin::Pin::new(&mut *self.0).poll_write(cx, buf)
            }
            fn poll_flush(mut self: std::pin::Pin<&mut Self>, cx: &mut std::task::Context<'_>) -> std::task::Poll<std::io::Result<()>> {
                std::pin::Pin::new(&mut *self.0).poll_flush(cx)
            }
            fn poll_shutdown(mut self: std::pin::Pin<&mut Self>, cx: &mut std::task::Context<'_>) -> std::task::Poll<std::io::Result<()>> {
                std::pin::Pin::new(&mut *self.0).poll_shutdown(cx)
            }
        }

        // ProxyJump takes precedence over a direct / proxied transport. When a
        // bastion is configured we connect+auth to it first, then open a
        // `direct-tcpip` channel to the REAL target over that connection and
        // use the channel as the transport for the primary handshake — exactly
        // what `ssh -J bastion target` does. The bastion's own Handle is parked
        // in `jump_handle_holder` so it lives through the target handshake; on
        // success it moves into `state_jump_connections` for the session's life.
        let mut jump_handle_holder: Option<russh::client::Handle<ssh_manager::ClientHandler>> = None;
        let stream_res: Result<Box<dyn AsyncStream>, String> = if let Some(jid) = jump_host_id {
            emit_log(&format!("ProxyJump: routing through jump host (server id {})...", jid), "info");
            match connect_jump_host(&app, &db_for_jump, &fp_txs_clone, &kbi_txs_clone, &session_id_clone, jid).await {
                Ok(jump_handle) => {
                    // Originator address is cosmetic (logged by the bastion); the
                    // pair below is what OpenSSH sends for a -J hop.
                    match jump_handle
                        .channel_open_direct_tcpip(host.clone(), port as u32, "127.0.0.1", 0)
                        .await
                    {
                        Ok(channel) => {
                            emit_log(&format!("ProxyJump: opened tunnel to {}:{} through the jump host.", host, port), "success");
                            let boxed: Box<dyn AsyncStream> = Box::new(channel.into_stream());
                            jump_handle_holder = Some(jump_handle);
                            Ok(boxed)
                        }
                        Err(e) => Err(format!(
                            "ProxyJump: could not open a channel to {}:{} through the jump host: {}",
                            host, port, e
                        )),
                    }
                }
                Err(e) => Err(format!("ProxyJump: {}", e)),
            }
        } else {
        match proxy_type.as_str() {
            "socks5" => {
                let p_host = match proxy_host.as_ref().filter(|h| !h.is_empty()) {
                    Some(h) => h,
                    None => {
                        let err_msg = "SOCKS5 Proxy Host is empty";
                        emit_log(&format!("Error: {}", err_msg), "error");
                        cleanup().await;
                        let _ = app.emit(&format!("connection-failed-{}", session_id_clone), serde_json::json!({"reason": err_msg}));
                        return;
                    }
                };
                let p_port = proxy_port.unwrap_or(1080) as u16;
                emit_log(&format!("Connecting via SOCKS5 Proxy {}:{}...", p_host, p_port), "info");
                
                let proxy_addr = format!("{}:{}", p_host, p_port);
                match tokio::time::timeout(
                    Duration::from_secs(10),
                    tokio_socks::tcp::Socks5Stream::connect(proxy_addr.as_str(), (host.as_str(), port as u16))
                ).await {
                    Ok(Ok(stream)) => {
                        emit_log("SOCKS5 Proxy tunnel established successfully.", "success");
                        // Socks5Stream derefs to the inner TcpStream, so the
                        // kernel keepalive applies to the real proxy socket.
                        apply_tcp_keepalive(&stream);
                        Ok(Box::new(stream))
                    }
                    Ok(Err(e)) => {
                        Err(humanize_network_err(&e.to_string(), &host, port, "SOCKS5 proxy"))
                    }
                    Err(_) => {
                        Err(format!("SOCKS5 proxy {}:{} did not respond in time", p_host, p_port))
                    }
                }
            }
            "http" => {
                let p_host = match proxy_host.as_ref().filter(|h| !h.is_empty()) {
                    Some(h) => h,
                    None => {
                        let err_msg = "HTTP Proxy Host is empty";
                        emit_log(&format!("Error: {}", err_msg), "error");
                        cleanup().await;
                        let _ = app.emit(&format!("connection-failed-{}", session_id_clone), serde_json::json!({"reason": err_msg}));
                        return;
                    }
                };
                let p_port = proxy_port.unwrap_or(8080) as u16;
                emit_log(&format!("Connecting via HTTP Proxy {}:{}...", p_host, p_port), "info");

                let proxy_addr = format!("{}:{}", p_host, p_port);
                match tokio::time::timeout(
                    Duration::from_secs(10),
                    tokio::net::TcpStream::connect(proxy_addr)
                ).await {
                    Ok(Ok(mut tcp_stream)) => {
                        // Disable Nagle: SSH is heavily interactive (keystrokes,
                        // small control packets) and batching adds noticeable
                        // round-trip latency. Ignore failures — set_nodelay is
                        // best-effort; some platforms / virtual NICs reject it.
                        let _ = tcp_stream.set_nodelay(true);
                        apply_tcp_keepalive(&tcp_stream);
                        emit_log(&format!("Requesting HTTP CONNECT tunnel to {}:{}...", host, port), "info");
                        match tokio::time::timeout(
                            Duration::from_secs(10),
                            async_http_proxy::http_connect_tokio(&mut tcp_stream, &host, port as u16)
                        ).await {
                            Ok(Ok(_)) => {
                                emit_log("HTTP Proxy tunnel established successfully.", "success");
                                Ok(Box::new(tcp_stream))
                            }
                            Ok(Err(e)) => {
                                Err(humanize_network_err(&e.to_string(), &host, port, "HTTP CONNECT tunnel"))
                            }
                            Err(_) => {
                                Err(format!("HTTP CONNECT tunnel to {}:{} timed out", host, port))
                            }
                        }
                    }
                    Ok(Err(e)) => {
                        Err(humanize_network_err(&e.to_string(), p_host, p_port as i32, "HTTP proxy"))
                    }
                    Err(_) => {
                        Err(format!("HTTP proxy {}:{} did not respond in time", p_host, p_port))
                    }
                }
            }
            _ => {
                emit_log(&format!("Connecting directly to {}:{}...", host, port), "info");
                match tokio::time::timeout(
                    Duration::from_secs(10),
                    tokio::net::TcpStream::connect((host.as_str(), port as u16))
                ).await {
                    Ok(Ok(stream)) => {
                        // See HTTP-proxy branch — SSH wants every packet on the
                        // wire immediately, no Nagle batching.
                        let _ = stream.set_nodelay(true);
                        apply_tcp_keepalive(&stream);
                        emit_log("Direct TCP Connection established successfully.", "success");
                        Ok(Box::new(stream))
                    }
                    Ok(Err(e)) => {
                        Err(humanize_network_err(&e.to_string(), &host, port, "Connection"))
                    }
                    Err(_) => {
                        Err(format!("{}:{} did not respond within 10 seconds", host, port))
                    }
                }
            }
        }
        };

        let stream = match stream_res {
            Ok(s) => s,
            Err(e) => {
                emit_log(&e, "error");
                cleanup().await;
                let _ = app.emit(&format!("connection-failed-{}", session_id_clone), serde_json::json!({"reason": e}));
                return;
            }
        };

        emit_log("Starting SSH Handshake and establishing secure session...", "info");
        // Config (keepalive, windows, algorithm negotiation) is shared with the
        // ProxyJump hop — see build_ssh_client_config for the full rationale.
        let config = Arc::new(build_ssh_client_config());

        let connect_future = client::connect_stream(config, StreamWrapper(stream), handler);

        match tokio::time::timeout(Duration::from_secs(15), connect_future).await {
            Ok(Ok(mut session)) => {
                emit_log("SSH Handshake complete. Authenticating user...", "info");
                
                let final_pass = custom_password.or(password);
                let saved_pass_for_sudo = final_pass.clone();
                
                let mut auth_res = if let Some((private_key, passphrase)) = key_data {
                    emit_log("Attempting Private Key Authentication...", "info");
                    let normalized_key = private_key.replace("\r\n", "\n");
                    match russh_keys::decode_secret_key(&normalized_key, passphrase.as_deref()) {
                        Ok(keypair) => {
                            let key_arc = std::sync::Arc::new(keypair);
                            session.authenticate_publickey(&effective_user, key_arc).await
                        }
                        Err(e) => {
                            // RSA private keys only work in builds that include the
                            // OpenSSL backend (release CI). Local debug builds skip
                            // OpenSSL to stay Perl-free, so surface a targeted hint
                            // instead of the raw "Unsupported key type rsa" string.
                            #[cfg(not(feature = "full-ssh-algos"))]
                            {
                                let err_str = e.to_string();
                                if err_str.contains("Unsupported key type rsa")
                                    || err_str.contains("rsa")
                                    || private_key.contains("RSA PRIVATE KEY")
                                {
                                    emit_log("RSA private keys aren't supported in this debug build — use Ed25519 for local testing, or grab a release build from GitHub for full RSA support.", "error");
                                }
                            }
                            emit_log(&format!("Failed to parse private key: {}", e), "error");
                            Err(russh::Error::from(std::io::Error::new(
                                std::io::ErrorKind::InvalidData,
                                e.to_string(),
                            )))
                        }
                    }
                } else if let Some(pass) = final_pass {
                    emit_log("Attempting Password Authentication...", "info");
                    session.authenticate_password(&effective_user, pass).await
                } else {
                    emit_log("Neither private key nor password auth credentials provided.", "error");
                    Ok(false)
                };

                // Keyboard-interactive (2FA / verification-code) fallback. Many
                // hardened servers gate login behind an interactive one-time
                // code AFTER — or INSTEAD of — a password. If the primary
                // attempt above didn't already authenticate us and the server
                // offers keyboard-interactive, drive it: relay each prompt to
                // the UI, collect the user's answers, and send them back. If
                // the server doesn't offer it, `run_keyboard_interactive`
                // returns None and we keep the original auth result untouched.
                if allow_kbi && !matches!(auth_res, Ok(true)) {
                    if let Some(kbi_res) = run_keyboard_interactive(
                        &mut session,
                        &effective_user,
                        &app,
                        &session_id_clone,
                        &connect_nonce,
                        &kbi_txs_clone,
                    )
                    .await
                    {
                        auth_res = kbi_res;
                    }
                }

                match auth_res {
                    Ok(true) => {
                        let session_arc = Arc::new(Mutex::new(session));
                        // "Still wanted?" registration guard. The handshake can
                        // take up to ~15s (longer via proxy/jump). If, meanwhile,
                        // a reconnect for this key bumped the generation or a
                        // disconnect/teardown swept it (both of which bump the
                        // generation BEFORE removing the connection), registering
                        // now would create a ZOMBIE: a live SSH connection with a
                        // watcher that immediately exits on the generation
                        // mismatch, plus — for ::fwd — tunnels migrated onto a
                        // connection nobody tracks. Do the check and the insert
                        // TOGETHER under the generation lock so a concurrent
                        // teardown can't interleave: we either observe the newer
                        // generation and bail, or insert first and the teardown's
                        // later connection-remove reaps us.
                        let registered = {
                            let g = state_session_generation.lock().await;
                            if g.get(&session_id_clone).copied().unwrap_or(0) == connect_generation {
                                state_connections
                                    .lock()
                                    .await
                                    .insert(session_id_clone.clone(), Arc::clone(&session_arc));
                                if let Some(ref p) = saved_pass_for_sudo {
                                    state_session_passwords
                                        .lock()
                                        .await
                                        .insert(session_id_clone.clone(), p.clone());
                                }
                                true
                            } else {
                                false
                            }
                        };
                        if !registered {
                            emit_log("Connection superseded before it was ready — dropping it.", "info");
                            // `session_arc` drops here, closing the transport.
                            // The FpCleanupGuard's Drop still clears the nonce.
                            return;
                        }
                        emit_log("Authentication successful. Session ready.", "success");
                        // A dedicated `::sftp` transport just came up — drop the
                        // base session's cached SFTP subsystem (it rides the
                        // primary). The next file operation re-opens on this
                        // dedicated connection via get_sftp_session's
                        // transport preference. Live migration, no re-keying.
                        if let Some(base) = session_id_clone.strip_suffix("::sftp") {
                            state_sftp_sessions.lock().await.remove(base);
                        }
                        // ProxyJump: now that the target session is live, park
                        // the bastion's Handle so it stays alive for the whole
                        // session (its direct-tcpip channel carries our
                        // transport). Dropped on reconnect / disconnect / close.
                        if let Some(jh) = jump_handle_holder.take() {
                            state_jump_connections.lock().await.insert(session_id_clone.clone(), jh);
                        }
                        let _ = app.emit(
                            &format!("connection-success-{}", session_id_clone),
                            serde_json::json!({}),
                        );

                        // Separate-sessions topology: in shared mode the primary
                        // owns the saved tunnels; in separate mode the dedicated
                        // `::fwd` connection owns them (it re-enters this same
                        // block under its own suffixed session id, so the tunnels
                        // are tagged/keyed against `::fwd` and ride that handle).
                        // `start_tunnels_inline` is false for the `::sftp`
                        // connection and for the primary when `separate` is on.
                        if start_tunnels_inline {
                        // Auto-start every tunnel attached to this session.
                        // Source of truth is the in-memory `session_tunnel_specs`
                        // map, which carries both the DB-saved rules AND any
                        // ad-hoc tunnels the user opened during the previous
                        // session lifetime. On first connect it's empty, so
                        // we seed it from the DB row's `tunnels` JSON.
                        let specs_to_start: Vec<tunnel::TunnelSpec> = {
                            let mut map = state_session_tunnel_specs.lock().await;
                            // A PRESENT replay list — even an empty one — is
                            // authoritative, exactly as in the ::fwd branch below
                            // and in restart_session_tunnels. An empty list means
                            // the user stopped every tunnel; only an ABSENT key is
                            // a genuine first engagement worth seeding from the
                            // node's saved rules. Treating empty as "unset" here
                            // meant every reconnect — including the health
                            // watcher's automatic one — silently reopened local
                            // listeners the user had deliberately closed.
                            match map.get(&session_id_clone).cloned() {
                                Some(existing) => existing,
                                None => match serde_json::from_str::<Vec<tunnel::TunnelSpec>>(&tunnels_json) {
                                    Ok(db_specs) => {
                                        map.insert(session_id_clone.clone(), db_specs.clone());
                                        db_specs
                                    }
                                    Err(e) => {
                                        emit_log(&format!("Tunnels JSON parse error: {}", e), "error");
                                        Vec::new()
                                    }
                                }
                            }
                        };
                        for spec in &specs_to_start {
                            let started = tunnel::start_tunnel(
                                app.clone(),
                                session_id_clone.clone(),
                                Arc::clone(&session_arc),
                                Arc::clone(&state_tunnels),
                                Arc::clone(&session_forwarded_targets),
                                spec.clone(),
                            ).await;
                            match started {
                                Ok(id) => emit_log(
                                    &format!("Tunnel started [{}]: {} {}", id, spec.kind, spec.local),
                                    "info",
                                ),
                                Err(e) => {
                                    // KEEP the spec in the replay list on failure
                                    // so the NEXT reconnect retries it. Stripping
                                    // it here (the old behaviour) turned a
                                    // transient rebind race on a flaky network —
                                    // a momentary AddrInUse while the previous
                                    // listener finished releasing the port — into
                                    // permanent loss of the tunnel until the user
                                    // manually restarted it. bind_with_retry now
                                    // absorbs that race; anything still failing is
                                    // logged and retried on the next reconnect
                                    // rather than silently dropped.
                                    emit_log(
                                        &format!("Tunnel start failed ({} {}): {} — will retry on next reconnect", spec.kind, spec.local, e),
                                        "error",
                                    );
                                }
                            }
                        }
                        } // end if start_tunnels_inline

                        // Dedicated `::fwd` transport: MIGRATE the session's
                        // tunnels onto this fresh connection. Stop whatever is
                        // running under the base tag (riding the primary, or a
                        // previous dead `::fwd`) so re-binding the same local
                        // ports can't conflict, then start the full replay
                        // list — seeded from the node's saved tunnels on first
                        // engagement — on this handle, still tagged under the
                        // BASE session id so the Tunnels panel / list / events
                        // never re-key. This runs on fresh connects, live
                        // toggle-on, the reconnect button, and auto-retry.
                        if role == "forward" {
                            let base = session_id_clone
                                .strip_suffix("::fwd")
                                .unwrap_or(&session_id_clone)
                                .to_string();
                            tunnel::stop_all_for_session(&state_tunnels, &base).await;
                            let specs: Vec<tunnel::TunnelSpec> = {
                                let mut map = state_session_tunnel_specs.lock().await;
                                // A PRESENT replay list — even an empty one — is
                                // authoritative: the session is already engaged
                                // and an empty list means the user stopped every
                                // tunnel. Only seed from the node's saved tunnels
                                // when the key is ABSENT (genuine first
                                // engagement) — otherwise stopped tunnels would
                                // resurrect on every ::fwd reconnect / toggle.
                                match map.get(&base).cloned() {
                                    Some(existing) => existing,
                                    None => match serde_json::from_str::<Vec<tunnel::TunnelSpec>>(&tunnels_json) {
                                        Ok(db_specs) => {
                                            if !db_specs.is_empty() {
                                                map.insert(base.clone(), db_specs.clone());
                                            }
                                            db_specs
                                        }
                                        Err(e) => {
                                            emit_log(&format!("Tunnels JSON parse error: {}", e), "error");
                                            Vec::new()
                                        }
                                    },
                                }
                            };
                            if !specs.is_empty() {
                                emit_log("Dedicated forwarding connection ready — moving tunnels onto it.", "info");
                                start_tunnel_specs_on(
                                    &app,
                                    &base,
                                    &session_arc,
                                    &session_forwarded_targets,
                                    &state_tunnels,
                                    &state_session_tunnel_specs,
                                    specs,
                                )
                                .await;
                            }
                        }

                        // Health watcher: polls the SSH handle every 5s. If
                        // `is_closed()` flips to true while the session is
                        // still registered (i.e. the user did NOT call
                        // disconnect_session explicitly), we fire a
                        // `session-disconnected-{id}` event so the UI can lock
                        // down the terminal/SFTP and show a reconnect prompt.
                        // An explicit disconnect removes the map entry, which
                        // the watcher detects and exits silently — no event.
                        let app_w = app.clone();
                        let sid_w = session_id_clone.clone();
                        let state_w = Arc::clone(&state_connections);
                        let state_sftp_w = Arc::clone(&state_sftp_sessions);
                        let state_gen_w = Arc::clone(&state_session_generation);
                        let state_tunnels_w = Arc::clone(&state_tunnels);
                        let state_mirrors_w: MirrorMap = mirrors_owned.clone();
                        // Captured so the watcher can periodically re-attempt a
                        // configured tunnel that failed to bind while the session
                        // stays alive (see the retry block in the loop below).
                        let state_specs_w = Arc::clone(&state_session_tunnel_specs);
                        let targets_w = Arc::clone(&session_forwarded_targets);
                        let my_gen = connect_generation;
                        tauri::async_runtime::spawn(async move {
                            // Two-tier liveness check:
                            //   - Every 2s: cheap is_closed() poll. Catches TCP
                            //     RST / FIN, russh's own teardown, AND — now that
                            //     the transport socket carries OS TCP keepalive
                            //     (see apply_tcp_keepalive) — kernel-detected
                            //     dead peers during long idle.
                            //   - Slow active probe: open a tiny SSH channel to
                            //     force a real round-trip, catching black-holes
                            //     the kernel hasn't flagged yet. Primary every
                            //     ~30s, dedicated `::sftp`/`::fwd` secondaries
                            //     every ~60s (they matter less urgently and the
                            //     probes multiply per-session overhead).
                            //     TWO consecutive probe failures are required
                            //     before declaring death: on poor networks a
                            //     single 10s latency spike is common, and the
                            //     old one-strike/5s-timeout probe tore down
                            //     perfectly recoverable sessions — the exact
                            //     opposite of what a flaky link needs.
                            let probe_every: u32 = if sid_w.contains("::") { 30 } else { 15 };
                            let mut tick: u32 = 0;
                            let mut probe_strikes: u8 = 0;
                            loop {
                                tokio::time::sleep(Duration::from_secs(2)).await;
                                tick = tick.wrapping_add(1);

                                // Generation guard: a reconnect under the same
                                // session_id bumps the counter. If we observe a
                                // newer value here, a fresh watcher has already
                                // taken over — bow out silently so we don't
                                // double-emit `session-disconnected-{id}`.
                                {
                                    let g = state_gen_w.lock().await;
                                    if g.get(&sid_w).copied().unwrap_or(0) != my_gen {
                                        break;
                                    }
                                }

                                let handle_opt = {
                                    let conns = state_w.lock().await;
                                    conns.get(&sid_w).cloned()
                                };
                                let handle_arc = match handle_opt {
                                    Some(h) => h,
                                    None => break, // explicit disconnect — quiet
                                };

                                let is_closed = {
                                    let h = handle_arc.lock().await;
                                    h.is_closed()
                                };

                                let mut dead = is_closed;

                                if !dead && tick % probe_every == 0 {
                                    // Active probe: hold the handle lock long
                                    // enough to start AND finish the round
                                    // trip — concurrent commands wait, but
                                    // that's fine, they would block on the
                                    // same lock to open their own channel
                                    // anyway. 10s timeout: generous enough
                                    // that a congested-but-alive link doesn't
                                    // strike out spuriously.
                                    let probe = {
                                        let h = handle_arc.lock().await;
                                        tokio::time::timeout(
                                            Duration::from_secs(10),
                                            h.channel_open_session(),
                                        ).await
                                    };
                                    match probe {
                                        Ok(Ok(ch)) => {
                                            probe_strikes = 0;
                                            // Close cleanly so the server
                                            // doesn't log a stuck session.
                                            let _ = ch.close().await;
                                        }
                                        _ => {
                                            probe_strikes += 1;
                                            if probe_strikes >= 2 {
                                                dead = true;
                                            } else {
                                                // One strike: re-probe on the
                                                // next 2s tick instead of a
                                                // full interval away, so a
                                                // real death still surfaces
                                                // promptly.
                                                tick = probe_every.wrapping_sub(1);
                                            }
                                        }
                                    }
                                }

                                // While the session is ALIVE, periodically re-attempt
                                // any configured tunnel that isn't currently running.
                                // A listener that failed to bind (its local port was
                                // briefly taken) otherwise stays dead until the user
                                // closes and reopens the tab — nothing retries it
                                // without a full reconnect. `start_tunnel_specs_on`
                                // skips specs already running (anywhere under this
                                // session), so this is a no-op once everything is up
                                // and can't create duplicates. Gated to the primary
                                // session id: the dedicated `::fwd`/`::sftp`
                                // transports have their own migration/restore paths,
                                // and the primary handle is the correct transport for
                                // the default (shared) topology. Spawned so a slow
                                // bind retry never delays death detection.
                                if !dead && tick % 30 == 0 && !sid_w.contains("::") {
                                    let specs = state_specs_w.lock().await.get(&sid_w).cloned().unwrap_or_default();
                                    if !specs.is_empty() {
                                        let app_r = app_w.clone();
                                        let sid_r = sid_w.clone();
                                        let handle_r = Arc::clone(&handle_arc);
                                        let targets_r = Arc::clone(&targets_w);
                                        let tunnels_r = Arc::clone(&state_tunnels_w);
                                        let specs_r = Arc::clone(&state_specs_w);
                                        tauri::async_runtime::spawn(async move {
                                            start_tunnel_specs_on(&app_r, &sid_r, &handle_r, &targets_r, &tunnels_r, &specs_r, specs).await;
                                        });
                                    }
                                }

                                if dead {
                                    // Re-check generation + verify OUR handle is
                                    // still the registered one before tearing
                                    // anything down. A slow probe holds the handle
                                    // lock up to 10s; during that window a manual
                                    // reconnect / auto-retry can bump the
                                    // generation and register a fresh, healthy
                                    // connection. Without this guard we'd remove
                                    // that NEW connection and kill its just-
                                    // migrated tunnels. Bail silently on mismatch.
                                    {
                                        let g = state_gen_w.lock().await;
                                        if g.get(&sid_w).copied().unwrap_or(0) != my_gen {
                                            break;
                                        }
                                    }
                                    // Compare-and-remove: only drop the map entry
                                    // if it's still OUR handle (Arc identity).
                                    {
                                        let mut conns = state_w.lock().await;
                                        match conns.get(&sid_w) {
                                            Some(cur) if Arc::ptr_eq(cur, &handle_arc) => { conns.remove(&sid_w); }
                                            _ => break, // superseded by a fresh connection — leave it be
                                        }
                                    }
                                    state_sftp_w.lock().await.remove(&sid_w);
                                    // Tear down all tunnels bound to this
                                    // session so their listeners release the
                                    // local ports + bridge tasks exit. Without
                                    // this, the listeners stayed up holding
                                    // the now-dead Arc<Handle>, and stop_tunnel
                                    // calls during reconnect raced with the
                                    // replay logic. This is the single
                                    // authoritative SSH-death tunnel-teardown
                                    // path; the listener tasks themselves no
                                    // longer probe the handle.
                                    tunnel::stop_all_for_session(&state_tunnels_w, &sid_w).await;
                                    // Dedicated-transport death: tunnels are
                                    // tagged under the BASE session id but ride
                                    // this `::fwd` connection — stop them so
                                    // their listeners release; the frontend's
                                    // auto-retry either brings the transport
                                    // back (migration restarts them on it) or
                                    // falls back to the primary. Same for the
                                    // base SFTP cache riding a dead `::sftp`.
                                    if let Some(base) = sid_w.strip_suffix("::fwd") {
                                        tunnel::stop_all_for_session(&state_tunnels_w, base).await;
                                    }
                                    if let Some(base) = sid_w.strip_suffix("::sftp") {
                                        state_sftp_w.lock().await.remove(base);
                                    }
                                    // Stop any mirrors bound to this session too — otherwise the
                                    // mirror worker keeps its own Arc<SftpSession> pointing at
                                    // this dead handle and hammers upload-fail on every future
                                    // FS event until the app is quit.
                                    mirror::stop_all_for_session(&state_mirrors_w, &sid_w).await;
                                    let _ = app_w.emit(
                                        &format!("session-disconnected-{}", sid_w),
                                        serde_json::json!({
                                            "reason": "Connection lost"
                                        }),
                                    );
                                    break;
                                }
                            }
                        });
                    },
                    Ok(false) => {
                        // Server reached the auth phase and explicitly told
                        // us "no". This is the only branch that maps to a
                        // real auth failure — everything else gets routed
                        // through `classify_russh_error` so a network drop
                        // or host-key timeout never gets relabelled as one.
                        emit_log("Authentication rejected by server.", "error");
                        let _ = app.emit(
                            &format!("connection-failed-{}", session_id_clone),
                            serde_json::json!({
                                "reason": "Authentication rejected by server (wrong password, missing key, or account locked).",
                                "is_auth_error": true,
                            }),
                        );
                    },
                    Err(e) => {
                        let kind = classify_russh_error(&e);
                        let target = format!("{}:{}", host, port);
                        let reason = describe_error_kind(kind, &target);
                        emit_log(&format!("{} (raw: {})", reason, e), "error");
                        let _ = app.emit(
                            &format!("connection-failed-{}", session_id_clone),
                            serde_json::json!({
                                "reason": reason,
                                "is_auth_error": kind.is_auth(),
                            }),
                        );
                    }
                }
            },
            Ok(Err(e)) => {
                // Connect-stream failed AFTER the TCP socket opened — most
                // commonly this is the host-key flow ending in either a
                // declined fingerprint or a timed-out prompt. Read the
                // outcome the handler stashed and surface a precise reason
                // instead of letting it ride the generic transport bucket.
                use std::sync::atomic::Ordering;
                let fp = fp_outcome_for_driver.load(Ordering::SeqCst);
                let (reason, kind) = match fp {
                    2 => (
                        "Host key prompt timed out — Reconnect and approve the fingerprint within 90 seconds.".to_string(),
                        ConnectErrorKind::HostKey,
                    ),
                    0 => (
                        "Host key was not approved. Reconnect to see the fingerprint prompt again.".to_string(),
                        ConnectErrorKind::HostKey,
                    ),
                    _ => {
                        let kind = classify_russh_error(&e);
                        let target = format!("{}:{}", host, port);
                        (describe_error_kind(kind, &target), kind)
                    }
                };
                emit_log(&format!("{} (raw: {})", reason, e), "error");
                let _ = app.emit(
                    &format!("connection-failed-{}", session_id_clone),
                    serde_json::json!({
                        "reason": reason,
                        "is_auth_error": kind.is_auth(),
                    }),
                );
            },
            Err(_) => {
                // 15s wall-clock on connect_stream — the TCP socket is up
                // but the SSH handshake never completed. Distinct enough
                // from the auth path to deserve its own message.
                let msg = format!(
                    "{}:{} did not finish SSH handshake within 15 seconds — host may be filtering SSH or running a non-SSH service on this port.",
                    host, port
                );
                emit_log(&msg, "error");
                let _ = app.emit(
                    &format!("connection-failed-{}", session_id_clone),
                    serde_json::json!({
                        "reason": msg,
                        "is_auth_error": false,
                    }),
                );
            }
        }

        cleanup().await;
    });
    
    Ok(())
}

/// Frontend acknowledgement of the SSH host-key prompt. The `nonce` must
/// match the value the matching `fingerprint-prompt-{session_id}` event
/// carried — without that match the response is dropped on the floor. Any
/// stale "accept" from a previous attempt cannot satisfy a fresh prompt.
#[tauri::command]
async fn verify_fingerprint_response(
    state: tauri::State<'_, SshState>,
    nonce: String,
    accepted: bool,
) -> Result<(), String> {
    if let Some(tx) = state.fp_txs.lock().await.remove(&nonce) {
        let _ = tx.send(accepted);
    }
    Ok(())
}

/// Frontend callback for a keyboard-interactive (2FA / verification-code)
/// prompt. `responses` is `Some(answers)` when the user submits, or `None`
/// when they cancel. Mirrors `verify_fingerprint_response`: the nonce binds
/// the answer 1:1 to the connect attempt that emitted the prompt, and a nonce
/// with no in-flight entry is silently a no-op (stale / forged responses can't
/// satisfy a fresh prompt).
#[tauri::command]
async fn submit_kbi_response(
    state: tauri::State<'_, SshState>,
    nonce: String,
    responses: Option<Vec<String>>,
) -> Result<(), String> {
    if let Some(tx) = state.kbi_txs.lock().await.remove(&nonce) {
        let _ = tx.send(responses);
    }
    Ok(())
}

#[tauri::command]
async fn disconnect_session(
    app: tauri::AppHandle,
    state: tauri::State<'_, SshState>,
    mirrors: tauri::State<'_, MirrorMap>,
    session_id: String,
) -> Result<(), String> {
    // Invalidate any connect worker still handshaking for THIS key: bump the
    // generation before removing anything, so a late auth-success hits its
    // "still wanted?" guard and drops instead of re-registering a transport the
    // user just turned off (which would then steal / strand tunnels). Done for
    // every key, including secondaries — this is the toggle-off / reconnect-
    // button invalidation path.
    {
        let mut g = state.session_generation.lock().await;
        let next = g.get(&session_id).copied().unwrap_or(0).wrapping_add(1);
        g.insert(session_id.clone(), next);
    }
    // Disconnecting a dedicated transport directly (toggle-off / reconnect
    // button): tunnels are tagged under the BASE session id but ride this
    // `::fwd` connection. Stop them ONLY when the dedicated connection actually
    // exists — i.e. the tunnels really are riding it. If it's absent (a failed
    // `::fwd` that never registered, so the tunnels fell back to the primary),
    // stopping base-tagged tunnels here would needlessly bounce every live
    // primary tunnel. The caller restarts them on the best transport via
    // restart_session_tunnels afterwards.
    if let Some(base) = session_id.strip_suffix("::fwd") {
        if state.connections.lock().await.contains_key(&session_id) {
            tunnel::stop_all_for_session(&state.tunnels, base).await;
        }
    }
    // `::sftp`: remove the dedicated transport FIRST, then purge the base SFTP
    // cache — so an SFTP op racing this teardown can't re-cache a subsystem on
    // the dying transport after the purge (get_sftp_session's still-current
    // check would then see the transport gone and refuse to cache).
    if session_id.ends_with("::sftp") {
        state.connections.lock().await.remove(&session_id);
        if let Some(base) = session_id.strip_suffix("::sftp") {
            state.sftp_sessions.lock().await.remove(base);
        }
    }
    // Stop all forwarders so their listener sockets are released before the
    // SSH handle is dropped (otherwise newly-incoming connections would just
    // bounce off a dead channel).
    tunnel::stop_all_for_session(&state.tunnels, &session_id).await;
    state.forwarded_targets.lock().await.remove(&session_id);
    // Explicit user disconnect — drop the replay list too. (Auto-reconnect
    // calls `initiate_connection` directly and never hits this path, so
    // those tunnels survive the cycle.)
    state.session_tunnel_specs.lock().await.remove(&session_id);
    // Same idea for any mirror that's still running — its watcher would
    // try to push uploads through a dead SSH handle otherwise.
    mirror::stop_all_for_session(&mirrors, &session_id).await;
    // Drop SFTP first so the channel it holds is freed before we tear down the
    // underlying SSH handle.
    state.sftp_sessions.lock().await.remove(&session_id);
    state.connections.lock().await.remove(&session_id);
    state.session_passwords.lock().await.remove(&session_id);
    // Drop any ProxyJump bastion handle for this session — closes the jump
    // connection once the target it was carrying is gone.
    state.jump_connections.lock().await.remove(&session_id);
    // Drop terminal tx/resize entries so a subsequent reconnect doesn't try
    // to write into a dead PTY task. Match by the exact `${session_id}-term-`
    // prefix — a `contains` here silently tears down session-10's terminals
    // when the user disconnects session-1.
    let term_prefix = format!("{}-term-", session_id);
    state.terminal_txs.lock().await.retain(|k, _| !k.starts_with(&term_prefix));
    state.resize_txs.lock().await.retain(|k, _| !k.starts_with(&term_prefix));
    // Wipe any temp files this session left behind (live-edit downloads + drag
    // staging). Best-effort: failures are usually because an editor still holds
    // a lock on a file, in which case the file persists until the OS cleans temp.
    let session_temp_dir = session_sftp_dir(&session_id);
    if session_temp_dir.exists() {
        let _ = std::fs::remove_dir_all(&session_temp_dir);
    }
    let session_drag = session_drag_dir(&session_id);
    if session_drag.exists() {
        let _ = std::fs::remove_dir_all(&session_drag);
    }
    // Separate-sessions: reap the dedicated `::sftp` / `::fwd` secondaries so an
    // explicit primary disconnect doesn't leak their SSH sessions. Only when
    // this IS a primary id (no `::` suffix) — a direct disconnect of a secondary
    // must not recurse into non-existent grandchildren.
    if !session_id.contains("::") {
        teardown_connection_key(state.inner(), mirrors.inner(), &format!("{}::sftp", session_id)).await;
        teardown_connection_key(state.inner(), mirrors.inner(), &format!("{}::fwd", session_id)).await;
    }
    // Tell the UI so the tab status dot flips to red. `user_initiated` keeps
    // SessionView from kicking off an auto-reconnect cycle for an intentional
    // disconnect — distinct from the watcher path which has no such flag.
    use tauri::Emitter;
    let _ = app.emit(
        &format!("session-disconnected-{}", session_id),
        serde_json::json!({
            "reason": "User disconnected",
            "user_initiated": true,
        }),
    );
    Ok(())
}

/// Bucket the failure modes that can come out of an SSH connect / auth round.
/// Drives both the UI's `is_auth_error` flag (so auto-reconnect only stops
/// on real credential rejection) and the wording of the error message.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ConnectErrorKind {
    /// Server refused the credentials we presented.
    Auth,
    /// Couldn't agree on KEX / cipher / MAC / host-key algorithm with the
    /// peer. Server is reachable, our crypto preference set doesn't overlap.
    Algorithm,
    /// Host key issue — mismatched, declined by the user, or the prompt
    /// timed out. Distinct from auth: credentials never even got tried.
    HostKey,
    /// Transport-level drop: TCP reset, EOF, peer disconnect, IO error.
    Transport,
    /// Server didn't respond inside our window (handshake / auth / probe).
    Timeout,
    /// We couldn't even reach the box: DNS lookup failed, route missing,
    /// connection refused.
    Unreachable,
    /// Anything russh surfaced that we don't have a categorical bucket for.
    /// Treated as non-auth so the UI keeps trying — a real credential
    /// rejection has a specific variant for it.
    Unknown,
}

impl ConnectErrorKind {
    fn is_auth(self) -> bool {
        matches!(self, Self::Auth)
    }
}

/// Map a russh error onto a `ConnectErrorKind`. Uses enum variants when the
/// information is available (russh 0.40 exposes them all), falling back to
/// a string sniff only for the catch-all `_ =>` branch — so a russh upgrade
/// that adds new variants degrades gracefully instead of misreporting them
/// as auth failures.
fn classify_russh_error(e: &russh::Error) -> ConnectErrorKind {
    use russh::Error::*;
    match e {
        // Real credential rejection — the only path that should set
        // is_auth_error so the UI stops auto-retrying.
        NotAuthenticated | NoAuthMethod => ConnectErrorKind::Auth,

        // Algorithm negotiation — server's reachable, we just don't share
        // the cipher / KEX / etc. it asked for.
        NoCommonCipher | NoCommonKexAlgo | NoCommonKeyAlgo
        | NoCommonCompression | NoCommonMac
        | UnknownAlgo | UnknownKey => ConnectErrorKind::Algorithm,

        // Host-key flow: the server's signature didn't verify. KeyChanged
        // carries data so it falls through to the catch-all branch which
        // sniffs the string.
        WrongServerSig => ConnectErrorKind::HostKey,

        // Transport-level: connection died mid-protocol.
        IO(_) | HUP | Disconnect | SendError => ConnectErrorKind::Transport,

        // Explicit timeouts from russh.
        ConnectionTimeout | Elapsed(_) => ConnectErrorKind::Timeout,

        // Protocol disagreements that aren't algorithm- or auth-shaped:
        // version skew, packet integrity, decryption — surface as transport
        // so the user is told "connection broke" not "password wrong".
        // `StrictKeyExchangeViolation` / `ChannelOpenFailure` carry data;
        // the `_ =>` fallthrough handles those via the string sniff below.
        Version | Kex | PacketAuth | Inconsistent | IndexOutOfBounds
        | DecryptionError | KexInit
        | WrongChannel | Pending => ConnectErrorKind::Transport,

        // Key-file problems (local cert can't be parsed). Tag as Auth-shaped
        // so the UI doesn't auto-retry a key that will keep failing.
        CouldNotReadKey | Keys(_) => ConnectErrorKind::Auth,

        // Last-resort string sniff for anything russh adds in future
        // versions or for io::Error subtypes the explicit arms above
        // missed. Default to Unknown which the driver treats as non-auth.
        _ => {
            let lc = e.to_string().to_lowercase();
            if lc.contains("connection refused")
                || lc.contains("no route")
                || lc.contains("network is unreachable")
                || lc.contains("dns")
            {
                ConnectErrorKind::Unreachable
            } else if lc.contains("timed out") || lc.contains("timeout") {
                ConnectErrorKind::Timeout
            } else if lc.contains("io error") || lc.contains("eof")
                || lc.contains("disconnect") || lc.contains("reset")
                || lc.contains("broken pipe") || lc.contains("aborted")
            {
                ConnectErrorKind::Transport
            } else if lc.contains("not authenticated") || lc.contains("auth method") {
                ConnectErrorKind::Auth
            } else {
                ConnectErrorKind::Unknown
            }
        }
    }
}

/// Human-readable phrase for an error bucket. Combined with `target` to
/// build the reason string the UI shows next to a failed connection.
fn describe_error_kind(kind: ConnectErrorKind, target: &str) -> String {
    match kind {
        ConnectErrorKind::Auth =>
            "Authentication rejected by server (wrong password, missing key, or account locked).".into(),
        ConnectErrorKind::Algorithm =>
            format!("Negotiation with {} failed: no SSH algorithm in common (this build might be missing legacy ciphers — try the release build).", target),
        ConnectErrorKind::HostKey =>
            "Host key was not approved (wrong key, declined, or the fingerprint prompt timed out).".into(),
        ConnectErrorKind::Transport =>
            format!("Connection to {} dropped mid-handshake.", target),
        ConnectErrorKind::Timeout =>
            format!("{} did not respond in time.", target),
        ConnectErrorKind::Unreachable =>
            format!("Could not reach {} (DNS lookup, route, or port refusal).", target),
        ConnectErrorKind::Unknown =>
            format!("Connection to {} failed for an unrecognised reason.", target),
    }
}

/// Translate raw socket / SSH error messages into something a human can act
/// on. Most russh / tokio errors come out as "tcp: io error: ..." with the
/// useful detail buried — this lifts the common cases up to a clear sentence
/// while still falling back to the original text for anything unfamiliar.
fn humanize_network_err(raw: &str, host: &str, port: i32, label: &str) -> String {
    let lower = raw.to_lowercase();
    let target = if port > 0 { format!("{}:{}", host, port) } else { host.to_string() };

    if lower.contains("connection refused") {
        return format!("{}: {} refused the connection (is the SSH server running on this port?)", label, target);
    }
    if lower.contains("network is unreachable") || lower.contains("network unreachable") {
        return format!("{}: network is unreachable — check VPN / firewall / internet", label);
    }
    if lower.contains("no route to host") {
        return format!("{}: no route to {} — host is down or blocked", label, target);
    }
    if lower.contains("name or service not known")
        || lower.contains("nodename nor servname")
        || lower.contains("failed to lookup address")
        || lower.contains("no such host")
        || lower.contains("dns")
    {
        return format!("{}: could not resolve hostname {}", label, host);
    }
    if lower.contains("timed out") || lower.contains("timeout") {
        return format!("{}: {} did not respond in time", label, target);
    }
    if lower.contains("connection reset") || lower.contains("broken pipe") {
        return format!("{}: {} closed the connection", label, target);
    }
    if lower.contains("permission denied") {
        return format!("{}: permission denied (check key file readability)", label);
    }
    // Fallback — keep the raw detail so power users can still see it.
    format!("{}: {}", label, raw)
}

pub(crate) use commands::sftp::{is_safe_dir_entry_name, session_drag_dir, session_sftp_dir};

/// Library entrypoint shared by both the desktop `bin/main.rs` shim and
/// Tauri's Android entry-point macro. Everything that builds the
/// `tauri::Builder`, registers plugins/state/commands, and finally calls
/// `.run(generate_context!())` lives here so the same binary contents
/// ship on both platforms — only the wrapping is different.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
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
    #[cfg(not(target_os = "android"))]
    let builder = builder.plugin(tauri_plugin_window_state::Builder::default().build());
    // Cross-platform URL opener — Android (Intent.ACTION_VIEW), Windows
    // (start), macOS (open), Linux (xdg-open). about.rs's open_external_url
    // dispatches through this so the same code path works in the desktop
    // installer AND the Android APK. Capability is granted in default.json.
    let builder = builder.plugin(tauri_plugin_opener::init());
    builder
        .manage(DbState { conn: std::sync::Arc::new(StdMutex::new(None)), master_key: StdMutex::new(None), salt: StdMutex::new(None), db_path: StdMutex::new(None), active_profile: StdMutex::new(None), hlc: StdMutex::new(None), session_password: StdMutex::new(None) })
        .manage(SshState::new())
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
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            check_db_exists, setup_master_db, persist_vault,
            list_profiles, cloud_list_sync_profiles, cloud_delete_profile, force_push_profile, select_profile, create_profile, delete_profile, rename_profile, close_profile,
            prepare_switch_profile, has_session_password, switch_profile_seamless,
            get_profiles_sync_status, sync_profile_password, change_master_password,
            export_profile, import_profile_pick, import_profile_save, save_audit_log,
            cloud::cloud_set_api_base, cloud::cloud_status, cloud::cloud_signup, cloud::cloud_consume_verify_link,
            cloud::cloud_set_password, cloud::cloud_login, cloud::cloud_logout,
            cloud::cloud_request_password_reset, cloud::cloud_reset_password,
            cloud::cloud_request_login_link, cloud::cloud_login_with_link,
            cloud_config::cloud_get_server, cloud_config::cloud_set_server,
            sync_now,
            identity_status, setup_identity, reset_identity,
            share_current_profile, invite_to_share, list_shares, share_member_list,
            accept_share, import_shared_profile, restore_personal_profile, share_set_role, share_revoke, share_leave, share_delete,
            profile_share_status, stop_sharing, profile_sync_stats,
            set_editor_label,
            commands::servers::add_server, commands::servers::save_quick_connect_node, commands::servers::edit_server, commands::servers::delete_server, commands::servers::add_mirror_to_server, commands::servers::get_servers, commands::servers::get_ssh_keys, commands::servers::set_server_color, commands::servers::set_folder_color, commands::servers::set_server_notes, commands::servers::set_server_run_on_connect, commands::servers::set_server_jump_host, commands::servers::set_server_is_production, commands::servers::set_server_icon, commands::servers::update_server_os_info, commands::servers::reorder_servers, commands::servers::clone_server, commands::servers::reveal_server_password, commands::servers::reveal_credential_password, commands::servers::reveal_ssh_key,
            commands::servers::get_credentials, commands::servers::generate_ssh_key,
            commands::servers::add_folder, commands::servers::rename_folder, commands::servers::delete_folder, commands::servers::get_folders,
            commands::servers::add_command, commands::servers::edit_command, commands::servers::delete_command, commands::servers::get_commands,
            commands::servers::cmd_history_add, commands::servers::cmd_history_list, commands::servers::cmd_history_clear,
            commands::servers::add_note, commands::servers::edit_note, commands::servers::delete_note, commands::servers::get_notes,
            commands::mirror::mirror_dry_run,
            commands::mirror::start_mirror,
            commands::mirror::stop_mirror,
            commands::mirror::list_mirrors,
            commands::mirror::pick_local_directory,
            commands::servers::add_credential, commands::servers::edit_credential, commands::servers::delete_credential,
            commands::servers::add_ssh_key, commands::servers::edit_ssh_key, commands::servers::delete_ssh_key,
            get_known_hosts, delete_known_host, clear_all_known_hosts,
            initiate_connection, verify_fingerprint_response, submit_kbi_response, disconnect_session,
            commands::tunnels::start_tunnel, commands::tunnels::stop_tunnel, commands::tunnels::list_tunnels, commands::tunnels::restart_session_tunnels, commands::tunnels::persist_session_tunnels,
            commands::terminal::open_terminal, commands::terminal::open_local_terminal, commands::terminal::get_available_local_shells, commands::terminal::write_terminal_data, commands::terminal::resize_terminal, commands::terminal::close_terminal,
            commands::diagnostics::ssh_info_probe_section,
            commands::diagnostics::ssh_systemctl_action,
            commands::diagnostics::ssh_kill_process,
            commands::diagnostics::detect_session_os,
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
            commands::sftp::select_local_folder, commands::sftp::local_list_dir,
            commands::sftp::local_home_dir, commands::sftp::local_desktop_dir, commands::sftp::local_create_dir, commands::sftp::local_remove, commands::sftp::local_rename,
            commands::sftp::android_quick_dirs, commands::sftp::android_default_local_dir,
            commands::sftp::parse_ssh_config,
            commands::sftp::parse_client_import,
            commands::sftp::sftp_list_dir, commands::sftp::sftp_resolve_owners, commands::sftp::sftp_create_dir, commands::sftp::sftp_remove_file, commands::sftp::sftp_remove_dir,
            commands::sftp::sftp_rename, commands::sftp::sftp_set_permissions, commands::sftp::sftp_set_owner,
            commands::sftp::sftp_download_file, commands::sftp::sftp_download_dir, commands::sftp::sftp_upload_file, commands::sftp::sftp_upload_dir, commands::sftp::sftp_cancel_transfer, commands::sftp::sftp_open_remote_file,
            commands::sftp::sftp_read_file_text, commands::sftp::sftp_write_file_text, commands::sftp::local_read_file_text, commands::sftp::local_write_file_text, commands::sftp::sftp_exec_command,
            commands::sftp::local_open_file, commands::sftp::local_open_in_explorer, commands::sftp::sftp_prepare_drag,
            commands::sftp::local_copy_entry,
            commands::terminal::set_ssh_keepalive_interval,
            commands::network::send_wake_on_lan, commands::network::perform_port_knock,
            commands::network::probe_tcp_port, commands::network::batch_probe_ports,
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
