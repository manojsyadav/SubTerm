# SubTerm Security Architecture & Threat Model

SubTerm stores high-value secrets including server IP addresses, SSH private keys, passwords, sudo credentials, and port forwarding rules. This document specifies the security controls, cryptographic primitives, memory management, and access controls implemented throughout the codebase.

---

## 1. Cryptographic Vault Specification

All user profiles (`*.subterm` and legacy `*.submarine` files) are stored encrypted at rest using industry-standard authenticated encryption.

### 1.1 Key Derivation Function (KDF)

- **Algorithm**: Argon2id (v0x13) via the `argon2` Rust crate.
- **Parameters**:
  - Memory Cost (`m_cost`): `65,536 KiB` (64 MiB).
  - Time Cost (`t_cost`): `3 passes`.
  - Parallelism (`p_cost`): `4 threads`.
  - Output Key Length: `32 bytes` (256 bits).
- **Design Rationale**: Argon2id provides hybrid defense against both GPU/ASIC side-channel attacks and memory-hard trade-off attacks. The 64 MiB cost was chosen to balance fast desktop unlock times (~200–350ms on modern hardware) with strong resistance against offline brute-force dictionary attacks.

### 1.2 Authenticated Encryption (AEAD)

- **Algorithm**: AES-256-GCM (`aes-gcm` Rust crate).
- **Key Length**: 256 bits (`[u8; 32]`).
- **Nonce / IV**: 96 bits (12 bytes), generated freshly for every vault write using `rand::thread_rng()`.
- **Integrity Tag**: 128 bits appended to the ciphertext, validating both authenticity and confidentiality. Any modification of the ciphertext or header halts decryption with `[CRYPTO] DECRYPT_FAILURE`.

### 1.3 Binary File Header Format

```
Offset (Bytes)   Length (Bytes)   Field Name         Value / Description
-----------------------------------------------------------------------------------
0x00             4                Magic Bytes        ASCII "OMNV" (0x4F 0x4D 0x4E 0x56)
0x04             1                Vault Version      0x01
0x05             16               Salt               Cryptographic random salt
0x15             12               Nonce / IV         AES-GCM initialization vector
0x21             Variable         Ciphertext + Tag   Encrypted Zstd-compressed SQLite DB
```

See `src-tauri/src/vault.rs` (`VAULT_MAGIC`, `VAULT_VERSION`, `HEADER_LEN`) for the authoritative constants — this table previously drifted from the code (`"SUBT"`/`0x02`) and was corrected here. §9 below covers what happens when this version byte needs to change.

---

## 2. In-Memory Lifecycle & Lock States

1. **Vault Locked**:
   - The SQLite database connection is closed.
   - The derived master key buffer is zeroed out and removed from memory (`DbState.master_key = None`).
   - The session password is removed from memory (`DbState.session_password = None`).
   - No credentials, server passwords, or SSH private keys remain unencrypted in memory.

2. **Automatic locking** (Settings > General > Security, all off by default):
   - *Auto-lock when idle* locks after 1 to 60 minutes with no mouse, keyboard, wheel or touch input (terminal output does not count as activity), and *Lock when the window is hidden* locks on minimise.
   - Both go through the same path as a manual lock but never prompt, because nobody may be present to answer: the vault closes and open SSH sessions are disconnected; local terminals stay open.
   - *Clear clipboard on lock* empties the clipboard at lock time. It is best effort: the webview only allows clipboard writes while focused.

3. **Vault Unlocked**:
   - The SQLite database resides strictly in memory (`sqlite3_deserialize`).
   - Data is never written to disk unencrypted or placed in temporary files.
   - Changes are immediately re-encrypted and flushed to disk via `persist_vault`.

---

## 3. Settings Panel Security & Access Gates

The Settings interface organizes configurations into 7 pages, enforcing access control based on vault lock state:

### 3.1 Unrestricted Categories
- **General**: Startup view, default local shell, security options (auto-lock), backup and restore of preferences, monitoring switch, Remote Desktop mode.
- **Appearance**: Colours, terminal theme, fonts, cursor, interface zoom.
- **Terminal**: Mouse and clipboard behaviour, sessions, SSH connection options, command widget, triggers.
- **Features**: Optional feature switches.
- **Quick Access** (partly): the *Keyboard Shortcuts* card. The *Pinned Servers* and *Quick Commands* cards of the same page are replaced by an unlock prompt while locked.

### 3.2 Locked Categories (Requires Master Password)
- **Quick Access, Pinned Servers and Quick Commands cards**: pinned server names and addresses; snippets and maintenance scripts (which often contain credentials).
- **Accounts & Sync**: workspace creation, renaming and deletion, master password changes, cloud account credentials, sync endpoints, invite tokens.
- **System**: Known Hosts, Maintenance (database resets, preference clearing, server export) and the Activity Log (connection histories, timestamps, diagnostic audit logs).

The preferences backup (General > Backup & Restore) is available while locked. It contains only preferences: biometric unlock handles, the last workspace and session, pinned server ids, connection history and anything credential-like are excluded on export and refused on import.

When locked, navigating to any protected category renders the unified `LockedPage` gate. Unlocking requires entering the master password, which verifies the decryption key before access is granted.

---

## 4. Production Server Safeguards

To prevent accidental destruction of production infrastructure:
- **`PROD` Server Flag**: Servers marked as production display a permanent, high-contrast red `PROD` badge across the terminal top bar, node grid, and status displays.
- **Safe Mode Command Interception**: Common catastrophic commands (e.g. `rm -rf /`, `mkfs`, `dd`, `shutdown`, `drop database`) trigger interactive modal confirmations before transmission to the remote PTY.
- **Multi-line Paste Confirmation**: Pasting text containing multiple lines triggers a visual review drawer displaying the total line count and exact content before execution.

---

## 5. Zero-Knowledge Cloud Synchronization

SubTerm supports encrypted cloud profile synchronization:
- The cloud backend (`https://api.subterm.com` or self-hosted endpoint) **only receives and stores pre-encrypted `.subterm` blobs**.
- The master password, derived Argon2 keys, and unencrypted databases are **never sent over the network**.
- Even in the event of a cloud database breach, stored profiles cannot be read without the user's local master password.

---

## 6. Directory Traversal & Input Validation

### 6.1 SFTP & File Path Validation
All directory listing and path manipulation functions (`sftp_list_dir`, `sftp_download_file`, `sftp_upload_file`) enforce strict safety filters:
- Path separators and null bytes in file names are rejected.
- Relative traversal indicators (`..`, `../`, `..\`) are sanitized or rejected.
- Directory entry names are verified using `is_safe_dir_entry_name`.

### 6.2 Workspace Profile Validation
Profile names are sanitized using `validate_profile_name`:
- Maximum 32 characters.
- Strict alphanumeric charset plus `-` and `_`.
- Reserved device names on Windows (`CON`, `PRN`, `AUX`, `NUL`, `COM1-9`, `LPT1-9`) are rejected to prevent filesystem corruption.

---

## 7. SSH Agent Forwarding Trust Model

SubTerm supports standard SSH agent forwarding (`-A`), opt-in per server via the **Forward SSH Agent** toggle (default off). Enabling it carries the same trust implications as OpenSSH's own `-A` flag, and users should understand them before turning it on:

- **What is exposed**: while forwarding is active, any process running as your user on the **remote** server can request signing operations from your **local** agent (e.g. to authenticate onward to a third host) for as long as the session is open. The remote process never sees your private key material — only signed challenges — but it can use your identity to authenticate elsewhere for the session's duration.
- **Who to enable it for**: only servers you trust the root/admin of. A malicious or compromised admin on a forwarding-enabled server can use your forwarded agent to authenticate as you to any other host your keys are valid for, while you're connected.
- **What SubTerm does and doesn't do**: SubTerm implements forwarding as a pure byte proxy (`ssh_agent.rs`) between the server's forwarded channel and your local agent socket/pipe — it never parses, logs, or stores the ssh-agent protocol traffic, and never has access to your private key material any differently than a normal (non-forwarded) connection using agent-based auth would. This is also why forwarding works unmodified with any standard-agent-protocol backend (OpenSSH agent, Pageant, 1Password, KeePassXC, Vaultwarden) with no vendor-specific code.
- **Scope**: the setting is per-server, not global — enabling it on one node does not forward the agent on any other connection.

## 8. Trust-On-First-Use (TOFU) Host-Key Verification

SubTerm does not ship or trust any CA or fixed host-key list — every server's identity is established the same way OpenSSH's `known_hosts` works: trust the key the first time, then refuse to proceed silently if it ever changes. This is the control actually responsible for catching an SSH MITM in practice, so its exact behavior is documented here rather than left implicit.

- **First connection (unknown host)**: when `check_server_key` (`src-tauri/src/ssh_manager.rs`) sees a host:port with no matching row in `known_hosts`, it emits a `fingerprint-prompt-{session_id}` event carrying the offered key's type and fingerprint. `SessionView.tsx` renders this as a blocking modal — "The authenticity of host '…' can't be established" — showing the fingerprint for out-of-band verification. The connection stalls on a 90-second timeout waiting for the user's accept/reject; no data is exchanged over the unverified channel while it waits.
- **Returning connection (known host)**: if the offered fingerprint matches any stored row for that host:port, the connection proceeds with no prompt — logged as "Host fingerprint found in known_hosts database. Verified."
- **Key changed (likely MITM, or legitimate rotation)**: if a *different* fingerprint shows up for the same host:port **and the same key algorithm** already on file, that's treated as a change, not a new host — the modal switches to a loud warning ("This is what a man-in-the-middle attack looks like — but it can also mean the server admin rotated the key"), lists every previously-trusted fingerprint for comparison, and still requires explicit accept before proceeding. A server presenting an *additional* algorithm it didn't have before (e.g. adding ed25519 alongside an existing RSA key) is **not** treated as a change — that's normal key-rotation hygiene on the server's side, so it falls through to the ordinary first-time prompt for that algorithm instead of a false MITM alarm.
- **Storage**: accepted fingerprints live in the `known_hosts` table inside the same encrypted vault blob described in §1 — AES-256-GCM, unlocked only with the master password. There is no separate plaintext `known_hosts` file on disk the way OpenSSH keeps one; a stolen vault file is useless without the password, same as every other table in it. Rows are keyed by `(host, port, key_type)`, matching OpenSSH's own per-host-per-algorithm semantics.
- **Strict policy (optional)**: **Settings > Terminal > SSH Connection > Unknown host keys > Refuse (strict)** makes the client refuse any key that is not already on file, whether unknown or changed, without showing the prompt (`HOST_KEY_STRICT` in `ssh_manager.rs`, set through `set_host_key_policy`). It removes the chance of trusting a new key with a stray click; the first connection to a server must be made in the default Ask mode.
- **Revocation / management**: Settings → System → Known Hosts (`src/components/SettingsKnownHosts.tsx`, backed by `get_known_hosts` / `delete_known_host`) lists every trusted fingerprint with its host, port, and key type, and lets the user delete any entry directly — forcing the next connection to that host through the first-connection TOFU prompt again. This is the manual equivalent of `ssh-keygen -R <host>`.
- **Failure-closed on DB errors**: if the known-hosts lock is poisoned (a prior panic left the mutex in a bad state), the handshake is refused outright rather than silently falling back to "unknown host" — which would otherwise re-prompt the user and could mask a real key-change warning behind a plain first-time prompt.

## 8a. AI Assistant

- **Keys**: provider API keys are stored in the `api_key` column of the vault's `ai_providers` table, so they are encrypted at rest like everything else in §1. `commands/ai.rs` is the only code that reads them. It reads a key into a `Zeroizing<String>` for one request. No command returns a key: the front end only sees `hasKey`, and there is no reveal command. The table is left out of Cloud Sync, so a key stays on the device where it was entered.
- **Network**: all model traffic goes from Rust (`reqwest`, rustls). The webview only calls `ai_chat` and receives text over a `Channel`.
- **What leaves the machine**: with an online provider, the provider receives:
  - the user's messages;
  - the terminal output attached to them (the last 80 lines, or the failed block for Explain);
  - the output of every command the model runs.

  Before the first send to an endpoint that is not loopback, `.local` or a private address, the panel asks the user to confirm. It asks once per provider. Saved server passwords are never part of the context.
- **Running commands**: `ai_exec` only runs commands that the front end passes in, after one of these:
  - the user approves them in the panel (Ask);
  - they match the read-only allowlist in `src/ai/agentLoop.ts` (Auto). That list refuses redirection, command substitution, backgrounding, `sudo`/`su`, follow flags and secret-looking paths.

  Auto never skips the prompt on a production server. The model's output and tool results are labelled as data in the system prompt, but prompt injection from text on the server is still possible. The approval step is the control, not the prompt. `ai_exec` grants no new capability to the webview, which can already type into any open terminal.

## 9. Vault Format & KDF Rotation Strategy

No vault has ever shipped with anything other than `VAULT_VERSION = 1` and the single hardcoded Argon2id profile in §1.1, so nothing here is implemented yet — this is the design for the day `ARGON2_M_COST`/`T_COST`/`P_COST` need to change (a stronger recommended profile, a response to a published Argon2 weakness, etc.) without breaking every vault already on disk. Written here, in the file that already specifies the format it amends, rather than a standalone doc that could drift out of sync with it.

### 9.1 The problem

The on-disk header (§1.3) has no field for KDF parameters — they're implicit, hardcoded constants baked into the binary. `derive_key()` always uses *today's* constants. That's fine as long as the constants never change, but the moment they do, a vault written under the old constants can no longer be unlocked by deriving the key with the new ones — the derived key simply won't match what the data was encrypted under, and AES-GCM will fail closed with `[CRYPTO] DECRYPT_FAILURE`, indistinguishable from a wrong password.

Two version concepts already exist in this codebase and must not be conflated:
- **`VAULT_VERSION`** (`vault.rs`) — the *file format / crypto framing* byte in the header itself. This is what this section is about.
- **`SCHEMA_VERSION`** (`profile.rs`, `schema_meta` table) — the *logical SQL schema* (which columns/tables exist) *inside* the decrypted plaintext. Orthogonal; a KDF rotation touches neither the SQL schema nor its migration path, and vice versa.

### 9.2 Detection: a KDF profile table, not a single hardcoded set of constants

Replace the three bare `ARGON2_*_COST` constants with a small table of named, versioned profiles:

```rust
struct KdfProfile { m_cost: u32, t_cost: u32, p_cost: u32 }
const KDF_PROFILES: &[(u8, KdfProfile)] = &[
    (1, KdfProfile { m_cost: 64 * 1024, t_cost: 3, p_cost: 4 }), // today's constants, unchanged
    // (2, KdfProfile { .. })  <- added whenever a rotation is actually needed
];
const CURRENT_KDF_PROFILE: u8 = 1;
```

Bump `VAULT_VERSION` to 2 and widen the header to carry a 1-byte KDF profile ID right after the version byte (`parse_vault_blob`/`write_vault_blob` both already gate on `VAULT_VERSION`, so this is the natural place to add it — see §1.3's offset table for exactly where). A v1 header (no profile byte) implicitly means profile `1`; a v2+ header's byte says which profile to use. `parse_vault_blob` keeps its existing fail-closed behavior for any version it doesn't recognize (`UNSUPPORTED_VERSION`) — same pattern already used for `SCHEMA_AHEAD_OF_BINARY`, so a vault written by a newer binary never gets silently mis-decrypted by an older one.

This means unlock becomes: read the version/profile byte(s) → look up the matching `KdfProfile` (old or new) → derive the key with *those* params, never today's. No vault ever needs its password re-entered just because the binary shipped new default params.

### 9.3 Forward migration: lazy re-encrypt on next successful unlock

Exactly the approach this TODO item names, and it falls out naturally from the existing save path:

1. Unlock proceeds as in §9.2 — decrypt with whatever profile the vault's header says, not the current default. This is the step that proves the password is correct and the plaintext is fully recovered in memory, before anything is touched on disk.
2. If the vault's stored profile ID is older than `CURRENT_KDF_PROFILE`, don't do anything special synchronously — just let the *next* `save_vault_internal` call (which already fires after essentially every mutation, and could additionally be forced once right after a successful unlock) write the vault back out using `CURRENT_KDF_PROFILE` and the new header format. `save_vault_blocking`'s existing tmp-write → `fsync` → atomic `rename` sequence doesn't change at all — it already treats "which bytes to write" as an opaque blob from `write_vault_blob`, so rotating the KDF profile is purely a change to what gets fed into that function, not a new write path.
3. **No data-loss window**: the original on-disk file is never deleted or truncated until the atomically-renamed replacement is fully written and fsynced. If the app crashes or loses power between step 1 and step 2, the next launch just repeats step 1 against the *still-intact* old-profile file and retries the migration — not a partial, not a corrupt vault, just a deferred rotation. This is the same crash-safety property `save_vault_blocking` already provides for every ordinary save, extended to profile changes for free.
4. The user never sees a password prompt, a progress bar, or any indication a migration happened — it's the same "silent background upgrade" posture this app already uses for schema migrations (§6.2's `ADD COLUMN` pattern) and SSH host-key algorithm additions (§8).

### 9.4 What does NOT need to change

- **The per-entity sync DEK** (`get_or_create_dek`, stored in `sync_meta` inside the vault) is independent of the vault's own KDF — it's a random 256-bit key, not password-derived. Rotating the vault's Argon2 profile has no effect on it, and vice versa.
- **The master password itself.** A KDF profile rotation changes how the *existing* password is stretched into a key, not the password. Users keep typing the same password through a rotation; only an explicit "Change master password" action (already a separate code path) issues a new salt.
- **Cloud-restored profiles** go through the same unlock path as a local vault once the encrypted blob is downloaded, so §9.2's detection applies identically — no separate case needed for the cloud-sync flow.

### 9.5 Why not eager (forced) migration instead

A forced "every vault gets rewritten the moment a new binary opens it" approach was considered and rejected: it would make the very first unlock after an update noticeably slower (re-serializing and re-encrypting the whole SQLite blob is already the expensive part of every save) for zero user-visible benefit over the lazy approach, since the lazy version converges to the same end state on the very next normal save anyway — which for an actively-used profile is typically seconds to minutes later.
