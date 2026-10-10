# SubTerm Backlog & TODO Roadmap

This document tracks active development tasks, pending architectural optimizations, and planned features for future SubTerm releases.

> Completed work isn't tracked here — see [`docs/RELEASE_NOTES.md`](docs/RELEASE_NOTES.md) for what's shipped and git history for implementation detail. This file lists only what's still open.

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

- [ ] 🟡 **P2 · L** — **Triage `.unwrap()` / `.expect()` in the Rust Backend**
  - 219 occurrences across `src-tauri/src` (168 in `lib.rs` alone, 23 in `tunnel.rs`, 15 in `identity.rs`). A panic in any of these can crash the whole Tauri process, killing every open SSH session, not just one request.
  - Prioritize paths touching untrusted network input (SSH packet/channel handling) and on-disk vault/config parsing — replace with `Result` propagation and surfaced errors.
  - **Validation:** `grep -rc unwrap\|expect` count trends down in connection/vault-handling modules; fuzzed/malformed inputs no longer crash the app.

- [ ] 🟢 **P3 · L** — **Reduce `any` / `as any` in the TypeScript Frontend**
  - 239 occurrences across `src/**/*.tsx`/`*.ts` with no lint rule currently flagging new ones.
  - Backfill proper types incrementally, starting with session/file-path handling code where a mistyped value has real consequences.
  - **Validation:** `grep -rc ": any\|as any"` count trends down; new PRs can't introduce more once ESLint's `no-explicit-any` is enabled.

---

## ⚡ Core Performance & IPC Optimizations

- [ ] 🟡 **P2 · L** — **SFTP Pipelined Transfers & Concurrent Chunking**
  - Implement multi-stream concurrent byte-range chunking for large single-file transfers across parallel SFTP channels.
  - Automatically saturate high-bandwidth, high-latency WAN links beyond the current 256 KiB sequential pipelined stream.

---

## ✏️ Editor & Terminal UX

- [ ] 🔴 **P1 · M** — **Syntax Highlighting in the Quick Editor (CodeMirror 6)**
  - `QuickEditorModal.tsx` is a plain `<textarea>` with a hand-rolled line-number gutter; no editor library is in the project. Replace it with CodeMirror 6 (`@codemirror/state|view|commands|language|search` + `@codemirror/legacy-modes` for shell/nginx/properties/toml), importing only the languages we need to keep the bundle growth to roughly 150–250 KB.
  - Pick the language from file name/extension (`.sh`/`.bashrc`, `.conf`, `.yml`, `.json`, `.toml`, `.py`, `.js/.ts`, `.service`/`.ini`, `Dockerfile`, `.env`); fall back to plain text. Dark theme matching the current `#0d0d11` look.
  - Keep Ctrl+S / Esc, the 2 MB read cap, dirty-state tracking, and the Diff toggle working unchanged.
  - **Validation:** open `.sh`, `.yml`, nginx `.conf`, `.json` over SFTP and locally — each highlights correctly; edit + save round-trips byte-identical content; unknown extensions open as plain text; `npm run build` passes.

- [ ] 🔴 **P1 · S** — **"Hide Comments" Toggle in the Quick Editor** (depends on syntax highlighting above)
  - Header button next to Diff; off by default, choice persisted in `localStorage`. Collapses comment-only lines/blocks into a single clickable `⋯ N comment lines hidden` marker; trailing comments on code lines stay visible.
  - Comment detection via the syntax tree for known languages, line-prefix fallback (`#`, `//`, `;`) for plain files.
  - View-only decoration — the document is never modified, so saving always writes the full file. Show "N lines hidden" in the status bar; auto-expand a block when the cursor enters it or an edit touches its boundary.
  - **Validation:** toggling hides/shows comment blocks in `.sh`, `.yml`, `.conf`; saving with comments hidden leaves the file's comment lines intact; unit tests cover comment-line detection per language.

- [ ] 🟡 **P2 · S** — **Regression test: splitting a terminal keeps scrollback**
  - Guards the fix in `fd99aeb` (terminals share one flat id-keyed list so split/unsplit never remounts a `TerminalView`). The repo has no component tests yet; add a minimal one (or a documented manual check in `docs/`) so the layout isn't re-split into separate trees later.

- [ ] 🟡 **P2 · M** — **Split-pane polish**
  - Persist split layout (members, orientation, ratios) per session across restarts.
  - Keyboard shortcuts for focus next/previous pane and for split right/down, registered in `src/shortcuts/defaults.ts`.

---

## 🚀 Strategic Power Features (Competitive Differentiators)

- [ ] 🟡 **P2 · L** — **Terminal Session Recording & Export (.cast / Asciinema)**
  - Native timed session recorder capturing stdout, stdin, and resize events according to the Asciinema v2 (`.cast`) standard.
  - Export to `.cast` files, raw terminal log dumps, or animated SVG/GIF for runbooks, documentation, and compliance audit trails.
  - In-app playback preview modal with play/pause, scrub slider, and playback speed controls.

- [ ] 🟡 **P2 · M** — **Cloud Sync Enhancements & Conflict Resolution** (first slice shipped)
  - **Done**: read-only visual diffing for concurrent edits. `profile_sync_stats`'s out-of-sync list now carries each entity's uuid and push/pull direction; a new `sync_conflict_diff(uuid)` command decrypts and pretty-prints the local vs. cloud copy (secrets redacted) for a one-click diff view in **Settings → Cloud Sync**, reusing the existing `computeDiff` line-diff algorithm via a new `SyncConflictDiffModal.tsx`. This is visibility only — the underlying merge is still deterministic Last-Write-Wins by HLC stamp; nothing about the merge rule changed.
  - **Not done (re-scope as its own follow-up)**: granular per-table push/pull selection (today a sync is all-or-nothing across all `SYNCED_TABLES`), and keyboard-shortcut sync — shortcuts (`src/shortcuts/useShortcutsStore.ts`) live entirely in `localStorage`, outside the vault/sync system; bringing them in needs a new table + triggers + `SYNCED_TABLES` entry + a migration off `localStorage`, which is its own well-scoped S/M task.
  - Interactive conflict *resolution* (picking a field from each side rather than accepting LWW) was explicitly scoped out as true M/L work; the diff view above covers the more valuable half of the ask — seeing what's about to be overwritten — without touching the merge protocol.

- [ ] 🟢 **P3 · XL** — **Dual-Pane Remote-to-Remote SFTP Sync**
  - Side-by-side split SFTP view (Commander / WinSCP style) allowing direct transfers between two distinct remote SSH servers.
  - Stream data directly from Server A to Server B in memory without staging unencrypted files onto the local host disk.

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

## ⚠️ Known Follow-Ups From Recent Work

- [ ] 🟡 **P2** — **Live-verify SSH agent forwarding end-to-end with a real agent**
  - Follow-up to the `russh` 0.40.2 → 0.63.3 upgrade (fixed RUSTSEC-2026-0153/0154). A live local-server smoke test ([`src-tauri/examples/russh_smoke_test.rs`](file:///d:/REPO/SubTerm/src-tauri/examples/russh_smoke_test.rs), run against a throwaway Windows OpenSSH `sshd` on `127.0.0.1:2222`) already confirmed, in both build profiles: connect, publickey auth via the new `PrivateKeyWithHashAlg` API, channel open + exec + reading `ChannelMsg::Data`, `tcpip_forward`, and — critically — a live round trip through the exact `Channel<Msg>` + `ChannelOpenHandle` callback pattern the rewritten `server_channel_open_agent_forward` now shares with `server_channel_open_forwarded_tcpip` (bytes sent into a forwarded port came back byte-for-byte through the handler's `copy_bidirectional` bridge).
  - **What's still unverified**: the actual ssh-agent wire protocol round-tripping through that bridge with a real agent (`ssh-add -l` on the remote reaching back to a real local OpenSSH agent/Pageant/1Password/KeePassXC). Windows's `ssh-agent` service was stopped on the dev machine and starting it needs admin elevation this environment didn't have — re-run once available, or test on a machine with the service already running.
  - SFTP was attempted live too: write/read/remove via `russh-sftp` (unaffected by this upgrade's API changes — it's a separate crate from `russh`) hit a `PermissionDenied` against the Windows OpenSSH test server's `internal-sftp` subsystem specifically — isolated as a test-environment quirk, not a client-side regression, by confirming a plain `exec`-based write to the same path over the same connection succeeded. Still worth a real run against an actual Linux/macOS SFTP server (what the vast majority of users connect to) rather than relying on this isolation alone.
  - Keyboard-interactive (2FA) auth specifically also wasn't exercised live this session (the smoke test only covers publickey auth) — worth including in the same manual pass.
  - To re-run the smoke test: stand up any local `sshd` with a throwaway keypair in its `authorized_keys`, then `SMOKE_SSH_PORT=<port> SMOKE_SSH_KEY=<path> SMOKE_SSH_USER=<user> cargo run --example russh_smoke_test [--features full-ssh-algos]` from `src-tauri`.

- [ ] 🟡 **P2 · M** — **Further `DesktopApp.tsx` decomposition (wall view, session-tab sidebar)**
  - This session's decomposition pass pulled the Library (commands/notes), Logins (passwords/SSH keys), and Logs (Activity) views out into `src/components/{LibraryView,LoginsView,LogsView}.tsx` — pure UI extractions, state stays lifted in `DesktopApp.tsx`, zero behavior change, each verified independently (`typecheck`/`lint`/`build`). File went 2,991 → 2,659 lines.
  - Still well short of the original <400-line aspiration. The remaining bulk is the Fleet Wall view (~235 lines) and the session-tab sidebar/drag-reorder/tiling logic — both read/write `activeView` state and session refs throughout, making them visibly more entangled than the three views already pulled out. Deliberately deferred rather than rushed, since a slip here breaks live SSH sessions, not just a static view.
  - No component-level test coverage exists yet — each further cut still needs manual click-through verification, not just `npm run typecheck`.
  - **Validation:** `npm run typecheck` passes; all tabs, wall, and vault operations behave identically; manual click-through of whatever view is touched.

- [ ] 🟡 **P2 · S** — **Manual click-through for session-only verified features**
  - Several features this session were validated by `typecheck`/`lint`/`build`/unit tests only, not live interaction — bundling as one follow-up pass rather than one line each:
    - Server list virtualization in `NodeGrid.tsx` (scroll + drag-reorder on a 500+-server fleet, resize across the 1024/1280px breakpoints).
    - Terminal output over the new Tauri binary IPC channel (firehose throughput, split-pane/Fleet-Wall multi-viewer attach, reconnect).
    - Cross-pane file diff/compare tool (`FileDiffModal`) and the four extracted `VaultEditPanels` (open/edit/save/cancel for a command, note, credential, SSH key).
    - The three newly-extracted views (`LibraryView`, `LoginsView`, `LogsView`): search/filter, add/edit/delete flows, and the commands/notes tab toggle.
    - Sudo-elevated SFTP file save to a root-owned path, with and without a saved session password.
