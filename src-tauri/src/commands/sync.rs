// HLC-based per-entity sync engine + profile sharing/escrow. Owns: schema
// backfill for pre-sync vaults, the sync triggers that auto-stamp uuid/HLC
// on every row mutation, per-entity encrypt/decrypt and LWW merge, the
// cloud sync_now/profile_sync_stats commands, and the identity/share/
// invite/accept/revoke commands used by profile sharing. Extracted out of
// lib.rs as one unit (including its two test modules) since the merge
// engine and the sharing/escrow code are tightly coupled through the DEK.

use crate::cloud;
use crate::hlc;
use crate::identity;
use crate::vault::{decrypt_with_key, derive_key, encrypt_with_key, get_or_create_dek, NONCE_LEN, SALT_LEN};
use crate::commands::profile::{save_vault_async, setup_master_db, setup_master_db_inner};
use crate::{profile_path, profiles_dir, validate_profile_name, DbState};
use rand::Rng;
use rusqlite::Connection;
use std::fs;
use zeroize::Zeroizing;

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

/// User-facing groups of synced tables that can be switched off per device
/// (Settings -> Cloud Sync). An excluded group is neither pushed nor pulled, and
/// its tombstones are held back too, so the local copy and the cloud copy of
/// that data simply stop talking to each other. Rows that point INTO an excluded
/// group (a server's saved credential, say) lose that link when a remote copy
/// is applied, exactly as for any referent that doesn't exist locally.
pub(crate) const SYNC_CATEGORIES: &[(&str, &[&str])] = &[
    ("servers", &["folders", "servers", "monitor_configs"]),
    ("credentials", &["ssh_keys", "credentials"]),
    ("commands", &["commands"]),
    ("notes", &["notes"]),
];

const SYNC_EXCLUDED_KEY: &str = "sync_excluded";

/// Category ids -> the table names they cover. Unknown ids are ignored.
pub(crate) fn tables_for_categories(ids: &[String]) -> Vec<&'static str> {
    SYNC_CATEGORIES
        .iter()
        .filter(|(id, _)| ids.iter().any(|i| i == id))
        .flat_map(|(_, tables)| tables.iter().copied())
        .collect()
}

/// The category ids this device has switched off (device-local `sync_meta`).
pub(crate) fn read_excluded_categories(conn: &Connection) -> Vec<String> {
    let raw: String = conn
        .query_row("SELECT value FROM sync_meta WHERE key=?1", [SYNC_EXCLUDED_KEY], |r| r.get(0))
        .unwrap_or_default();
    raw.split(',')
        .map(|x| x.trim())
        .filter(|x| SYNC_CATEGORIES.iter().any(|(id, _)| id == x))
        .map(|x| x.to_string())
        .collect()
}

pub(crate) fn read_excluded_tables(conn: &Connection) -> Vec<&'static str> {
    tables_for_categories(&read_excluded_categories(conn))
}

/// Drop every record (live or tombstone) belonging to an excluded table.
pub(crate) fn retain_synced(records: Vec<SyncRecord>, excluded: &[&str]) -> Vec<SyncRecord> {
    if excluded.is_empty() {
        return records;
    }
    records.into_iter().filter(|r| !excluded.contains(&r.entity_type.as_str())).collect()
}

/// Opaque 128-bit hex id for a synced row. Not RFC-4122 formatted — we only
/// need global uniqueness, and this matches the app's existing random-id idiom
/// (see `app_temp_root`).
pub(crate) fn new_entity_uuid() -> String {
    let mut bytes = [0u8; 16];
    rand::thread_rng().fill(&mut bytes);
    hex::encode(bytes)
}

/// Load — or generate once — this device's stable sync node id. Stored in a
/// device-local sidecar next to the cloud token, deliberately OUTSIDE the vault
/// so it never travels when a vault is copied/restored to another device (two
/// devices sharing a node id would make HLC tie-breaks collide and corrupt the
/// causal order).
pub(crate) fn sync_device_node_id(app: &tauri::AppHandle) -> String {
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
pub(crate) fn backfill_identity_cols(table: &str) -> &'static [&'static str] {
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
pub(crate) fn derived_entity_uuid(table: &str, values: &[Option<String>]) -> Option<String> {
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
pub(crate) fn backfill_sync_columns(conn: &Connection, _hlc: &hlc::Hlc) -> Result<bool, String> {
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
pub(crate) fn register_sync_functions(conn: &Connection, hlc: &std::sync::Arc<hlc::Hlc>) -> Result<(), String> {
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
pub(crate) fn create_sync_triggers(conn: &Connection) -> Result<(), String> {
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

/// Category ids this device does NOT sync (see `SYNC_CATEGORIES`).
#[tauri::command]
pub(crate) async fn get_sync_excluded(db_state: tauri::State<'_, DbState>) -> Result<Vec<String>, String> {
    let conn_g = db_state.conn.lock().map_err(|_| "[STATE] LOCK_CONN")?;
    let conn = conn_g.as_ref().ok_or("[STATE] DB_NOT_OPEN")?;
    Ok(read_excluded_categories(conn))
}

/// Replace the set of categories this device keeps out of sync. Local-only
/// (`sync_meta` never leaves the vault); unknown ids are dropped.
#[tauri::command]
pub(crate) async fn set_sync_excluded(db_state: tauri::State<'_, DbState>, categories: Vec<String>) -> Result<(), String> {
    let kept: Vec<&str> = SYNC_CATEGORIES
        .iter()
        .map(|(id, _)| *id)
        .filter(|id| categories.iter().any(|c| c == id))
        .collect();
    {
        let conn_g = db_state.conn.lock().map_err(|_| "[STATE] LOCK_CONN")?;
        let conn = conn_g.as_ref().ok_or("[STATE] DB_NOT_OPEN")?;
        if kept.is_empty() {
            conn.execute("DELETE FROM sync_meta WHERE key=?1", [SYNC_EXCLUDED_KEY])
                .map_err(|e| format!("[SYNC] EXCLUDE_CLEAR: {e}"))?;
        } else {
            conn.execute(
                "INSERT INTO sync_meta(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                rusqlite::params![SYNC_EXCLUDED_KEY, kept.join(",")],
            )
            .map_err(|e| format!("[SYNC] EXCLUDE_SET: {e}"))?;
        }
    }
    save_vault_async(&db_state).await
}

#[cfg(test)]
mod sync_category_tests {
    use super::*;

    fn rec(t: &str, deleted: bool) -> SyncRecord {
        SyncRecord { uuid: format!("u-{t}"), entity_type: t.into(), updated_at: "1".into(), deleted, blob: None }
    }

    #[test]
    fn categories_cover_only_real_synced_tables_exactly_once() {
        let mut seen = std::collections::HashSet::new();
        for (_, tables) in SYNC_CATEGORIES {
            for t in *tables {
                assert!(SYNCED_TABLES.contains(t), "{t} is not a synced table");
                assert!(seen.insert(*t), "{t} appears in two categories");
            }
        }
        for t in SYNCED_TABLES {
            assert!(seen.contains(t), "{t} cannot be toggled");
        }
    }

    #[test]
    fn excluded_records_and_tombstones_are_dropped_everything_else_kept() {
        let recs = vec![rec("notes", false), rec("notes", true), rec("servers", false), rec(ESCROW_ETYPE, false)];
        let kept = retain_synced(recs.clone(), &["notes"]);
        assert_eq!(kept.iter().map(|r| r.entity_type.as_str()).collect::<Vec<_>>(), vec!["servers", ESCROW_ETYPE]);
        assert_eq!(retain_synced(recs, &[]).len(), 4);
    }

    #[test]
    fn unknown_category_ids_are_ignored() {
        let t = tables_for_categories(&["credentials".to_string(), "bogus".to_string()]);
        assert_eq!(t, vec!["ssh_keys", "credentials"]);
    }

    #[test]
    fn exclusion_round_trips_through_sync_meta() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute("CREATE TABLE sync_meta(key TEXT PRIMARY KEY, value TEXT)", []).unwrap();
        assert!(read_excluded_categories(&conn).is_empty());
        conn.execute("INSERT INTO sync_meta VALUES('sync_excluded','notes, bogus,commands')", []).unwrap();
        assert_eq!(read_excluded_categories(&conn), vec!["notes".to_string(), "commands".to_string()]);
        assert_eq!(read_excluded_tables(&conn), vec!["commands", "notes"]);
    }
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

pub(crate) struct Fk {
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
pub(crate) struct EntitySpec {
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
        cols: &["name", "host", "port", "username", "password", "proxy_type", "proxy_host", "proxy_port", "tunnels", "auth_type", "autostart", "mirrors", "color", "notes", "run_on_connect", "position", "protocol", "edited_by"],
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
pub(crate) fn encrypt_entity(plaintext: &[u8], key: &[u8; 32]) -> Result<String, String> {
    let (ct, nonce) = encrypt_with_key(plaintext, key)?;
    let mut out = Vec::with_capacity(NONCE_LEN + ct.len());
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&ct);
    Ok(hex::encode(out))
}
pub(crate) fn decrypt_entity(blob_hex: &str, key: &[u8; 32]) -> Result<Vec<u8>, String> {
    let raw = hex::decode(blob_hex).map_err(|e| format!("[SYNC] BLOB_HEX: {e}"))?;
    if raw.len() < NONCE_LEN + 16 {
        return Err("[SYNC] BLOB_TOO_SHORT".into());
    }
    decrypt_with_key(&raw[NONCE_LEN..], &raw[..NONCE_LEN], key)
}

pub(crate) fn json_to_sql(v: Option<&serde_json::Value>) -> Box<dyn rusqlite::types::ToSql> {
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
pub(crate) fn collect_local_records(conn: &Connection, key: &[u8; 32], since: &str) -> Result<Vec<SyncRecord>, String> {
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
pub(crate) fn apply_remote_records(conn: &Connection, key: &[u8; 32], records: &[SyncRecord], hlc: &hlc::Hlc) -> Result<(), String> {
    conn.execute("INSERT INTO sync_flags(key,val) VALUES('merge',1) ON CONFLICT(key) DO UPDATE SET val=1", [])
        .map_err(|e| format!("[SYNC] MERGE_ON: {e}"))?;
    let r = apply_remote_inner(conn, key, records, hlc);
    let _ = conn.execute("UPDATE sync_flags SET val=0 WHERE key='merge'", []);
    r
}

/// One deferred foreign-key repair: set `table.fk_col` for the row `uuid` to
/// whatever `ref_table.uuid = ref_uuid` resolves to once the batch is complete.
pub(crate) struct FkFixup {
    table: String,
    uuid: String,
    fk_col: String,
    ref_table: String,
    ref_uuid: String,
}

pub(crate) fn apply_remote_inner(conn: &Connection, key: &[u8; 32], records: &[SyncRecord], hlc: &hlc::Hlc) -> Result<(), String> {
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

pub(crate) fn apply_entity(conn: &Connection, key: &[u8; 32], spec: &EntitySpec, rec: &SyncRecord, fk_fixups: &mut Vec<FkFixup>) -> Result<(), String> {
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

pub(crate) fn apply_tombstone(conn: &Connection, rec: &SyncRecord) -> Result<(), String> {
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
pub(crate) struct SyncReport {
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
pub(crate) fn build_pw_escrow_record(
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
pub(crate) fn open_pw_escrow(blob_hex: &str, password: &str) -> Result<[u8; 32], String> {
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
pub(crate) async fn sync_now(
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
    let (records, dek, hlc, share, cloud_profile, master_key, salt, excluded) = {
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
        let excluded = read_excluded_tables(conn);
        let records = retain_synced(collect_local_records(conn, &dek, "")?, &excluded);
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
        (records, dek, hlc, share, cloud_profile, master_key, salt, excluded)
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
    // Hold back anything the server sent for a group this device doesn't sync.
    let remote = retain_synced(remote, &excluded);
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
pub(crate) struct RecentEdit {
    name: String,
    edited_by: String,
    updated_at: String,
}

#[derive(serde::Serialize)]
pub(crate) struct OutOfSyncItem {
    uuid: String,
    name: String,
    /// "push" when the local copy is newer than the cloud's, "pull" the
    /// other way — lets the panel label each row without re-deriving it.
    direction: &'static str,
}

#[derive(serde::Serialize)]
pub(crate) struct SyncDiff {
    in_sync: usize,
    needs_push: usize,
    needs_pull: usize,
    /// Local nodes whose local copy differs from the cloud (either an
    /// unpushed local edit, or a cloud copy at a different stamp). Capped.
    out_of_sync_nodes: Vec<OutOfSyncItem>,
}

#[derive(serde::Serialize)]
pub(crate) struct ProfileSyncStats {
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
pub(crate) async fn profile_sync_stats(
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
    let (local, dek, share, cloud_profile, recent_edits, server_names, excluded) = {
        let conn_g = db_state.conn.lock().map_err(|_| "[STATE] LOCK_CONN")?;
        let conn = conn_g.as_ref().ok_or("[STATE] DB_NOT_OPEN")?;
        let (dek, _created) = get_or_create_dek(conn)?;
        let excluded = read_excluded_tables(conn);
        let local = retain_synced(collect_local_records(conn, &dek, "")?, &excluded);
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
            excluded,
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
                let server = retain_synced(server, &excluded);
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
                let mut out: Vec<OutOfSyncItem> = Vec::new();

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
                        let direction = if l > s { "push" } else { "pull" };
                        if direction == "push" {
                            needs_push += 1;
                        } else {
                            needs_pull += 1;
                        }
                        if is_server && out.len() < 20 {
                            if let Some(name) = server_names.get(u) {
                                out.push(OutOfSyncItem { uuid: u.to_string(), name: name.clone(), direction });
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

/// Payload keys that hold secrets. Redacted before a decrypted entity is
/// shown in the conflict-diff panel — this view exists so a user can SEE
/// what a sync is about to overwrite, not to put plaintext passwords/private
/// keys on screen for a side that didn't ask to reveal them.
const REDACTED_PAYLOAD_KEYS: &[&str] = &["password", "private_key", "passphrase"];

fn redact_payload(mut v: serde_json::Value) -> serde_json::Value {
    if let serde_json::Value::Object(map) = &mut v {
        for key in REDACTED_PAYLOAD_KEYS {
            if let Some(val) = map.get_mut(*key) {
                if !val.is_null() {
                    *val = serde_json::Value::String("••••••••".to_string());
                }
            }
        }
    }
    v
}

fn decrypt_record_pretty(rec: &SyncRecord, key: &[u8; 32]) -> Option<String> {
    if rec.deleted {
        return Some("(deleted)".to_string());
    }
    let blob = rec.blob.as_ref()?;
    let plain = decrypt_entity(blob, key).ok()?;
    let v: serde_json::Value = serde_json::from_slice(&plain).ok()?;
    serde_json::to_string_pretty(&redact_payload(v)).ok()
}

#[derive(serde::Serialize)]
pub(crate) struct ConflictDiff {
    entity_type: String,
    local_updated_at: Option<String>,
    remote_updated_at: Option<String>,
    /// Pretty-printed, secret-redacted JSON for each side. `None` means that
    /// side has no record at all (created only on the other device).
    local_json: Option<String>,
    remote_json: Option<String>,
}

/// Read-only side-by-side view of what a sync is about to do to one entity:
/// decrypts and pretty-prints the local copy and the cloud's copy of the
/// same uuid so the user can see exactly what's about to be overwritten by
/// the LWW merge, before it happens. Does not change the merge rule itself —
/// this is visibility, not interactive resolution.
#[tauri::command]
pub(crate) async fn sync_conflict_diff(
    app: tauri::AppHandle,
    db_state: tauri::State<'_, DbState>,
    cloud: tauri::State<'_, std::sync::Arc<cloud::CloudState>>,
    uuid: String,
) -> Result<ConflictDiff, String> {
    let (dek, share, cloud_profile, local_rec) = {
        let conn_g = db_state.conn.lock().map_err(|_| "[STATE] LOCK_CONN")?;
        let conn = conn_g.as_ref().ok_or("[STATE] DB_NOT_OPEN")?;
        let (dek, _created) = get_or_create_dek(conn)?;
        let local_rec = collect_local_records(conn, &dek, "")?
            .into_iter()
            .find(|r| r.uuid == uuid);
        let share_id: Option<String> = conn
            .query_row("SELECT value FROM sync_meta WHERE key='share_id'", [], |r| r.get(0))
            .ok();
        let share_role: Option<String> = conn
            .query_row("SELECT value FROM sync_meta WHERE key='share_role'", [], |r| r.get(0))
            .ok();
        let profile = db_state
            .active_profile
            .lock()
            .map_err(|_| "[STATE] LOCK_PROFILE")?
            .clone()
            .ok_or("[SYNC] NO_PROFILE_OPEN")?;
        let cloud_profile: String = conn
            .query_row("SELECT value FROM sync_meta WHERE key='cloud_profile'", [], |r| r.get(0))
            .unwrap_or(profile);
        (
            dek,
            share_id.map(|s| (s, share_role.unwrap_or_else(|| "user".to_string()))),
            cloud_profile,
            local_rec,
        )
    };

    let pulled = if let Some((share_id, _role)) = &share {
        cloud::shared_sync_exchange(&app, &cloud, share_id, "", &[]).await
    } else {
        cloud::sync_exchange(&app, &cloud, &cloud_profile, "", &[], None).await
    }
    .map_err(|e| format!("[SYNC] CONFLICT_DIFF_PULL: {e}"))?;

    let remote_rec = pulled
        .into_iter()
        .find(|r| r.uuid == uuid && r.entity_type != ESCROW_ETYPE);

    let entity_type = local_rec
        .as_ref()
        .map(|r| r.entity_type.clone())
        .or_else(|| remote_rec.as_ref().map(|r| r.entity_type.clone()))
        .ok_or("[SYNC] CONFLICT_DIFF_NOT_FOUND")?;

    Ok(ConflictDiff {
        entity_type,
        local_updated_at: local_rec.as_ref().map(|r| r.updated_at.clone()),
        remote_updated_at: remote_rec.as_ref().map(|r| r.updated_at.clone()),
        local_json: local_rec.as_ref().and_then(|r| decrypt_record_pretty(r, &dek)),
        remote_json: remote_rec.as_ref().and_then(|r| decrypt_record_pretty(r, &dek)),
    })
}

// ===========================================================================
// Profile sharing commands (E2E). Identity lives in the cloud session; the
// per-profile DEK is what actually gets shared, sealed to each member.
// ===========================================================================

pub(crate) fn hex_to_32(s: &str) -> Result<[u8; 32], String> {
    let raw = hex::decode(s).map_err(|_| "[SHARE] BAD_HEX".to_string())?;
    if raw.len() != 32 {
        return Err("[SHARE] BAD_KEY_LEN".into());
    }
    let mut out = [0u8; 32];
    out.copy_from_slice(&raw);
    Ok(out)
}

#[derive(serde::Serialize)]
pub(crate) struct IdentityStatus {
    exists_on_server: bool,
    unlocked: bool,
    public_key: Option<String>,
}

/// Is a sharing identity set up (server) and/or unlocked (this session)?
#[tauri::command]
pub(crate) async fn identity_status(
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
pub(crate) async fn setup_identity(
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
pub(crate) async fn reset_identity(
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
pub(crate) struct ShareResult {
    share_id: String,
}

/// Owner: turn the OPEN profile into a shared profile. Seals the profile DEK to
/// my own public key and records the share_id locally.
#[tauri::command]
pub(crate) async fn share_current_profile(
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
pub(crate) struct InviteResult {
    email: String,
}

/// Owner: invite `email` to a share at `role` (editor|user). Obtains the DEK by
/// unsealing my own grant, then re-seals it to the invitee's public key.
#[tauri::command]
pub(crate) async fn invite_to_share(
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
pub(crate) async fn list_shares(
    app: tauri::AppHandle,
    cloud: tauri::State<'_, std::sync::Arc<cloud::CloudState>>,
) -> Result<Vec<cloud::ShareInfo>, String> {
    cloud::list_shares(&app, &cloud).await
}

/// The member roster of a share I belong to.
#[tauri::command]
pub(crate) async fn share_member_list(
    app: tauri::AppHandle,
    cloud: tauri::State<'_, std::sync::Arc<cloud::CloudState>>,
    share_id: String,
) -> Result<Vec<cloud::MemberInfo>, String> {
    cloud::share_members(&app, &cloud, &share_id).await
}

#[derive(serde::Serialize)]
pub(crate) struct AcceptResult {
    role: String,
}

/// Accept a pending invite. Verifies I can unseal the DEK with my identity, then
/// records the share locally. (Materialising it as a syncable local profile is
/// wired in S3c.)
#[tauri::command]
pub(crate) async fn accept_share(
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
pub(crate) async fn import_shared_profile(
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
pub(crate) fn discard_half_built_profile(app: &tauri::AppHandle, name: &str) {
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
pub(crate) async fn restore_personal_profile(
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
pub(crate) async fn share_set_role(
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
pub(crate) async fn rotate_share_dek(
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
pub(crate) async fn share_revoke(
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
pub(crate) async fn share_leave(
    app: tauri::AppHandle,
    cloud: tauri::State<'_, std::sync::Arc<cloud::CloudState>>,
    share_id: String,
) -> Result<(), String> {
    cloud::leave_share(&app, &cloud, &share_id).await
}

/// Owner: delete the whole shared profile.
#[tauri::command]
pub(crate) async fn share_delete(
    app: tauri::AppHandle,
    cloud: tauri::State<'_, std::sync::Arc<cloud::CloudState>>,
    share_id: String,
) -> Result<(), String> {
    cloud::delete_share(&app, &cloud, &share_id).await
}

#[derive(serde::Serialize)]
pub(crate) struct ProfileShareStatus {
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
pub(crate) async fn profile_share_status(
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
pub(crate) async fn stop_sharing(
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
pub(crate) async fn set_editor_label(db_state: tauri::State<'_, DbState>, label: String) -> Result<(), String> {
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
             CREATE TABLE servers(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, host TEXT, port INTEGER, username TEXT, password TEXT, credential_id INTEGER, folder_id INTEGER, proxy_type TEXT, proxy_host TEXT, proxy_port INTEGER, tunnels TEXT, auth_type TEXT, key_id INTEGER, autostart INTEGER, mirrors TEXT, color TEXT, notes TEXT, run_on_connect TEXT, jump_host_id INTEGER, position INTEGER NOT NULL DEFAULT 0, is_production INTEGER NOT NULL DEFAULT 0, icon TEXT DEFAULT 'server', os_info TEXT DEFAULT '', uuid TEXT, updated_at TEXT, deleted INTEGER NOT NULL DEFAULT 0, edited_by TEXT, protocol TEXT DEFAULT 'ssh');
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

    // `protocol` marks an RDP server. It has to travel with the row, and a record
    // from a peer that predates the column (no `protocol` key) must still land,
    // reading back as plain SSH instead of being skipped.
    #[test]
    fn rdp_protocol_syncs_and_an_older_peer_record_without_it_still_merges() {
        let (a, _ha) = device("A");
        a.execute("INSERT INTO servers(name, host, port, protocol) VALUES('win','10.0.0.9',3389,'rdp')", []).unwrap();
        let recs = collect_local_records(&a, &KEY, "").unwrap();
        let (b, hb) = device("B");
        apply_remote_records(&b, &KEY, &recs, &hb).unwrap();
        let p: String = b.query_row("SELECT protocol FROM servers WHERE name='win'", [], |r| r.get(0)).unwrap();
        assert_eq!(p, "rdp");

        // Same server as an older app would send it: payload without the `protocol` key.
        let mut rec = recs.iter().find(|r| r.entity_type == "servers").unwrap().clone();
        let mut payload: serde_json::Value =
            serde_json::from_slice(&decrypt_entity(rec.blob.as_deref().unwrap(), &KEY).unwrap()).unwrap();
        payload.as_object_mut().unwrap().remove("protocol");
        rec.uuid = "fixed-old-peer-uuid".into();
        rec.blob = Some(encrypt_entity(payload.to_string().as_bytes(), &KEY).unwrap());
        let (c, hc) = device("C");
        apply_remote_records(&c, &KEY, std::slice::from_ref(&rec), &hc).unwrap();
        let n: i64 = c.query_row("SELECT COUNT(*) FROM servers WHERE name='win'", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 1, "the record from an older peer must not be skipped");
        let p: Option<String> = c.query_row("SELECT protocol FROM servers WHERE name='win'", [], |r| r.get(0)).unwrap();
        assert!(p.is_none() || p.as_deref() == Some("ssh"));
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
