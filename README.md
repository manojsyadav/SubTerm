<div align="center">
  <img src="src/assets/logo.png" alt="SubTerm logo" width="120" />
  <h1>SubTerm</h1>
  <p><strong>A Modern, Cross-Platform SSH &amp; SFTP Client</strong></p>
  <p><i>SubTerm is a customized fork of <a href="https://github.com/sinaxhpm/submarine">Submarine</a>.</i></p>
</div>

---

SubTerm is a fast, native, and highly customizable client for managing remote servers, terminals, file transfers, and infrastructure. Built with Rust and Tauri v2, it combines terminal multiplexing, SFTP exploration, port forwarding, and Docker management into a single, cohesive desktop and mobile workspace.

---

## Documentation Suite

Comprehensive technical and user documentation is available in the [`docs/`](docs/) directory:

- [**System Architecture & Design**](docs/ARCHITECTURE.md): Runtime models, component interactions, Mermaid dataflow diagrams, and vault format.
- [**Tauri IPC & API Reference**](docs/API_REFERENCE.md): Complete catalog of backend commands, input arguments, return types, and event streams.
- [**Developer & Setup Guide**](docs/DEVELOPMENT.md): Toolchain prerequisites, local development, cargo feature flags, Android builds, and Linux WebKit workarounds.
- [**Security & Threat Model**](docs/SECURITY.md): Argon2id KDF specifications, AES-256-GCM AEAD encryption, zero-knowledge cloud sync, and safety controls.
- [**Performance & Competitive Benchmarks**](docs/PERFORMANCE.md): WebGL hardware acceleration throughput, memory footprint, and competitive matrix against Termius, Warp, Ghostty, PuTTY, WinSCP, and MobaXterm.
- [**User Guide & Workflows**](docs/USER_GUIDE.md): Step-by-step guides for server connectivity, SFTP editing, port forwarding, and settings.
- [**Release Notes**](docs/RELEASE_NOTES.md): Customer-ready changelog and feature announcements for version releases.
- [**Roadmap & Backlog**](TODO.md): Active development tasks, pending architectural optimizations, and strategic feature milestones.

---

## Core Capabilities

- **Integrated Terminal & SFTP**: Run terminal commands and manage remote files via SFTP side-by-side.
- **SFTP Directory Bookmarks & Hidden Files Toggle**: 1-click folder starring, instant standard system quick jumps (`/`, `~`, `/var/log`, `/etc`, `/var/www`, `/opt`, `/tmp`), persistent bookmarks, and `Ctrl+H` toggle for Unix dotfiles with suppressed item counter badge.
- **SFTP Duplication & File Category Filters**: Clone any file or directory with 1 click or `Ctrl+D` with intelligent collision-free naming, and instantly filter files by category (*Folders*, *Code*, *Logs*, *Archives*, *Media*).
- **1-Click OpenSSH `~/.ssh/config` & Client Importer**: Direct toolbar launcher to import existing SSH hosts from `~/.ssh/config`, PuTTY sessions, or Termius vaults.
- **Upload Public Keys (`ssh-copy-id`)**: Right-click a connected session tab to append any saved public key to the server's `~/.ssh/authorized_keys` in one click, with correct directory/file permissions.
- **Inline SSH Key Generation**: Generate a new key directly from the Add/Edit Server panel's `[+]` button without leaving the form.
- **Blank Username Resolution**: Save a server profile with no username and it resolves to the matching `Host` entry's `User` in your local `~/.ssh/config` at connect time.
- **Directory Symlinks as Folders**: SFTP and local file panes resolve directory symlinks as navigable folders with a link badge, instead of treating them as plain files.
- **Paste Saved Password**: Terminal context-menu action that injects the session's saved SSH password straight into an interactive `[sudo] password for user:` prompt, server-side only.
- **Wildcard Server Search**: Home-screen search accepts shell-style `*`/`?` glob wildcards on top of plain substring matching.
- **Terminal Triggers & Alert Keywords**: Keyword/regex patterns matched against live terminal output, firing a toast notification, audible chime, visual flash, or Activity Log entry.
- **Cross-Pane File Diff & Compare**: Unified diff viewer comparing any two files — local vs. remote, or across sessions — with one-click overwrite in either direction.
- **Server-Scoped Snippets & Tags**: Bind a saved command to one specific server (or leave it global), plus freeform tags — the Command Palette only surfaces a server-scoped snippet while that server's tab is active.
- **Export Server List (JSON / CSV)**: 1-click export of saved server profiles to a portable, unencrypted JSON or CSV file for backup or migration — passwords, keys, and passphrases are never included.
- **Interactive Network Diagnostics & Port Prober**: TCP port ping with millisecond round-trip latency, concurrent common service port audits (SSH, HTTP/S, DBs, Cache), Wake-on-LAN (WOL), and firewall port knocking.
- **Configurable SSH Keep-Alive Settings**: Dynamic 15s–120s keep-alive packet intervals to prevent dropped sessions across NAT firewalls and cloud proxies.
- **Auto-Reconnect with Sleep/Resume & Network-Change Detection**: Detects laptop sleep/resume cycles and network interface changes (Wi-Fi roam, VPN toggle) and retries immediately instead of waiting on the passive health check, with capped exponential backoff (2s–30s) and a live "Reconnecting · attempt N" status banner.
- **SSH Agent Forwarding (`-A`)**: Per-server toggle to forward your local SSH agent (OpenSSH agent, Pageant, 1Password, KeePassXC, Vaultwarden) for onward authentication from the remote session, without SubTerm ever touching your keys.
- **Port Forwarding**: Easily configure local (`-L`), remote (`-R`), and dynamic SOCKS5 (`-D`) tunnels.
- **Folder Sync**: Keep your local and remote directories mirrored with real-time two-way sync tools.
- **Cross-Platform**: Compiles natively for Windows, macOS, Linux, and Android.
- **Custom Cloud API**: Bring your own backend! SubTerm allows you to easily configure your own sync endpoints without recompiling.
- **Native Local Terminal**: Integrated cross-platform local PTY shell (PowerShell/CMD on Windows, Bash/Zsh on macOS/Linux) with full xterm features (themes, shortcuts, OSC 133, copilot, split views). Launchable instantly from the Top Bar, Node Grid, Command Palette, or global shortcut (`Ctrl+Alt+T`).
- **Production Node Safeguards**: First-class Production Server flag with persistent database tracking, high-visibility `PROD` badges, active Safe Mode with destructive command interception, multi-line paste confirmation.
- **Parallel Tool Tabs**: Dedicated first-class tabs for **Docker** (containers, images, compose stacks), **Processes** (real-time task manager), and **Services** (systemd control).
- **Top Bar Quick Access Servers**: Pin up to 5 quick-access servers next to the logo with active green dot status indicators.
- **Customizable Keyboard Shortcuts**: Fully customizable keybinding manager with interactive key recording, conflict detection, and category filters.
- **Universal Command Palette**: `Ctrl+K` command palette for cluster fleet operations and quick actions.
- **Hardware-Accelerated Terminal**: WebGL GPU rasterization with automatic canvas fallback for 60–120+ FPS throughput and reduced CPU overhead.
- **Curated Terminal Color Schemes & Custom Theme Importer**: 8 pro color schemes (*SubTerm Dark*, *Dracula*, *One Dark Pro*, *Nord*, *Catppuccin*, *Tokyo Night*, *Monokai*, *Solarized Dark*) with full 16-color ANSI support, custom xterm.js / Windows Terminal JSON theme importer, and 1-click theme export to clipboard.
- **Typography, Line Height & Scrollback Customization**: Font family presets (*JetBrains Mono*, *Fira Code*, *Cascadia Code*, *Consolas*, *Monaco*, *Source Code Pro*) with custom font support, interactive line-height slider (1.00x–1.60x), and configurable scrollback memory retention (1,000–50,000 lines).
- **Terminal Bell & Pro Search Widget**: Configurable visual screen flash / Web Audio chime on ASCII bell, plus enhanced `Ctrl+F` search with match counts, case matching (`Aa`), whole words (`\b`), and regex (`.*`).
- **Terminal Context Menu & Buffer Export**: Glassmorphic right-click menu with Copy, Paste, Select All, Find, Clear, Reset, 1-click buffer export to `.log`, configurable right-click behavior (Context Menu vs PuTTY-style immediate paste), and automatic copy-on-select.
- **Smart Right-Click & Ctrl+Click Links**: Right-click copies a selection, otherwise pastes; Shift+Right-Click opens the full menu. URLs and file paths in output open on Ctrl/Cmd+Click so a stray click never launches anything. Both are settings (Settings > Terminal > Mouse & Clipboard).
- **ssh / sftp from a Local Terminal**: Type `ssh host` in a local shell and SubTerm opens the matching saved server, or offers to save the host or Quick Connect it. Aliases from `~/.ssh/config`, `-p`, `-l` and `-i` are honoured; passwords are never read. Choose Ask First or automatic for saved servers, or turn it off under Settings > Features.
- **Startup View**: Choose what opens after unlock: the server list (default), your last session, or a new local terminal.
- **Multi-Tab Fleet Broadcast**: Concurrently fan out keystrokes and commands across multiple server sessions with live session targeting and armed safety banners.
- **Parameterized Snippets Engine**: Runbook automation with `{{variable:defaultValue}}` placeholders and interactive variable prompting.
- **Horizontal & Vertical Split Multiplexing**: Tile multiple shells within a session or across different servers with draggable dividers, orientation flipping, and 1-click unsplit restore.
- **VS Code-Style Settings Panel**: 13 focused pages (General, Appearance, Terminal, Features and more) with a vertical left-sidebar navigator, a settings search box and vault-gated security screens.

---

## Settings Categories & Security

| Category | Requires Unlock | Primary Contents |
|---|:---:|---|
| General | — | Startup view, Remote Desktop (RDP) mode |
| Appearance | — | Accent color, background theme, terminal theme, fonts, cursor, WebGL, bell |
| Terminal | — | Right-click, copy on select, link opening, sessions, SSH keep-alive, command widget, triggers |
| Features | — | Optional feature toggles with their options nested underneath |
| Monitoring | — | Enable/disable resource polling, intervals |
| Keyboard Shortcuts | — | Rebind global keyboard shortcuts and shortcuts recorder |
| Quick Access Servers | **Yes** | Pinned servers (exposes server names/IPs) |
| Cloud & Sync | **Yes** | Cloud API endpoint, auth, push/pull sync operations |
| Profile | **Yes** | Create, rename, delete workspaces; change master password |
| Quick Commands | **Yes** | OS/environment quick commands (may contain secrets) |
| Known Hosts | **Yes** | Trusted SSH host keys and fingerprints, fingerprint revocation |
| Maintenance | **Yes** | Reset preferences to factory defaults, cache purge |
| Activity Log | **Yes** | Session diagnostics timeline and connection logs |

---

## Technology Stack

- **Backend**: Rust 1.70+, Tokio async runtime, Tauri 2.1+
- **SSH & SFTP**: `russh` 0.63, `russh-sftp`
- **Local PTY**: `portable-pty`
- **Crypto & Compression**: `argon2` 0.5, `aes-gcm` 0.10, `zstd`
- **Database**: `rusqlite` (in-memory deserialized SQLite with serialized encrypted blob storage)
- **Frontend**: React 18, TypeScript 5, Vite 5, TailwindCSS, `xterm.js` 5.3+

---

## Getting Started

### Prerequisites
- [Node.js](https://nodejs.org/) (v18+)
- [Rust](https://rustup.rs/) (v1.70+)
- C++ build tools (Visual Studio on Windows, Xcode on macOS, WebKit2GTK on Linux)

### Installation & Run

```bash
# 1. Clone the repository
git clone https://github.com/manojsyadav/SubTerm.git
cd SubTerm

# 2. Install dependencies
npm install

# 3. Run development build
npm run tauri dev

# 4. Build release installers (MSI / NSIS)
npm run tauri build

# 5. (Optional) Build standalone portable zip
npm run build:portable
```

For advanced builds, see [Developer Guide](docs/DEVELOPMENT.md) and [Testing Guide](docs/TESTING.md).

---

## License

This project is licensed under the MIT License.
