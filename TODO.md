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



---

## 🚀 Strategic Power Features (Competitive Differentiators)

- [ ] 🟢 **P3 · M** — **Session Recording: remaining export formats**
  - Recording to `.cast`/text and the in-app player are done. Still open: animated SVG/GIF export for runbooks, and an optional "always record this server" setting for audit trails.

- [ ] 🟢 **P3 · S/M** — **Cloud Sync: keyboard-shortcut sync**
  - Per-device "what to sync" selection and the read-only conflict diff are shipped. Still open: keyboard shortcuts (`src/shortcuts/useShortcutsStore.ts`) live entirely in `localStorage`, outside the vault/sync system; syncing them needs a new table + triggers + `SYNCED_TABLES`/`ENTITIES` entry + a vault schema migration and a one-time import from `localStorage`. Decide first whether per-OS key differences (Cmd vs Ctrl) make cross-device sync desirable at all.

---

## 🌐 Network, Protocols & Multi-Platform

- [ ] 🟢 **P3 · L** — **RDP embedded view: finish and harden**
  - First slice is in (beta, opt-in in Settings): login, screen, keyboard, mouse, wheel, Ctrl+Alt+Del. The handshake was exercised against a local Windows RDP server (it reaches the credential check and returns the expected logon failure), but a full signed-in session — screen updates, input, disconnect — has not been verified; test it against a real host first.
  - Still open: clipboard (`ironrdp-cliprdr`), resize on window change (display control), certificate trust-on-first-use instead of accepting any certificate, audio, dirty-rectangle batching for slow links, a real tab instead of a full-window view, shipping the helper in installer bundles (`tauri.conf.json` resources), Linux/macOS helper builds in CI.
  - Why a helper program: IronRDP pins `picky`/`curve25519-dalek` pre-release versions that cannot resolve in the same lockfile as `russh`. Revisit if either side moves.

- [ ] 🟢 **P3 · L** — **iOS / iPadOS: first Mac build**
  - Prepared but never built: desktop-only crates are excluded for iOS, platform checks use `desktop` / `mobile`, iOS detection and Documents-folder handling exist, scripts `ios:init` / `ios:dev` / `ios:build` are in `package.json`, and [`docs/IOS.md`](docs/IOS.md) has the steps. Needs a Mac with Xcode: run `npm run ios:init`, fix the first compile errors (suspects: `notify`, `if-watch`, C builds of `ring` / `zstd`), then test connect, terminal, SFTP and suspend/resume.

---

## ⚠️ Known Follow-Ups From Recent Work

- [ ] 🟡 **P2** — **Live-verify SSH agent forwarding end-to-end with a real agent**
  - Follow-up to the `russh` 0.40.2 → 0.63.3 upgrade (fixed RUSTSEC-2026-0153/0154). A live local-server smoke test ([`src-tauri/examples/russh_smoke_test.rs`](file:///d:/REPO/SubTerm/src-tauri/examples/russh_smoke_test.rs), run against a throwaway Windows OpenSSH `sshd` on `127.0.0.1:2222`) already confirmed, in both build profiles: connect, publickey auth via the new `PrivateKeyWithHashAlg` API, channel open + exec + reading `ChannelMsg::Data`, `tcpip_forward`, and — critically — a live round trip through the exact `Channel<Msg>` + `ChannelOpenHandle` callback pattern the rewritten `server_channel_open_agent_forward` now shares with `server_channel_open_forwarded_tcpip` (bytes sent into a forwarded port came back byte-for-byte through the handler's `copy_bidirectional` bridge).
  - **What's still unverified**: the actual ssh-agent wire protocol round-tripping through that bridge with a real agent (`ssh-add -l` on the remote reaching back to a real local OpenSSH agent/Pageant/1Password/KeePassXC). Windows's `ssh-agent` service was stopped on the dev machine and starting it needs admin elevation this environment didn't have — re-run once available, or test on a machine with the service already running.
  - SFTP was attempted live too: write/read/remove via `russh-sftp` (unaffected by this upgrade's API changes — it's a separate crate from `russh`) hit a `PermissionDenied` against the Windows OpenSSH test server's `internal-sftp` subsystem specifically — isolated as a test-environment quirk, not a client-side regression, by confirming a plain `exec`-based write to the same path over the same connection succeeded. Still worth a real run against an actual Linux/macOS SFTP server (what the vast majority of users connect to) rather than relying on this isolation alone.
  - Keyboard-interactive (2FA) auth specifically also wasn't exercised live this session (the smoke test only covers publickey auth) — worth including in the same manual pass.
  - To re-run the smoke test: stand up any local `sshd` with a throwaway keypair in its `authorized_keys`, then `SMOKE_SSH_PORT=<port> SMOKE_SSH_KEY=<path> SMOKE_SSH_USER=<user> cargo run --example russh_smoke_test [--features full-ssh-algos]` from `src-tauri`.

- [ ] 🟡 **P2 · M** — **Further `DesktopApp.tsx` decomposition (session-tab sidebar)**
  - Library, Logins, Logs and (now) the Fleet Wall are separate components (`src/components/{LibraryView,LoginsView,LogsView,WallView}.tsx`); `DesktopApp.tsx` is ~2,480 lines, down from 2,991. `WallView` has jsdom component tests.
  - Still in `DesktopApp.tsx`: the session-tab sidebar / drag-reorder / tiling logic. It reads and writes `activeView` and session refs throughout, and a slip breaks live SSH sessions, so cut it only with a manual click-through (tab switch, drag-reorder, split, close, reconnect) after each step.

- [ ] 🟡 **P2 · S** — **Manual click-through for session-only verified features**
  - Several features this session were validated by `typecheck`/`lint`/`build`/unit tests only, not live interaction — bundling as one follow-up pass rather than one line each:
    - Server list virtualization in `NodeGrid.tsx` (scroll + drag-reorder on a 500+-server fleet, resize across the 1024/1280px breakpoints).
    - Terminal output over the new Tauri binary IPC channel (firehose throughput, split-pane/Fleet-Wall multi-viewer attach, reconnect).
    - Cross-pane file diff/compare tool (`FileDiffModal`) and the four extracted `VaultEditPanels` (open/edit/save/cancel for a command, note, credential, SSH key).
    - The three newly-extracted views (`LibraryView`, `LoginsView`, `LogsView`): search/filter, add/edit/delete flows, and the commands/notes tab toggle.
    - Sudo-elevated SFTP file save to a root-owned path, with and without a saved session password.
