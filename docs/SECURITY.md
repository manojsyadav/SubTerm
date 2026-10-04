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
0x00             4                Magic Bytes        ASCII "SUBT" (0x53 0x55 0x42 0x54)
0x04             1                Vault Version      0x02
0x05             16               Salt               Cryptographic random salt
0x15             12               Nonce / IV         AES-GCM initialization vector
0x21             Variable         Ciphertext + Tag   Encrypted Zstd-compressed SQLite DB
```

---

## 2. In-Memory Lifecycle & Lock States

1. **Vault Locked**:
   - The SQLite database connection is closed.
   - The derived master key buffer is zeroed out and removed from memory (`DbState.master_key = None`).
   - The session password is removed from memory (`DbState.session_password = None`).
   - No credentials, server passwords, or SSH private keys remain unencrypted in memory.

2. **Vault Unlocked**:
   - The SQLite database resides strictly in memory (`sqlite3_deserialize`).
   - Data is never written to disk unencrypted or placed in temporary files.
   - Changes are immediately re-encrypted and flushed to disk via `persist_vault`.

---

## 3. Settings Panel Security & Access Gates

The Settings interface organizes configurations into 10 categories, enforcing access control based on vault lock state:

### 3.1 Unrestricted Categories
- **Appearance**: Color themes, accent colors, zoom levels.
- **Terminal**: Font family, font size, scrollback buffer, command widget visibility.
- **Monitoring**: Host resource polling toggles and intervals.
- **Keyboard Shortcuts**: User keybinding preferences.

### 3.2 Locked Categories (Requires Master Password)
- **Quick Access Servers**: Displays pinned server names and addresses.
- **Cloud & Sync**: Cloud account credentials, sync endpoints, invite tokens.
- **Profiles & Vault**: Creation, renaming, deletion of workspaces; master password modification.
- **Quick Commands**: Snippets and pre-configured maintenance scripts (which often contain credentials).
- **Maintenance**: Database resets and preference clearing.
- **Activity Log**: Connection histories, timestamps, and diagnostic audit logs.

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
- **Revocation / management**: Settings → Known Hosts (`src/components/SettingsKnownHosts.tsx`, backed by `get_known_hosts` / `delete_known_host`) lists every trusted fingerprint with its host, port, and key type, and lets the user delete any entry directly — forcing the next connection to that host through the first-connection TOFU prompt again. This is the manual equivalent of `ssh-keygen -R <host>`.
- **Failure-closed on DB errors**: if the known-hosts lock is poisoned (a prior panic left the mutex in a bad state), the handshake is refused outright rather than silently falling back to "unknown host" — which would otherwise re-prompt the user and could mask a real key-change warning behind a plain first-time prompt.
