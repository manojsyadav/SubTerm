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

- 🔴 **P1 / M** — **Click-through of everything added in the settings/navigation overhaul, in a packaged Windows build.** Also: the sidebar session lists that replaced the top tabs (Servers / SFTP / RDP under their icons, or the wide panel from Settings > Appearance > Open sessions list; click, Ctrl+click split, right-click menu with Rename, Pin, Group, Wall, split and close; hover close; groups collapse; pinned sessions reopen after unlock; quick commands now share the row with Snippets / Docker / System); pasting an image (Win+Shift+S, then Ctrl+V, right-click paste and the menu's Paste) into a local and an SSH terminal; dropping files onto a terminal (local PowerShell, cmd, Git Bash and WSL type the quoted path; an SSH session uploads to `/tmp/subterm-drop-…` and types that path; try at 100% and 150% Windows scaling, and in a split pane); the identifier move to `com.subterm.desktop` (install over a machine with old data: profiles, preferences, sync device and recordings should all be there; then uninstall the old entry); the centred Palette / Wall / Broadcast cluster with many tabs; Settings > Appearance > Window opacity and Background effect (Acrylic, Mica) on Windows 10 and 11, with WebGL on and off, including resizing and maximising; keyboard-shortcut sync between two devices (change, reset, and the first-unlock upload of existing shortcuts); recording player > Export SVG (open the file in a browser), and right-click > Always record this server (saved to the app data recordings folder when the tab closes); Reduce motion (its stylesheet was never loaded before) and High contrast (On, and Follow system with Windows contrast themes); SFTP page > This computer (local files with no server); long-command notifications in a local PowerShell and Git Bash tab with no setup (built-in shell integration); the Profile, Cloud Sync and Quick Commands cards now carry their title inside the card; local shells listed in the sidebar under Local on desktop (Local and + ask which shell, Default first; click a listed shell to switch, hover x to close; the title-bar Local Shell button is gone; the strip keeps them on phones), as sub-tabs of the single Local tab (sidebar right-click shell, top-bar shell menu, New tab; a plain Local click only focuses; each sub-tab runs its own shell; `exit` in the last sub-tab); right-click on the sidebar Local item to pick a shell; the embedded-RDP certificate prompt (first connect, a changed certificate, Cancel, closing the window at the prompt). None of it has been run in the app yet (automated checks only). Cover: smart right-click and Shift+right-click menu; `exit` closing a local PowerShell/cmd/bash tab; Ctrl+Click links; `ssh`/`sftp` detection (Tab completion, history recall, saved vs unsaved host, Ask and Auto modes, Ctrl+C of the shell's ssh); Servers search Enter (single match, IP, `user@ip`, bare word) and the lightning button; Local, SFTP (close returns to the terminal), RDP and Network Tools sidebar entries; On Startup modes; every Settings page at 1280, 1700 and 1920 px; search, dots and Reset; auto-lock, preferences export/import, interface zoom, start on sign-in, strict host-key policy.
- 🟢 **P3 / S** — The nested-ssh guard now also clears when PowerShell's or cmd's own prompt comes back. A silent ssh end in a local bash/WSL shell still leaves it set until the next accepted offer (their prompt looks like a remote one).
- 🟡 **P2 / S** — The update check (startup banner, Settings > General > Updates) queries `github.com/manojsyadav/SubTerm` releases anonymously, which currently returns 404: make the repository public and publish a release (tag `vX.Y.Z`) for it to find anything. A self-installing updater would additionally need the Tauri updater plugin and a signing key.
- 🟡 **P2 / S** — Verify background notifications and clipboard-clear-on-lock in the packaged Windows build; both depend on webview/OS permissions that tests cannot cover.



---

## 🚀 Strategic Power Features (Competitive Differentiators)

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

- [ ] 🟡 **P2** — **Live-verify SSH agent forwarding end-to-end with a real agent**
  - Follow-up to the `russh` 0.40.2 → 0.63.3 upgrade (fixed RUSTSEC-2026-0153/0154). A live local-server smoke test ([`src-tauri/examples/russh_smoke_test.rs`](src-tauri/examples/russh_smoke_test.rs), run against a throwaway Windows OpenSSH `sshd` on `127.0.0.1:2222`) already confirmed, in both build profiles: connect, publickey auth via the new `PrivateKeyWithHashAlg` API, channel open + exec + reading `ChannelMsg::Data`, `tcpip_forward`, and — critically — a live round trip through the exact `Channel<Msg>` + `ChannelOpenHandle` callback pattern the rewritten `server_channel_open_agent_forward` now shares with `server_channel_open_forwarded_tcpip` (bytes sent into a forwarded port came back byte-for-byte through the handler's `copy_bidirectional` bridge).
  - **What's still unverified**: the actual ssh-agent wire protocol round-tripping through that bridge with a real agent (`ssh-add -l` on the remote reaching back to a real local OpenSSH agent/Pageant/1Password/KeePassXC). Windows's `ssh-agent` service was stopped on the dev machine and starting it needs admin elevation this environment didn't have — re-run once available, or test on a machine with the service already running.
  - SFTP was attempted live too: write/read/remove via `russh-sftp` (unaffected by this upgrade's API changes — it's a separate crate from `russh`) hit a `PermissionDenied` against the Windows OpenSSH test server's `internal-sftp` subsystem specifically — isolated as a test-environment quirk, not a client-side regression, by confirming a plain `exec`-based write to the same path over the same connection succeeded. Still worth a real run against an actual Linux/macOS SFTP server (what the vast majority of users connect to) rather than relying on this isolation alone.
  - Keyboard-interactive (2FA) auth specifically also wasn't exercised live this session (the smoke test only covers publickey auth) — worth including in the same manual pass.
  - To re-run the smoke test: stand up any local `sshd` with a throwaway keypair in its `authorized_keys`, then `SMOKE_SSH_PORT=<port> SMOKE_SSH_KEY=<path> SMOKE_SSH_USER=<user> cargo run --example russh_smoke_test [--features full-ssh-algos]` from `src-tauri`.

- [ ] 🟡 **P2 · S** — **Click through the extracted title bar** (`src/components/TitleBar.tsx`, moved out of `DesktopApp.tsx`, which is now ~1,700 lines, down from 2,823): tab switch, Ctrl+click split, right-click and double-click tab menu (rename, pin to Wall, close others / to the right), close with and without a live connection, the mobile session picker, the sidebar's workspace button (now the only workspace control: shows the workspace icon, name on hover), local-shell menu, quick-access bookmarks, broadcast menu, Wall button, minimise / maximise / close. The move was mechanical (same JSX, values passed as props) and two component tests cover tab switch and close, but nothing has been clicked in the app.

- [ ] 🟡 **P2 · S** — **Manual click-through for session-only verified features**
  - Several features this session were validated by `typecheck`/`lint`/`build`/unit tests only, not live interaction — bundling as one follow-up pass rather than one line each:
    - Server list virtualization in `NodeGrid.tsx` (scroll + drag-reorder on a 500+-server fleet, resize across the 1024/1280px breakpoints).
    - Terminal output over the new Tauri binary IPC channel (firehose throughput, split-pane/Fleet-Wall multi-viewer attach, reconnect).
    - Cross-pane file diff/compare tool (`FileDiffModal`) and the four extracted `VaultEditPanels` (open/edit/save/cancel for a command, note, credential, SSH key).
    - The three newly-extracted views (`LibraryView`, `LoginsView`, `LogsView`): search/filter, add/edit/delete flows, and the commands/notes tab toggle.
    - Sudo-elevated SFTP file save to a root-owned path, with and without a saved session password.


---

## Settled decisions (not doing, and why)

- **No tar fast path for folder transfers** (removed 2026-10-13). It ran `tar` on the server and unpacked locally, which skipped every local path guard — a malicious server could drop files outside the chosen folder, e.g. into the Windows Startup folder — quoted server paths in double quotes (so `$(…)` ran), used guessable `/tmp` names, and reported "done" when tar failed. Folder transfers always use the guarded per-file walk. Revisit only with extraction into a temp dir plus per-entry validation, single-quote escaping, `mktemp`, and exit-code checks.
- **No transfer-concurrency setting.** Uploads and downloads take one slot per session on purpose (`acquireTransferSlot`): two transfers aimed at the same path would both pass the backend's exists check and write into the file together. Revisit only with a per-path lock.
- **No "trim trailing spaces on copy" or "Alt as Meta" options.** Selection text already omits trailing whitespace, and xterm already sends Alt as an ESC prefix on desktop.
- **No separate "show hidden files by default" setting.** The file browser's own toggle already remembers the choice.
- **Monitoring intervals and alert thresholds stay on the Monitor page.** Settings only holds the on/off switch and a link; duplicating them would put one value in two places.
