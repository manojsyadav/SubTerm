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

---

## Core Capabilities

- **Integrated Terminal & SFTP**: Run terminal commands and manage remote files via SFTP side-by-side.
- **SFTP Directory Bookmarks & Quick Navigation**: 1-click folder starring, instant standard system quick jumps (`/`, `~`, `/var/log`, `/etc`, `/var/www`, `/opt`, `/tmp`), and persistent bookmark management.
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
- **Curated Terminal Color Schemes & Cursor Customization**: 8 pro color schemes (*SubTerm Dark*, *Dracula*, *One Dark Pro*, *Nord*, *Catppuccin*, *Tokyo Night*, *Monokai*, *Solarized Dark*) with full 16-color ANSI support, live palette swatches, and configurable cursor styles (*Block*, *Underline*, *Bar*).
- **Terminal Bell & Pro Search Widget**: Configurable visual screen flash / Web Audio chime on ASCII bell, plus enhanced `Ctrl+F` search with match counts, case matching (`Aa`), whole words (`\b`), and regex (`.*`).
- **Terminal Context Menu & Buffer Export**: Glassmorphic right-click menu with Copy, Paste, Select All, Find, Clear, Reset, 1-click buffer export to `.log`, configurable right-click behavior (Context Menu vs PuTTY-style immediate paste), and automatic copy-on-select.
- **Multi-Tab Fleet Broadcast**: Concurrently fan out keystrokes and commands across multiple server sessions with live session targeting and armed safety banners.
- **Parameterized Snippets Engine**: Runbook automation with `{{variable:defaultValue}}` placeholders and interactive variable prompting.
- **Horizontal & Vertical Split Multiplexing**: Tile multiple shells within a session or across different servers with draggable dividers, orientation flipping, and 1-click unsplit restore.
- **VS Code-Style Settings Panel**: 11 focused category pages with a vertical left-sidebar navigator and vault-gated security screens.

---

## Settings Categories & Security

| Category | Requires Unlock | Primary Contents |
|---|:---:|---|
| Appearance | — | Accent color, background theme, interface zoom |
| Terminal | — | Font size/family, session behaviour, command widget |
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
- **SSH & SFTP**: `russh` 0.45+, `russh-sftp`
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

# 4. Build release bundle
npm run tauri build
```

For advanced builds (e.g. legacy RSA host key support via `--features full-ssh-algos` or Android development), see [Developer Guide](docs/DEVELOPMENT.md).

---

## License

This project is licensed under the MIT License.
