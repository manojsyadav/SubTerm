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

- [x] 🔴 **P1 · L** — **Add an Automated Test Suite (Currently Zero Tests)** — ✅ Done (minimum-viable coverage, not exhaustive)
  - **Backend** — 36 new `#[cfg(test)]` cases (45 → 81 total), each targeting a real, previously-untested security/correctness boundary rather than padding a count:
    - `vault.rs` (13 tests, new module): Argon2id determinism + salt/password sensitivity (`derive_key_*`), AES-256-GCM round-trip + wrong-key rejection + tampered-ciphertext rejection, zstd compress/decompress round-trip + the 64 MiB decompression-bomb guard, on-disk blob framing round-trip + bad-magic/unsupported-version/truncated-header rejection, and a DEK malformed-hex guard.
    - `commands/sftp.rs` (12 tests, new module): `removable_dir_path` (rejects `/`, relative paths, `.`/`..` traversal segments), `is_child_name`, `safe_temp_leaf_name`, and `guard_local_path` (accepts a real path in a normal location, allows/rejects a nonexistent leaf per its own flag, rejects known OS system directories) — the last one exercised against real temp-directory fixtures, not mocked.
    - `mirror.rs` (11 tests, new module): `is_excluded` (hardcoded defaults, default extensions, Windows-separator normalization, user glob/substring patterns, and a regression guard for a blank user pattern matching everything via `"".contains("")`), and `local_to_remote` (nested-path mapping, root mapping, trailing-slash handling, outside-root rejection).
  - **Frontend** — added Vitest (pinned to `^3.2.7`, which still supports this project's Vite 5 pin — the latest Vitest major requires Vite 6+, out of scope for a test-suite addition). `npm test` wired into `package.json` and `.github/workflows/ci.yml`'s frontend job. 22 tests across 3 new files targeting this session's own pure-logic modules (no existing tests existed to extend): `src/fs/diff.test.ts` (the shared diff algorithm), `src/terminal/triggers.test.ts` (trigger compilation/matching, including the invalid-regex-doesn't-crash guard), `src/export/serverExport.test.ts` (folder-name resolution, the password-never-leaks guarantee, JSON round-trip, CSV quoting per RFC 4180).
  - **Scope decisions, named explicitly rather than silently skipped**: this is "minimum viable," not exhaustive — it does not attempt component/render tests (would need React Testing Library + jsdom, a much bigger lift), does not cover the sync engine beyond what `sync.rs`'s own pre-existing tests already did, and does not test UI-heavy modules like `DesktopApp.tsx`/`FilePanel.tsx` (those need the `DesktopApp.tsx` decomposition from the top of this list first to even be testable in isolation).
  - Installing `vitest@^3.2.7` added 2 new moderate-severity `npm audit` entries (`@vitest/mocker` / `vitest` — a path-traversal issue in Vitest's mock-redirect feature, fixed only in `vitest@>=4.1.11` which requires Vite 6+). Not used by any of these tests (no mocking), and scoped to a devDependency test runner, not shipped code.
  - **Validation:** `cargo test` (81/81) and `npm test` (22/22) both pass; `npm run typecheck`, `npm run lint` (0 errors, 115 pre-existing warnings — the three new `.test.ts` files lint clean), and `npm run build` all clean. Both suites now run in CI (`ci.yml`).

- [x] 🔴 **P1 · M** — **Wire Test/Lint Gates into CI** — ✅ Done
  - Added [`.github/workflows/ci.yml`](file:///d:/REPO/SubTerm/.github/workflows/ci.yml), triggered on every PR and push to `main`, separate from `release.yml` (which stays focused on packaging). Two jobs: `rust` (`cargo check --all-targets`, `cargo test`, Linux WebKit deps installed for the build to compile), and `frontend` (`npm run typecheck`, `npm run lint`).
  - `cargo clippy -- -D warnings` (as originally worded) was **not** used as a hard gate — the codebase currently carries ~62 pre-existing clippy warnings (complex types, too-many-arguments, style nits), which would block every PR immediately. `clippy` runs advisory-only (`|| true`) until that backlog gets its own cleanup pass, mirroring the existing `.unwrap()`/`.expect()` Triage item's same deferred-cleanup pattern.
  - `npm run lint` **is** a hard gate — but it only fails on errors, not ESLint's 115 pre-existing warnings (ESLint's default exit behavior). This required actually fixing the 2 pre-existing `react-hooks/rules-of-hooks` errors in `InfoPanel.tsx`'s `ServicesTab` (the `counts` `useMemo` and the first-arrival `useEffect` were declared *after* an early `return` for the `!data.available` case — moved both above the early return, no behavior change) so the gate isn't broken from the moment it's merged.
  - **Validation:** `cargo check` + `cargo test` (45/45) pass; `npm run typecheck` clean; `npm run lint` now at 0 errors / 115 warnings (down from 2 errors); `ci.yml` parses as valid YAML (`python -c "import yaml; yaml.safe_load(...)"`). A real PR run is the final confirmation once pushed.

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

- [x] 🟢 **P3 · S** — **Document TOFU Host-Key Verification UX in `SECURITY.md`** — ✅ Done
  - Added §8 to [`docs/SECURITY.md`](file:///d:/REPO/SubTerm/docs/SECURITY.md), tracing the actual flow in `check_server_key` (`src-tauri/src/ssh_manager.rs`): first-connection prompt, returning-host silent accept, the same-algorithm-mismatch MITM warning vs. benign new-algorithm addition distinction, storage (inside the encrypted vault blob, not a plaintext file), revocation via Settings → Known Hosts, and fail-closed behavior on a poisoned DB lock.
  - No gap found between the documented behavior and the actual code — this was a pure write-up.
  - **Validation:** Doc review only; no code change.

- [x] 🟢 **P3 · M** — **Vault Format/KDF Rotation Strategy for Deployed Users** — ✅ Done (design doc)
  - Added [`docs/SECURITY.md` §9](file:///d:/REPO/SubTerm/docs/SECURITY.md) — design-only, no code changes, per the TODO's own validation bar. Covers: a `KdfProfile` table replacing the three bare `ARGON2_*_COST` constants so a profile change is additive (new table entry + bump `CURRENT_KDF_PROFILE`), widening the header with a 1-byte KDF profile ID gated by `VAULT_VERSION` the same way `parse_vault_blob` already fails closed on an unrecognized version, and a lazy re-encrypt-on-next-save migration that reuses `save_vault_blocking`'s existing atomic tmp-write/fsync/rename path unchanged — so there's no new write path to get wrong, and no data-loss window (the original file is untouched until the replacement is fully written).
  - Along the way, found and fixed a real doc/code drift in §1.3: the vault header table claimed magic `"SUBT"` / version `0x02`, but `vault.rs` actually uses `"OMNV"` / version `1`. Corrected to match the code.
  - Also clarifies `VAULT_VERSION` (crypto/file-format framing) is a distinct concept from `SCHEMA_VERSION` (the SQL schema inside the decrypted plaintext, from the `schema_meta` table) — the two are easy to conflate and a rotation only ever touches the former.
  - **Validation:** Doc review only, no code change — matches the TODO's own bar ("no immediate code required").

---

## ⚡ Core Performance & IPC Optimizations

- [x] 🔴 **P1 · M** — **High-Throughput IPC: Tauri 2 Binary Channels** — ✅ Done
  - Migrated terminal byte stream dispatch off base64 JSON strings over `app.emit` (`emit_terminal_batch`) to `tauri::ipc::Channel<InvokeResponseBody>`, sending `InvokeResponseBody::Raw(Vec<u8>)`. Small batches deliver as a zero-copy `ArrayBuffer` via a direct `eval`; larger ones go through Tauri's binary fetch-channel-data path — no base64 (~1.33x overhead), no JSON number-array encoding (~4x), and no `atob`/manual byte-loop decode on the frontend (`TerminalView.tsx` now does `new Uint8Array(arrayBuffer)` directly in the channel's `onmessage`).
  - The tricky part: the old `terminal-output-{id}` event was a global broadcast, so split-pane "attach-only" viewers of the same `terminal_id` (and the Fleet Wall's tile re-mounts, see `DesktopApp.tsx`) got output for free without opening their own PTY. A Channel only delivers to whoever registers it, so `SshState` gained an `output_channels: HashMap<String, Vec<Channel>>` fan-out registry (`ssh_manager.rs`): the PTY owner's `open_terminal`/`open_local_terminal`/`open_container_terminal` registers its channel directly (deduped by channel id so reconnects reusing the same JS `Channel` instance don't pile up sinks), and a new lightweight `subscribe_terminal_output(terminal_id, channel)` command lets attach-only viewers register an additional sink without creating a second PTY. `close_terminal` clears the whole registry entry; a stale attach-only channel from an unmounted pane that never explicitly unsubscribes just lingers harmlessly (send on a dead channel is ignored) until the owner closes the terminal.
  - `docker.rs`'s `open_container_terminal` and the Android stub for `open_local_terminal` were updated to match the new signature/registration pattern.
  - **Validation:** `cargo check`/`cargo test` (45/45) pass; `npm run typecheck`, `npm run lint` (0 errors, 115 pre-existing warnings), and `npm run build` all clean. Live firehose throughput comparison (`cat` of a large file, `docker logs -f`) on a real connection is a recommended manual follow-up — not simulable in this sandbox.

- [ ] 🟡 **P2 · L** — **SFTP Pipelined Transfers & Concurrent Chunking**
  - Implement multi-stream concurrent byte-range chunking for large single-file transfers across parallel SFTP channels.
  - Automatically saturate high-bandwidth, high-latency WAN links beyond the current 256 KiB sequential pipelined stream.

- [x] 🟢 **P3 · M** — **Server List Virtualization** — ✅ Done (drag-reorder rewritten to be virtualization-safe, per explicit scope decision)
  - Added `@tanstack/react-virtual` (zero new transitive vulnerabilities — confirmed `npm audit` reports the same 13 pre-existing issues with or without it, all in unrelated devDependency tooling). The grid is now rendered as virtualized **rows** (each row = `columnCount` fixed-height cards), not a 2D virtualizer — simpler and sufficient since there's no horizontal scroll.
  - **The real work was the drag-to-reorder rewrite**, flagged to the user before starting: the existing reorder algorithm computed drop targets by `querySelectorAll('[data-sid]')`-ing every card's live DOM geometry at drag-start — impossible once off-screen cards stop being mounted. Replaced with **analytic** slot geometry: column count (now a single JS source of truth — see below), the dragged card's own measured width, and the fixed `CARD_H`/`GRID_GAP` constants fully determine every slot's center, including cards scrolled far out of view. `folderCount` leading cells shift the math the same way folders' real DOM cells used to. The scroll-position compensation already in the move handler (`scrollTop0Ref` delta) needed no changes — it composes with the new analytic slots exactly like it did with the old DOM-rect ones.
  - **Column count** is no longer the pure-CSS `grid-cols-2 lg:grid-cols-3 xl:grid-cols-4` Tailwind classes (unreadable from JS synchronously) — replaced with a single `columnCount` value computed from the existing `useViewportWidth()` hook (already used elsewhere for responsive logic) against Tailwind's own default lg/xl breakpoints (1024/1280), feeding both the row-chunking and the drag math from one source instead of two that could drift apart.
  - Layout: the grid's search bar, folder breadcrumb header, and action toolbar are now non-scrolling `shrink-0` siblings above a dedicated `flex-1 min-h-0 overflow-y-auto` scroll container holding only the virtualized rows — needed because the virtualizer positions rows as absolute offsets from its own wrapper's top, which only lines up correctly if that wrapper starts at the scroll container's origin (no header content sharing the same scroll region pushing things out of alignment).
  - FLIP reflow animation during a drag now only covers currently-mounted (visible + overscan) cards — cards scrolled out of view don't need to animate since the user can't see them move.
  - **Validation:** `npm run typecheck`, `npm run lint` (0 errors, 115 pre-existing warnings — `NodeGrid.tsx` itself lints completely clean), and `npm run build` all clean. **Could not do a live browser click-through in this session** (no interactive Chrome session available) — a manual pass (scroll a 500+-server fleet, drag-reorder across scrolled-out rows, resize the window across the 1024/1280 breakpoints) is a recommended follow-up before fully trusting this on a real large fleet.

---

## 🚀 Strategic Power Features (Competitive Differentiators)

- [x] 🔴 **P1 · M** — **Auto-Reconnect on Sleep / Resume & Network Shifts** — ✅ Done
  - `commands/connection.rs` now spawns two background watchers from `run()`'s setup hook: a resume detector (wall-clock-vs-monotonic drift on a 2s tokio interval — no native OS power-event API needed) and a network-interface-change watcher (`if-watch` crate, debounced to 1/sec), emitting `system-resume` / `network-changed`.
  - `SessionView.tsx` listens for both and, if a session is mid-backoff or already gave up on a non-auth failure, retries immediately instead of waiting out the remaining delay. Fixed 5s retry interval replaced with exponential backoff (2s → 4s → 8s → 16s, capped at 30s).
  - **Validation:** `cargo build` + all 45 backend unit tests pass; frontend typecheck clean. Live sleep/resume and network-toggle behavior on real hardware is still a manual follow-up — not simulable in a dev sandbox.

- [x] 🔴 **P1 · M** — **SFTP Multi-Item Batch Selection** — ✅ Already implemented, verified by code trace
  - Found fully built in [`src/components/FilePanel.tsx`](file:///d:/REPO/SubTerm/src/components/FilePanel.tsx) — not a prior session's doc, this TODO entry was simply stale. `onRowClick` (~line 510) implements the standard three-mode click model: plain click replaces selection, `Ctrl`/`⌘`+click toggles a row, `Shift`+click range-extends from the last anchor using the *rendered* order (`sortedEntries`). A per-row checkbox (always reserved as a 22px column so it never shifts content) gives a touch/no-modifier-key path to the same toggle, plus a header select-all control.
  - The floating batch toolbar (shown whenever `selected.size > 0`) has Download (remote pane), Upload (local pane), Move… (opens a bulk destination-path modal), Delete (routes through the same confirmation dialog as a single-item delete, pluralized), and Clear.
  - "Batch cut" from the original wording is covered by the Move… modal relocating every selected item to a typed destination path in one step — there's no separate OS-clipboard-style cut/paste, since Move already satisfies the same user need without a second UI concept.
  - **Validation:** Code trace only, no functional change — confirmed `removeItems`/`downloadItems`/`uploadItems` all accept and iterate an item array, not a single entry. `npm run typecheck` passes (no edits made).

- [x] 🔴 **P1 · M** — **SSH Agent Forwarding (`-A`)** — ✅ Core deliverable done
  - New `ssh_agent.rs` connects to the local agent (`$SSH_AUTH_SOCK` on Unix, `\\.\pipe\openssh-ssh-agent` on Windows); `ssh_manager.rs`'s `ClientHandler` bridges the server's `auth-agent@openssh.com` channel to it via a new `agent_forward_channels` map + `data()`/`server_channel_open_agent_forward`. New `servers.forward_agent` column + AddNodePanel toggle. Works with any standard-agent-protocol backend (OpenSSH agent, Pageant, 1Password, KeePassXC, Vaultwarden) via dumb byte proxying — no per-vendor code needed.
  - **Still open (fast-follow, not blocking):** using the local agent to *authenticate to the first hop* (so SubTerm never loads a raw private key) — pending confirming `russh` 0.40.2's client auth API can accept an externally-signed challenge rather than only an in-memory `KeyPair`. This is what would make "1Password/KeePassXC/Vaultwarden integration" complete rather than just forwarding.
  - **Validation:** `cargo build` + all 45 unit tests pass. Live forwarding (`ssh-add`, connect, `ssh-add -l` on the remote, hop to a third host) still needs a manual pass with a real agent — not simulable in a dev sandbox.

- [x] 🟡 **P2 · M** — **Terminal Triggers & Alert Keywords** — ✅ Done (in-app alert, not a native OS push notification)
  - New [`src/terminal/triggers.ts`](file:///d:/REPO/SubTerm/src/terminal/triggers.ts): a user-managed list of `{ pattern, isRegex, caseSensitive, action, enabled }` triggers, stored in `localStorage` (`subterm-terminal-triggers`, same pattern as custom terminal themes), compiled to `RegExp`s once per list change rather than per output chunk.
  - Managed from **Settings → Terminal → Terminal Triggers & Alert Keywords**: add/remove/edit triggers, toggle regex vs. plain-keyword matching, case sensitivity, and the fired action.
  - `TerminalView.tsx`'s output handler scans each decoded output *chunk* (not the full scrollback buffer) against the compiled triggers — scoped to a chunk so a persistent match in view doesn't re-fire the same trigger on every subsequent ~8ms batch, at the cost of (rarely) missing a keyword split exactly across two flush batches.
  - Four actions, reusing existing UI primitives instead of adding new ones: **Toast Notification** (in-app toast), **Audible Chime** (existing `playTerminalBellChime`), **Visual Flash** (existing bell-flash state), **Activity Log Entry** (dispatches a `subterm-add-log` window event up to `DesktopApp.tsx`'s `addLog`, the same decoupled-signal pattern already used for `submarine-open-copilot-{sessionId}`, since `TerminalView` sits several component layers below the log sink).
  - **Deliberately did not add a native OS push notification** (`tauri-plugin-notification`) — `src-tauri/capabilities/default.json` explicitly documents this app's policy of keeping the webview's permission surface as narrow as possible ("we intentionally omit shell:\*, opener:\*, fs:\*, and webview:\* ... exposing them just widens the blast radius of any future XSS"); a new plugin + OS notification permission (including an Android manifest entry) for one feature didn't clear that bar when the existing toast/chime/flash already give in-app + audible coverage.
  - **Validation:** `npm run typecheck`, `npm run lint` (0 errors, 115 pre-existing warnings), and `npm run build` all clean. No backend change. Live multi-session trigger firing (e.g. a background session logging `ERROR` while another tab is focused) is a recommended manual follow-up.

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

- [x] 🔴 **P1 · M** — **Sudo Elevation for File Transfer & Docker Management** — ✅ Done
  - **Docker management was already fully covered** before this pass: `docker.rs`'s `run_docker_smart` silently retries any failed docker command (daemon-socket permission denied) via `sudo -n` first, then `sudo -S -p ''` with the session's saved password — every docker lifecycle/inspect command and `open_container_terminal`'s `use_sudo` flag already route through it.
  - **File transfer was the real gap**: `sftp_write_file_text` (the quick-editor `Ctrl+S` save path) had a latent bug — its exec fallback (used when the sftp subsystem can't open the file, e.g. no write permission) piped straight to `> "$FILE"` and then `.map(|_| ())`'d the result, **ignoring the shell's actual exit code**. Saving a root-owned file like `/etc/nginx/nginx.conf` as a non-root user looked like it succeeded in the UI while silently writing nothing.
  - Rewrote the fallback in [`src-tauri/src/commands/sftp.rs`](file:///d:/REPO/SubTerm/src-tauri/src/commands/sftp.rs): stage the content into a `mktemp`-generated path (unprivileged, non-guessable — same rationale as the existing `app_temp_root` comment), resolve the `$HOME`-relative fallback as a plain path string, then `mv` the staged file into place as a flat `mv src dst` argv. Splitting staging from the move is what makes sudo retry possible — sudo can only cleanly re-exec a flat command, not a multi-stage shell script. On "permission denied"/"operation not permitted", retries as `sudo -n mv ...`, then `sudo -S -p ''` with the saved session password, mirroring `run_docker_smart`'s exact elevation order. `run_capture`/`run_capture_with_stdin`/`shq` were promoted to `pub(crate)` in `docker.rs` so `sftp.rs` could reuse the same exit-code-aware exec helper instead of duplicating it.
  - **Validation:** `cargo check`/`cargo test` (45/45) pass; `npm run typecheck`/`npm run lint` unaffected (no frontend change — command signature is unchanged). A live save to a root-owned file with and without a saved session password is a recommended manual follow-up — not simulable in this sandbox without a real SSH target with sudo configured.

- [x] 🟡 **P2 · M** — **Visual File Comparison (Diff Tool)** — ✅ Done (unified diff; merge scoped to one-directional overwrite)
  - New [`src/components/FileDiffModal.tsx`](file:///d:/REPO/SubTerm/src/components/FileDiffModal.tsx): loads two independently-addressed files (any combination of local/remote, any session) in parallel and renders a unified line diff with additions/deletions counts. The line-diff algorithm (`computeDiff`) already existed inside `QuickEditorModal.tsx` (used there for "my unsaved edits vs. what's on disk") — extracted to shared [`src/fs/diff.ts`](file:///d:/REPO/SubTerm/src/fs/diff.ts) so there's one diff implementation, not two.
  - Entry point: right-click a file in either SFTP pane → **Compare with Other Pane**, which diffs it against the same-named file in the opposite pane's *current directory* (not confirmed to exist first — a read error just surfaces in the modal, same UX as the existing quick editor). Wired through a new `onCompareWithOpposite` prop on `FilePanel`, implemented in `SftpWorkspace.tsx` (the only component that already holds refs to both panes).
  - **Scoped down from the TODO's literal wording** in two ways: (1) unified diff only, no separate side-by-side layout — reusing the exact same visual diff block as the quick editor means one rendering path for the whole app; (2) "inline merge" is one-directional overwrite (**Use Left →** / **← Use Right** buttons copy one file's full contents over the other) rather than an interactive per-line merge — covers the real use case (promote a validated config, or pull a hotfix back) without a much larger 3-way-merge UI.
  - **Validation:** `npm run typecheck`, `npm run lint` (0 errors, 115 pre-existing warnings), and `npm run build` all clean. No backend change — reuses the existing `sftp_read_file_text`/`sftp_write_file_text`/`local_read_file_text`/`local_write_file_text` commands. A live compare+overwrite across two real sessions is a recommended manual follow-up.

- [x] 🟢 **P3 · S** — **Option to Treat Directory Symlinks as Folders in SFTP** — ✅ Done
  - Backend: `SftpFileEntry`/`LocalFileEntry` gained an `is_symlink` field. The primary SFTP-protocol listing (`sftp_list_dir`) and the local listing (`local_list_dir`) both lstat the entry first, then follow a symlink with a real stat to resolve `is_dir` against the link's *target* — so a directory symlink navigates exactly like a real folder. The `ls -la` exec-fallback path (used only when the sftp subsystem is unavailable) detects symlinks from the `l` permission bit and strips the `-> target` suffix from the name, but can't resolve the target type without a second round-trip per entry, so it stays non-navigable there — a documented, acceptable degradation since the primary SFTP path is what most servers use.
  - Frontend: `FileEntry.isSymlink` (already declared in `src/fs/types.ts`) is now populated by both `remoteProvider.ts` and `localProvider.ts`. [`FilePanel.tsx`](file:///d:/REPO/SubTerm/src/components/FilePanel.tsx) renders a small `ExternalLink` badge over the folder/file icon when `isSymlink` is set.
  - **Validation:** `cargo check` + all 45 backend unit tests pass; `npm run typecheck` and `npm run lint` clean (no new issues).

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

- [x] 🟡 **P2 · M** — **Server-Specific Snippets & Command Libraries** — ✅ Done
  - Schema: `commands` gained `server_id INTEGER` (NULL = global, matching every existing row) and `tags TEXT NOT NULL DEFAULT ''` (plain comma-separated string, not JSON — simple labels don't need a parser). Added to both the fresh-profile `CREATE TABLE` and the additive `ALTER TABLE` migration list in `profile.rs`, following the exact precedent of `jump_host_id`/`forward_agent` (nullable/defaulted, no `SCHEMA_VERSION` bump needed).
  - Backend: `add_command`/`edit_command` accept optional `server_id`/`tags`; `get_commands` returns them (`serverId`/`tags` camelCase, matching the app's existing JS-facing naming convention).
  - Frontend: the Library "New/Edit Command" panel in `DesktopApp.tsx` gained a **Scope** dropdown (Global or any saved server) and a **Tags** text input. Library cards show a scope badge (server name, or "Global") and tag chips, and the search box now also matches against tags.
  - **Command Palette filtering**: `CommandPalette.tsx`'s saved-snippet section now filters to `!serverId || serverId === <active session's server>` — opening `Ctrl+K` inside one server's tab no longer surfaces snippets written for a different server, while global snippets always show.
  - **Validation:** `cargo check`/`cargo test` (45/45) pass; `npm run typecheck`, `npm run lint` (0 errors, 115 pre-existing warnings), and `npm run build` all clean.

- [x] 🟡 **P2 · S** — **Blank Username Fallback & Interactive Prompt** — ✅ Done (ssh_config resolution; interactive prompt deferred)
  - Blank usernames were already saveable (no frontend validation blocked it) — the gap was entirely server-side: [`src-tauri/src/commands/connection.rs`](file:///d:/REPO/SubTerm/src-tauri/src/commands/connection.rs) hardcoded `"root"` the moment `user.trim().is_empty()`, in both `initiate_connection` and `connect_jump_host`.
  - Added `resolve_user_from_ssh_config(host)`, which reuses the existing `parse_ssh_config` parser (already shipped for the "Import from ~/.ssh/config" flow) to look for a `Host` block matching the connecting host (by alias or resolved `Hostname`) with a `User` directive, and tries it before falling back to `root`. Best-effort by design — any parse failure (missing config, unreadable file, Android) is swallowed and falls through to the existing `root` default, never a connect-blocking error.
  - **Interactive prompt-on-connect deliberately not implemented**: `initiate_connection` resolves username synchronously from the DB row before any network I/O, with no existing round-trip mechanism to pause mid-connect for a frontend dialog and resume with a typed answer (unlike the keyboard-interactive/fingerprint flows, which already have that plumbing for a different purpose). The TODO's phrasing offers resolve-from-config *or* prompt as alternatives; config resolution covers the common case without that added complexity.
  - **Validation:** `cargo check` clean; all 45 backend unit tests pass. A live connect to a blank-username profile with a matching `~/.ssh/config` entry is a recommended manual follow-up.

- [x] 🟢 **P3 · S** — **Auto-Pasting Password for Sudo Prompts** — ✅ Done
  - New backend command `write_saved_password(session_id, terminal_id)` in [`commands/terminal.rs`](file:///d:/REPO/SubTerm/src-tauri/src/commands/terminal.rs) looks up the session's saved SSH password from `session_passwords` (the same map `docker.rs`'s silent-sudo-elevation path already reads) and writes it + `\n` straight into the PTY's input channel — the plaintext password never round-trips into JS.
  - "Paste Saved Password" terminal context-menu action in [`TerminalContextMenu.tsx`](file:///d:/REPO/SubTerm/src/components/TerminalContextMenu.tsx), shown for any non-local (SSH) session; no-ops with a toast if the session has no saved password (e.g. key-based auth).
  - **Validation:** `cargo check` + all 45 backend unit tests pass; `npm run typecheck` and `npm run lint` both clean (same 117 pre-existing baseline problems, no new ones).

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

- [x] 🟡 **P2 · M** — **Vault Export to Portable Formats (JSON / CSV)** — ✅ Done (plain JSON/CSV; encrypted archive deferred)
  - New **Settings → Maintenance → Export Server List**: one-click export of every saved server to JSON or CSV. Purely client-side — `get_servers()` already never returns a plaintext password (confirmed by reading its own doc comment before building on it), so there was no backend change needed; [`src/export/serverExport.ts`](file:///d:/REPO/SubTerm/src/export/serverExport.ts) explicitly **whitelists** exportable fields (name, host, port, username, auth type, folder name, proxy, notes, run-on-connect, production flag, agent-forwarding flag) rather than spreading the raw server row, so a future column added to `servers` is excluded by default instead of silently leaking into an export.
  - Destination picked via the existing `select_local_folder` (desktop) / `android_default_local_dir` (Android) commands, written with the existing `local_write_file_text` — zero new Tauri commands, zero new permissions.
  - **Deliberately did not build the "password-protected encrypted archive" variant** from the TODO's wording — that's effectively a second, separate export format (needs its own KDF/encryption choice, not just a zip password) and the primary ask — a portable, inspectable backup/migration format — is fully served by plain JSON/CSV. Worth a dedicated follow-up if an encrypted-at-rest export is actually needed later.
  - **Validation:** `npm run typecheck`, `npm run lint` (0 errors, 115 pre-existing warnings), and `npm run build` all clean. No backend change, no new unit tests needed (pure data mapping + string formatting, exercised by typecheck).

- [x] 🟡 **P2 · S** — **Portable Standalone Version in Releases** — ✅ Done
  - Added a "Zip portable Windows build" step to the Windows job in [`.github/workflows/release.yml`](file:///d:/REPO/SubTerm/.github/workflows/release.yml) that zips the raw `subterm.exe` into `SubTerm-v<version>-windows-portable.zip` — no installer needed since Tauri embeds the frontend assets into the binary (no `resources` entry in `tauri.conf.json`) and WebView2 already ships with Windows 10/11.
  - The zip is staged alongside the `.msi`/`.exe` artifacts and the release job's flatten step now also picks up `*-portable.zip` so it lands on the GitHub Release.
  - Windows-only, matching the TODO wording ("alongside the Windows NSIS setup and MSI installers") — macOS already ships a zipped `.app` and Linux already ships an installer-free `.AppImage`, so neither needed a portable variant added.
  - **Validation:** YAML parses cleanly (`python -c "import yaml; yaml.safe_load(open(...))"`). Not runnable locally — this only executes on a tag push / manual `workflow_dispatch`, so a real CI run is the actual validation once a release is cut.

- [x] 🟢 **P3 · S** — **Wildcard Character Matching in Server Filter** — ✅ Done
  - [`NodeGrid.tsx`](file:///d:/REPO/SubTerm/src/components/NodeGrid.tsx)'s search now compiles `*`/`?` queries into a case-insensitive regex (escaping every other regex-special character first) and matches against both server name and host. Queries with no wildcard characters fall through to the original plain substring check, so existing search behavior is unchanged.
  - **Validation:** `npm run typecheck` and `npm run lint` clean (no new issues).
