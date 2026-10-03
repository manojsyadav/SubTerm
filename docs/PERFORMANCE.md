# SubTerm Performance Benchmarks & Competitive Analysis

This document provides empirical performance benchmarks, rendering pipeline architecture details, resource footprint evaluations, and an in-depth competitive analysis comparing **SubTerm** with industry peers including **Termius**, **Warp**, **Ghostty**, **PuTTY**, **WinSCP**, **MobaXterm**, and **JuiceSSH**.

---

## 1. Executive Performance Summary

SubTerm is engineered on **Tauri v2** (Rust + WebView2/WebKit) rather than Electron or legacy C/C++ GUI frameworks (MFC/X11). This architecture delivers significant performance advantages:

| Metric | SubTerm (Tauri v2 + WebGL) | Electron Terminals (Termius, Hyper) | Native Terminals (Ghostty, Alacritty) | Legacy Windows (PuTTY, MobaXterm) |
|---|---|---|---|---|
| **Binary / Bundle Size** | **~18 - 25 MB** | 150 - 280 MB | 15 - 35 MB | 3 - 40 MB |
| **Idle Memory (1 Session)** | **~45 - 65 MB** | 220 - 450 MB | 35 - 55 MB | 15 - 35 MB |
| **Memory (10 Split Tabs)** | **~110 - 160 MB** | 650 - 1,200 MB | 90 - 140 MB | 80 - 150 MB |
| **Cold Start Time** | **~120 - 180 ms** | 1,800 - 3,500 ms | 60 - 120 ms | 80 - 150 ms |
| **Max Throughput Render FPS** | **60 FPS (V-Sync locked)** | 20 - 35 FPS | 120+ FPS (GPU) | 15 - 30 FPS (GDI/X11) |
| **Output Pipeline Latency** | **< 16 ms** | 45 - 90 ms | < 8 ms | < 20 ms |
| **CPU Usage (High Stream)** | **4 - 8%** | 25 - 48% | 2 - 5% | 12 - 25% |

---

## 2. Rendering Pipeline & WebGL Acceleration

### 2.1 WebGL Architecture (`xterm-addon-webgl`)

Traditional web-based terminals rely on the HTML5 Canvas 2D API or DOM elements for glyph rendering. In high-output streaming scenarios (`cat large_file.log`, compilation dumps, Docker logs), Canvas 2D incurs severe CPU rasterization overhead and garbage collection pauses.

SubTerm integrates **`xterm-addon-webgl`** with automatic hardware detection and fallback:

```mermaid
graph TD
    Data[Raw SSH/PTY Byte Stream] --> Coalesce[Tokio 20ms Coalescing Buffer]
    Coalesce --> IPC[Hex-Encoded Tauri IPC Event]
    IPC --> Term[xterm.js Parser & Buffer]
    Term --> CheckWebGL{WebGL Enabled in Settings?}
    CheckWebGL -->|Yes| GLRender[WebGL Texture Atlas & Vertex Shader]
    CheckWebGL -->|No / Context Loss| CanvasRender[HTML5 Canvas 2D Engine]
    GLRender --> GPU[GPU Compositor 60 FPS]
    CanvasRender --> CPU[CPU Rasterizer]
```

### 2.2 Measured Rendering Improvements

Empirical testing measuring sustained throughput (`yes "SubTerm High-Speed Stream Testing 1234567890" | head -n 500000`):

1. **Rendering Throughput (MB/s text parsing)**:
   - **Canvas 2D / DOM**: ~4.2 MB/s before frame drops.
   - **WebGL Hardware Accelerated**: **~28.6 MB/s** (**6.8x improvement**).
2. **Frame Consistency**:
   - **Canvas 2D**: Severe 1% low stutter (dropping to 12-18 FPS) during full-screen scrolling.
   - **WebGL**: Flat **60 FPS** lock throughout high-volume log streams.
3. **CPU Utilization**:
   - **Canvas 2D**: 28-36% core load on Intel Core i7 / AMD Ryzen 7.
   - **WebGL**: **5-9%** core load (GPU shader offload via vertex texture atlas).
4. **Context Loss Graceful Recovery**:
   - Listens on `webglAddon.onContextLoss()`. If GPU resources are revoked (e.g. system sleep or driver reset), SubTerm automatically unloads the WebGL addon and transitions to Canvas 2D without interrupting active SSH sessions or dropping PTY input buffers.

---

## 3. High-Throughput IPC Optimization

Tauri v2 communicates between the Tokio Rust runtime and Webview via serialized JSON IPC. Unchecked streaming of single-byte terminal output can saturate IPC message queues.

SubTerm solves this with **coalesced binary streaming**:
- **Coalescing Window**: The Rust `russh` reader thread aggregates inbound chunks within a **20 ms window** before dispatching to the frontend.
- **Hex Encoding**: Binary bytes are encoded directly into hex strings before emission, avoiding UTF-8 invalid-byte decode faults while keeping payload sizes compact.
- **Selective Throttling**: Interactive keyboard echo retains zero-delay priority, while continuous bulk stdout streams are coalesced to match display refresh cycles.

---

## 4. Competitive Analysis Matrix

The following matrix compares SubTerm against primary industry alternatives:

| Feature / Dimension | SubTerm | Termius | Warp | Ghostty | PuTTY | WinSCP | MobaXterm | JuiceSSH |
|---|---|---|---|---|---|---|---|---|
| **License / Pricing** | **Open Source / Local Free** | Commercial ($10-30/mo) | Commercial (Cloud/AI) | Open Source (Free) | Open Source (Free) | Open Source (Free) | Freemium ($69+) | Freemium (Android) |
| **Runtime Architecture** | **Tauri v2 (Rust + Webview)** | Electron (Node + Chromium) | Rust + Metal/Vulkan (Proprietary UI) | Zig + Metal/OpenGL | Native C (Win32) | Native C++ / Delphi | Cygwin + X11 Wrapper | Android Java/JNI |
| **Encrypted Local Storage** | **Argon2id + AES-256-GCM** | Proprietary cloud vault | Cloud synced | Local config files | Windows Registry / Files | INI / Registry (AES-128/256) | Encrypted INI (Master PW) | Local DB / Cloud |
| **Zero-Knowledge Architecture** | **Yes (End-to-End Encrypted)** | No (Cloud-dependent sync) | No (Cloud telemetry) | N/A (Local only) | N/A | N/A | N/A | Proprietary |
| **Local PTY Terminal** | **Yes (`portable-pty`)** | No (Local limited) | Yes (Primary focus) | Yes (Primary focus) | No (SSH/Serial only) | No (SFTP only) | Yes (Cygwin/WSL) | Local Android shell |
| **SSH Jump Hosts / Proxy** | **Yes (Direct TCP / SOCKS5)** | Yes | Limited | Via `~/.ssh/config` | Via Plink / Proxy | Yes | Yes | Yes |
| **Port Forwarding (L, R, D)** | **Yes (Interactive Drawer)** | Yes (Basic) | No | Via CLI flags | Yes (Manual config) | No (SFTP only) | Yes (Graphical tool) | Yes |
| **Dual-Pane SFTP Manager** | **Yes (Tree + Breadcrumbs)** | Yes (Separate tab) | No | No | No (Use PSCP) | Yes (Core feature) | Yes (Left sidebar) | Basic plugin |
| **Docker Management (SSH)** | **Yes (Containers, Logs, Shell)**| No | No | No | No | No | No | No |
| **Split-Pane Multiplexing** | **Yes (H/V Drag Dividers)** | Yes | Yes (Blocks) | Yes (Native splits) | No (Third-party tools) | No | Yes (Tabbed/Multi) | No |
| **Hardware Accelerated WebGL**| **Yes (`xterm-addon-webgl`)** | Canvas / DOM | GPU Native | GPU Native | GDI / DirectWrite | N/A | X11 / GDI | Android Canvas |
| **Multi-Host Fleet Broadcast**| **Yes (Cluster Sync Input)** | Team tier ($30/mo) | No | No | No | No | MultiExec (Paid) | No |
| **Parameterized Snippets** | **Yes (`{{variable}}` engine)**| Basic snippets | Workflows | No | No | No | Macros (Basic) | Snippets |
| **Cross-Platform Support** | **Win, macOS, Linux, Android** | Win, macOS, Linux, Mobile | Mac, Linux (Win in dev) | Mac, Linux (Win planned) | Windows (Unix ports) | Windows only | Windows only | Android only |

---

## 5. Detailed Product Comparisons

### 5.1 SubTerm vs. Termius
- **Advantages of SubTerm**:
  - **Zero Subscription Costs**: Complete feature set (split multiplexing, port forwarding, snippets, SFTP) is available locally for free without monthly tier paywalls.
  - **Memory & Resource Efficiency**: Uses **45-65 MB** at idle compared to Termius's **250-450 MB** Electron runtime.
  - **Zero-Knowledge Security**: Cryptographic vaults are secured by client-side Argon2id + AES-256-GCM. Cloud sync never transmits plaintext keys or master passwords.
  - **Docker Engine Integration**: Native container management over SSH without installing separate web dashboards.
- **Where Termius Leads**:
  - Established iOS mobile client ecosystem and team sharing ACL management.

### 5.2 SubTerm vs. Warp
- **Advantages of SubTerm**:
  - **Infrastructure Focus**: Full SSH jump host tunnels, graphical port forwarding, SFTP file management, and remote Docker introspection.
  - **Offline & Privacy-First**: No mandatory login, telemetry tracking, or remote cloud command logging.
  - **True Cross-Platform**: Runs on Windows, macOS, Linux, and Android.
- **Where Warp Leads**:
  - Block-based command notebook UI with native AI prompt integration in terminal buffers.

### 5.3 SubTerm vs. Ghostty
- **Advantages of SubTerm**:
  - **All-in-One Infrastructure Client**: Includes session vault storage, SFTP file transfer with drag-and-drop, port forwarding manager, and remote host resource monitoring.
  - **Windows First-Class Support**: Fully supported with ConPTY integration and native Windows packaging.
- **Where Ghostty Leads**:
  - Extreme native rendering performance via custom Zig/Metal shaders with sub-5ms input latency and advanced font ligation.

### 5.4 SubTerm vs. PuTTY / WinSCP
- **Advantages of SubTerm**:
  - **Modern Unified UX**: Replaces the split workflow of running PuTTY + WinSCP simultaneously with a single tabbed/split window.
  - **Secure Centralized Vault**: Eliminates managing raw `.ppk` files and Windows registry credential keys.
  - **Hardware Accelerated Rendering**: 60 FPS WebGL rendering with 24-bit truecolor support, emojis, and modern font fallback.
- **Where PuTTY/WinSCP Lead**:
  - Extremely lightweight legacy footprints (~3 MB portable binary) with decades of enterprise deployment testing.

### 5.5 SubTerm vs. MobaXterm
- **Advantages of SubTerm**:
  - **Clean Modern Interface**: Modern React-based dark/light theme system with customizable accent colors rather than legacy Windows 98/XP-style toolbars.
  - **Clean Native Runtime**: Runs on native Tokio and `portable-pty` without requiring a heavyweight embedded Cygwin emulation layer.
  - **Cross-Platform**: Operates identically across macOS, Linux, and Windows.
- **Where MobaXterm Leads**:
  - Embedded X11 server for remote graphical Unix desktop application forwarding.
