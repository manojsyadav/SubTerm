# Data Model

SubTerm's state lives in three places, and confusing them is the source of most "where did
my settings go" questions:

| Store | Holds | Encrypted | Syncs | Survives a reinstall |
| :--- | :--- | :--- | :--- | :--- |
| **The profile vault** (`*.subterm`) | Servers, credentials, SSH keys, folders, snippets, notes, known hosts, monitor configs, shortcuts | **Yes** — Argon2id + AES-256-GCM | Yes, via Cloud Sync | Yes, if you keep the file |
| **Webview preferences** | Appearance, feature toggles, terminal settings — anything on the Settings panel that is not in the list above | No | No | **Often not** (see §4) |
| **Loose app-data files** | `cloud_token.json`, window state, the RDP known-hosts entries written outside a profile | No | No | Yes, but they are caches, not data |

This document covers the first. The format on disk is specified in
[`SECURITY.md`](SECURITY.md) §1 and [`ARCHITECTURE.md`](ARCHITECTURE.md) §3; what follows
is the *logical* schema inside it.

---

## 1. The vault is an in-memory SQLite database

While locked, the vault is a single encrypted file. On unlock, it is decrypted,
decompressed and handed to SQLite with `sqlite3_deserialize` — **the database only ever
exists in memory.** Every mutation re-serializes, compresses, encrypts and atomically
rewrites the file (`persist_vault` → `save_vault_blocking`: temp file, fsync, rename).

Consequences:

- There is no `.db` on disk to inspect, and no WAL. A crash loses at most the mutations
  since the last save, never the file.
- **Each profile is independently encrypted** — its own salt, its own derived key. There is
  no shared key across profiles, which is why a second profile's password is genuinely a
  second lock and not a UI gate.
- Two version numbers exist and must not be conflated: **`VAULT_VERSION`** (the crypto
  framing, `vault.rs`) and **`SCHEMA_VERSION`** (the SQL schema below, `schema_meta` table
  in `profile.rs`).

---

## 2. Tables

### Connection data

| Table | Holds |
| :--- | :--- |
| `servers` | The central row: `name`, `host`, `port`, `username`, auth selection (`auth_type`, `credential_id`, `key_id`, inline `password`), `folder_id`, `proxy_*`, `jump_host_id`, `tunnels` (JSON), `mirrors` (JSON), `run_on_connect`, `autostart`, `forward_agent`, `is_production`, `icon`, `color`, `notes`, `position`, `os_info` |
| `folders` | Tree via `parent_id`, with a `color` |
| `credentials` | `auth_type`, `username`, `password`, optional `key_id` → `ssh_keys` |
| `ssh_keys` | `public_key`, `private_key`, `passphrase` |
| `known_hosts` | TOFU host-key store: `host`, `port`, `fingerprint`, `key_type`. Embedded RDP writes here too, with `key_type = 'rdp-tls'` |

`servers.is_production` is the flag behind the `PROD` badge and Safe Mode's destructive
command interception — it is data, not a UI preference, so it travels with the profile and
syncs between devices.

A server can carry a password **inline** or through a `credential_id`; `auth_type`
(`vault` by default) decides which is used. Both columns can be populated, which is why
changing auth type does not clear the other field.

### User content

| Table | Holds |
| :--- | :--- |
| `commands` | Snippets: `title`, `content`, optional `server_id` (server-scoped), `tags` |
| `notes` | `title`, `body` |
| `cmd_history` | `server_id`, `server_name`, `command`, `ts`, `exit_code` |
| `shortcuts` | `platform`, `action`, `combo`, unique on `(platform, action)` |

`shortcuts` is keyed by platform because Cmd and Ctrl differ — a Mac and a Windows machine
sharing a profile keep separate sets, deliberately.

`cmd_history` stores `server_name` alongside `server_id` so history stays readable after
the server row is deleted.

### Monitoring

| Table | Holds |
| :--- | :--- |
| `monitor_configs` | Per-server: `enabled_metrics`, `custom_metrics`, `paused`. `node_id` → `servers(id)` `ON DELETE CASCADE` |
| `monitor_settings` | One row, a JSON blob of global polling intervals and thresholds |

**Every `monitor_configs` row is forced to `paused = 1` when a profile opens.** Pollers do
not survive an app restart, so a stored `paused = 0` would advertise a monitor as running
while no task exists. The displayed state has to be truthful.

### Sync bookkeeping

| Table | Holds |
| :--- | :--- |
| `sync_meta` | Per-profile sync state, including the profile's **DEK** — a random 256-bit data key, *not* password-derived |
| `sync_tombstones` | `uuid`, `entity_type`, `updated_at` for deleted rows |
| `sync_flags` | Local sync toggles |
| `schema_meta` | `SCHEMA_VERSION` and friends |

---

## 3. How a row syncs: UUID, HLC, soft delete

Every syncable table carries the same four columns, added by the sync schema backfill:

| Column | Meaning |
| :--- | :--- |
| `uuid` | The row's identity **across devices**. The integer `id` is local and meaningless elsewhere. |
| `updated_at` | A Hybrid Logical Clock stamp (`hlc.rs`), not a wall clock — this is what orders two devices' edits without trusting either machine's time. |
| `deleted` | Soft delete. A row is never removed by sync; it is flagged, and a `sync_tombstones` entry records it. |
| `edited_by` | Which member last wrote it. |

Merge is **last-writer-wins by HLC**, per row. SQLite triggers (`create_sync_triggers`)
maintain the stamps, so a plain `UPDATE` from anywhere in the code participates in sync
without the caller knowing.

Two rules that follow:

- **Never hard-`DELETE` a syncable row.** Set `deleted = 1`; a hard delete resurrects on
  the next pull from a device that still has it.
- **Never match rows across devices on `id`.** Only `uuid` is stable.

The DEK in `sync_meta` is minted eagerly on first open and persisted immediately,
precisely so it cannot drift from blobs already pushed — a DEK created in memory and lost
to a crash would leave unreadable blobs in the cloud.

---

## 4. What is *not* in the vault

Everything on the Settings panel that is not a server, credential, key, folder, snippet,
note, known host, monitor config or shortcut is a **webview preference**. That matters
because:

- It does not sync.
- It is stored by the webview, not by SubTerm, so **it may not survive an app identifier
  change or a reinstall on macOS and Linux**. The `com.subterm.app` →
  `com.subterm.desktop` migration copies profiles, sync state, cloud settings and
  recordings; it cannot always reach preferences.
- Settings > General > **Backup & Restore** exports exactly this set, and nothing else.
  See [`BACKUP_AND_RECOVERY.md`](BACKUP_AND_RECOVERY.md).

`cloud_token.json` (the bearer token for Cloud Sync) also lives outside the vault, in app
data. It is a credential; treat the app-data folder accordingly.

---

## 5. Changing the schema

- Add a column with `ALTER TABLE … ADD COLUMN` in the bootstrap path and bump
  `SCHEMA_VERSION`. The pattern is additive on purpose: an older binary opening a newer
  vault fails closed with `SCHEMA_AHEAD_OF_BINARY` rather than silently dropping data.
- A new **syncable** table needs the four sync columns, a tombstone entity type and
  trigger registration, or it will diverge silently between devices.
- A schema change is orthogonal to a `VAULT_VERSION` / KDF change
  ([`SECURITY.md`](SECURITY.md) §9). Do not bump one for the other.
