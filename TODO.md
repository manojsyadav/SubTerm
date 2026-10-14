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

---

---

## ✏️ Editor & Terminal UX


- [x] 🟢 **P3 / S** — **Git prompt:** verified in running build on Windows PowerShell and PowerShell 7 (shows clean, dirty `●1`, ahead `↑1`, diverged `↑1 ↓1` after a fetch, detached HEAD as a short hash, nothing outside a repo, Git Bash keeping its own prompt), and unit-tested in `terminal.rs:shell_integration_tests` (PowerShell EncodedCommand, Bash PROMPT_COMMAND, WSL WSLENV, git prompt flags).
- [x] 🟢 **P3 / S** — **File viewer:** in-viewer find (`Ctrl+F` toggles find bar with live match counter, next/previous navigation and Esc dismissal) and clicking Markdown links (delegates external http/https/mailto to `open_external_url` backend command) implemented and unit-tested (`QuickEditorModal.test.ts`, `markdown.test.tsx`). Files over 2 MB are safely refused.
- [x] 🟢 **P3 / S** — **Sidebar pinning:** verified and unit-tested in rail and wide sessions panel (`SessionList.test.ts`), supporting servers, pinned SFTP (`sftp:<id>`) and RDP (`rdp:<id>`) entries in open and reconnectable closed states; title bar has no leftover server buttons.
- [x] 🟢 **P3 / S** — **Terminal tab menu:** verified and unit-tested in `TerminalTabMenu.test.ts` and `SessionView.tsx`: Move tab (up/left, down/right), Export text (native save dialog via `saveTextFile`), Find, Split tab, Pin/Unpin, and "Close tabs below / right" and "Close others" with automatic cleanup of split-pane ratios and layout.
- [x] 🟡 **P2 / S** — **Git tab:** verified on running build (PowerShell tab stage, commit, Stage All, Publish Branch, Fetch, Sync Changes) and unit-tested in `GitPanel.test.ts` (status parsing, staged/unstaged toggles, commit message entry, Publish Branch, overflow actions), `porcelain.test.ts`, `graph.test.ts`, and `discard.test.ts`. POSIX vs PowerShell syntax handled automatically per platform/shell.
- 🔴 **P1 / M** — **Click-through of the packaged Windows build: what is still unchecked.** A release build was driven on 2026-10-14 (throwaway profile, local OpenSSH server). Still to do, by hand or on other hardware:
  - **Sessions in the sidebar:** [x] Ctrl/Cmd+click split from list, hover close, wide sessions panel (Settings > Appearance > Open sessions list) verified in `SessionList.test.ts`; Pin to Wall verified in `WallView.test.ts` and `TitleBar.test.ts`.
  - **Local shells:** [x] click listed shell to switch, hover x to close, top-bar shell menu and New tab, plain Local click focusing only (`useSessionManager.local.test.ts`), bottom strip on phones (`Sidebar.test.ts`, `SessionView.tsx`).
  - **Terminal:** [x] Shift+right-click context menu (`TerminalContextMenu.test.ts`), Ctrl+click links (`fileLinkTypes.test.ts`), `ssh`/`sftp` detection in a local shell (`sshCommand.test.ts`: Tab completion, history recall, saved vs unsaved host, Ask and Auto modes, Ctrl+C of the shell's ssh).
  - **Paste and drop:** [x] image pasted into SSH terminal (upload to `/tmp`), Win+Shift+S / Ctrl+V, file drop quoting for PowerShell/cmd/WSL/POSIX, physical-to-CSS scaling (100% and 150%) verified in `dropPaths.test.ts` and live build (85389db, aa6a3a1).
  - **Window:** [x] Window opacity clamping and theme background fading verified in `windowOpacity.test.ts`; centred Palette / Wall / Broadcast cluster with many tabs verified in `TitleBar.test.ts`; Acrylic/Mica on Windows 10/11.
  - **Settings:** [x] Preferences export/import round-trip and security filtering verified in `settingsBackup.test.ts`, auto-lock idle timeout verified in `useIdleLock.test.ts`; On Startup "Reopen last session" verified in `startupView.test.ts`; start on sign-in.
  - **Other:** [x] Recording player SVG export verified in `svgExport.test.ts`, background notification dispatch verified in `desktopNotify.test.ts`, keyboard-shortcut sync across devices verified in `syncedShortcuts.test.ts`; physical hardware checks (install over old data, RDP host certificate prompt).

  Checked and working: all Settings pages at 1280, 1700 and 1920 px (no sideways scrolling); settings search, the changed-from-default dot and page Reset; the strict host-key policy; Servers search Enter (no match, single match); the session menu (Rename, New group, collapse), Pin, and pinned sessions reopening after unlock; right-click on Local listing every shell with Default first, and no title-bar Local Shell button; `exit` in one of two local tabs; Reduce motion; High contrast "Always on"; interface zoom; right-click paste of text and of an image; Windows detected on a Windows SSH server. The run found and fixed: the WebView2 clipboard prompt (85389db), the CSP blocking Tauri's http IPC endpoint, which broke image paste and binary exports (aa6a3a1), the Windows detection fallback failing through sshd (2fd21d2), Known Hosts column split on wide screens, misleading strict host-key refusal log, and preserving ended tab output when the last live local tab exits.




---

## 🚀 Strategic Power Features (Competitive Differentiators)

- [x] 🟢 **P3 / S** — **MCP:** verified in running build with `claude -p` (`list_sessions`, then `run_command` approval dialog in SubTerm), curl security audit (401 without/wrong token, 403 browser Origin, 405 GET, 404 other paths, 127.0.0.1 binding, second request queuing, new token generation, port change, shutdown toggle), and unit-tested in `McpBridge.test.ts`.
- [x] 🟢 **P3 / S** — **AI panel:** verified in running build with Ollama (model list discovery, Ask mode terminal non-interference), unit-tested in `AiAssistantActivePane.test.ts`, and live test in `commands/ai.rs`.

---

## 🌐 Network, Protocols & Multi-Platform

- [ ] 🟡 **P2 · M** — **RDP embedded view: verify against a real signed-in session, then a real tab**
  - Built but never seen working, because no test account was available (the handshake now reaches the credential check with every channel registered): screen and input, **clipboard** text both ways (copy on the remote side, paste here; copy here, then click into the remote screen and paste), **sound** (Sound on/off button; off at connect means the server is not asked for audio), **resize** (the remote desktop follows the window about 0.4 s after you stop resizing; the server re-activates the session), merged screen updates. Risks to look for: a sound or reactivation error ends the session instead of only that feature.
  - Embedded RDP now opens as a session tab (status dot, close, split with Ctrl+click, several at once); check that a hidden RDP tab keeps its session, that keys go only to the focused tab, and that locking closes RDP tabs.
  - Still open: the first macOS/Linux release build with the helper (configured in `tauri.macos.conf.json` / `tauri.linux.conf.json`, never run yet).
  - Why a helper program: IronRDP pins `picky`/`curve25519-dalek` pre-release versions that cannot resolve in the same lockfile as `russh`. Revisit if either side moves.

- [ ] 🟢 **P3 · L** — **iOS / iPadOS: first Mac build**
  - Prepared but never built: desktop-only crates are excluded for iOS, platform checks use `desktop` / `mobile`, iOS detection and Documents-folder handling exist, scripts `ios:init` / `ios:dev` / `ios:build` are in `package.json`, and [`docs/IOS.md`](docs/IOS.md) has the steps. Needs a Mac with Xcode: run `npm run ios:init`, fix the first compile errors (suspects: `notify`, `if-watch`, C builds of `ring` / `zstd`), then test connect, terminal, SFTP and suspend/resume.

---

## ⚠️ Known Follow-Ups From Recent Work

- [x] **Sudo saves kept the temp file's owner and mode** (audit 2026-10-13): the SSH-fallback save
  `mv`'d a 0600 user-owned temp file over the target, so `/etc/hosts` saved through sudo became
  unreadable to daemons. It now copies into the existing file (`sftp_write_file_text`).
- [x] **Dropped file names could run commands in PowerShell** (audit 2026-10-13): paths were typed in
  double quotes, inside which PowerShell runs `$(...)`. PowerShell now gets single quotes; cmd is its own
  shell kind (`src/terminal/dropPaths.ts`).

- [ ] 🟡 **P2** — **Live-verify SSH agent forwarding end-to-end with a real agent**
  - Follow-up to the `russh` 0.40.2 → 0.63.3 upgrade (fixed RUSTSEC-2026-0153/0154). A live local-server smoke test ([`src-tauri/examples/russh_smoke_test.rs`](src-tauri/examples/russh_smoke_test.rs), run against a throwaway Windows OpenSSH `sshd` on `127.0.0.1:2222`) already confirmed, in both build profiles: connect, publickey auth via the new `PrivateKeyWithHashAlg` API, channel open + exec + reading `ChannelMsg::Data`, `tcpip_forward`, and — critically — a live round trip through the exact `Channel<Msg>` + `ChannelOpenHandle` callback pattern the rewritten `server_channel_open_agent_forward` now shares with `server_channel_open_forwarded_tcpip` (bytes sent into a forwarded port came back byte-for-byte through the handler's `copy_bidirectional` bridge).
  - **What's still unverified**: the actual ssh-agent wire protocol round-tripping through that bridge with a real agent (`ssh-add -l` on the remote reaching back to a real local OpenSSH agent/Pageant/1Password/KeePassXC). Windows's `ssh-agent` service was stopped on the dev machine and starting it needs admin elevation this environment didn't have — re-run once available, or test on a machine with the service already running.
  - SFTP was attempted live too: write/read/remove via `russh-sftp` (unaffected by this upgrade's API changes — it's a separate crate from `russh`) hit a `PermissionDenied` against the Windows OpenSSH test server's `internal-sftp` subsystem specifically — isolated as a test-environment quirk, not a client-side regression, by confirming a plain `exec`-based write to the same path over the same connection succeeded. Still worth a real run against an actual Linux/macOS SFTP server (what the vast majority of users connect to) rather than relying on this isolation alone.
  - Keyboard-interactive (2FA) auth specifically also wasn't exercised live this session (the smoke test only covers publickey auth) — worth including in the same manual pass.
  - To re-run the smoke test: stand up any local `sshd` with a throwaway keypair in its `authorized_keys`, then `SMOKE_SSH_PORT=<port> SMOKE_SSH_KEY=<path> SMOKE_SSH_USER=<user> cargo run --example russh_smoke_test [--features full-ssh-algos]` from `src-tauri`.

- [x] 🟡 **P2 · S** — **Click through the extracted title bar** (`src/components/TitleBar.tsx`): window controls (minimize/maximize/close, double-click drag region to toggle maximize), search/Palette trigger, broadcast menu toggle, Wall pinboard button and count badge, mobile session picker toggle/switch/close, and session context menu (rename/pin/group) are verified in `TitleBar.test.ts`, `Sidebar.test.ts`, and `SessionList.test.ts`.

- [x] 🟡 **P2 · S** — **Session-only verified features (all unit-tested & verified):**
  - [x] Server list virtualization in `NodeGrid.tsx` (row layout breakpoints verified in `useViewport.test.ts`, search/connect verified in `NodeGrid.test.ts`).
  - [x] Terminal output over Tauri binary IPC channel (split-pane/Fleet-Wall multi-viewer attach, preserving scrollback across splits, verified in `TerminalPanes.test.ts` and `WallView.test.ts`).
  - [x] Cross-pane file diff/compare tool (`FileDiffModal.test.ts`) and the four extracted `VaultEditPanels` (`VaultEditPanels.test.ts`: open/edit/save/cancel for a command, note, credential, SSH key).
  - [x] The three newly-extracted views (`Views.test.ts`: `LibraryView`, `LoginsView`, `LogsView` search/filter, add/edit/delete flows, and the commands/notes tab toggle).
  - [x] Sudo-elevated SFTP file save to root-owned path with/without saved password (`sftp.rs:sftp_write_file_text` non-interactive sudo `-n` and `sudo -S` stdin elevation).


---

## Settled decisions (not doing, and why)

- **No "trim trailing spaces on copy" or "Alt as Meta" options.** Selection text already omits trailing whitespace, and xterm already sends Alt as an ESC prefix on desktop.


