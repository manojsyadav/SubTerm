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

---

## 3. Configuration & Customization

SubTerm includes a 10-category **Settings Panel** (accessible via the gear icon or `Ctrl+,`):

- **Appearance**: Select your preferred accent color and dark/light UI theme.
- **Terminal**: Adjust font family, font size, line height, cursor styles, and terminal scrollback buffer size.
- **Keyboard Shortcuts**: Rebind global shortcuts (e.g., Command Palette `Ctrl+K`, Quick Terminal `Ctrl+Alt+T`, Switch Profile).
- **Monitoring**: Adjust background polling intervals (default: 5 seconds) and CPU/RAM alert thresholds.
- **Cloud & Sync**: Configure custom self-hosted sync endpoints and manage profile synchronization.
- **Profiles & Workspaces**: Create isolated profiles (e.g. "Work", "Personal", "Staging") each encrypted with its own master password.

---

## 4. Frequently Asked Questions & Troubleshooting

### Q: Why does an unknown server show a "Host Key Verification" prompt?
On the first connection to any server, SubTerm displays the server's public key fingerprint (SHA256). Verify that this fingerprint matches your server's fingerprint to protect against Man-in-the-Middle (MITM) attacks before clicking **Trust & Connect**.

### Q: "No common key algorithm" or connection fails on older Linux servers?
If you are connecting to older servers that only support legacy RSA host keys (`ssh-rsa`), ensure your SubTerm build was compiled with the `full-ssh-algos` feature:
```bash
npm run tauri dev -- --features full-ssh-algos
```
The pure-Rust default build intentionally disables legacy RSA host keys to reduce attack surface and build dependencies.

### Q: How do I open a native local terminal on my computer?
Press `Ctrl+Alt+T` or click the **Local Shell** button in the top navigation bar. On Windows, this launches PowerShell or Command Prompt via ConPTY. On Linux/macOS, it launches your default `$SHELL`.

### Q: Why are some settings categories showing a lock screen?
Sensitive settings categories (Profiles, Cloud Sync, Quick Commands, Quick Access Servers, Maintenance, Activity Log) contain private credentials and configurations. If your vault is locked, SubTerm prevents access until you click **Unlock** and enter your master password.
