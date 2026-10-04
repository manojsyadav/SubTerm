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

- [x] 🟡 **P2 · S** — **Add ESLint Configuration** — ✅ Done
  - Added [`eslint.config.js`](file:///d:/REPO/SubTerm/eslint.config.js) (flat config, ESLint 9) with `@typescript-eslint` recommended rules, `eslint-plugin-react-hooks`, and `eslint-plugin-react-refresh`. `npm run lint` added to `package.json`.
  - Two codebase-wide exceptions, not disabled blindly: `no-empty` allows empty `catch {}` (the codebase uses these deliberately for best-effort fallbacks like `localStorage` writes), and `no-control-regex` is off (`TerminalView.tsx` matches raw ANSI escape/bell bytes to parse terminal control sequences — that's the feature).
  - Fixed the handful of zero-risk pre-existing issues along the way (all verified not to change behavior): 3 `prefer-const` (`FilePanel.tsx`, `Sidebar.tsx` — confirmed never reassigned), a ternary-as-statement in `FilePanel.tsx` rewritten as `if`/`else`, and 6 `no-useless-escape` regex escapes in `TerminalView.tsx`/`TunnelsPanel.tsx` (all inside character classes, where the escaped char was already literal).
  - **Tracked baseline** (left as-is — out of scope for adding the linter itself): 2 errors in `InfoPanel.tsx` (`react-hooks/rules-of-hooks`, hooks called conditionally — a real pre-existing bug worth its own fix) and 115 warnings (mostly unused imports/vars and `react-hooks/exhaustive-deps` gaps) across the codebase.
  - **Validation:** `npm run lint` → 117 problems (2 errors, 115 warnings), all pre-existing and tracked above; `npm run typecheck` passes.

- [ ] 🟡 **P2 · L** — **Triage `.unwrap()` / `.expect()` in the Rust Backend**
  - 219 occurrences across `src-tauri/src` (168 in `lib.rs` alone, 23 in `tunnel.rs`, 15 in `identity.rs`). A panic in any of these can crash the whole Tauri process, killing every open SSH session, not just one request.
  - Prioritize paths touching untrusted network input (SSH packet/channel handling) and on-disk vault/config parsing — replace with `Result` propagation and surfaced errors.
  - **Validation:** `grep -rc unwrap\|expect` count trends down in connection/vault-handling modules; fuzzed/malformed inputs no longer crash the app.

- [ ] 🟢 **P3 · L** — **Reduce `any` / `as any` in the TypeScript Frontend**
  - 239 occurrences across `src/**/*.tsx`/`*.ts` with no lint rule currently flagging new ones.
  - Backfill proper types incrementally, starting with session/file-path handling code where a mistyped value has real consequences.
  - **Validation:** `grep -rc ": any\|as any"` count trends down; new PRs can't introduce more once ESLint's `no-explicit-any` is enabled.

- [x] 🟡 **P2 · S** — **Reconcile `russh` Version Drift** — ✅ Done
  - README's "`russh` 0.45+" was aspirational — [`src-tauri/Cargo.toml`](file:///d:/REPO/SubTerm/src-tauri/Cargo.toml) actually pins `russh = "0.40.2"` / `russh-keys = "0.40.1"`. README corrected to say 0.40.
  - **Audit turned up something more urgent — see the new P1 item directly below.**
  - **Validation:** `cargo audit` run (see finding below); README diff is a one-line doc fix, no code change.

- [ ] 🔴 **P1 · L** — **Upgrade `russh` — High-severity RustSec Advisory on the Pinned Version**
  - `cargo audit` flags the pinned `russh 0.40.2` under **[RUSTSEC-2026-0154](https://rustsec.org/advisories/RUSTSEC-2026-0154)** (Severity 7.5/High — unbounded 32-bit allocation) and `russh-cryptovec 0.7.3` under **[RUSTSEC-2026-0153](https://rustsec.org/advisories/RUSTSEC-2026-0153)** (same class). Both are fixed only in `russh >= 0.60.3`. This is a DoS on SSH packet parsing — i.e. untrusted network input, the exact category flagged above in "Triage `.unwrap()` / `.expect()`".
  - `0.40.2 → 0.60+` (current latest `0.63.3`) spans ~20 minor versions with likely breaking API changes across `ssh_manager.rs`, `commands/connection.rs`, `commands/sftp.rs`, and the agent-forwarding/auto-reconnect code added since — deliberately **not** attempted alongside unrelated low-effort cleanup; needs its own dedicated pass.
  - Audit the 0.40→0.60+ changelog/breaking changes, upgrade both `russh` and `russh-keys`/`russh-cryptovec`, fix call sites, then run the full manual SSH/SFTP/agent-forwarding/auto-reconnect validation pass.
  - **Validation:** `cargo audit` shows no `russh`/`russh-cryptovec` advisories; `cargo build` + all 45 unit tests pass; live SSH connect, SFTP transfer, tunnel, and agent-forwarding all still work.

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

- [x] 🔴 **P1 · M** — **Auto-Reconnect on Sleep / Resume & Network Shifts** — ✅ Done
  - `commands/connection.rs` now spawns two background watchers from `run()`'s setup hook: a resume detector (wall-clock-vs-monotonic drift on a 2s tokio interval — no native OS power-event API needed) and a network-interface-change watcher (`if-watch` crate, debounced to 1/sec), emitting `system-resume` / `network-changed`.
  - `SessionView.tsx` listens for both and, if a session is mid-backoff or already gave up on a non-auth failure, retries immediately instead of waiting out the remaining delay. Fixed 5s retry interval replaced with exponential backoff (2s → 4s → 8s → 16s, capped at 30s).
  - **Validation:** `cargo build` + all 45 backend unit tests pass; frontend typecheck clean. Live sleep/resume and network-toggle behavior on real hardware is still a manual follow-up — not simulable in a dev sandbox.

- [ ] 🔴 **P1 · M** — **SFTP Multi-Item Batch Selection**
  - Checkbox selection or `Shift` / `Ctrl` multi-click selection for multiple files and folders in [`src/components/FilePanel.tsx`](file:///d:/REPO/SubTerm/src/components/FilePanel.tsx).
  - Batch actions toolbar: batch download to local archive/directory, batch delete with confirmation modal, and batch cut/move.

- [x] 🔴 **P1 · M** — **SSH Agent Forwarding (`-A`)** — ✅ Core deliverable done
  - New `ssh_agent.rs` connects to the local agent (`$SSH_AUTH_SOCK` on Unix, `\\.\pipe\openssh-ssh-agent` on Windows); `ssh_manager.rs`'s `ClientHandler` bridges the server's `auth-agent@openssh.com` channel to it via a new `agent_forward_channels` map + `data()`/`server_channel_open_agent_forward`. New `servers.forward_agent` column + AddNodePanel toggle. Works with any standard-agent-protocol backend (OpenSSH agent, Pageant, 1Password, KeePassXC, Vaultwarden) via dumb byte proxying — no per-vendor code needed.
  - **Still open (fast-follow, not blocking):** using the local agent to *authenticate to the first hop* (so SubTerm never loads a raw private key) — pending confirming `russh` 0.40.2's client auth API can accept an externally-signed challenge rather than only an in-memory `KeyPair`. This is what would make "1Password/KeePassXC/Vaultwarden integration" complete rather than just forwarding.
  - **Validation:** `cargo build` + all 45 unit tests pass. Live forwarding (`ssh-add`, connect, `ssh-add -l` on the remote, hop to a third host) still needs a manual pass with a real agent — not simulable in a dev sandbox.

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

- [x] 🔴 **P1 · S** — **Focus on Select Tab** — ✅ Already implemented, verified by code trace
  - The top tab strip's click handler ([`src/DesktopApp.tsx:1123`](file:///d:/REPO/SubTerm/src/DesktopApp.tsx)) calls `setActiveView(s.id)`, which flips `isFocused` → the `isSessionActive` prop passed into `SessionView` → the `isActive` prop on each `TerminalView` ([`src/components/SessionView.tsx:2169`](file:///d:/REPO/SubTerm/src/components/SessionView.tsx)).
  - `TerminalView.tsx`'s existing repaint effect ([`src/components/TerminalView.tsx:312-327`](file:///d:/REPO/SubTerm/src/components/TerminalView.tsx)) already calls `t.focus()` whenever `isActive` turns true, so the canvas already regains keyboard focus automatically on every tab switch — no code change was needed.
  - **Validation:** `npm run typecheck` passes (no change made). Live click-through in the running desktop app is still a recommended manual spot-check, but the full prop chain from tab click to `xterm.focus()` is unbroken.

- [x] 🔴 **P1 · S** — **Upload Public SSH Keys (`ssh-copy-id`)** — ✅ Done
  - Added an "Upload public key" section to the session tab's right-click context menu ([`src/DesktopApp.tsx`](file:///d:/REPO/SubTerm/src/DesktopApp.tsx), inside the `tabMenu` block), listing every saved key from `sshKeys`. Picking one runs a single remote shell command over the already-authenticated session via the existing `sftp_exec_command` Tauri command (no new backend code needed — it already execs arbitrary commands on an open SSH channel).
  - The command does `mkdir -p ~/.ssh && chmod 700 ~/.ssh && touch ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys`, then appends the key only if it isn't already present (`grep -qxF` dedupe check). The key is single-quoted with embedded `'` escaped (`'\''`) so a key's comment field can't break out of the remote shell command.
  - Only offered while the session is `connected` (there's no live channel to exec on otherwise) and when at least one key is saved.
  - **Validation:** `npm run typecheck` passes. A live end-to-end run (connect, upload a key, confirm passwordless login on a second connection) is still a recommended manual follow-up — not simulable in this sandbox without a real SSH target.

- [x] 🟡 **P2 · S** — **Direct Shortcut to Add Keys from Server Edit Modal** — ✅ Done
  - Added a `[+]` button next to the SSH Key dropdown inside [`src/components/AddNodePanel.tsx`](file:///d:/REPO/SubTerm/src/components/AddNodePanel.tsx). Reuses the exact `useTextPrompt` → `generate_ssh_key` → refresh pattern already used in the Settings → SSH Keys panel (`DesktopApp.tsx`), then auto-selects the freshly generated key in the dropdown so the user never leaves the form.
  - Scoped to "generate" only (not "import") — importing needs the full key-paste form (`public_key`/`private_key`/`passphrase`), which didn't fit a one-button inline action; that's still reachable via Settings → SSH Keys → Add Key as before.
  - **Validation:** `npm run typecheck` passes; `npm run lint` unchanged at 117 problems (2 pre-existing errors, 115 warnings — no new issues introduced).

- [ ] 🟡 **P2 · M** — **Server-Specific Snippets & Command Libraries**
  - Allow segmenting saved commands and snippet runbooks so snippets can be bound specifically to individual servers or tags alongside the global snippet library.

- [x] 🟡 **P2 · S** — **Blank Username Fallback & Interactive Prompt** — ✅ Done (ssh_config resolution; interactive prompt deferred)
  - Blank usernames were already saveable (no frontend validation blocked it) — the gap was entirely server-side: [`src-tauri/src/commands/connection.rs`](file:///d:/REPO/SubTerm/src-tauri/src/commands/connection.rs) hardcoded `"root"` the moment `user.trim().is_empty()`, in both `initiate_connection` and `connect_jump_host`.
  - Added `resolve_user_from_ssh_config(host)`, which reuses the existing `parse_ssh_config` parser (already shipped for the "Import from ~/.ssh/config" flow) to look for a `Host` block matching the connecting host (by alias or resolved `Hostname`) with a `User` directive, and tries it before falling back to `root`. Best-effort by design — any parse failure (missing config, unreadable file, Android) is swallowed and falls through to the existing `root` default, never a connect-blocking error.
  - **Interactive prompt-on-connect deliberately not implemented**: `initiate_connection` resolves username synchronously from the DB row before any network I/O, with no existing round-trip mechanism to pause mid-connect for a frontend dialog and resume with a typed answer (unlike the keyboard-interactive/fingerprint flows, which already have that plumbing for a different purpose). The TODO's phrasing offers resolve-from-config *or* prompt as alternatives; config resolution covers the common case without that added complexity.
  - **Validation:** `cargo check` clean; all 45 backend unit tests pass. A live connect to a blank-username profile with a matching `~/.ssh/config` entry is a recommended manual follow-up.

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
