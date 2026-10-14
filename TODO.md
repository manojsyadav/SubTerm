# SubTerm Backlog & TODO Roadmap

This document tracks active development tasks, pending architectural optimizations, and planned features for future SubTerm releases.

> Completed work isn't tracked here — see [`docs/RELEASE_NOTES.md`](docs/RELEASE_NOTES.md) for what's shipped and git history for implementation detail. This file lists only what's still open or deferred.

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

- 🟡 **P2 / S** — **Window Backdrop (Acrylic / Mica / Tabbed / Solid) & Opacity** *(Ready for validation)*
  - **Issue Reported:** Shell background remained opaque when adjusting opacity percentage or selecting Acrylic/Mica/Tabbed.
  - **Fix Implemented:** Updated `index.css`, `DesktopApp.tsx`, and `SessionView.tsx` with `.app-root-surface` and `.session-view-surface` translucency rules so the opaque wrapper divs (`bg-[#0a0a0c]` and `bg-[#09090b]`) allow the native DWM blur / desktop wallpaper tint through.
  - **Validation Steps:**
    1. Go to **Settings → Appearance**.
    2. Adjust **Window opacity** slider down (e.g. 70–80%) or select **Background effect** (`Acrylic (blur)`, `Mica (wallpaper tint)`, or `Tabbed (Mica Alt)`).
    3. Verify the terminal window reflects transparency / wallpaper blur while terminal text stays crisp and readable.
    4. Set back to `Solid (opaque)` and 100% opacity to confirm solid background restores cleanly.

- 🔴 **P1 / M** — **[DEFERRED] Untrusted RDP Host Certificate Prompt** *(Deferred for manual hardware testing)*
  - **Validation Steps:**
    1. Connect to any Windows Pro / Server RDP host using a self-signed or untrusted certificate (or quick-connect `rdp://<ip>`).
    2. Verify the security warning modal displays with the host name and SHA-256 fingerprint.
    3. Click **"Connect Anyway" / "Trust"** to save the certificate fingerprint and proceed to the session.
    4. Reconnect to the same host and verify it connects directly without re-prompting.

---

## 🌐 Network, Protocols & Multi-Platform

- 🟡 **P2 · M** — **[DEFERRED] Embedded RDP Live Session Interaction** *(Deferred for manual hardware testing)*
  - **Validation Steps:**
    1. **Input & Rendering:** Connect to an RDP host; verify smooth mouse tracking, clicking, dragging, and keyboard input.
    2. **Bidirectional Clipboard:**
       - Copy text from Windows Notepad → paste into remote RDP desktop.
       - Copy text inside RDP desktop → paste into local Windows Notepad.
    3. **Audio Toggle:**
       - Toggle the **Sound / Audio** button in the RDP session toolbar.
       - Play remote audio to verify local playback (or quiet mode when muted).
    4. **Window Resizing:**
       - Resize the SubTerm window.
       - Verify the remote desktop follows the window resolution (~0.4s debounce) without disconnecting.
    5. **Tab Switching & Lock:**
       - Switch to another terminal tab and return to RDP (session must stay alive).
       - Lock SubTerm (or let idle timeout trigger) → verify RDP disconnects cleanly and does not leak behind the lock screen.
  - First macOS/Linux release build with the helper binary (configured in `tauri.macos.conf.json` / `tauri.linux.conf.json`).

- 🟢 **P3 · L** — **[DEFERRED] iOS / iPadOS: first Mac build** *(Deferred: requires macOS hardware with Xcode)*
  - Prepared architecture: desktop-only crates excluded for iOS, platform checks use `desktop` / `mobile`, iOS detection and Documents-folder sandbox handling exist, build scripts `ios:init` / `ios:dev` / `ios:build` configured in `package.json`, and instructions documented in [`docs/IOS.md`](docs/IOS.md).
  - When Apple hardware is available: run `npm run ios:init`, resolve any native crate build issues (`notify`, `if-watch`, C builds of `ring` / `zstd`), and validate SSH terminal, SFTP, and app suspend/resume.

---

## 🔐 SSH Protocol & Cryptography

- 🟡 **P2** — **[DEFERRED] SSH Agent Forwarding End-to-End** *(Deferred for manual testing with live agent)*
  - **Validation Steps:**
    1. **Start Local Agent:**
       - In PowerShell:
         ```powershell
         Start-Service ssh-agent
         ssh-add -l
         # If empty, add your key:
         ssh-add $HOME\.ssh\id_ed25519
         ```
         *(Or run Pageant / 1Password SSH Agent with keys loaded).*
    2. **Enable Forwarding:** Edit server profile in SubTerm → **SSH Options** → enable **"Forward authentication agent"**.
    3. **Connect & Check:**
       - Open an SSH terminal session to the server.
       - In the remote shell, run:
         ```bash
         echo $SSH_AUTH_SOCK
         ssh-add -l
         ```
    4. **Expected Result:** `$SSH_AUTH_SOCK` points to an active socket, and `ssh-add -l` on the remote server lists your local public keys.

- 🟡 **P2** — **[DEFERRED] Keyboard-Interactive (2FA / OTP) Authentication** *(Deferred for manual testing against 2FA server)*
  - **Validation Steps:**
    1. Connect to an SSH server configured with PAM 2FA (e.g., Google Authenticator, Duo, or YubiKey OTP).
    2. Verify SubTerm displays a modal with the server's prompt message (e.g. `Verification code:`).
    3. Enter the OTP and submit to confirm login completes into the terminal.

---

## 🚀 Planned Features & Explorers

- 🟡 **P2 · M** — **MCP (Model Context Protocol) Servers**
  - Integrate Model Context Protocol (MCP) server support into SubTerm.
  - Enable connecting custom MCP tool servers (local stdio or SSE/HTTP) so AI assistants and copilot agents can query homelab services, run diagnostic tools, and interact with external systems.
  - Provide a configuration UI in Settings for adding, enabling/disabling, testing, and managing MCP server definitions and environment variables.

- 🟡 **P2 · M** — **Embedded Web Browser Tab**
  - Leverage Tauri's underlying Chromium webview engine to provide a built-in tabbed browser view inside SubTerm sessions.
  - Open web management consoles (Proxmox, TrueNAS, Portainer, router portals, Grafana) and local/remote dev servers directly beside terminal & SFTP tabs.
  - Implement a streamlined browser toolbar with URL navigation, back/forward/refresh, certificate override handling for local self-signed homelab IPs, and quick bookmarks.

- 🟡 **P2 · M** — **Local & Remote File Explorer**
  - Full-featured local and remote file explorer with directory tree navigation, breadcrumbs, search/filtering, multi-file batch operations, file preview, and drag-and-drop transfers.
  - Bi-directional sync between the active terminal directory and the explorer view (reveal CWD in explorer and navigate terminal to selected folder).

- 🟡 **P2 · L** — **NAS Storage Explorer (SMB / NFS / WebDAV / S3)**
  - Dedicated Network-Attached Storage (NAS) explorer for browsing and managing shared homelab storage repositories.
  - Multi-protocol support: SMB/CIFS shares, NFS network mounts, WebDAV endpoints, and S3 / MinIO object storage buckets.
  - Store NAS connection profiles and credentials safely in SubTerm's encrypted vault.
  - Enable high-speed direct file transfers between NAS shares, local storage, and remote SSH hosts.

---

## Settled decisions (not doing, and why)

- **No "Alt as Meta" option.** xterm already sends Alt as an ESC prefix on desktop.
