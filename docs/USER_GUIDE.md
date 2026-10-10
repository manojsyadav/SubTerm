# SubTerm User Guide & Workflows

SubTerm is a fast, native, and customizable client for managing remote servers, SSH connections, SFTP file trees, Docker containers, and port forwarding tunnels.

---

## 1. Getting Started

### 1.1 Unlocking Your Vault
When you launch SubTerm, you are presented with the **Unlock** screen:
- **First Launch**: Enter a master password to create your primary encrypted workspace profile (`default.subterm`).
- **Subsequent Launches**: Enter your master password to unlock your stored servers, SSH keys, and credentials.
- **Locking Your Vault**: Click the Lock icon in the sidebar or top bar at any time to immediately flush unencrypted data from memory.

### 1.2 Finding a Server
The home dashboard's search bar filters by server name or host as you type. It also accepts shell-style glob wildcards: `*` matches any run of characters and `?` matches exactly one — e.g. `web-*`, `prod-db?`, `*-staging`.

---

## 2. Core Workflows

### Workflow 1: Adding and Connecting to an SSH Server

*Goal*: Connect to a remote Linux or BSD server and start an interactive terminal session.

1. **Add Server**:
   - Click the **+ New Server** button on the home dashboard or press `Ctrl+N`.
   - Provide a friendly **Name**, **Host/IP**, and **Port** (default: `22`).
2. **Configure Authentication**:
   - Choose **Password Authentication** or **Private Key**.
   - Select an existing saved key from your vault, or click the `[+]` button next to the SSH Key dropdown to generate a new key inline without leaving this panel.
   - Leave **Username** blank to resolve it from the matching `Host` block in your local `~/.ssh/config` at connect time (falls back to `root` if there's no match).
3. **Optional Configurations**:
   - **Jump Host**: If behind a bastion, select another saved server as your `ProxyJump`.
   - **Production Flag**: Check the `Production Server` box if the server hosts live customer traffic (enables safe mode command interception).
   - **Forward SSH Agent**: Toggle on to let this server use your local SSH agent (OpenSSH agent, Pageant, 1Password, KeePassXC, Vaultwarden) for further hops — e.g. `ssh`-ing to a third host or a `git` fetch over SSH — without SubTerm ever handling those keys itself. Requires a running local agent; only enable it for servers whose admins you trust (see `docs/SECURITY.md` §7 for the trust model).
4. **Connect**:
   - Click **Save & Connect**.
   - Verify the host key fingerprint on the first connection prompt.
   - An interactive `xterm.js` terminal tab opens immediately.
5. **Split Panes & Multiplexing**:
   - **Split Right (Columns)**: Click the Columns icon in the tab strip or press `Ctrl+\` to spawn a side-by-side terminal pane.
   - **Split Down (Rows)**: Click the Rows icon or press `Ctrl+Shift+D` to split the terminal into stacked rows.
   - **Move Between Panes**: Press `Alt+Shift+→` / `Alt+Shift+←` to focus the next / previous pane (or terminal tab when not split); it wraps around. All shortcuts can be rebound in **Settings > Keyboard Shortcuts**.
   - **Resize Panes**: Drag the divider line between adjacent panes to adjust flex ratios. SubTerm remembers your orientation (columns/rows) and the pane sizes you last used for each pane count, so the next split starts the same way; double-click a divider to reset to equal sizes.
   - **Unsplit**: Click the `Unsplit` button in the active split pill or click the `X` button on any pane's top-right corner to detach it.
   - **Multi-Session Splits**: Select multiple sessions from the top bar or session menu to tile multiple servers side-by-side or stacked in a unified canvas.
6. **Hardware Acceleration (WebGL)**:
   - GPU-accelerated rendering is enabled by default. To toggle or check status, navigate to **Settings (`Ctrl+,`) > Terminal > Display > WebGL Hardware Acceleration**.

7. **Fleet Broadcast (Cluster Mode)**:
   - When 2 or more server sessions are open, a Broadcast button (`Radio` icon) appears in the top navigation bar.
   - Click the button to toggle fleet broadcast mode, or select specific target sessions from the dropdown menu.
   - Armed sessions display a prominent orange banner: `Fleet Broadcast Active: Commands & keystrokes mirror concurrently`.
   - Any keystroke typed or command executed is fanned out to all selected sessions simultaneously.
   - Click **Disarm This Tab** or **Disable All** on the safety banner to immediately stop fan-out.

8. **Terminal Context Menu & Buffer Export**:
   - **Right-Click Context Menu**: Right-click anywhere in the active terminal to open a modern glassmorphic context menu with actions for **Copy** (`Ctrl+C`), **Paste** (`Ctrl+V`), **Select All** (`Ctrl+A`), **Find in Terminal** (`Ctrl+F`), **Clear Scrollback**, **Reset Terminal**, and **Export Buffer**.
   - **Paste Saved Password**: For sessions that connected with a saved password, this entry writes it straight into an interactive `[sudo] password for user:` prompt — the password is injected on the backend and never passes through the frontend.
   - **Record and replay a session**: Right-click > **Start recording** captures everything the terminal shows (plus window resizes) with timing; **Start recording with keystrokes** also captures what you type, so use it only when you are not typing secrets. Stop from the same menu (or click the red **REC** badge) and choose where to save in the Save dialog: a `.cast` file (asciinema v2) or a plain-text `.log`. Cancelling the dialog keeps the recording running. Open the command palette (`Ctrl+Shift+P`) and choose **Play Session Recording** to replay a `.cast` file with play/pause, a seek slider, speed (0.5x-8x) and Skip idle. Switch the feature off under Settings > Feature Toggles.
   - **Export Buffer to .log**: Click **Export Buffer** in the context menu and pick a location in the Save dialog to write the complete scrollback history to a `.log` file (e.g., `terminal-serverName-YYYY-MM-DDTHH-mm-ss.log`) for offline analysis or audit trails.
    - **Right-Click Action Preference**: Under **Settings (`Ctrl+,`) > Terminal > Session Behaviour**, choose between **Open Context Menu** or **Paste Immediately (PuTTY style)**.
    - **Copy on Select**: Under **Settings (`Ctrl+,`) > Terminal > Session Behaviour**, toggle **Copy on select** to automatically copy highlighted terminal text to your system clipboard without pressing any key.

9. **Tab Strip Context Menu & Session Management**:
   - Right-click any open session tab in the top tab strip to access the session menu:
     - **Reconnect / Disconnect**: Cleanly drop or re-establish connection without closing the tab.
     - **Split View With...**: Tick other open sessions to instantly tile them side-by-side or stacked.
     - **Pin to Wall**: Pin the session's active terminal directly into your persistent multi-pane terminal Wall.
     - **Close Tab**: Disconnect and dismiss the active tab.
     - **Close Other Tabs**: Disconnect and close all tabs except the selected session.
     - **Close Tabs to the Right**: Batch-dismiss all tabs situated to the right of the current tab.
     - **Upload public key**: While connected, pick a saved key to append its public half to the server's `~/.ssh/authorized_keys` (`~/.ssh` and `authorized_keys` permissions are set correctly, duplicates are skipped) — the one-click equivalent of `ssh-copy-id`.

10. **1-Click OpenSSH `~/.ssh/config` & Client Importer**:
    - Effortlessly migrate existing SSH hosts without manual entry.
    - Click **Import SSH Config** in the Node Toolbar (or the prominent button in the empty server state).
    - SubTerm scans your local standard OpenSSH configuration (`~/.ssh/config` on Linux/macOS or `%USERPROFILE%\.ssh\config` on Windows), parses `Host`, `HostName`, `User`, `Port`, and `IdentityFile` declarations, and allows batch-importing into your encrypted vault with 1 click.
    - Also supports importing from PuTTY session registry exports and Termius JSON vaults.

11. **Configurable SSH Keep-Alive Settings**:
    - Prevent SSH session timeouts and dropped connections caused by NAT gateways, corporate firewalls, and cloud load balancers.
    - Navigate to **Settings (`Ctrl+,`) > Terminal > Session Behaviour > SSH Connection Keep-Alive Interval**.
    - Choose between **Disabled**, **15 seconds** (recommended for strict NATs/firewalls), **30 seconds**, **60 seconds**, or **120 seconds**.
    - Changes take effect dynamically across all active and newly spawned SSH connections.

12. **Interactive Network Diagnostics & TCP Port Prober**:
    - Rapidly troubleshoot connectivity before or during connection issues.
    - Click **Network Tools** (`Activity` icon) in the node toolbar or select **Network Diagnostics** from any server card's context menu.
    - **TCP Ping & Latency**: Test connectivity to any host/port and observe real-time round-trip latency (`ms`).
    - **Common Port Audit**: 1-click audit scanning essential infrastructure ports simultaneously: SSH (22), HTTP (80), HTTPS (443), MySQL (3306), PostgreSQL (5432), Redis (6379), Web Alternative (8080), and HTTPS Alternative (8443).
    - **Wake-on-LAN (WOL)**: Send magic broadcast packets (`FF:FF:FF:FF:FF:FF` + MACx16) to wake sleeping local network servers.
    - **Port Knocking**: Execute sequential single-packet TCP knocks across designated firewall sequence ports with custom inter-knock delays.

### Workflow 2: Managing Remote Files with SFTP & Quick Editor

*Goal*: Browse, upload, download, and edit configuration files directly on the remote server.

1. **Open SFTP Tab**:
   - From an active session, click the **SFTP** tab or press `Ctrl+Shift+F`.
2. **Directory Navigation**:
   - Browse through remote directories using the clickable breadcrumb bar or path input.
   - Right-click any file to download, rename, change permissions (`chmod`), or delete.
   - Symbolic links pointing at directories are shown as navigable folders (with a small link badge on the icon) in both the remote and local panes, so you can open them the same way as a real folder.
   - **Multi-Item Selection**: Click a row to select it, `Ctrl`/`⌘`+click to add/remove individual rows, `Shift`+click to select a range, or use the per-row checkbox (revealed on hover). A floating action bar appears with Download, Upload, Move…, and Delete for every selected item at once.
   - **Compare with Other Pane**: Right-click a file and choose **Compare with Other Pane** to open a unified diff against the same-named file in the opposite pane's current directory — works local-vs-remote or across two different sessions. **Use Left →** / **← Use Right** copies one file's contents over the other.
3. **Editing Remote Files**:
   - Double-click any text configuration file (e.g. `nginx.conf` or `.env`).
   - The in-app code editor opens with syntax highlighting.
   - Press `Ctrl+S` to save modifications directly back to the remote server over SFTP.
4. **File Transfers**:
   - Drag and drop files from your local file explorer into the SubTerm SFTP panel to start transfers.
   - Monitor real-time transfer progress and transfer speed in the progress widget.
5. **Directory Bookmarks & Quick Navigation (Starred Folders)**:
   - **Quick Access Jumps**: Click the **Bookmark / Star** icon in the SFTP toolbar to access standard paths including `/` (Root), `~` (Home), `/var/log` (Logs), `/etc` (Configuration), `/var/www` (Web Root), `/opt`, and `/tmp`.
   - **Star Any Directory**: Click **Star Folder** inside the bookmarks popover (or check the active gold star status) to save frequently accessed paths with custom friendly names.
   - **Persistent & Searchable**: Bookmarks persist across application restarts and can be instantly filtered by typing in the popover search input.
6. **Toggle Hidden Files & Dotfiles (`Ctrl+H`)**:
   - Click the **Eye / Eye-Off** button in the SFTP toolbar (or press `Ctrl+H`) to toggle visibility of hidden files and Unix dotfiles (e.g. `.env`, `.git/`, `.bashrc`).
   - When hidden files are suppressed, SubTerm displays a discreet counter badge (e.g. `4 hidden`) indicating suppressed items; click the badge anytime to instantly reveal them.
7. **Duplicate / Clone Files & Folders (`Ctrl+D`)**:
   - Right-click any file or directory and select **Duplicate** (or select the item and press `Ctrl+D`).
   - For files, SubTerm automatically appends `.copy` before the extension (e.g., `nginx.conf` -> `nginx.copy.conf`). If a copy already exists, it auto-increments (`nginx.copy 2.conf`).
   - For folders, SubTerm performs an automatic recursive copy (e.g., `dist` -> `dist.copy`).
   - Supported across both remote SFTP servers and local desktop file browsing.
8. **File Type Category Filter**:
   - Easily isolate specific file formats in large directories using the file category dropdown filter next to the filename search box:
     - **All Types**: Displays every file and directory.
     - **Folders Only**: Filters the list to directories only.
     - **Code & Scripts**: Displays programming and script files (`.js`, `.ts`, `.py`, `.sh`, `.rs`, `.go`, `.html`, `.css`, etc.).
     - **Logs & Text**: Displays log outputs, documentation, and configuration files (`.log`, `.txt`, `.md`, `.json`, `.yaml`, `.ini`, etc.).
     - **Archives**: Displays compressed packages (`.zip`, `.tar`, `.gz`, `.tgz`, `.bz2`, `.7z`, `.rar`).
     - **Media & Images**: Displays graphic assets and video (`.png`, `.jpg`, `.jpeg`, `.gif`, `.svg`, `.webp`, `.mp4`).

### Workflow 3: Configuring Port Forwarding (Tunnels)

*Goal*: Access a remote database (e.g. PostgreSQL on port 5432) or web admin panel locally.

1. **Open Tunnels Panel**:
   - In your active server session, click the **Tunnels** tab.
2. **Add a Tunnel**:
   - Click **+ Add Tunnel**.
   - Select **Local Forwarding (`-L`)**.
   - Set **Local Address**: `127.0.0.1:5432`.
   - Set **Remote Address**: `127.0.0.1:5432`.
3. **Start Forwarding**:
   - Click **Start**. The status indicator turns green (`Active`).
   - You can now connect your local database client (e.g. pgAdmin, DBeaver) to `localhost:5432`.

### Workflow 4: Managing Remote Docker Containers

*Goal*: Inspect, restart, and tail logs from Docker containers running on the remote host.

1. **Open Docker Tab**:
   - Click the **Docker** tab in your active connection window.
2. **Container Inspection**:
   - View running containers, status, uptime, and mapped ports.
   - View live CPU and memory utilization meters per container.
3. **Container Actions**:
   - Click **Restart**, **Stop**, or **Start** for individual containers.
   - Click the **Logs** button to view real-time log output.
   - Click the **Terminal** icon to attach an interactive `docker exec -it` shell directly inside the container.

### Workflow 5: Parameterized Snippets & Runbook Automation

*Goal*: Create and execute reusable commands with dynamic variable prompts and default values.

1. **Define Parameterized Syntax**:
   - Use `{{variable}}` or `{{variable:defaultValue}}` placeholders in your command snippets.
   - Example:
     ```bash
     docker run -d -p {{port:8080}}:80 --name {{name:web-nginx}} {{image:nginx:alpine}}
     ```
2. **Executing Snippets**:
   - **From Command Palette (`Ctrl+K`)**: Select any saved command snippet.
   - **From Quick Commands (`CmdsPanel`)**: Click the play icon on any snippet in the terminal sidebar.
   - **From Library Tab**: Click the **Run** button directly on the command card.
3. **Interactive Parameter Modal**:
   - SubTerm detects variables and prompts you with a modal displaying:
     - Input fields prefilled with default values or previously used values.
     - Live monospace preview of the interpolated command.
     - Fleet Broadcast indicator if running across multiple sessions.
   - Click **Run Command** (`Enter`) to execute, or **Paste to Prompt** to insert into the terminal without executing.
4. **Scoping a Snippet to One Server**:
   - When adding or editing a command in the Library, set **Scope** to a specific server instead of **Global**, and optionally add comma-separated **Tags**.
   - A server-scoped snippet only appears in that server's Command Palette (`Ctrl+K`) — global snippets (the default) still show everywhere. Library cards show a scope badge and tag chips, and the Library search box matches against tags too.

---

## 3. Configuration & Customization

SubTerm includes an 11-category **Settings Panel** (accessible via the gear icon or `Ctrl+,`):

- **Appearance**: Select your preferred accent color and dark/light UI theme.
- **Terminal**:
  - **Curated Color Schemes & Custom Theme Importer**:
    - Select from 8 curated themes (*SubTerm Dark*, *Dracula*, *One Dark Pro*, *Nord*, *Catppuccin Macchiato*, *Tokyo Night*, *Monokai Pro*, *Solarized Dark*) with full 16-color ANSI rendering and live preview swatches.
    - **Import Custom Theme**: Click the **+** button in the theme selector to paste any `xterm.js` theme JSON or Windows Terminal / Alacritty color scheme. Custom themes are saved locally and immediately selectable in the theme dropdown.
    - **Export Theme JSON**: Click the **Download / Copy** button to copy the active theme's exact color specification JSON to your system clipboard for sharing or backup.
    - **Delete Custom Theme**: Delete any user-created theme with a single click.
  - **Typography & Font Family**: Choose from curated developer font presets (*JetBrains Mono*, *Fira Code*, *Cascadia Code*, *Consolas*, *Monaco / Menlo*, *Source Code Pro*) or specify a custom font family stack.
  - **Line Height & Vertical Spacing**: Interactive slider (1.00x–1.60x) to fine-tune row density for optimal reading comfort.
  - **Scrollback Buffer Limit**: Configure memory buffer size per session (1,000, 5,000, 10,000, 25,000, or 50,000 lines) to support long-running build outputs and container logs.
  - **Cursor Customization**: Configure cursor shape (*Block*, *Underline*, *Bar / Vertical Line*) and toggle animated cursor blinking.
  - **Terminal Bell Alerts**: Choose between *Visual Flash* (amber border glow), *Audible Chime* (pure Web Audio synthesizer), *Both*, or *Disabled* when an ASCII Bell (`\a` or `BEL`) is triggered by completed builds or shell alerts.
  - **Pro Terminal Search (`Ctrl+F`)**: Floating search widget featuring live match counter badge (`3 of 15` / `No matches`), case-sensitive matching (`Aa`), whole-word boundaries (`\b`), regular expressions (`.*`), and navigation arrows.
  - **Font Size & WebGL Acceleration**: Real-time font size adjustment (8px–24px) and WebGL GPU rasterization toggle.
  - **Clipboard & Mouse Behavior**: Choose between glassmorphic Context Menu or instant PuTTY-style paste on right-click, and toggle automatic Copy on Select.
  - **SSH Keep-Alive Interval**: Configure keep-alive ping frequency (Disabled, 15s, 30s, 60s, 120s) to keep remote SSH tunnels and terminal sessions resilient across unstable networks and strict NAT firewalls.
  - **Terminal Triggers & Alert Keywords**: Define keyword or regex patterns matched against live output in any session. Each trigger fires one of: a toast notification, the audible bell chime, the visual bell flash, or an entry in the Activity Log — useful for noticing `ERROR`/`FATAL`/`Exception` in a background session tab.
- **Keyboard Shortcuts**: Rebind global shortcuts (e.g., Command Palette `Ctrl+K`, Quick Terminal `Ctrl+Alt+T`, Switch Profile).
- **Monitoring**: Adjust background polling intervals (default: 5 seconds) and CPU/RAM alert thresholds.
- **Cloud & Sync**: Configure custom self-hosted sync endpoints and manage profile synchronization. Under **What to sync on this device** you can leave out servers, credentials, saved commands or notes on this device only; unchecked data is neither uploaded nor downloaded.
- **Profiles & Workspaces**: Create isolated profiles (e.g. "Work", "Personal", "Staging") each encrypted with its own master password.
- **Known Hosts**: Review all trusted SSH host keys and fingerprints, copy fingerprints to clipboard, and revoke stale keys when a server is re-imaged.
- **Maintenance**: Reset UI preferences to factory defaults, and **Export Server List** to a portable JSON or CSV file (name, host, port, username, folder, proxy, notes — never passwords or keys) for backup or migration.

---

## 4. Frequently Asked Questions & Troubleshooting

### Q: Why does an unknown server show a "Host Key Verification" prompt?
On the first connection to any server, SubTerm displays the server's public key fingerprint (SHA256). Verify that this fingerprint matches your server's fingerprint to protect against Man-in-the-Middle (MITM) attacks before clicking **Trust & Connect**.

### Q: How do I remove a revoked or changed SSH host key?
If a remote server's OS was re-installed or its SSH host key was rotated, navigate to **Settings (`Ctrl+,`) > Known Hosts**, find the entry for that host/port, and click **Revoke**. When you reconnect to the server, SubTerm will display a fresh fingerprint prompt to trust the new key.

### Q: "No common key algorithm" or connection fails on older Linux servers?
If you are connecting to older servers that only support legacy RSA host keys (`ssh-rsa`), ensure your SubTerm build was compiled with the `full-ssh-algos` feature:
```bash
npm run tauri dev -- --features full-ssh-algos
```
The pure-Rust default build intentionally disables legacy RSA host keys to reduce attack surface and build dependencies.

### Q: How do I open a native local terminal on my computer?
Press `Ctrl+Alt+T` or click the **Local Shell** button in the top navigation bar. On Windows, this launches PowerShell or Command Prompt via ConPTY. On Linux/macOS, it launches your default `$SHELL`.

### Q: What happens if my laptop sleeps or I switch networks mid-session?
SubTerm detects both and retries automatically — you don't need to manually reconnect. A sleep/resume cycle or a network change (Wi-Fi roam, VPN toggle, cable unplug) triggers an immediate reconnect attempt instead of waiting for the passive connection-health check to notice. If the server is still unreachable, retries continue with increasing backoff (2s, 4s, 8s, up to 30s) until it comes back, shown as a "Reconnecting · attempt N" banner. A connection you disconnected yourself (right-click → Disconnect) never auto-reconnects — click **Reconnect** on the banner when you're ready.

### Q: Why are some settings categories showing a lock screen?
Sensitive settings categories (Profiles, Cloud Sync, Quick Commands, Quick Access Servers, Known Hosts, Maintenance, Activity Log) contain private credentials and configurations. If your vault is locked, SubTerm prevents access until you click **Unlock** and enter your master password.
