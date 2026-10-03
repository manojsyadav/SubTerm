# SubTerm Backlog & TODO Roadmap

This document tracks active development tasks, pending architectural optimizations, and planned features for future SubTerm releases.

---

## ⚡ Core Performance & IPC Optimizations

- [ ] **High-Throughput IPC: Tauri 2 Binary Channels**
  - Migrate terminal byte stream dispatch from base64 JSON strings over `app.emit` (`emit_terminal_batch`) to zero-copy Tauri 2 `ipc::Channel<bytes>`.
  - Further reduces CPU overhead and eliminates string serialization latency during saturated terminal outputs (`cat /dev/urandom`, `docker logs -f`).
- [ ] **Server List Virtualization**
  - Integrate windowed list/grid virtualization (e.g. `@tanstack/react-virtual` or `react-window`) into [`src/components/NodeGrid.tsx`](file:///d:/REPO/SubTerm/src/components/NodeGrid.tsx).
  - Ensures buttery-smooth 60 FPS scrolling and low DOM memory usage for fleets with 500+ saved nodes.
- [ ] **SFTP Pipelined Transfers & Concurrent Chunking**
  - Implement multi-stream concurrent byte-range chunking for large single-file transfers across parallel SFTP channels.
  - Automatically saturate high-bandwidth, high-latency WAN links beyond the current 256 KiB sequential pipelined stream.

---

## 🚀 Strategic Power Features (Competitive Differentiators)

- [ ] **SFTP Multi-Item Batch Selection**
  - Checkbox selection or `Shift` / `Ctrl` multi-click selection for multiple files and folders in [`src/components/FilePanel.tsx`](file:///d:/REPO/SubTerm/src/components/FilePanel.tsx).
  - Batch actions toolbar: batch download to local archive/directory, batch delete with confirmation modal, and batch cut/move.
- [ ] **Terminal Session Recording & Export (.cast / Asciinema)**
  - Native timed session recorder capturing stdout, stdin, and resize events according to the Asciinema v2 (`.cast`) standard.
  - Export to `.cast` files, raw terminal log dumps, or animated SVG/GIF for runbooks, documentation, and compliance audit trails.
  - In-app playback preview modal with play/pause, scrub slider, and playback speed controls.
- [ ] **Auto-Reconnect on Sleep / Resume & Network Shifts**
  - Detect laptop lid close / sleep transitions, wake events, and network interface changes (e.g. WiFi network roaming, VPN toggles).
  - Automatically attempt connection recovery with configurable exponential backoff and non-intrusive status pills.
- [ ] **Dual-Pane Remote-to-Remote SFTP Sync**
  - Side-by-side split SFTP view (Commander / WinSCP style) allowing direct transfers between two distinct remote SSH servers.
  - Stream data directly from Server A to Server B in memory without staging unencrypted files onto the local host disk.
- [ ] **SSH Agent Forwarding & 1Password / KeePassXC / vaultwarden Integration**
  - Support SSH Agent Forwarding (`-A` flag) using native `SSH_AUTH_SOCK` socket proxying on macOS/Linux.
  - Named pipe integration on Windows (`\\.\pipe\openssh-ssh-agent`) for seamless integration with 1Password, KeePassXC, Vaultwarden, and Pageant.
- [ ] **Terminal Triggers & Alert Keywords**
  - Configurable regex / keyword matching on live terminal output streams (e.g., highlighting or notification on `ERROR`, `FATAL`, `FAIL`, `Exception`).
  - Action options: trigger system notification, play audible chime, highlight line in red/amber, or capture matched snippet into activity log.
- [ ] **Cloud Sync Enhancements & Conflict Resolution**
  - Expand self-hosted cloud sync API with visual diffing for simultaneous modifications across multiple devices.
  - Granular push/pull synchronization for server definitions, credentials, snippet runbooks, and keyboard shortcuts.

---

## 📂 SFTP & File Management Enhancements

- [ ] **Option to Treat Directory Symlinks as Folders in SFTP**
  - Resolve symbolic links pointing to directories (`lrwxrwxrwx`) as navigable folders in remote and local file managers instead of treating them as plain files.
  - Show a small link badge on the folder icon while allowing seamless navigation into the linked target directory.
- [ ] **Visual File Comparison (Diff Tool)**
  - Integrated side-by-side or unified diff viewer to compare differences between local and remote files, or between two remote files across sessions.
  - Syntax-highlighted change visualization with inline merge and save capabilities.
- [ ] **Sudo Elevation for File Transfer & Docker Management**
  - Support administrative elevation (`sudo sftp-server` or `sudo tee` / `sudo docker`) for saving root-owned configuration files (e.g. `/etc/nginx/nginx.conf`) and managing privileged containers.

---

## 🖥️ Terminal & Connection Enhancements

- [ ] **Focus on Select Tab**
  - Automatically shift active keyboard and cursor focus to the terminal emulator canvas as soon as its tab is selected from the top tab strip.
  - Eliminates the need to click inside the terminal window after switching tabs before typing.
- [ ] **Upload Public SSH Keys (`ssh-copy-id`)**
  - 1-click action inside the server details panel or context menu to append a selected public key to the remote server's `~/.ssh/authorized_keys`.
  - Automatically ensures correct directory permissions (`0700` for `~/.ssh`, `0600` for `authorized_keys`).
- [ ] **Direct Shortcut to Add Keys from Server Edit Modal**
  - Add a quick `[+]` button next to the SSH Key dropdown inside [`src/components/AddNodePanel.tsx`](file:///d:/REPO/SubTerm/src/components/AddNodePanel.tsx) to generate or import a key without having to cancel out of editing the server.
- [ ] **Auto-Pasting Password for Sudo Prompts**
  - Convenience hotkey or context action to securely inject the active session's saved password into interactive `[sudo] password for user:` prompts.
- [ ] **Blank Username Fallback & Interactive Prompt**
  - Allow saving connection profiles with blank usernames that automatically resolve to the `User` defined in `~/.ssh/config`, or prompt interactively on connect rather than strictly defaulting to `root`.
- [ ] **Server-Specific Snippets & Command Libraries**
  - Allow segmenting saved commands and snippet runbooks so snippets can be bound specifically to individual servers or tags alongside the global snippet library.

---

## 🌐 Network, Protocols & Multi-Platform

- [ ] **Native Tailscale / Tailcat Mesh Support**
  - Direct userspace Tailscale mesh network transport to seamlessly discover and connect to Tailscale nodes by MagicDNS name without manual local proxy configurations.
- [ ] **RDP Functionality (Remote Desktop Protocol)**
  - Native Remote Desktop Protocol (RDP) session tabs alongside SSH, SFTP, and Docker for managing Windows infrastructure.
- [ ] **iOS / iPadOS Support**
  - Target compilation and packaging for iPadOS and iOS devices, pairing with SubTerm's mobile accessory keybar.

---

## 📦 Vault, Packaging & Ecosystem

- [ ] **Vault Export to Portable Formats (JSON / CSV)**
  - 1-click export of saved server profiles, folders, and non-sensitive configs to portable unencrypted JSON/CSV or password-protected encrypted archives for backup and migration.
- [ ] **Wildcard Character Matching in Server Filter**
  - Support glob wildcard pattern matching (`*` and `?`) in the home server search bar (e.g., `web-*`, `prod-db?`, `*-staging`).
- [ ] **Portable Standalone Version in Releases**
  - Automated CI workflow release step to package and publish a zero-install portable `.zip` bundle alongside the Windows NSIS setup and MSI installers.
