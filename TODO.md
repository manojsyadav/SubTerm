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

## 🪟 Windows & Hardware Verification

- 🔴 **P1 / M** — **Packaged Windows build: manual hardware checks**
  - **Acrylic / Mica:** verify native window backdrop vibrancy on Windows 10 (Acrylic blur) and Windows 11 (Mica / Tabbed material).
  - **Start on sign-in:** verify registry autostart toggle via Tauri autostart plugin across sign-out/sign-in.
  - **Upgrade installation:** verify installing a new installer over existing `%APPDATA%/SubTerm` data preserves SQLite vault encryption, profile tokens, and custom settings without prompt loops.
  - **Live RDP certificate dialog:** connect to a real Windows Server / Windows Pro host with an untrusted or self-signed TLS cert to verify the certificate fingerprint prompt and trust confirmation flow.

---

## 🌐 Network, Protocols & Multi-Platform

- 🟡 **P2 · M** — **RDP embedded view: verify against a real signed-in session, then a real tab**
  - Live interaction on a real Windows RDP host:
    - Screen rendering and user input (mouse move, click, drag, keyboard focus).
    - Bidirectional clipboard text synchronization (copy remote -> paste local; copy local -> paste remote).
    - Sound toggle (Sound on/off button; disabled at connect avoids audio channel negotiation).
    - Dynamic resize (remote desktop follows container resize after ~0.4s debounce; server reactivates session).
  - Verify that a hidden RDP tab keeps its session active without disconnect, keystrokes route strictly to the active tab, and app lock closes/suspends RDP sessions.
  - First macOS/Linux release build with the helper binary (configured in `tauri.macos.conf.json` / `tauri.linux.conf.json`).
  - *Context:* Helper program isolates IronRDP's pinned pre-release `picky`/`curve25519-dalek` dependencies from `russh` in the main process.

- 🟢 **P3 · L** — **iOS / iPadOS: first Mac build**
  - Prepared architecture: desktop-only crates excluded for iOS, platform checks use `desktop` / `mobile`, iOS detection and Documents-folder sandbox handling exist, build scripts `ios:init` / `ios:dev` / `ios:build` configured in `package.json`, and instructions documented in [`docs/IOS.md`](docs/IOS.md).
  - Requires a Mac with Xcode: run `npm run ios:init`, resolve any native crate build issues (`notify`, `if-watch`, C builds of `ring` / `zstd`), and validate SSH terminal, SFTP, and app suspend/resume.

---

## 🔐 SSH Protocol & Cryptography

- 🟡 **P2** — **Live-verify SSH agent forwarding end-to-end with a real agent**
  - Automated smoke test (`src-tauri/examples/russh_smoke_test.rs`) verifies connect, publickey auth (`PrivateKeyWithHashAlg`), channel open/exec, `tcpip_forward`, and bidirectional byte streaming through the callback bridge.
  - Manual follow-up needed:
    - Actual `ssh-agent` wire protocol round-trip through the bridge with a live local agent (`ssh-add -l` on remote reaching back to OpenSSH Authentication Agent, Pageant, 1Password, or KeePassXC).
    - Exercise live keyboard-interactive (2FA / OTP) authentication prompt against a server requiring two-factor auth.
    - Run against a remote Linux/macOS OpenSSH server to supplement the Windows test suite.

---

## Settled decisions (not doing, and why)

- **No "trim trailing spaces on copy" or "Alt as Meta" options.** Selection text already omits trailing whitespace, and xterm already sends Alt as an ESC prefix on desktop.
