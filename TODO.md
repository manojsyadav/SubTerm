# SubTerm Backlog & TODO Roadmap

This document tracks active development tasks, pending architectural optimizations, and planned features for future SubTerm releases.

### Legend

| Label | Meaning |
|---|---|
| 🔴 **P1** | High priority — user-visible correctness, major UX gap, or competitive blocker |
| 🟡 **P2** | Medium priority — valuable improvement, ships when capacity allows |
| 🟢 **P3** | Low priority — nice-to-have, exploratory, or long-horizon feature |
| **S** (Small) | < 1 day — isolated change, minimal risk |
| **M** (Medium) | 1–3 days — self-contained feature, a few files |
| **L** (Large) | 3–7 days — cross-cutting change, multiple subsystems |
| **XL** (X-Large) | 1–3 weeks — new protocol, platform target, or major architecture shift |

---

## 🏗️ Engineering Health: Architecture, Testing & CI

- [x] 🔴 **P1 · L** — **Finish `lib.rs` Modularization (Phase 6 Follow-Through)** — ✅ Done
  - `src-tauri/src/lib.rs` shrank from 7,385 → 419 lines across 7 incremental commits: `vault.rs` (crypto primitives), `commands/diagnostics.rs`, `commands/monitor_settings.rs`, `commands/mirror.rs`, `commands/sync.rs` (HLC engine + sharing/escrow, largest single move), `commands/profile.rs` (profile lifecycle + schema bootstrap), `commands/connection.rs` (SSH connection establishment, health watcher, error classification).
  - `lib.rs` now holds only imports, `DbState`, and the Tauri builder/`invoke_handler![]` in `run()` — every command domain lives in its own `commands/*.rs` module.
  - `commands/sftp.rs` (3,048 lines) was **not** split further — out of scope for this pass; revisit separately if it keeps growing.
  - **Validation:** `cargo check`/`cargo build` clean after every step; all 45 existing unit tests passed unchanged throughout; no behavior change.

- [ ] 🔴 **P1 · M** — **Finish `DesktopApp.tsx` Decomposition**
  - `src/hooks/useSessionManager.ts`, `useWallManager.ts`, and `useProfileVault.ts` already exist and are wired in, but [`src/DesktopApp.tsx`](file:///d:/REPO/SubTerm/src/DesktopApp.tsx) is still 3,137 lines — the root component itself was never trimmed after the hook extraction.
  - Move remaining view-wiring/layout logic out of the root component; target was originally <400 lines.
  - **Validation:** `npm run typecheck` passes; all tabs, wall, and vault operations behave identically.

- [ ] 🔴 **P1 · L** — **Add an Automated Test Suite (Currently Zero Tests)**
  - No test files exist anywhere in the repo for either the Rust backend or the frontend.
  - Minimum viable coverage: vault encrypt/decrypt round-trip (Argon2id + AES-256-GCM), KDF parameter regression test, mirror sync diff/reconciliation logic, and SFTP path-handling edge cases.
  - **Validation:** `cargo test` in `src-tauri` and a frontend test runner (e.g. Vitest) both pass in CI.

- [ ] 🔴 **P1 · M** — **Wire Test/Lint Gates into CI**
  - [`.github/workflows/release.yml`](file:///d:/REPO/SubTerm/.github/workflows/release.yml) only builds and packages release artifacts — there is no `cargo test`, `cargo clippy`, `tsc --noEmit`, or lint step gating merges.
  - Add a separate `ci.yml` workflow that runs on PRs: `cargo clippy -- -D warnings`, `cargo test`, `npm run typecheck`, and lint.
  - **Validation:** A PR with a deliberate type error or failing test is blocked from merging.

- [ ] 🟡 **P2 · S** — **Add ESLint Configuration**
  - No `.eslintrc*` and no lint script exist in `package.json`, so there's nothing catching regressions in the frontend.
  - Add a baseline config (`@typescript-eslint` recommended + React hooks rules) and a `lint` script.
  - **Validation:** `npm run lint` runs clean on current code or produces a tracked baseline of existing violations.

- [ ] 🟡 **P2 · L** — **Triage `.unwrap()` / `.expect()` in the Rust Backend**
  - 219 occurrences across `src-tauri/src` (168 in `lib.rs` alone, 23 in `tunnel.rs`, 15 in `identity.rs`). A panic in any of these can crash the whole Tauri process, killing every open SSH session, not just one request.
  - Prioritize paths touching untrusted network input (SSH packet/channel handling) and on-disk vault/config parsing — replace with `Result` propagation and surfaced errors.
  - **Validation:** `grep -rc unwrap\|expect` count trends down in connection/vault-handling modules; fuzzed/malformed inputs no longer crash the app.

- [ ] 🟢 **P3 · L** — **Reduce `any` / `as any` in the TypeScript Frontend**
  - 239 occurrences across `src/**/*.tsx`/`*.ts` with no lint rule currently flagging new ones.
  - Backfill proper types incrementally, starting with session/file-path handling code where a mistyped value has real consequences.
  - **Validation:** `grep -rc ": any\|as any"` count trends down; new PRs can't introduce more once ESLint's `no-explicit-any` is enabled.

- [ ] 🟡 **P2 · S** — **Reconcile `russh` Version Drift**
  - README advertises `russh` 0.45+ but [`src-tauri/Cargo.toml`](file:///d:/REPO/SubTerm/src-tauri/Cargo.toml) pins `russh = "0.40.2"` / `russh-keys = "0.40.1"`. Either the doc is aspirational or the dependency is behind on releases that may include SSH protocol fixes.
  - Audit changelog between 0.40.2 and latest, upgrade if safe, and correct whichever side (doc or dependency) is wrong.
  - **Validation:** `cargo update -p russh` (or doc correction) reviewed; `cargo test` / manual SSH connect still passes.

- [ ] 🟢 **P3 · S** — **Document TOFU Host-Key Verification UX in `SECURITY.md`**
  - `docs/SECURITY.md` covers the vault crypto spec thoroughly but doesn't document the first-connect trust-on-first-use host key flow, which is the control most responsible for actually preventing MITM in practice.
  - Add a section describing fingerprint prompt UX, storage location, and revocation flow (ties into the existing "Known Hosts" settings category).
  - **Validation:** Doc review only; no code change required unless a gap in the actual flow is found while writing it.

- [ ] 🟢 **P3 · M** — **Vault Format/KDF Rotation Strategy for Deployed Users**
  - No documented process exists for rotating Argon2id parameters or the vault binary format for users who already have `v0x02` vaults on disk.
  - Define a migration path (e.g. lazy re-encrypt on next unlock when params change) before it's needed under pressure.
  - **Validation:** Design doc covers old-vault detection and forward migration without data loss; no immediate code required.

---

## ⚡ Core Performance & IPC Optimizations

- [ ] 🔴 **P1 · M** — **High-Throughput IPC: Tauri 2 Binary Channels**
  - Migrate terminal byte stream dispatch from base64 JSON strings over `app.emit` (`emit_terminal_batch`) to zero-copy Tauri 2 `ipc::Channel<bytes>`.
  - Further reduces CPU overhead and eliminates string serialization latency during saturated terminal outputs (`cat /dev/urandom`, `docker logs -f`).

- [ ] 🟡 **P2 · L** — **SFTP Pipelined Transfers & Concurrent Chunking**
  - Implement multi-stream concurrent byte-range chunking for large single-file transfers across parallel SFTP channels.
  - Automatically saturate high-bandwidth, high-latency WAN links beyond the current 256 KiB sequential pipelined stream.

- [ ] 🟢 **P3 · M** — **Server List Virtualization**
  - Integrate windowed list/grid virtualization (e.g. `@tanstack/react-virtual` or `react-window`) into [`src/components/NodeGrid.tsx`](file:///d:/REPO/SubTerm/src/components/NodeGrid.tsx).
  - Ensures buttery-smooth 60 FPS scrolling and low DOM memory usage for fleets with 500+ saved nodes.

---

## 🚀 Strategic Power Features (Competitive Differentiators)

- [ ] 🔴 **P1 · M** — **Auto-Reconnect on Sleep / Resume & Network Shifts** — *(scope corrected: ~80% already built)*
  - `src/components/SessionView.tsx` (~lines 703-979) already has a full reconnect state machine (`scheduleReconnect`/`cancelReconnect`/`reconnect()`), a status banner ("Reconnecting · attempt N"), and correct `user_initiated` disconnect handling (no auto-retry after a deliberate disconnect). Originally filed as if greenfield — it isn't.
  - Actual remaining gap: no OS sleep/resume or network-interface-change detection (reconnect only starts after the passive health-watcher's 15-30s probe notices the drop), and no exponential backoff (currently a fixed 5s retry forever).
  - Add wall-clock-vs-monotonic drift detection in `commands/connection.rs` for sleep/resume (no native OS hooks needed), the `if-watch` crate for network-interface-change detection, new `system-resume`/`network-changed` events wired into the existing frontend reconnect logic, and swap the fixed interval for capped exponential backoff.
  - **Validation:** sleep/resume with an active session reconnects within ~1-2s instead of waiting for the passive timeout; toggling Wi-Fi/network does the same; user-initiated disconnect still never auto-reconnects.

- [ ] 🔴 **P1 · M** — **SFTP Multi-Item Batch Selection**
  - Checkbox selection or `Shift` / `Ctrl` multi-click selection for multiple files and folders in [`src/components/FilePanel.tsx`](file:///d:/REPO/SubTerm/src/components/FilePanel.tsx).
  - Batch actions toolbar: batch download to local archive/directory, batch delete with confirmation modal, and batch cut/move.

- [ ] 🔴 **P1 · L** — **SSH Agent Forwarding & 1Password / KeePassXC / Vaultwarden Integration**
  - Support SSH Agent Forwarding (`-A` flag) using native `SSH_AUTH_SOCK` socket proxying on macOS/Linux.
  - Named pipe integration on Windows (`\\.\pipe\openssh-ssh-agent`) for seamless integration with 1Password, KeePassXC, Vaultwarden, and Pageant.

- [ ] 🟡 **P2 · M** — **Terminal Triggers & Alert Keywords**
  - Configurable regex / keyword matching on live terminal output streams (e.g., highlighting or notification on `ERROR`, `FATAL`, `FAIL`, `Exception`).
  - Action options: trigger system notification, play audible chime, highlight line in red/amber, or capture matched snippet into activity log.

- [ ] 🟡 **P2 · L** — **Terminal Session Recording & Export (.cast / Asciinema)**
  - Native timed session recorder capturing stdout, stdin, and resize events according to the Asciinema v2 (`.cast`) standard.
  - Export to `.cast` files, raw terminal log dumps, or animated SVG/GIF for runbooks, documentation, and compliance audit trails.
  - In-app playback preview modal with play/pause, scrub slider, and playback speed controls.

- [ ] 🟡 **P2 · S** — **Cloud Sync Enhancements & Conflict Resolution**
  - Expand self-hosted cloud sync API with visual diffing for simultaneous modifications across multiple devices.
  - Granular push/pull synchronization for server definitions, credentials, snippet runbooks, and keyboard shortcuts.

- [ ] 🟢 **P3 · XL** — **Dual-Pane Remote-to-Remote SFTP Sync**
  - Side-by-side split SFTP view (Commander / WinSCP style) allowing direct transfers between two distinct remote SSH servers.
  - Stream data directly from Server A to Server B in memory without staging unencrypted files onto the local host disk.

---

## 📂 SFTP & File Management Enhancements

- [ ] 🔴 **P1 · M** — **Sudo Elevation for File Transfer & Docker Management**
  - Support administrative elevation (`sudo sftp-server` or `sudo tee` / `sudo docker`) for saving root-owned configuration files (e.g. `/etc/nginx/nginx.conf`) and managing privileged containers.

- [ ] 🟡 **P2 · M** — **Visual File Comparison (Diff Tool)**
  - Integrated side-by-side or unified diff viewer to compare differences between local and remote files, or between two remote files across sessions.
  - Syntax-highlighted change visualization with inline merge and save capabilities.

- [ ] 🟢 **P3 · S** — **Option to Treat Directory Symlinks as Folders in SFTP**
  - Resolve symbolic links pointing to directories (`lrwxrwxrwx`) as navigable folders in remote and local file managers instead of treating them as plain files.
  - Show a small link badge on the folder icon while allowing seamless navigation into the linked target directory.

---

## 🖥️ Terminal & Connection Enhancements

- [ ] 🔴 **P1 · S** — **Focus on Select Tab**
  - Automatically shift active keyboard and cursor focus to the terminal emulator canvas as soon as its tab is selected from the top tab strip.
  - Eliminates the need to click inside the terminal window after switching tabs before typing.

- [ ] 🔴 **P1 · S** — **Upload Public SSH Keys (`ssh-copy-id`)**
  - 1-click action inside the server details panel or context menu to append a selected public key to the remote server's `~/.ssh/authorized_keys`.
  - Automatically ensures correct directory permissions (`0700` for `~/.ssh`, `0600` for `authorized_keys`).

- [ ] 🟡 **P2 · S** — **Direct Shortcut to Add Keys from Server Edit Modal**
  - Add a quick `[+]` button next to the SSH Key dropdown inside [`src/components/AddNodePanel.tsx`](file:///d:/REPO/SubTerm/src/components/AddNodePanel.tsx) to generate or import a key without having to cancel out of editing the server.

- [ ] 🟡 **P2 · M** — **Server-Specific Snippets & Command Libraries**
  - Allow segmenting saved commands and snippet runbooks so snippets can be bound specifically to individual servers or tags alongside the global snippet library.

- [ ] 🟡 **P2 · S** — **Blank Username Fallback & Interactive Prompt**
  - Allow saving connection profiles with blank usernames that automatically resolve to the `User` defined in `~/.ssh/config`, or prompt interactively on connect rather than strictly defaulting to `root`.

- [ ] 🟢 **P3 · S** — **Auto-Pasting Password for Sudo Prompts**
  - Convenience hotkey or context action to securely inject the active session's saved password into interactive `[sudo] password for user:` prompts.

---

## 🌐 Network, Protocols & Multi-Platform

- [ ] 🟡 **P2 · XL** — **Native Tailscale / Tailcat Mesh Support**
  - Direct userspace Tailscale mesh network transport to seamlessly discover and connect to Tailscale nodes by MagicDNS name without manual local proxy configurations.
  - _Note: Evaluated in PR #44; deferred due to binary footprint, CGo toolchain requirements, and the fact that OS-level Tailscale already routes transparently through standard SSH. Revisit if embedded Go build pipeline becomes viable._

- [ ] 🟢 **P3 · XL** — **RDP Functionality (Remote Desktop Protocol)**
  - Native Remote Desktop Protocol (RDP) session tabs alongside SSH, SFTP, and Docker for managing Windows infrastructure.

- [ ] 🟢 **P3 · XL** — **iOS / iPadOS Support**
  - Target compilation and packaging for iPadOS and iOS devices, pairing with SubTerm's mobile accessory keybar.

---

## 📦 Vault, Packaging & Ecosystem

- [ ] 🟡 **P2 · M** — **Vault Export to Portable Formats (JSON / CSV)**
  - 1-click export of saved server profiles, folders, and non-sensitive configs to portable unencrypted JSON/CSV or password-protected encrypted archives for backup and migration.

- [ ] 🟡 **P2 · S** — **Portable Standalone Version in Releases**
  - Automated CI workflow release step to package and publish a zero-install portable `.zip` bundle alongside the Windows NSIS setup and MSI installers.

- [ ] 🟢 **P3 · S** — **Wildcard Character Matching in Server Filter**
  - Support glob wildcard pattern matching (`*` and `?`) in the home server search bar (e.g., `web-*`, `prod-db?`, `*-staging`).
