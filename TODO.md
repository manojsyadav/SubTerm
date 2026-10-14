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

- 🔴 **P1 / S** — **Find out why a profile opened with no password prompt.** On 2026-10-14, the release build from 15:31, started with an empty WebView2 storage folder (so no saved biometric token), went straight to the `HomeLab` profile's server list without asking for the master password. The instance was stopped before anything was written. Check `useProfileVault` / `MasterUnlockPage` and the backend `select_profile` / `setup_master_db` path for an automatic unlock, and whether the vault is still encrypted at rest.
- 🟡 **P2 / S** — Push `main` to Gitea (`origin`, 10.0.0.20:222). It is about 50 commits ahead of `origin/main`, including the AI assistant merge (febbe85) and the fixes after it.
- 🟡 **P2 / S** — Merge the two branches that are not in `main` yet: `docs/standard-set` (2 commits: data model, backup and recovery, runbook and troubleshooting pages, architecture sequence diagrams) and `docs/session-split-release-note` (1 commit).
- 🟢 **P3 / S** — Merge `feat/ai-assistant` into `main` again for whatever lands on it after febbe85 (another session was still committing to it).

- 🟢 **P3 / S** — Git prompt: still to try in the app with plain bash and WSL bash (only Docker's `sh` distro was available), with oh-my-posh, and in a very large repo (prompt delay). Checked in a running build on 2026-10-14: Windows PowerShell and PowerShell 7 show clean, dirty `●1`, ahead `↑1`, diverged `↑1 ↓1` after a fetch, detached HEAD as a short hash, and nothing outside a repo. Git Bash keeps its own `(main)` prompt, as designed.
- 🟢 **P3 / S** — File viewer: still to try Ctrl+F in view mode and clicking a Markdown link (opens the browser). Checked in a running build: local and remote (SFTP) files open read-only, Edit then Save writes the file, README.md renders headings, task lists, tables and code, and literal `<img onerror>` / `<script>` stay text and never run. Files over 2 MB are refused; that check found the overwrite bug fixed in b6524f4.
- 🟢 **P3 / S** — Sidebar pinning: still to try in the wide sessions panel, and pinned SFTP and RDP entries. Checked in the rail: pin, close (stays as "pinned, not open"), reconnect by clicking it, unpin; the title bar has no server buttons left.
- 🟢 **P3 / S** — Terminal tab menu: still to try in the wide sessions panel and on a tab inside an SSH session, Move tab, Export text (native save dialog), and "Close tabs below" with a split open. Checked on a local tab in the rail: rename shows in the sidebar, Duplicate and Split keep the shell, colour stripe, Find, Close other tabs.
- 🟡 **P2 / S** — Git tab: still to try on an SSH server with a POSIX shell (stage, commit, Publish, Sync) and a push that asks for a password. Checked on a local Windows PowerShell tab: typed repository folder, stage one file, commit, Stage All, Publish Branch to a bare origin, Fetch, Sync Changes 1↓. It cannot work on SSH hosts whose shell is not POSIX (a Windows OpenSSH server running cmd), since it sends `export …; cd …`.
- 🔴 **P1 / M** — **Click-through of the packaged Windows build: what is still unchecked.** A release build was driven on 2026-10-14 (throwaway profile, local OpenSSH server). Still to do, by hand or on other hardware:
  - **Sessions in the sidebar:** Ctrl+click split from the list, hover close, Pin to Wall, the wide sessions panel (Settings > Appearance > Open sessions list).
  - **Local shells:** click a listed shell to switch, hover x to close, the top-bar shell menu and New tab, a plain Local click only focusing, the strip on phones.
  - **Terminal:** Shift+right-click menu, Ctrl+click links, `ssh`/`sftp` detection in a local shell (Tab completion, history recall, saved vs unsaved host, Ask and Auto modes, Ctrl+C of the shell's ssh).
  - **Paste and drop:** an image pasted into an SSH terminal (upload to `/tmp` on a Linux server); Win+Shift+S then Ctrl+V; dropping files from Explorer (local PowerShell, cmd, Git Bash, WSL; SSH upload; 100% and 150% scaling; a split pane).
  - **Window:** the centred Palette / Wall / Broadcast cluster with many tabs; Window opacity and Background effect (Acrylic, Mica) on Windows 10 and 11, with WebGL on and off, resizing and maximising.
  - **Settings:** On Startup "Reopen last session" (needs a full app restart, not a lock), auto-lock, preferences export/import (native dialogs), start on sign-in, High contrast "Follow system" with a Windows contrast theme, the Profile / Cloud Sync / Quick Commands card titles.
  - **Other:** recording player Export SVG and "Always record this server"; long-command notifications in local PowerShell and Git Bash (needs someone to see the toast); keyboard-shortcut sync between two devices; the identifier move to `com.subterm.desktop` (install over old data, then uninstall the old entry); the embedded-RDP certificate prompt (needs an RDP host); the RDP and Network Tools sidebar entries; closing the SFTP page returns to the terminal.

  Checked and working: all Settings pages at 1280, 1700 and 1920 px (no sideways scrolling); settings search, the changed-from-default dot and page Reset; the strict host-key policy; Servers search Enter (no match, single match); the session menu (Rename, New group, collapse), Pin, and pinned sessions reopening after unlock; right-click on Local listing every shell with Default first, and no title-bar Local Shell button; `exit` in one of two local tabs; Reduce motion; High contrast "Always on"; interface zoom; right-click paste of text and of an image; Windows detected on a Windows SSH server. The run found and fixed three bugs: the WebView2 clipboard prompt (85389db), the CSP blocking Tauri's http IPC endpoint, which broke image paste and binary exports (aa6a3a1), and the Windows detection fallback failing through sshd (2fd21d2).
- 🟢 **P3 / S** — Settings > System at 1920 px: the Known Hosts card and its empty state ("No trusted host keys recorded yet") land in different columns, so the empty state looks like a separate card.
- 🟢 **P3 / S** — With the strict host-key policy on, a refused connection's log ends with "Host key was not approved. Reconnect to see the fingerprint prompt again", but reconnecting shows no prompt while the policy is strict. The line before it explains it correctly.
- 🟢 **P3 / S** — `exit` in the last live local tab, when the only other tab had already ended, closes the whole Local view, including the ended tab's output. With one tab, `exit` keeps the ended tab with Reconnect / Close.
- 🟡 **P2 / S** — The update check (startup banner, Settings > General > Updates) queries `github.com/manojsyadav/SubTerm` releases anonymously, which currently returns 404: make the repository public and publish a release (tag `vX.Y.Z`) for it to find anything. A self-installing updater would additionally need the Tauri updater plugin and a signing key.
- 🟡 **P2 / S** — Verify background notifications in the packaged Windows build (seeing the toast needs a person). Clipboard-clear-on-lock was checked in a running build: with SubTerm focused, locking emptied the clipboard.



---

## 🚀 Strategic Power Features (Competitive Differentiators)

- 🟢 **P3 / S** — MCP: nothing left except a run on macOS and Linux. Checked in a running build with a real `claude -p` (list_sessions, then run_command approved in SubTerm), and with curl: 401 without or with the wrong token, 403 with a browser Origin, 405 for GET, 404 for other paths, 127.0.0.1 only; Decline returns an error to the agent; a second request waits for the first dialog; New token cuts off the old one; a port change moves the server; switching off stops it. The New token check found the restart bug fixed in 07fbcb4.
- 🟢 **P3 / S** — AI panel: run it once with a real Anthropic key (`SUBTERM_AI_LIVE_KEY`, see the live test in `commands/ai.rs`). Checked in a running build with Ollama: providers set up through Settings (model list loaded), Ask mode on an SSH session asked to run `whoami`, then answered from its output; the terminal stayed untouched.

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

- [ ] 🟡 **P2 · S** — **Click through the extracted title bar** (`src/components/TitleBar.tsx`, moved out of `DesktopApp.tsx`, which is now ~1,700 lines, down from 2,823): the session menu now opened from the sidebar session lists (the tab strip is gone; rename, pin to Wall, close others / to the right), close with and without a live connection, the mobile session picker, the sidebar's workspace button (now the only workspace control: shows the workspace icon, name on hover), local-shell menu, quick-access bookmarks, broadcast menu, Wall button, minimise / maximise / close. The move was mechanical (same JSX, values passed as props) and two component tests cover tab switch and close, but nothing has been clicked in the app.

- [ ] 🟡 **P2 · S** — **Manual click-through for session-only verified features**
  - Several features this session were validated by `typecheck`/`lint`/`build`/unit tests only, not live interaction — bundling as one follow-up pass rather than one line each:
    - Server list virtualization in `NodeGrid.tsx` (scroll + drag-reorder on a 500+-server fleet, resize across the 1024/1280px breakpoints).
    - Terminal output over the new Tauri binary IPC channel (firehose throughput, split-pane/Fleet-Wall multi-viewer attach, reconnect).
    - Cross-pane file diff/compare tool (`FileDiffModal`) and the four extracted `VaultEditPanels` (open/edit/save/cancel for a command, note, credential, SSH key).
    - The three newly-extracted views (`LibraryView`, `LoginsView`, `LogsView`): search/filter, add/edit/delete flows, and the commands/notes tab toggle.
    - Sudo-elevated SFTP file save to a root-owned path, with and without a saved session password.


---

## Settled decisions (not doing, and why)

- **No re-wrapping of long lines in a narrow local Windows pane.** A line wider than the pane is cut at the edge until the pane is wider again. ConPTY repaints the screen from its own copy after a resize, and that copy cuts the line; `portable-pty` already passes `PSEUDOCONSOLE_RESIZE_QUIRK`. Letting xterm own the screen would need ConPTY's experimental passthrough mode, which means patching `portable-pty`, and it changes how every console program's output is handled. Revisit if passthrough becomes the ConPTY default.
- **No tar fast path for folder transfers** (removed 2026-10-13). It ran `tar` on the server and unpacked locally, which skipped every local path guard — a malicious server could drop files outside the chosen folder, e.g. into the Windows Startup folder — quoted server paths in double quotes (so `$(…)` ran), used guessable `/tmp` names, and reported "done" when tar failed. Folder transfers always use the guarded per-file walk. Revisit only with extraction into a temp dir plus per-entry validation, single-quote escaping, `mktemp`, and exit-code checks.
- **No transfer-concurrency setting.** Uploads and downloads take one slot per session on purpose (`acquireTransferSlot`): two transfers aimed at the same path would both pass the backend's exists check and write into the file together. Revisit only with a per-path lock.
- **No "trim trailing spaces on copy" or "Alt as Meta" options.** Selection text already omits trailing whitespace, and xterm already sends Alt as an ESC prefix on desktop.
- **No separate "show hidden files by default" setting.** The file browser's own toggle already remembers the choice.
- **Monitoring intervals and alert thresholds stay on the Monitor page.** Settings only holds the on/off switch and a link; duplicating them would put one value in two places.
