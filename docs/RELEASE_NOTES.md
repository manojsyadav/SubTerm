# SubTerm Release Notes

---

## [v0.4.0] — 2026-10-03

### Summary
SubTerm v0.4.0 introduces an entirely redesigned VS Code-style Settings navigation system, zero-downtime seamless workspace profile switching, and a local-first startup experience that lets you use terminal tools immediately without unlocking your secret vault. Sensitive settings and destructive workspace actions are now strictly gated behind master password protection.

---

### 🚀 New Features

- **VS Code-Style 11-Category Settings Hub**:
  - The monolithic, single-page settings panel has been replaced by a clean, 11-category left sidebar navigator with dedicated pages for *Appearance*, *Terminal*, *Monitoring*, *Keyboard Shortcuts*, *Quick Access Servers*, *Cloud & Sync*, *Profile & Workspaces*, *Quick Commands*, *Known Hosts*, *Maintenance*, and *Activity Log*.
  - Access it anytime via `Ctrl+,` or the gear icon in the title bar.

- **SSH Known Hosts & Fingerprint Manager**:
  - Added a dedicated **Known Hosts** settings page allowing users to inspect all trusted SSH public key fingerprints across their servers.
  - Search by hostname, IP address, port, or key algorithm (`ssh-ed25519`, `rsa`, `ecdsa`).
  - 1-click SHA256 fingerprint copying to clipboard with confirmation toast.
  - 1-click **Revoke** action to easily clear stale or rotated host keys when a remote VPS is rebuilt or re-installed.
  - Protected behind master password vault lock.

- **Local-First Launch (Instant Shell Access)**:
  - You no longer have to enter your master password just to use SubTerm. Launch the application to immediately open a local terminal (PowerShell, CMD, or Bash) without being blocked by an unlock screen.
  - Your encrypted server vault can be unlocked on-demand whenever you need to connect to remote infrastructure.

- **Unified Master Password & Seamless Profile Switching**:
  - Switch between client or environment workspaces (e.g. *Work*, *Personal*, *Staging*) with one click from the top titlebar menu. When profiles share the same master password, SubTerm unlocks them seamlessly in memory without re-prompting.
  - Added a dedicated **Password Synchronization** tool in the Profile settings that allows syncing master passwords across all local vaults in one action.

- **Vault Lock Gates on Sensitive Settings**:
  - Settings categories containing sensitive hostnames, API tokens, workspace deletion controls, or custom shell scripts now display an integrated **Locked** splash screen when the vault is locked.
  - Sensitive configurations and passwords cannot be inspected or altered without clicking **Unlock** and confirming your master password.

- **WebGL Hardware-Accelerated Terminal Rendering**:
  - Integrated GPU-accelerated rasterization using `xterm-addon-webgl`, offloading character glyph rendering from CPU to GPU shaders. Delivers locked 60–120+ FPS rendering during intense output streams (`cat large.log`, `docker logs -f`), reduces terminal CPU consumption by ~65%, and includes automatic fallback to Canvas/DOM on GPU context loss.
  - Configurable under **Settings > Terminal > Display > WebGL Hardware Acceleration**.

- **Enhanced Horizontal & Vertical Split-Pane Multiplexing**:
  - Direct 1-click **Split Right (Columns)** (`Ctrl+Shift+D`) and **Split Down (Rows)** (`Ctrl+Shift+E`) buttons in the terminal tab strip.
  - Added orientation switching, active pane count indicators, and 1-click unsplit restore.
  - Multi-session workspace splits in `DesktopApp` now support both horizontal (side-by-side) and vertical (stacked) layouts with smooth, draggable dividers between adjacent sessions.

- **Multi-Tab Fleet Broadcast (Cluster Input Mode)**:
  - Top-bar broadcast button with session counter badge when 2+ sessions are active.
  - Interactive popover to select individual sessions or "Select All" / "Select None".
  - Armed sessions display a high-visibility safety warning banner with 1-click disarm controls to prevent accidental execution.
  - Live keystrokes and command snippets fan out to all targeted sessions concurrently.

- **Parameterized Snippets Engine (`{{variable:default}}`)**:
  - Reusable snippet template syntax supporting `{{variable}}` and `{{variable:defaultValue}}` placeholders.
  - Interactive parameter prompt modal featuring live monospace command preview, pre-populated defaults, and persistent parameter memory.
  - Direct execution integration across Command Palette (`Ctrl+K`), quick commands panel (`CmdsPanel`), and 1-click **Run** buttons on cards in the Library view.

- **Prominent Linux Distro Badges in Node Cards**:
  - Server cards in the grid now automatically showcase prominent high-resolution logos for detected Linux distributions (Ubuntu, Debian, Fedora, Arch, CentOS, Alpine, etc.) alongside connection latency and OS specs.

- **Terminal Context Menu & Buffer Export**:
  - Added a modern glassmorphic right-click context menu in terminal sessions with immediate shortcuts for Copy (`Ctrl+C`), Paste (`Ctrl+V`), Select All (`Ctrl+A`), Find in Terminal (`Ctrl+F`), Clear Scrollback, Reset Terminal, and Export Buffer.
  - 1-click **Export Buffer** action dumps the entire terminal history to a timestamped `.log` file for auditability and incident post-mortems.
  - Added **Right-Click Action** user preference under *Settings > Terminal* allowing users to toggle between opening the context menu or instant clipboard pasting (PuTTY style).
  - Added **Copy on select** toggle in *Settings > Terminal* to automatically copy highlighted text into the system clipboard.

- **Curated Terminal Color Schemes & Cursor Customization**:
  - Added 8 built-in developer-favorite terminal themes (*SubTerm Dark*, *Dracula*, *One Dark Pro*, *Nord*, *Catppuccin Macchiato*, *Tokyo Night*, *Monokai Pro*, and *Solarized Dark*).
  - Full 16-color ANSI rendering support for command output, logs, and syntax highlighters.
  - Live color palette swatches in the Settings panel with instant zero-reconnect live hot-reloading across all active terminal sessions.
  - Added cursor shape configuration (*Block*, *Underline*, *Bar*) and animated cursor blinking toggle.

- **SFTP Directory Bookmarks & Quick Navigation**:
  - Added a dedicated **Directory Bookmarks** toolbar popover for both remote SFTP and local file exploration.
  - Pre-loaded standard quick jumps for common server directories: `/` (Root), `~` (Home), `/var/log` (Logs), `/etc` (Configuration), `/var/www` (Web Root), `/opt`, and `/tmp`.
  - 1-click **Star Folder** toggle directly in the toolbar with live gold star indicator when viewing any bookmarked directory.
  - Real-time bookmark search filter and 1-click removal controls.

- **SFTP Hidden Files (Dotfiles) Toggle (`Ctrl+H`)**:
  - Added 1-click **Eye / Eye-Off** toolbar toggle and `Ctrl+H` keyboard shortcut to effortlessly filter Unix dotfiles (e.g. `.git/`, `.env`, `.bash_history`) in local and remote SFTP file browsers.
  - Interactive counter badge indicates the exact count of suppressed hidden items (e.g. `12 hidden`); clicking the badge instantly reveals all hidden entries.
  - State is persisted across sessions in local storage (`subterm-sftp-show-hidden`).

- **Terminal Bell Notifications & Pro Search Widget**:
  - Added configurable **Terminal Bell** support triggering on ASCII bell (`\a` or `BEL`): choose between *Visual Flash* (amber screen glow), *Audible Chime* (pure Web Audio API synthesizer), *Both*, or *Disabled*.
  - Upgraded in-terminal search widget (`Ctrl+F`) with real-time match counter (`X of Y` / `No matches`), case-sensitive toggle (`Aa`), whole-word boundary matching (`\b`), and regex pattern matching (`.*`).

- **Terminal Typography, Line Height & Scrollback Customization**:
  - **Font Family Presets**: Choose between curated developer fonts (*JetBrains Mono*, *Fira Code*, *Cascadia Code*, *Consolas*, *Monaco / Menlo*, *Source Code Pro*) or enter any custom font family stack.
  - **Row Line Height Slider**: Adjust vertical spacing (1.00x–1.60x) with real-time feedback and dynamic terminal re-fitting without session reconnection.
  - **Configurable Scrollback Buffer**: Select scrollback history limit per session from 1,000 lines (low memory) up to 50,000 lines (deep build & streaming log retention).

- **SFTP File & Directory Duplication (`Ctrl+D`)**:
  - 1-click **Duplicate** action in the SFTP and local file manager context menu and global `Ctrl+D` shortcut.
  - Automatically derives collision-free target names (`filename.copy.ext` or `filename.copy 2.ext`, and `folder.copy` for directories).
  - High-performance recursive copying for directories on both remote SFTP servers and local desktop environments.

- **1-Click OpenSSH `~/.ssh/config` & Client Importer**:
  - Direct **Import SSH Config** button placed prominently in the node toolbar and empty state.
  - Automatic zero-configuration parsing of OpenSSH config files (`~/.ssh/config` or `%USERPROFILE%\.ssh\config`) including host aliases, hostnames, ports, usernames, and identity keys.
  - Supports importing sessions from PuTTY registry exports and Termius JSON vaults.

- **Interactive Network Diagnostics & Port Prober**:
  - Built-in multi-tool diagnostics modal accessible via the node toolbar (`Activity` icon) and server card context menus.
  - Real-time TCP port probing with millisecond latency ping (`ms`) measurement.
  - 1-click concurrent port audit scanning common production services: SSH (22), HTTP (80), HTTPS (443), MySQL (3306), Postgres (5432), Redis (6379), and web proxies (8080, 8443).
  - Integrated Wake-on-LAN (WOL) magic packet broadcaster and sequential TCP port knocking for secured gateways.

- **Configurable SSH Keep-Alive Settings**:
  - Dynamic user-configurable keep-alive packet interval in **Settings > Terminal > SSH Connection Keep-Alive Interval**.
  - Choose between Disabled, 15s, 30s, 60s, or 120s intervals to eliminate dropped connections across NAT firewalls and cloud load balancers.
  - Dynamically updates active sessions and newly established connections without client restarts.

- **SFTP File Type Category Filters**:
  - Instant file filtering dropdown in the SFTP search bar allowing users to quickly filter directory contents by category: *All Types*, *Folders Only*, *Code & Scripts*, *Logs & Text*, *Archives*, and *Media & Images*.
  - Matches across all common extensions for rapid browsing of massive project roots and server file trees.

- **Custom Terminal Theme Importer & JSON Exporter**:
  - Import custom color themes directly by pasting `xterm.js` theme JSON or Windows Terminal / Alacritty color profiles.
  - 1-click **Copy Theme JSON** button in the theme selector to export color specifications to the system clipboard for sharing and backup.
  - Full management of custom saved themes alongside SubTerm's 8 built-in curated palettes.

---

### ⚡ Improvements & Performance

- **Refined Titlebar & Top Navigation**:
  - Top bar tabs (Terminal, SFTP, Docker, Processes, Services) now feature standardized, balanced dimensions with active indicator bars for a unified look across display resolutions.
  - Added direct, distinct buttons in the top titlebar to **Lock Vault** (`Lock` icon) and **Switch Profile** without navigating into deep menus.
- **Advanced Tab Strip Context Menu Actions**:
  - Added **Close Other Tabs** and **Close Tabs to the Right** to the right-click session tab menu, enabling rapid tab cleanup during multi-server maintenance workflows.
- **Accurate "Unlock" Terminology**:
  - Replaced misleading cloud-oriented "Sign In / Sign Out" terms across the application with local-first "Unlock / Lock Vault" terminology to accurately reflect local cryptographic security.
- **Integrated Profile Management**:
  - Merged standalone profile and team-sharing dialogs directly into the core **Settings > Profile & Workspaces** and **Settings > Cloud & Sync** categories, eliminating unnecessary sidebar clutter.
- **Production Safety Warnings**:
  - Enhanced workspace profile deletion, renaming, and factory reset dialogs with safety guards and confirmation steps to prevent accidental data loss.

---

### 🐛 Bug Fixes

- **Unauthorized Workspace Deletion Guard**: Fixed an issue where workspace profiles could be deleted from settings even while the vault was locked. All destructive workspace operations (delete, rename, change password) now strictly enforce an active unlock state.
- **Settings State Preservation**: Navigating between settings categories no longer resets unsaved form inputs or scroll offsets.
- **Memory Key Zeroing**: Fixed a condition where an in-memory session password could persist after an explicit vault lock action. Locking now completely frees the SQLite connection and clears cryptographic keys from memory.
- **Linux WebKit Wayland / Mesa 24 Startup**: Added auto-detection and safe fallback flags (`WEBKIT_DISABLE_HARDWARE_ACCELERATION`, `GDK_BACKEND=x11`) to prevent Wayland-EGL driver abort crashes on modern Linux distributions (Fedora 40+, Ubuntu 24.04+).

---

### ⚠️ Breaking Changes & Migration Steps

- **Profile Import/Export Format Standardization**:
  - Legacy plaintext imports have been phased out in favor of encrypted `.subterm` (and backwards-compatible `.submarine`) encrypted binary blobs.
  - *Migration*: Existing `.submarine` profiles in your data directory are automatically recognized, migrated, and preserved on first launch.
- **Settings Navigation Change**:
  - Global settings are no longer accessible from floating modal windows. Update workflows and documentation to access settings via `Ctrl+,` or the gear icon in the top header.
