# SubTerm User Guide & Workflows

SubTerm is a fast, native, and customizable client for managing remote servers, SSH connections, SFTP file trees, Docker containers, and port forwarding tunnels.

---

## 1. Getting Started

### 1.1 Unlocking Your Vault
When you launch SubTerm, you are presented with the **Unlock** screen:
- **First Launch**: Enter a master password to create your primary encrypted workspace profile (`default.subterm`).
- **Subsequent Launches**: Enter your master password to unlock your stored servers, SSH keys, and credentials.
- **Locking Your Vault**: Click the Lock icon in the sidebar or top bar at any time to immediately flush unencrypted data from memory.

---

## 2. Core Workflows

### Workflow 1: Adding and Connecting to an SSH Server

*Goal*: Connect to a remote Linux or BSD server and start an interactive terminal session.

1. **Add Server**:
   - Click the **+ New Server** button on the home dashboard or press `Ctrl+N`.
   - Provide a friendly **Name**, **Host/IP**, and **Port** (default: `22`).
2. **Configure Authentication**:
   - Choose **Password Authentication** or **Private Key**.
   - Select an existing saved key from your vault or click **Generate Key** / **Import Key**.
3. **Optional Configurations**:
   - **Jump Host**: If behind a bastion, select another saved server as your `ProxyJump`.
   - **Production Flag**: Check the `Production Server` box if the server hosts live customer traffic (enables safe mode command interception).
4. **Connect**:
   - Click **Save & Connect**.
   - Verify the host key fingerprint on the first connection prompt.
   - An interactive `xterm.js` terminal tab opens immediately.
5. **Split Panes & Multiplexing**:
   - **Split Right (Columns)**: Click the Columns icon in the tab strip or press `Ctrl+Shift+D` to spawn a side-by-side terminal pane.
   - **Split Down (Rows)**: Click the Rows icon or press `Ctrl+Shift+E` to split the terminal vertically.
   - **Resize Panes**: Drag the divider line between adjacent panes to adjust flex ratios.
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
   - **Export Buffer to .log**: Click **Export Buffer** in the context menu to download the complete scrollback history into a timestamped `.log` file (e.g., `terminal-serverName-YYYY-MM-DDTHH-mm-ss.log`) for offline analysis or audit trails.
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

### Workflow 2: Managing Remote Files with SFTP & Quick Editor

*Goal*: Browse, upload, download, and edit configuration files directly on the remote server.

1. **Open SFTP Tab**:
   - From an active session, click the **SFTP** tab or press `Ctrl+Shift+F`.
2. **Directory Navigation**:
   - Browse through remote directories using the clickable breadcrumb bar or path input.
   - Right-click any file to download, rename, change permissions (`chmod`), or delete.
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

---

## 3. Configuration & Customization

SubTerm includes an 11-category **Settings Panel** (accessible via the gear icon or `Ctrl+,`):

- **Appearance**: Select your preferred accent color and dark/light UI theme.
- **Terminal**:
  - **Curated Color Schemes**: Select from 8 curated terminal themes (*SubTerm Dark*, *Dracula*, *One Dark Pro*, *Nord*, *Catppuccin Macchiato*, *Tokyo Night*, *Monokai Pro*, *Solarized Dark*) with full 16-color ANSI rendering and live preview swatches. Active terminals update instantly without reconnecting.
  - **Cursor Customization**: Configure cursor shape (*Block*, *Underline*, *Bar / Vertical Line*) and toggle animated cursor blinking.
  - **Terminal Bell Alerts**: Choose between *Visual Flash* (amber border glow), *Audible Chime* (pure Web Audio synthesizer), *Both*, or *Disabled* when an ASCII Bell (`\a` or `BEL`) is triggered by completed builds or shell alerts.
  - **Pro Terminal Search (`Ctrl+F`)**: Floating search widget featuring live match counter badge (`3 of 15` / `No matches`), case-sensitive matching (`Aa`), whole-word boundaries (`\b`), regular expressions (`.*`), and navigation arrows.
  - **Font Size & WebGL Acceleration**: Real-time font size adjustment (8px–24px) and WebGL GPU rasterization toggle.
  - **Clipboard & Mouse Behavior**: Choose between glassmorphic Context Menu or instant PuTTY-style paste on right-click, and toggle automatic Copy on Select.
- **Keyboard Shortcuts**: Rebind global shortcuts (e.g., Command Palette `Ctrl+K`, Quick Terminal `Ctrl+Alt+T`, Switch Profile).
- **Monitoring**: Adjust background polling intervals (default: 5 seconds) and CPU/RAM alert thresholds.
- **Cloud & Sync**: Configure custom self-hosted sync endpoints and manage profile synchronization.
- **Profiles & Workspaces**: Create isolated profiles (e.g. "Work", "Personal", "Staging") each encrypted with its own master password.
- **Known Hosts**: Review all trusted SSH host keys and fingerprints, copy fingerprints to clipboard, and revoke stale keys when a server is re-imaged.

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

### Q: Why are some settings categories showing a lock screen?
Sensitive settings categories (Profiles, Cloud Sync, Quick Commands, Quick Access Servers, Known Hosts, Maintenance, Activity Log) contain private credentials and configurations. If your vault is locked, SubTerm prevents access until you click **Unlock** and enter your master password.
