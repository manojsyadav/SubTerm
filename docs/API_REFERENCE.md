# SubTerm Tauri IPC & Command API Reference

This document provides a technical reference for the main Tauri IPC commands registered in `subterm_lib::run()` via `tauri::generate_handler![]` and invoked by the frontend via `@tauri-apps/api/core::invoke`. It is not exhaustive (about 230 commands are registered); the `generate_handler![]` list in `src-tauri/src/lib.rs` is the authoritative catalog, with each command in its `src-tauri/src/commands/` module.

---

## 1. Vault & Workspace Profile Commands

### `check_db_exists`
- **Description**: Verifies whether an active profile or default vault exists on disk.
- **Input Arguments**: None.
- **Return Type**: `Result<bool, String>`

### `setup_master_db`
- **Description**: Initializes or unlocks the in-memory SQLite database from an encrypted `.subterm` profile using the supplied master password.
- **Input Arguments**:
  ```typescript
  { password: string }
  ```
- **Return Type**: `Result<(), String>`
- **Errors**: `[CRYPTO] DECRYPT_FAILURE` if master password is invalid or ciphertext is corrupted.

### `persist_vault`
- **Description**: Serializes, compresses (Zstandard), encrypts (AES-256-GCM), and writes the current in-memory SQLite state to the active profile on disk.
- **Input Arguments**: None.
- **Return Type**: `Result<(), String>`

### `list_profiles`
- **Description**: Lists all local workspace profiles found in the profile data directory.
- **Input Arguments**: None.
- **Return Type**: `Result<Vec<String>, String>`

### `select_profile`
- **Description**: Sets the active profile and attempts to unlock it using the provided password.
- **Input Arguments**:
  ```typescript
  { name: string, password: string }
  ```
- **Return Type**: `Result<(), String>`

### `create_profile`
- **Description**: Creates a new profile with an empty schema, encrypted with the specified password.
- **Input Arguments**:
  ```typescript
  { name: string, password: string }
  ```
- **Return Type**: `Result<(), String>`

### `delete_profile`
- **Description**: Permanently removes a profile file from disk. Protected behind vault unlock.
- **Input Arguments**:
  ```typescript
  { name: string }
  ```
- **Return Type**: `Result<(), String>`

### `rename_profile`
- **Description**: Renames an existing profile file on disk.
- **Input Arguments**:
  ```typescript
  { oldName: string, newName: string }
  ```
- **Return Type**: `Result<(), String>`

### `change_master_password`
- **Description**: Re-keys the in-memory database with a new Argon2id salt/key and writes the newly encrypted blob to disk.
- **Input Arguments**:
  ```typescript
  { oldPassword: string, newPassword: string }
  ```
- **Return Type**: `Result<(), String>`

### `export_profile`
- **Description**: Exports the encrypted profile binary blob to a destination path selected by the user.
- **Input Arguments**:
  ```typescript
  { name: string, destPath: string }
  ```
- **Return Type**: `Result<(), String>`

### `import_profile_save`
- **Description**: Validates and saves an imported `.subterm` / `.submarine` file into the application profile directory.
- **Input Arguments**:
  ```typescript
  { name: string, sourcePath: string }
  ```
- **Return Type**: `Result<(), String>`

### `get_known_hosts`
- **Description**: Retrieves all trusted host keys, key algorithms, and fingerprints stored in the active profile's `known_hosts` database.
- **Input Arguments**: None.
- **Return Type**: `Result<Vec<KnownHostRecord>, String>`
  ```typescript
  interface KnownHostRecord {
    id: number;
    host: string;
    port: number;
    fingerprint: string;
    key_type: string;
  }
  ```

### `delete_known_host`
- **Description**: Deletes a specific trusted host key entry by ID and persists the updated vault.
- **Input Arguments**:
  ```typescript
  { id: number }
  ```
- **Return Type**: `Result<(), String>`

### `clear_all_known_hosts`
- **Description**: Clears all trusted host fingerprints from the active profile's `known_hosts` table and persists the vault.
- **Input Arguments**: None.
- **Return Type**: `Result<(), String>`

---

## 2. Server & Infrastructure Node Management

### `get_servers`
- **Description**: Retrieves all server records from the active vault.
- **Input Arguments**: None.
- **Return Type**: `Result<Vec<ServerNode>, String>`

### `add_server`
- **Description**: Adds a new server entry to the database and commits the vault.
- **Input Arguments**:
  ```typescript
  { server: NewServerPayload }
  ```
  `NewServerPayload` includes `forwardAgent?: boolean` — enables SSH agent forwarding (`-A`) on every connection to this server (see `docs/SECURITY.md` §7). Defaults to `false`.
- **Return Type**: `Result<i64, String>` (Returns auto-generated Server ID)

### `edit_server`
- **Description**: Updates fields of an existing server.
- **Input Arguments**:
  ```typescript
  { id: number, server: UpdateServerPayload }
  ```
  `UpdateServerPayload` includes the same `forwardAgent?: boolean` field as `add_server`.
- **Return Type**: `Result<(), String>`

### `delete_server`
- **Description**: Removes a server and cascades deletion to associated monitor configurations.
- **Input Arguments**:
  ```typescript
  { id: number }
  ```
- **Return Type**: `Result<(), String>`

### `set_server_is_production`
- **Description**: Sets the production safety flag on a server.
- **Input Arguments**:
  ```typescript
  { id: number, isProduction: boolean }
  ```
- **Return Type**: `Result<(), String>`

### `reveal_server_password`
- **Description**: Unmasks the plaintext password for a server. Protected behind vault unlock.
- **Input Arguments**:
  ```typescript
  { id: number }
  ```
- **Return Type**: `Result<String, String>`

### `clone_server`
- **Description**: Duplicates a server definition under a new name.
- **Input Arguments**:
  ```typescript
  { id: number, newName: string }
  ```
- **Return Type**: `Result<i64, String>`

### `reorder_servers`
- **Description**: Updates manual ordering positions for server list presentation.
- **Input Arguments**:
  ```typescript
  { orderedIds: number[] }
  ```
- **Return Type**: `Result<(), String>`

---

### `resolve_ssh_target`
- **Description**: Resolves what was typed in a local shell (`ssh [-p N] [-i key] [user@]host`) against `~/.ssh/config`. Command-line values win; the config fills alias to HostName, User, Port and IdentityFile. Returns an error for hosts that use `ProxyJump`. The identity file is read only when it exists and is not passphrase-protected.
- **Input Arguments**:
  ```typescript
  { host: string; username?: string | null; port?: number | null; identityFile?: string | null }
  ```
- **Return Type**: `Result<{ host: string; port: number; username: string; private_key: string | null; user_explicit: boolean }, String>`. `user_explicit` is false when `username` is only the local-account fallback.

### `find_saved_servers`
- **Description**: Saved SSH servers a typed target refers to: same port, and host equal to the resolved host or the typed alias (or alias equal to the node name), case-insensitive. When `username` is given the node's user must match unless the node stores none. RDP nodes are excluded.
- **Input Arguments**:
  ```typescript
  { host: string; alias?: string | null; port: number; username?: string | null }
  ```
- **Return Type**: `Result<{ id: number; name: string; host: string; port: number; username: string }[], String>`

### `set_host_key_policy`
- **Description**: Switches between asking about unknown host keys (default) and refusing every key that is not already trusted (`strict`). A key that has changed is refused too in strict mode. Applies to the next connection.
- **Input Arguments**: `{ strict: boolean }`
- **Return Type**: `Result<(), String>`

### `cmd_history_prune`
- **Description**: Applies the command-history limits: keeps at most `max_entries` newest rows (clamped to 50 to 50,000) and drops rows older than `max_age_days` (0 = no age limit). `cmd_history_add` takes an optional `max_entries` for the same cap on every insert.
- **Input Arguments**: `{ maxEntries: number; maxAgeDays: number }`
- **Return Type**: `Result<(), String>`

### `get_autostart` / `set_autostart`
- **Description**: Read or change whether SubTerm launches at sign-in, through `tauri-plugin-autostart` (Windows Run key, macOS LaunchAgent, Linux autostart entry). The OS owns the state, so it is not stored in preferences. No-op or error on mobile.
- **Input Arguments**: `get_autostart`: none. `set_autostart`: `{ enabled: boolean }`
- **Return Type**: `Result<bool, String>` / `Result<(), String>`

### `set_ssh_connect_timeout`
- **Description**: Sets how long the initial TCP connect (direct, SOCKS5 or HTTP proxy) may take. Clamped to 3 to 120 seconds; applies to the next connection.
- **Input Arguments**: `{ secs: number }`
- **Return Type**: `Result<(), String>`

### `set_ui_zoom`
- **Description**: Sets the webview zoom for the calling window (Settings > Appearance > Interface Zoom). Clamped to 0.5 to 2.0; a no-op on mobile.
- **Input Arguments**: `{ factor: number }` (1.0 = 100%)
- **Return Type**: `Result<(), String>`

## 3. SSH Credentials & Private Keys

### `get_credentials`
- **Description**: Returns all reusable credentials stored in the vault.
- **Return Type**: `Result<Vec<CredentialRecord>, String>`

### `add_credential` / `edit_credential` / `delete_credential`
- **Description**: CRUD operations for reusable username/password/key credentials.

### `reveal_credential_password`
- **Description**: Returns the plaintext password for a credential ID.

### `get_ssh_keys` / `add_ssh_key` / `edit_ssh_key` / `delete_ssh_key`
- **Description**: CRUD operations for SSH private/public key pairs stored in the vault.

### `generate_ssh_key`
- **Description**: Generates a new Ed25519 or RSA-4096 key pair in memory with optional passphrase.
- **Input Arguments**:
  ```typescript
  { keyType: "ed25519" | "rsa", bits?: number, passphrase?: string }
  ```
- **Return Type**: `Result<{ publicKey: string, privateKey: string }, String>`

---

## 4. SSH Session Lifecycle

### `initiate_connection`
- **Description**: Establishes an asynchronous SSH connection to a remote host. Supports direct host, jump hosts (`ProxyJump`), password auth, key auth, and interactive keyboard auth.
- **Input Arguments**:
  ```typescript
  {
    sessionId: string,
    host: string,
    port: number,
    username: string,
    auth: AuthConfig,
    jumpHostId?: number
  }
  ```
- **Return Type**: `Result<ConnectionStatus, String>`

### `verify_fingerprint_response`
- **Description**: Submits the user's accept/reject response when an unknown host key fingerprint is presented.
- **Input Arguments**:
  ```typescript
  { sessionId: string, accepted: boolean }
  ```
- **Return Type**: `Result<(), String>`

### `submit_kbi_response`
- **Description**: Sends keyboard-interactive responses (e.g. 2FA/MFA OTP token or PAM prompt).
- **Input Arguments**:
  ```typescript
  { sessionId: string, responses: string[] }
  ```
- **Return Type**: `Result<(), String>`

### `disconnect_session`
- **Description**: Closes all channels, terminates associated tunnels and mirrors, and tears down the SSH connection.
- **Input Arguments**:
  ```typescript
  { sessionId: string }
  ```
- **Return Type**: `Result<(), String>`

---

## 5. Terminal Operations

### `open_terminal`
- **Description**: Opens an interactive remote PTY shell over an existing SSH session. `channel` is a Tauri 2 binary `Channel` — PTY output streams back as raw `ArrayBuffer` messages on it instead of a `terminal-output-{id}` event (see `subscribe_terminal_output` below for multi-viewer fan-out).
- **Input Arguments**:
  ```typescript
  {
    sessionId: string,
    terminalId: string,
    cols: number,
    rows: number,
    channel: Channel<ArrayBuffer>
  }
  ```
- **Return Type**: `Result<(), String>`

### `open_local_terminal`
- **Description**: Spawns a native local PTY process (PowerShell/CMD on Windows, Bash/Zsh on Unix). Same binary `channel` output convention as `open_terminal`.
- **Input Arguments**:
  ```typescript
  {
    terminalId: string,
    cols: number,
    rows: number,
    shellPath?: string,
    cwd?: string,
    channel: Channel<ArrayBuffer>
  }
  ```
- **Return Type**: `Result<(), String>`

### `subscribe_terminal_output`
- **Description**: Registers an additional output `Channel` for a `terminal_id` without opening a new PTY — used by attach-only split-pane/Fleet-Wall viewers that watch a terminal another `TerminalView` instance already owns. Deduped by channel id, so a PTY owner re-invoking `open_terminal` on reconnect with the same JS `Channel` instance doesn't need this command.
- **Input Arguments**:
  ```typescript
  { terminalId: string, channel: Channel<ArrayBuffer> }
  ```
- **Return Type**: `Result<(), String>`

### `get_available_local_shells`
- **Description**: Detects installed system shells on the host machine.
- **Return Type**: `Result<Vec<LocalShellInfo>, String>`

### `write_terminal_data`
- **Description**: Sends input keystrokes or pasted text into the PTY stream.
- **Input Arguments**:
  ```typescript
  { terminalId: string, data: string }
  ```
- **Return Type**: `Result<(), String>`

### `write_saved_password`
- **Description**: Looks up the session's saved SSH password (the same map `docker.rs`'s silent-sudo-elevation path reads) and writes it, followed by a newline, straight into the PTY's input channel. Backs the terminal context menu's "Paste Saved Password" action for interactive `[sudo] password for user:` prompts. The plaintext password never crosses into the frontend — this command returns only whether a password was found and written.
- **Input Arguments**:
  ```typescript
  { sessionId: string, terminalId: string }
  ```
- **Return Type**: `Result<bool, String>`

### `resize_terminal`
- **Description**: Emits a window-change event to adjust PTY rows and columns.
- **Input Arguments**:
  ```typescript
  { terminalId: string, cols: number, rows: number }
  ```
- **Return Type**: `Result<(), String>`

### `close_terminal`
- **Description**: Terminates the local PTY process or closes the remote SSH terminal channel.
- **Input Arguments**:
  ```typescript
  { terminalId: string }
  ```
- **Return Type**: `Result<(), String>`

---

## 6. SFTP File Operations

All remote path operations validate path safety against directory traversal vulnerabilities.

| Command | Arguments | Return Type | Description |
|---|---|---|---|
| `sftp_list_dir` | `{ sessionId, path }` | `Result<Vec<FileEntry>, String>` | Lists remote folder entries |
| `sftp_create_dir` | `{ sessionId, path }` | `Result<(), String>` | Creates remote directory |
| `sftp_remove_file` | `{ sessionId, path }` | `Result<(), String>` | Deletes remote file |
| `sftp_remove_dir` | `{ sessionId, path }` | `Result<(), String>` | Deletes remote directory recursively |
| `sftp_rename` | `{ sessionId, oldPath, newPath }` | `Result<(), String>` | Renames/moves remote path |
| `sftp_set_permissions` | `{ sessionId, path, mode }` | `Result<(), String>` | Chmod remote file (`mode: u32`) |
| `sftp_download_file` | `{ sessionId, remotePath, localPath, transferId }` | `Result<(), String>` | Downloads remote file |
| `sftp_upload_file` | `{ sessionId, localPath, remotePath, transferId }` | `Result<(), String>` | Uploads local file |
| `sftp_cancel_transfer` | `{ transferId }` | `Result<(), String>` | Aborts in-flight transfer |
| `sftp_read_file_text` | `{ sessionId, path, maxBytes? }` | `Result<String, String>` | Reads remote file content into text editor |
| `sftp_write_file_text` | `{ sessionId, path, content }` | `Result<(), String>` | Saves modified text back to remote path |

---

## 7. Port Forwarding (Tunnels)

### `start_tunnel`
- **Description**: Initiates a local, remote, or dynamic tunnel.
- **Input Arguments**:
  ```typescript
  {
    sessionId: string,
    spec: {
      kind: "local" | "remote" | "dynamic",
      local: string,    // e.g. "127.0.0.1:8080"
      remote?: string   // e.g. "127.0.0.1:80" (omitted for dynamic)
    }
  }
  ```
- **Return Type**: `Result<string, String>` (Returns unique `tunnelId`)

### `stop_tunnel`
- **Description**: Closes the specified listener and all active forwarding streams.
- **Input Arguments**:
  ```typescript
  { tunnelId: string }
  ```
- **Return Type**: `Result<(), String>`

### `list_tunnels`
- **Description**: Returns all running and configured tunnels for a session.
- **Input Arguments**:
  ```typescript
  { sessionId: string }
  ```
- **Return Type**: `Result<Vec<ActiveTunnelInfo>, String>`

---

## 8. Docker Operations (Over Remote SSH)

Commands in this module interact with the remote Docker daemon via SSH exec:

- `ssh_docker_containers({ sessionId, all: boolean })`: Returns running or all containers.
- `ssh_docker_container_action({ sessionId, containerId, action: "start"|"stop"|"restart"|"pause"|"unpause" })`: Executes container lifecycle actions.
- `ssh_docker_stats({ sessionId, containerId })`: Fetches live CPU/Memory utilization.
- `ssh_docker_logs_start({ sessionId, containerId, streamId, tail?: number })`: Begins background log streaming.
- `ssh_docker_logs_stop({ streamId })`: Stops streaming container logs.
- `ssh_docker_images_list({ sessionId })`: Lists Docker images on remote host.
- `ssh_docker_volumes_list({ sessionId })`: Lists Docker volumes.
- `ssh_docker_compose_list({ sessionId })`: Discovers running Docker Compose stacks.
- `ssh_docker_compose_action({ sessionId, composeFile, action })`: Controls Compose stacks (`up`, `down`, `restart`).

---

## 9. Background Monitoring Commands

- `monitor_list()`: Returns all configured server monitors.
- `monitor_add({ nodeId, metrics: string[] })`: Attaches monitoring poller to server ID.
- `monitor_remove({ nodeId })`: Drops monitoring poller.
- `monitor_resume({ nodeId })` / `monitor_pause({ nodeId })`: Toggles active polling.
- `monitor_get_settings()` / `monitor_set_settings({ settings })`: Configures polling intervals and CPU/RAM alert thresholds.

---

## 10. Cloud Sync Commands

- `cloud_set_api_base({ url: string })`: Configures the remote cloud backend URL (stored in memory; defaults to `https://api.subterm.com`).
- `cloud_status()`: Checks current auth status, user email, and last sync timestamp.
- `cloud_signup({ email: string })`: Requests registration verification link.
- `cloud_login({ email: string, password: string })`: Logs in and persists `cloud_token.json`.
- `cloud_logout()`: Clears stored bearer token.
- `sync_now()`: Triggers bidirectional sync of active encrypted profile with cloud server.
- `force_push_profile({ name: string })`: Force-uploads local encrypted profile blob, overwriting cloud copy.
- `profile_sync_stats()`: Read-only local + cloud diff snapshot (in-sync/needs-push/needs-pull counts, recent edits, and up to 20 named out-of-sync servers with their uuid and push/pull direction).
- `sync_conflict_diff({ uuid: string })`: Decrypts and pretty-prints the local and cloud copies of one entity (by uuid) for a read-only side-by-side diff — secrets (`password`/`private_key`/`passphrase`) are redacted. Does not change the Last-Write-Wins merge outcome; visibility only.

---

## 11. Tauri Event Streams (Rust -> Frontend)

Events emitted from Rust to the Webview via `app.emit(...)`:

| Event Name | Payload Format | Description |
|---|---|---|
| `terminal-data-{terminalId}` | Base64 or Hex encoded batch string | Coalesced PTY terminal stdout |
| `terminal-exit-{terminalId}` | `{ code: number }` | Terminal process exit notification |
| `transfer-progress-{transferId}` | `{ bytesTransferred: number, totalBytes: number, speed: number }` | SFTP transfer progress updates |
| `docker-log-{streamId}` | `{ line: string }` | Live Docker container log output line |
| `monitor-pulse` | `{ nodeId: number, cpu: number, mem: number, disk: number, load: number }` | Real-time system health metrics |
| `fingerprint-request` | `{ sessionId: string, fingerprint: string, keyType: string }` | Host key verification prompt |
| `kbi-request` | `{ sessionId: string, prompts: string[] }` | Keyboard-interactive 2FA prompt |
| `system-resume` | *(none)* | App-wide, not session-scoped. Fired when the resume detector notices a sleep/resume cycle (see `docs/ARCHITECTURE.md` §4.9). Every open session reacts independently based on its own reconnect state. |
| `network-changed` | *(none)* | App-wide, not session-scoped. Fired on a detected network interface change (Wi-Fi roam, VPN toggle), debounced to 1/sec. Same consumption pattern as `system-resume`. |

---

## 12. Remote Desktop & File Export Commands

| Command | Arguments | Return Type | Description |
|---|---|---|---|
| `launch_rdp` | `{ id }` | `Result<(), String>` | Opens saved server `id` in the OS Remote Desktop client (desktop only) |
| `rdp_connect` | `{ id, password, width, height, audio?, onEvent }` | `Result<String, String>` (session id) | Starts an embedded session in a `subterm-rdp-helper` process. `onEvent` is a binary `Channel`: first byte = kind (1 connected, 2 update, 3 error, 4 closed, 5 certificate question with JSON `{sessionId, fingerprint, mismatch}`), rest = payload (see `src-tauri/rdp-helper/src/wire.rs`). Desktop only |
| `rdp_answer_certificate` | `{ sessionId, trust }` | `Result<(), String>` | Answers a kind-5 question; `trust` pins the certificate for that host:port |
| `rdp_send_input` | `{ sessionId, data: number[] }` | `Result<(), String>` | Forwards already-encoded input events to the helper |
| `rdp_disconnect` | `{ sessionId }` | `Result<(), String>` | Logs off and ends the helper process |
| `save_text_file` / `save_binary_file` | `{ content, filename, extension }` / raw body with `x-filename`, `x-extension` headers | `Result<Option<String>, String>` | Save dialog for exports (buffer `.log`, `.cast`, SVG, GIF); `None` when cancelled |
| `recordings_dir` | none | `Result<String, String>` | `<app data>/recordings`, created on demand |
| `save_recording` | `{ content, filename }` | `Result<String, String>` | Writes an automatic recording into `recordings_dir` without a dialog |
| `save_temp_file` | raw body, `x-filename` header | `Result<String, String>` | Writes a pasted image to `<temp>/subterm-paste/` and returns the path |
| `get_synced_shortcuts` / `set_synced_shortcuts` | `{ platform: "mac" \| "pc" }` / `{ platform, map }` | `Result<Record<string,string>, String>` / `Result<(), String>` | Customised keyboard shortcuts stored in the profile vault (synced) |

---

## 13. AI Assistant Commands

These commands are in `src-tauri/src/commands/ai.rs`. Providers live in the vault table `ai_providers`, which is not synced. `kind` is `"openai"` (any OpenAI-compatible `/chat/completions`, including Ollama at `http://localhost:11434/v1`) or `"anthropic"`. The agent loop runs in `src/ai/agentLoop.ts`.

| Command | Arguments | Return Type | Description |
|---|---|---|---|
| `ai_list_providers` | none | `Result<{ id, name, kind, baseUrl, model, hasKey }[], String>` | Lists saved providers. The key is never returned, only `hasKey` |
| `ai_save_provider` | `{ provider: { id?, name, kind, baseUrl, model, apiKey? } }` | `Result<number, String>` (id) | Inserts, or updates when `id` is set. `apiKey`: `null` keeps the stored key, `""` clears it |
| `ai_delete_provider` | `{ id }` | `Result<(), String>` | Removes the provider and its key |
| `ai_list_models` | `{ id }` | `Result<string[], String>` | `GET {baseUrl}/models`, sorted ids |
| `ai_chat` | `{ id, system, messages: ChatMsg[], tools: { name, description, parameters }[], onText: Channel<string>, requestId? }` | `Result<ChatMsg, String>` | One streamed assistant turn. Text deltas arrive on `onText`. The return value is the whole message, including `toolCalls: { id, name, arguments }[]` (`arguments` is raw JSON text). `ChatMsg` is `{ role: "user" \| "assistant" \| "tool", content, toolCalls?, toolCallId? }`. Rejects with `[AI] STOPPED` when cancelled |
| `ai_cancel` | `{ requestId }` | `()` | Stops the `ai_chat` started with that `requestId` and closes its HTTP request. Unknown ids are ignored |
| `ai_exec` | `{ sessionId: string \| null, command, cwd?, shell?, timeoutSecs? }` | `Result<{ stdout, stderr, exitCode, truncated, timedOut }, String>` | Runs one approved command on a new channel of SSH session `sessionId`, or locally when it is `null`, in `shell` (a local shell name as for `open_local_terminal`, or the default; desktop only). PowerShell gets `-NoProfile -NonInteractive -Command`, cmd gets `/D /S /C` raw, WSL gets `-e sh -c`, anything else gets `-c`. The default timeout is 60 s and the maximum 600 s. Each stream keeps its last 16 KB |
