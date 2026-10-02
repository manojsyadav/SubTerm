<div align="center">
  <img src="src/assets/logo.png" alt="SubTerm logo" width="120" />
  <h1>SubTerm</h1>
  <p><strong>A Modern, Cross-Platform SSH & SFTP Client</strong></p>
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

## 🛠️ SubTerm Features & Optimizations

This fork diverges from the original Submarine repository by adding a massive suite of quality-of-life (QoL) improvements and optimizations, including:
- **Terminal Enhancements**: OSC 133 command block separation, 1-click output copy, exit code status, output link providers, paste preview, and production safety guardrails.
- **Advanced SFTP**: Clickable breadcrumbs, side-by-side visual diffs before overwriting, Smart Tar transfer acceleration for high-speed directory sync, and an in-app code editor.
- **Universal Command Palette**: A universal Ctrl+K command palette for cluster fleet operations and quick actions.
- **Docker & Git Integration**: 1-click container port tunneling, browser launch, and a dedicated Git drawer for branch inspection, diffs, and commits.
- **Smart Tunnels**: Remote listening ports auto-discovery and local port conflict resolution.
- **Network & Health**: Live server health pulses, outage alert badges, Wake-on-LAN magic packets, and port knocking connection options.
- **Mobile & UI QoL**: Gesture-based terminal control, Shell AI Copilot, biometric vault unlock, keybar haptics, and quick-connect history.
- **Performance**: Heavily optimized Vite bundle chunking for xterm and vendor packages, plus a massive backend refactor for stability.
- **Dynamic Cloud Backend**: The hardcoded cloud sync API has been replaced with a dynamic system. You can now define your own custom backend endpoint at runtime via the UI Settings without needing to recompile the source code.

## Getting Started

To run SubTerm locally, you'll need [Node.js](https://nodejs.org/) and [Rust](https://rustup.rs/) installed on your machine.

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

SubTerm supports dynamic configuration overrides. If you want to host your own cloud API for syncing profiles, you don't need to fork or modify the source code.

Simply open the **Settings** panel in the app and enter your API URL in the **Cloud Sync** section. SubTerm will automatically use this endpoint for all synchronization requests.

## License

This project is licensed under the MIT License.
