<div align="center">
  <img src="src/assets/logo.png" alt="SubTerm logo" width="120" />
  <h1>SubTerm</h1>
  <p><strong>A Modern, Cross-Platform SSH &amp; SFTP Client</strong></p>
  <p><i>SubTerm is a customized fork of <a href="https://github.com/sinaxhpm/submarine">Submarine</a>.</i></p>
</div>

---

SubTerm is a fast, native, and highly customizable client for managing your servers. Built with Rust and Tauri, it brings your terminal sessions, file management, and port forwarding into a single, beautiful window.

## Core Features

- **Integrated Environment**: Run terminal commands and manage remote files via SFTP side-by-side.
- **Port Forwarding**: Easily configure local, remote, and dynamic (SOCKS) tunnels.
- **Folder Sync**: Keep your local and remote directories mirrored with two-way sync tools.
- **Cross-Platform**: Compiles natively for Windows, macOS, Linux, and Android.
- **Custom Cloud API**: Bring your own backend! SubTerm allows you to easily configure your own sync endpoints without recompiling.

## SubTerm Features & Optimizations

- **Native Local Terminal**: Integrated cross-platform local PTY shell (PowerShell/CMD on Windows, Bash/Zsh on macOS/Linux) with full xterm features (themes, shortcuts, OSC 133, copilot, split views). Launchable instantly from the Top Bar, Node Grid, Command Palette, or global shortcut (`Ctrl+Alt+T`).
- **Production Node Safeguards**: First-class Production Server flag with persistent database tracking, high-visibility `PROD` badges, active Safe Mode with destructive command interception, multi-line paste confirmation.
- **Terminal Enhancements**: OSC 133 command block separation, 1-click output copy, exit code status, output link providers, paste preview.
- **In-App Quick File Editor**: 1-click terminal file path editing, `Alt+E` quick file search with interactive picker.
- **Parallel Tool Tabs**: Dedicated first-class tabs for **Docker** (containers & images), **Processes** (real-time task manager), and **Services** (systemd control).
- **Top Bar Quick Access Servers**: Pin up to 5 quick-access servers next to the logo with active green dot status indicators.
- **Customizable Keyboard Shortcuts**: Fully customizable keybinding manager with interactive key recording, conflict detection, and category filters.
- **Advanced SFTP**: Clickable breadcrumbs, side-by-side visual diffs, Smart Tar transfer acceleration, in-app code editor.
- **Universal Command Palette**: `Ctrl+K` command palette for cluster fleet operations and quick actions.
- **Docker & Git Integration**: 1-click container port tunneling, browser launch, dedicated Git drawer.
- **Smart Tunnels**: Remote listening ports auto-discovery and local port conflict resolution.
- **Network & Health**: Live server health pulses, outage alert badges, Wake-on-LAN, port knocking.
- **Mobile & UI QoL**: Gesture-based terminal control, Shell AI Copilot, biometric vault unlock.
- **Session Audits & Clipboard Automation**: Automated session transcripts, configurable command dismiss timers, auto-copy output to clipboard.
- **Dynamic Cloud Backend**: Define your own backend endpoint at runtime via the UI Settings without recompiling.
- **VS Code-Style Settings Panel**: Settings are organized into 10 focused category pages with a vertical left-sidebar navigator. Sensitive categories are gated behind the vault lock and display a full-page lock screen until the master password is entered.

## Settings Categories & Security

| Category | Requires Unlock | Contents |
|---|:---:|---|
| Appearance | — | Accent color, background theme |
| Terminal | — | Font size, session behaviour, command widget |
| Monitoring | — | Enable/disable resource polling |
| Keyboard Shortcuts | — | Rebind global keyboard shortcuts |
| Quick Access Servers | **Yes** | Pinned servers (exposes server names/IPs) |
| Cloud & Sync | **Yes** | Force-push, invite members, sync operations |
| Profile | **Yes** | Create, rename, delete workspaces; change master password |
| Quick Commands | **Yes** | OS/environment quick commands (may contain secrets) |
| Maintenance | **Yes** | Reset preferences to factory defaults |
| Activity Log | **Yes** | Session diagnostics timeline |

## Getting Started

To run SubTerm locally, you need [Node.js](https://nodejs.org/) and [Rust](https://rustup.rs/).

1. **Clone the repository**
   ```bash
   git clone https://github.com/manojsyadav/SubTerm.git
   cd SubTerm
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Run the development server**
   ```bash
   npm run tauri dev
   ```

4. **Build for production**
   ```bash
   npm run tauri build
   ```

## Custom Configuration

SubTerm supports dynamic configuration overrides. If you want to host your own cloud API for syncing profiles, you do not need to fork or modify the source code.

Open the **Settings** panel, go to the **Cloud & Sync** category, and enter your API URL. SubTerm will automatically use this endpoint for all synchronization requests.

> **Note:** Cloud & Sync settings require the vault to be unlocked.

## License

This project is licensed under the MIT License.
