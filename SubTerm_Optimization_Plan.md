# SubTerm Master Optimization & QoL Plan (All 33 Features)

This master plan covers every single requested feature and enhancement, structured in **strict order of lowest blast radius and lowest effort first**. Every feature includes target files, implementation specifics, validation procedures, and estimated effort.

---

## High-Level Phase & Effort Overview

| Phase | Focus Area | Features | Blast Radius | Est. Effort |
| :--- | :--- | :--- | :---: | :---: |
| **Phase 1** | Pure Frontend UI & Keyboard Wins | 8 Features | Zero (Frontend only) | ~18–22 hrs (2.5 days) |
| **Phase 2** | Workflow Deep Linking & SFTP Supercharging | 7 Features | Low (Component interop) | ~24–28 hrs (3.5 days) |
| **Phase 3** | Git Intelligence, Ports & Docker Quick-Actions | 7 Features | Low–Medium (Lightweight backend probes) | ~24–30 hrs (3.5 days) |
| **Phase 4** | Power Workstation, Command Palette & Fleet | 6 Features | Medium (Terminal / Rust stream) | ~30–36 hrs (4.5 days) |
| **Phase 5** | Mobile Touch, Biometrics & AI Copilot | 4 Features | Medium (OS Keystore / AI API) | ~22–28 hrs (3.5 days) |
| **Phase 6** | Codebase Architecture & Modularization | 3 Features | Medium (Structural refactor) | ~20–24 hrs (3 days) |
| **Total** | **Full Workstation Transformation** | **33 Features** | — | **~138–168 hrs (~20 days)** |

---

## Phase 1: Pure Frontend UI & Keyboard Wins (Zero Backend Blast Radius)
**Estimated Effort:** ~18–22 hours (2.5 days)  
**Risk / Blast Radius:** Very Low — Pure React/TypeScript UI changes; no Rust backend or database changes.

### 1.1 1-Click Direct Server Actions
* **Target Files:** [src/components/NodeGrid.tsx](file:///d:/REPO/SubTerm/src/components/NodeGrid.tsx), [src/DesktopApp.tsx](file:///d:/REPO/SubTerm/src/DesktopApp.tsx), [src/components/SessionView.tsx](file:///d:/REPO/SubTerm/src/components/SessionView.tsx)
* **Effort:** 3 hours
* **Details:** Add hover action chips `[📁 SFTP]` and `[🐳 Docker]` on server cards in NodeGrid. Clicking jumps straight into that tool on connect instead of terminal.
* **Validation:** Hover card $\rightarrow$ click `[SFTP]` $\rightarrow$ verify SFTP workspace opens immediately. Click `[Docker]` $\rightarrow$ verify Docker container tab opens.

### 1.2 1-Click "Open in Browser" for Local Port Tunnels
* **Target Files:** [src/components/TunnelsPanel.tsx](file:///d:/REPO/SubTerm/src/components/TunnelsPanel.tsx)
* **Effort:** 2 hours
* **Details:** For active local port forwards (`127.0.0.1:<port>`), render `[🌐 Open Browser]`. On click, invokes existing `about::open_external_url` to `http://localhost:<port>`.
* **Validation:** Forward port 8080 $\rightarrow$ click browser icon $\rightarrow$ verify default OS browser opens `http://localhost:8080`.

### 1.3 Core Global Keyboard Shortcuts Suite (Keyboard-First Flow)
* **Target Files:** [src/DesktopApp.tsx](file:///d:/REPO/SubTerm/src/DesktopApp.tsx), [src/hooks/useGlobalShortcuts.ts](file:///d:/REPO/SubTerm/src/hooks/useGlobalShortcuts.ts)
* **Effort:** 4 hours
* **Details:** Add global window listeners for:
  * `Ctrl+Tab` / `Ctrl+Shift+Tab`: Cycle through open session tabs.
  * `Alt+1` to `Alt+9`: Switch directly to tab 1..9.
  * `Ctrl+Shift+W`: Close active tab.
  * `Ctrl+Shift+D` or `Ctrl+\`: Instant horizontal split terminal.
  * `Ctrl+Shift+E`: Instant vertical split terminal.
  * `Ctrl+Shift+F`: Toggle SFTP workspace.
* **Validation:** Open multiple tabs and press shortcuts; verify tab switching, closing, and splitting occur with 0 mouse clicks.

### 1.4 Recent Quick-Connects MRU Dropdown
* **Target Files:** [src/components/QuickConnectModal.tsx](file:///d:/REPO/SubTerm/src/components/QuickConnectModal.tsx)
* **Effort:** 2 hours
* **Details:** Store last 5 quick-connects in `localStorage`. Render as clickable chips at the top of the modal for 1-click re-connection.
* **Validation:** Connect to quick host $\rightarrow$ reopen modal $\rightarrow$ verify chip appears $\rightarrow$ click chip to auto-populate form.

### 1.5 Production Environment Safety Badges & Guardrails
* **Target Files:** [src/components/AddNodePanel.tsx](file:///d:/REPO/SubTerm/src/components/AddNodePanel.tsx), [src/components/SessionView.tsx](file:///d:/REPO/SubTerm/src/components/SessionView.tsx), [src/DesktopApp.tsx](file:///d:/REPO/SubTerm/src/DesktopApp.tsx)
* **Effort:** 3 hours
* **Details:** Add `environment: "prod" | "staging" | "dev"`. Production servers display a crimson border and `⚠️ PRODUCTION` badge. Broadcasting commands to a group containing Production prompts for confirmation.
* **Validation:** Mark server as Production $\rightarrow$ open session $\rightarrow$ verify red accent and badge $\rightarrow$ test broadcast safety prompt.

### 1.6 Pinned Quick-Action Bar Below / Above Terminal
* **Target Files:** [src/components/SessionView.tsx](file:///d:/REPO/SubTerm/src/components/SessionView.tsx)
* **Effort:** 3 hours
* **Details:** Add a compact customizable toolbar above/below the terminal with favorite 1-click pills: `[ 🐳 docker ps ]`, `[ 📊 htop ]`, `[ 🔄 git status ]`, `[ 📝 tail logs ]`.
* **Validation:** Click any quick chip $\rightarrow$ verify command writes to terminal with carriage return immediately.

### 1.7 Split View Drag-to-Resize & Layout Presets
* **Target Files:** [src/components/SessionView.tsx](file:///d:/REPO/SubTerm/src/components/SessionView.tsx)
* **Effort:** 3 hours
* **Details:** Add layout preset buttons: `[2-Col]`, `[2-Row]`, `[1 Big + 2 Stacked]` and smooth drag handles between split panes.
* **Validation:** Click 2-Col $\rightarrow$ drag separator $\rightarrow$ verify xterm instances auto-fit dynamically.

### 1.8 Background Tab Rendering Optimization
* **Target Files:** [src/components/TerminalView.tsx](file:///d:/REPO/SubTerm/src/components/TerminalView.tsx)
* **Effort:** 2 hours
* **Details:** Pause xterm WebGL/canvas refresh cycles when a tab is inactive or hidden, refitting only when made active.
* **Validation:** Switch between 5 tabs $\rightarrow$ verify CPU usage drops to near-zero for hidden tabs.

---

## Phase 2: Workflow Deep Linking & SFTP Supercharging
**Estimated Effort:** ~24–28 hours (3.5 days)  
**Risk / Blast Radius:** Low — Component-to-component communication; lightweight backend helpers.

### 2.1 Interactive Clickable Breadcrumbs in SFTP
* **Target Files:** [src/components/FilePanel.tsx](file:///d:/REPO/SubTerm/src/components/FilePanel.tsx)
* **Effort:** 3 hours
* **Details:** Replace plain text path with clickable segment chips (`root / var / log / nginx`). Double-click empty area toggles back to editable text.
* **Validation:** Click `log` in breadcrumbs $\rightarrow$ verify SFTP navigates straight to `/var/log`.

### 2.2 Seamless Terminal $\leftrightarrow$ SFTP Deep Linking ("Open Here")
* **Target Files:** [src/components/SessionView.tsx](file:///d:/REPO/SubTerm/src/components/SessionView.tsx), [src/components/TerminalView.tsx](file:///d:/REPO/SubTerm/src/components/TerminalView.tsx), [src/components/FilePanel.tsx](file:///d:/REPO/SubTerm/src/components/FilePanel.tsx)
* **Effort:** 4 hours
* **Details:**
  * Terminal $\rightarrow$ SFTP: "Open in SFTP" button opens remote file browser at the terminal's active `pwd`.
  * SFTP $\rightarrow$ Terminal: Right-click any folder $\rightarrow$ "Open in Terminal" sends `cd "<path>"\r` to active terminal.
* **Validation:** In terminal run `cd /var/www` $\rightarrow$ click "Open in SFTP" $\rightarrow$ verify SFTP loads `/var/www`.

### 2.3 Parameterized Command Snippets with Variables `{{var}}`
* **Target Files:** [src/components/CmdsPanel.tsx](file:///d:/REPO/SubTerm/src/components/CmdsPanel.tsx)
* **Effort:** 4 hours
* **Details:** Support templates like `docker logs -f {{container_name}}`. On click, pop up a small dialog asking for `container_name`, then execute.
* **Validation:** Create command with `{{app_name}}` $\rightarrow$ click Run $\rightarrow$ input value $\rightarrow$ verify substituted command runs in terminal.

### 2.4 Built-in Lightweight Code & Config Editor
* **Target Files:** [src/components/FilePanel.tsx](file:///d:/REPO/SubTerm/src/components/FilePanel.tsx), [src/components/SftpWorkspace.tsx](file:///d:/REPO/SubTerm/src/components/SftpWorkspace.tsx)
* **Effort:** 6 hours
* **Details:** Slide-over modal editor for text/config files $<2\text{ MB}$ with syntax highlighting and a 1-click "Save & Upload" button.
* **Validation:** Right-click remote `.env` $\rightarrow$ "Quick View" $\rightarrow$ edit a line $\rightarrow$ click Save $\rightarrow$ verify upload toast confirms file write.

### 2.5 Side-by-Side Visual Diff Before Overwriting
* **Target Files:** [src/components/FilePanel.tsx](file:///d:/REPO/SubTerm/src/components/FilePanel.tsx)
* **Effort:** 4 hours
* **Details:** On transfer collision (`EXISTS:<path>`), provide a `[View Diff]` button showing a two-pane visual diff (additions in green, deletions in red) before confirming overwrite.
* **Validation:** Upload an existing file $\rightarrow$ collision dialog pops up $\rightarrow$ click View Diff $\rightarrow$ verify diff viewer shows changed lines.

### 2.6 Remote Archive & Compression Context Actions (tar / zip)
* **Target Files:** [src/components/FilePanel.tsx](file:///d:/REPO/SubTerm/src/components/FilePanel.tsx), [src-tauri/src/lib.rs](file:///d:/REPO/SubTerm/src-tauri/src/lib.rs)
* **Effort:** 4 hours
* **Details:** Right-click remote file/folder $\rightarrow$ "Compress to .tar.gz / .zip" or "Extract here" (executed via background SSH `tar -czf` / `tar -xzf`).
* **Validation:** Right-click remote folder $\rightarrow$ "Compress to .tar.gz" $\rightarrow$ verify archive file appears in folder listing.

### 2.7 Remote Fuzzy File Search (`Ctrl+P` inside SFTP)
* **Target Files:** [src/components/FilePanel.tsx](file:///d:/REPO/SubTerm/src/components/FilePanel.tsx), [src-tauri/src/lib.rs](file:///d:/REPO/SubTerm/src-tauri/src/lib.rs)
* **Effort:** 3 hours
* **Details:** Press `Ctrl+P` in SFTP $\rightarrow$ popup fuzzy-finds any file under current directory tree via remote `find` / `fd`.
* **Validation:** Press `Ctrl+P` in `/var/www` $\rightarrow$ type `settings` $\rightarrow$ verify results list matching files with 1-click jump.

---

## Phase 3: Git Intelligence, Ports & Docker Quick-Actions
**Estimated Effort:** ~24–30 hours (3.5 days)  
**Risk / Blast Radius:** Low–Medium — Non-interactive background SSH commands and new status indicators.

### 3.1 SFTP File Explorer Git Integration
* **Target Files:** [src/components/FilePanel.tsx](file:///d:/REPO/SubTerm/src/components/FilePanel.tsx)
* **Effort:** 4 hours
* **Details:** If folder contains `.git/`, read `.git/HEAD` via SFTP. Display active branch chip `[ main]`. Highlight modified files in yellow/amber and untracked files in green.
* **Validation:** Browse to a Git repository in SFTP $\rightarrow$ verify branch chip displays and modified files carry badges.

### 3.2 Terminal Git Status Bar & 1-Click Git Drawer
* **Target Files:** [src/components/SessionView.tsx](file:///d:/REPO/SubTerm/src/components/SessionView.tsx)
* **Effort:** 6 hours
* **Details:** Display live Git branch and dirty count in the terminal header: ` main *2 [↑1]`. Clicking opens a quick drawer with 1-click `[Git Pull]`, `[Git Stash]`, and `[View Diff]` actions.
* **Validation:** `cd` into a Git repo in terminal $\rightarrow$ verify status chip updates $\rightarrow$ click chip and run `[Git Pull]`.

### 3.3 Backend Non-Blocking `ssh_git_status` Probe
* **Target Files:** [src-tauri/src/lib.rs](file:///d:/REPO/SubTerm/src-tauri/src/lib.rs)
* **Effort:** 4 hours
* **Details:** Rust command executing `git status --porcelain -b` non-interactively over the SSH transport without touching the interactive PTY.
* **Validation:** Invoke command via Tauri test $\rightarrow$ verify structured response `{ branch: "main", dirty: 3, ahead: 1, behind: 0 }`.

### 3.4 1-Click Container Port Tunneling
* **Target Files:** [src/components/DockerTab.tsx](file:///d:/REPO/SubTerm/src/components/DockerTab.tsx), [src/components/TunnelsPanel.tsx](file:///d:/REPO/SubTerm/src/components/TunnelsPanel.tsx)
* **Effort:** 3 hours
* **Details:** On every container card in DockerTab with mapped ports (e.g. `3306`), add a `[Tunnel to Localhost]` button. 1 click sets up local forwarding.
* **Validation:** Click tunnel icon on Postgres container $\rightarrow$ verify local tunnel starts on `127.0.0.1:5432`.

### 3.5 Live "Listening Ports" Auto-Discovery
* **Target Files:** [src/components/TunnelsPanel.tsx](file:///d:/REPO/SubTerm/src/components/TunnelsPanel.tsx), [src-tauri/src/lib.rs](file:///d:/REPO/SubTerm/src-tauri/src/lib.rs)
* **Effort:** 5 hours
* **Details:** Background probe parses listening TCP ports on the server (`ss -tulpn`). Surfaces them as 1-click forwardable suggestions in TunnelsPanel.
* **Validation:** Start an HTTP server on remote port 9000 $\rightarrow$ verify TunnelsPanel shows *"Port 9000 listening (python3) — [Forward]"*.

### 3.6 Local Port Conflict Auto-Resolver
* **Target Files:** [src-tauri/src/tunnel.rs](file:///d:/REPO/SubTerm/src-tauri/src/tunnel.rs), [src/components/TunnelsPanel.tsx](file:///d:/REPO/SubTerm/src/components/TunnelsPanel.tsx)
* **Effort:** 4 hours
* **Details:** If binding to local port 8080 fails with `EADDRINUSE`, identify the conflicting process and offer: *"Port in use by PID 1204 (node). [Bind to 8081] or [Kill PID]"*.
* **Validation:** Run local dummy server on port 8080 $\rightarrow$ start tunnel on 8080 $\rightarrow$ verify conflict resolver prompt appears.

### 3.7 Live Server Health Pulse in Sidebar
* **Target Files:** [src/components/Sidebar.tsx](file:///d:/REPO/SubTerm/src/components/Sidebar.tsx), [src/components/MonitoringPanel.tsx](file:///d:/REPO/SubTerm/src/components/MonitoringPanel.tsx)
* **Effort:** 4 hours
* **Details:** Display a subtle alert badge on the sidebar "Servers" icon if any server in the background monitor hits $>95\%$ CPU, RAM, or is offline.
* **Validation:** Trigger high CPU threshold in monitor $\rightarrow$ verify pulse indicator lights up in sidebar.

---

## Phase 4: Power Workstation, Command Palette & Fleet Operations
**Estimated Effort:** ~30–36 hours (4.5 days)  
**Risk / Blast Radius:** Medium — Terminal output parsing, streaming tar, and cluster-wide actions.

### 4.1 Global Command Palette (`Ctrl+K` / `Ctrl+P`)
* **Target Files:** [src/DesktopApp.tsx](file:///d:/REPO/SubTerm/src/DesktopApp.tsx), new `src/components/CommandPalette.tsx`
* **Effort:** 8 hours
* **Details:** Universal fuzzy-search dialog for jumping to any server, switching active tabs, running saved snippets, or triggering layout actions.
* **Validation:** Press `Ctrl+K` $\rightarrow$ type server name $\rightarrow$ hit Enter $\rightarrow$ verify connection initiates immediately.

### 4.2 Tag-Based Fleet Operations (Cluster Management)
* **Target Files:** [src/components/AddNodePanel.tsx](file:///d:/REPO/SubTerm/src/components/AddNodePanel.tsx), [src/components/NodeGrid.tsx](file:///d:/REPO/SubTerm/src/components/NodeGrid.tsx), [src/ui/broadcast.tsx](file:///d:/REPO/SubTerm/src/ui/broadcast.tsx)
* **Effort:** 6 hours
* **Details:** Group servers by tags (`web`, `db`, `k8s`). 1-click action: "Open all `web` servers in Split View" and "Broadcast input to all `web` servers".
* **Validation:** Tag 3 servers as `web` $\rightarrow$ select tag broadcast $\rightarrow$ verify typed keystrokes replicate to all 3 servers simultaneously.

### 4.3 "Clickable Everything" in Output
* **Target Files:** [src/components/TerminalView.tsx](file:///d:/REPO/SubTerm/src/components/TerminalView.tsx)
* **Effort:** 5 hours
* **Details:** Register xterm link providers for file paths (`/etc/nginx/nginx.conf`), container IDs (`a1b2c3d4e`), and URLs. Clicking opens the file in editor or navigates in SFTP.
* **Validation:** Run `cat` on a file with paths $\rightarrow$ hover path $\rightarrow$ verify underline $\rightarrow$ click $\rightarrow$ opens in built-in editor.

### 4.4 Command Block Separation (OSC 133 Shell Integration)
* **Target Files:** [src/components/TerminalView.tsx](file:///d:/REPO/SubTerm/src/components/TerminalView.tsx)
* **Effort:** 8 hours
* **Details:** Parse OSC 133 prompt markers to divide output into discrete blocks. Provide 1-click **"Copy Output"**, **"Collapse Output"**, and exit code badges.
* **Validation:** Run `ls -la` $\rightarrow$ click "Copy Output" hover button $\rightarrow$ verify clipboard contains exact command output without prompt noise.

### 4.5 "Smart Tar Transfer" (50x Faster SFTP Folder Transfers)
* **Target Files:** [src-tauri/src/lib.rs](file:///d:/REPO/SubTerm/src-tauri/src/lib.rs), [src/components/FilePanel.tsx](file:///d:/REPO/SubTerm/src/components/FilePanel.tsx)
* **Effort:** 7 hours
* **Details:** When downloading/uploading directories with $>50$ files, execute remote `tar -czf -` and stream compressed stream into local tar unpacker.
* **Validation:** Download 1,000 files $\rightarrow$ verify transfer takes seconds instead of minutes and file structure is intact.

### 4.6 Wake-on-LAN (WoL) & Port Knocking
* **Target Files:** [src/components/AddNodePanel.tsx](file:///d:/REPO/SubTerm/src/components/AddNodePanel.tsx), [src-tauri/src/lib.rs](file:///d:/REPO/SubTerm/src-tauri/src/lib.rs)
* **Effort:** 4 hours
* **Details:** Configure MAC address or knock port sequence. SubTerm sends magic packet or port knocks before initiating SSH connection.
* **Validation:** Configure WoL on sleeping server $\rightarrow$ connect $\rightarrow$ verify packet transmission log and successful connection.

---

## Phase 5: Mobile Touch, Biometrics & AI Copilot
**Estimated Effort:** ~22–28 hours (3.5 days)  
**Risk / Blast Radius:** Medium — Platform-specific APIs (Android Keystore / AI API integration).

### 5.1 Biometric Vault Unlock (Touch ID / Face ID / Windows Hello)
* **Target Files:** [src/components/ProfileSelectPage.tsx](file:///d:/REPO/SubTerm/src/components/ProfileSelectPage.tsx), [src-tauri/src/lib.rs](file:///d:/REPO/SubTerm/src-tauri/src/lib.rs)
* **Effort:** 8 hours
* **Details:** Store encrypted profile key in OS Credential Manager / Android Keystore protected by biometrics. Unlock vault via fingerprint/face instead of typing master password.
* **Validation:** Launch app $\rightarrow$ biometric prompt appears $\rightarrow$ scan fingerprint $\rightarrow$ profile unlocks instantly.

### 5.2 Gesture-Based Terminal Control (Mobile)
* **Target Files:** [src/components/TerminalView.tsx](file:///d:/REPO/SubTerm/src/components/TerminalView.tsx)
* **Effort:** 5 hours
* **Details:** Add touch gestures: horizontal swipe to switch tabs, 2-finger tap to paste clipboard, pinch-to-zoom font size.
* **Validation:** On touch screen/Android, swipe sideways $\rightarrow$ verify session tab switches. Pinch $\rightarrow$ font size changes fluidly.

### 5.3 Haptic Feedback on Mobile Key Bar
* **Target Files:** [src/components/MobileKeyBar.tsx](file:///d:/REPO/SubTerm/src/components/MobileKeyBar.tsx)
* **Effort:** 2 hours
* **Details:** Trigger `navigator.vibrate(12)` on pressing keys on the mobile sticky bar for crisp tactile confirmation.
* **Validation:** Tap keys on Android $\rightarrow$ verify subtle mechanical haptic response.

### 5.4 Local AI Copilot & Error Explainer (`Ctrl+I` / `## prompt`)
* **Target Files:** [src/components/TerminalView.tsx](file:///d:/REPO/SubTerm/src/components/TerminalView.tsx), new `src/components/AiCopilotModal.tsx`
* **Effort:** 10 hours
* **Details:** Press `Ctrl+I` $\rightarrow$ type natural language prompt $\rightarrow$ generates shell command with flag breakdown. If a command exits with error, 1-click "Explain & Fix" button suggests the solution.
* **Validation:** Type `Ctrl+I` $\rightarrow$ "find files over 50mb" $\rightarrow$ press Enter $\rightarrow$ command inputs into shell prompt.

---

## Phase 6: Codebase Architecture & Modularization
**Estimated Effort:** ~20–24 hours (3 days)  
**Risk / Blast Radius:** Medium — Large file refactoring, but strictly zero runtime behavior change.

### 6.1 Decompose [DesktopApp.tsx](file:///d:/REPO/SubTerm/src/DesktopApp.tsx) (2,693 lines)
* **Target Files:** [src/DesktopApp.tsx](file:///d:/REPO/SubTerm/src/DesktopApp.tsx), `src/hooks/`
* **Effort:** 8 hours
* **Details:** Extract `useSessionManager.ts`, `useWallManager.ts`, and `useProfileVault.ts`. Reduces root component to $<400$ lines.
* **Validation:** `npm run typecheck` $\rightarrow$ 0 errors; verify all tabs, wall, and vault operations behave identically.

### 6.2 Modularize [src-tauri/src/lib.rs](file:///d:/REPO/SubTerm/src-tauri/src/lib.rs) (10,576 lines)
* **Target Files:** [src-tauri/src/lib.rs](file:///d:/REPO/SubTerm/src-tauri/src/lib.rs), `src-tauri/src/commands/`
* **Effort:** 12 hours
* **Details:** Split monolithic `lib.rs` into domain modules:
  * `commands/servers.rs`
  * `commands/terminal.rs`
  * `commands/sftp.rs`
  * `commands/tunnels.rs`
  * `commands/git.rs`
* **Validation:** `cargo check` in `src-tauri` passes cleanly; measure reduction in incremental compile times.

---

## Verification Matrix: All 33 Requested Features

| # | Requested Feature | Plan Phase | Implementation Section | Blast Radius |
| :---: | :--- | :---: | :--- | :---: |
| 1 | **1-Click Direct Actions on Server Cards** | Phase 1 | Section 1.1 | Very Low |
| 2 | **1-Click "Open in Browser" for Port Forwards** | Phase 1 | Section 1.2 | Very Low |
| 3 | **Global Keyboard Shortcuts (Keyboard-First Flow)** | Phase 1 | Section 1.3 | Very Low |
| 4 | **Recent Quick-Connects Dropdown** | Phase 1 | Section 1.4 | Very Low |
| 5 | **Production Guardrails ("Safety Mode")** | Phase 1 | Section 1.5 | Very Low |
| 6 | **Pinned Quick-Action Bar Below / Above Terminal** | Phase 1 | Section 1.6 | Very Low |
| 7 | **Split View Drag-to-Resize & Layout Presets** | Phase 1 | Section 1.7 | Very Low |
| 8 | **Background Tab Rendering Optimization** | Phase 1 | Section 1.8 | Very Low |
| 9 | **Interactive Clickable Breadcrumbs in SFTP** | Phase 2 | Section 2.1 | Low |
| 10 | **Seamless Terminal ↔ SFTP Deep Linking** | Phase 2 | Section 2.2 | Low |
| 11 | **Parameterized Command Snippets (`{{var}}`)** | Phase 2 | Section 2.3 | Low |
| 12 | **Built-in Lightweight Code & Config Editor** | Phase 2 | Section 2.4 | Low |
| 13 | **Side-by-Side Visual Diff Before Overwriting** | Phase 2 | Section 2.5 | Low |
| 14 | **Remote Archive & Compression Actions (tar/zip)**| Phase 2 | Section 2.6 | Low |
| 15 | **Remote Fuzzy File Search (`Ctrl+P` in SFTP)** | Phase 2 | Section 2.7 | Low |
| 16 | **SFTP File Explorer Git Integration** | Phase 3 | Section 3.1 | Low–Med |
| 17 | **Terminal Status Header / Tab Badge (Git)** | Phase 3 | Section 3.2 | Low–Med |
| 18 | **1-Click Git Quick-Status Drawer** | Phase 3 | Section 3.2 | Low–Med |
| 19 | **Git Repository Awareness (Backend Probe)** | Phase 3 | Section 3.3 | Low–Med |
| 20 | **1-Click Container Port Tunneling** | Phase 3 | Section 3.4 | Low–Med |
| 21 | **Live "Listening Ports" Auto-Discovery** | Phase 3 | Section 3.5 | Low–Med |
| 22 | **Local Port Conflict Auto-Resolver** | Phase 3 | Section 3.6 | Low–Med |
| 23 | **Live Server Health Pulse in Sidebar** | Phase 3 | Section 3.7 | Low–Med |
| 24 | **Global Command Palette (`Ctrl+K` / `Ctrl+P`)** | Phase 4 | Section 4.1 | Medium |
| 25 | **Tag-Based Fleet Operations (Cluster Mgmt)** | Phase 4 | Section 4.2 | Medium |
| 26 | **"Clickable Everything" in Output** | Phase 4 | Section 4.3 | Medium |
| 27 | **Command Block Separation (OSC 133)** | Phase 4 | Section 4.4 | Medium |
| 28 | **"Smart Tar Transfer" (50x Faster Transfers)** | Phase 4 | Section 4.5 | Medium |
| 29 | **Wake-on-LAN (WoL) & Port Knocking** | Phase 4 | Section 4.6 | Medium |
| 30 | **Biometric Vault Unlock (Touch ID / Hello)** | Phase 5 | Section 5.1 | Medium |
| 31 | **Gesture-Based Terminal Control** | Phase 5 | Section 5.2 | Medium |
| 32 | **Haptic Feedback (Mobile Key Bar)** | Phase 5 | Section 5.3 | Low |
| 33 | **Local AI Copilot & Error Explainer** | Phase 5 | Section 5.4 | Medium |
| 34 | **Decompose DesktopApp.tsx (2,693 lines)** | Phase 6 | Section 6.1 | Medium |
| 35 | **Modularize lib.rs (10,576 lines)** | Phase 6 | Section 6.2 | Medium |
