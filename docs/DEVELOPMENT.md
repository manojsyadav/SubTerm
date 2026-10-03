# SubTerm Developer & Contributor Guide

This guide details environment setup, build pipelines, testing procedures, feature flags, and platform-specific workarounds for contributing to SubTerm.

---

## 1. Prerequisites & Toolchain

### Required Tooling
- **Node.js**: `v18.x` or higher (tested with Node 20+)
- **npm**: `v9.x` or higher
- **Rust Toolchain**: `v1.70.0` or higher (managed via `rustup`)
- **Tauri CLI**: `@tauri-apps/cli` (installed via devDependencies, run with `npx tauri` or `npm run tauri`)

### Platform-Specific Native Requirements

#### Windows
- **Microsoft C++ Build Tools** (Visual Studio 2022 with "Desktop development with C++").
- **WebView2**: Built into Windows 10/11 by default.

#### macOS
- **Xcode Command Line Tools**: `xcode-select --install`.

#### Linux (Debian / Ubuntu / Fedora / Arch)
- WebKit2GTK and GTK 3 development headers:
  ```bash
  # Debian / Ubuntu / Pop!_OS
  sudo apt-get update && sudo apt-get install -y \
      libwebkit2gtk-4.1-dev \
      build-essential \
      curl \
      wget \
      file \
      libxdo-dev \
      libssl-dev \
      libayatana-appindicator3-dev \
      librsvg2-dev
  ```

#### Android (Optional)
- **Android Studio / Android SDK** (API Level 33+).
- **Android NDK** (version 25+).
- **Rust Android Targets**:
  ```bash
  rustup target add aarch64-linux-android armv7-linux-androideabi x86_64-linux-android i686-linux-android
  ```

---

## 2. Cargo Features & Algorithm Support

SubTerm defines two build profiles in `src-tauri/Cargo.toml`:

```toml
[features]
default = []
full-ssh-algos = ["russh/openssl", "russh-keys/openssl", "dep:openssl-sys"]
```

### `default` (Pure Rust Crypto)
- **Characteristics**: Compiles with 100% pure Rust cryptographic backends. Does not require OpenSSL, Perl, or external C tooling.
- **Algorithms**: Ed25519 and ECDSA host keys and modern KEX / ciphers (AES-GCM, ChaCha20-Poly1305).
- **Limitation**: Cannot connect to legacy SSH servers that only offer RSA host keys (`ssh-rsa`) or legacy diffie-hellman key exchange.

### `full-ssh-algos` (Production / Complete Compatibility)
- **Characteristics**: Enables russh's OpenSSL backend with a vendored, statically-linked `libcrypto`.
- **Algorithms**: Full RSA host-key family (`rsa-sha2-512`, `rsa-sha2-256`, `ssh-rsa`), legacy DH groups, older HMAC-SHA1 algorithms.
- **Requirement**: Requires `perl` on the build machine to compile vendored OpenSSL.
- **Usage**:
  ```bash
  npm run tauri dev -- --features full-ssh-algos
  npm run tauri build -- --features full-ssh-algos
  ```

---

## 3. Local Development Workflows

### 3.1 Initial Setup
```bash
# 1. Clone the repository
git clone https://github.com/manojsyadav/SubTerm.git
cd SubTerm

# 2. Install NPM dependencies
npm install

# 3. Verify TypeScript type safety
npm run typecheck
```

### 3.2 Running the Desktop App
```bash
# Starts Vite dev server (port 1420) and spawns the native Tauri window
npm run tauri dev
```

### 3.3 Running Android in Development
SubTerm provides a customized PowerShell script `scripts/android-dev.ps1` that uses USB loopback port forwarding (`adb reverse tcp:1420 tcp:1420` and `adb reverse tcp:1421 tcp:1421`) to guarantee reliable development whether Wi-Fi is active or not:

```bash
# Ensure ADB is in PATH and your device is plugged in with USB debugging enabled
npm run android:dev
```

---

## 4. Linux Runtime Environment Variables

On Linux systems running Mesa ≥ 24 (e.g. Fedora 40+, Ubuntu 24.04+, Arch), WebKit2GTK's hardware acceleration can trigger `SIGABRT` crashes due to DMA-BUF / Wayland-EGL mismatches.

`subterm_lib::run()` in `src-tauri/src/lib.rs` automatically inspects and defaults these variables unless already exported by the user:

| Variable | Auto-Default | Description |
|---|---|---|
| `WEBKIT_DISABLE_HARDWARE_ACCELERATION` | `"1"` | Bypasses eglGetDisplay SIGABRT on Mesa ≥ 24 |
| `WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS` | `"1"` | Prevents seccomp sandbox crashes on unprivileged user namespaces |
| `WEBKIT_FORCE_SANDBOX` | `"0"` | Complements sandbox disablement |
| `WEBKIT_DISABLE_DMABUF_RENDERER` | `"1"` | Forces GLES render fallback |
| `WEBKIT_DISABLE_COMPOSITING_MODE` | `"1"` | Disables compositing overhead |
| `GDK_BACKEND` | `"x11"` | Forces X11/XWayland to bypass Wayland-EGL driver incompatibilities |
| `LIBGL_ALWAYS_SOFTWARE` | `"1"` | Software rendering fallback if hardware acceleration is unavailable |

To override any of these flags during debugging, set them explicitly in your shell before launching:
```bash
export WEBKIT_DISABLE_HARDWARE_ACCELERATION=0
npm run tauri dev
```

---

## 5. Testing & Verification

### 5.1 Frontend Verification
```bash
# Run TypeScript compilation check
npm run typecheck

# Test production Vite bundling
npm run build
```

### 5.2 Rust Backend Verification
```bash
cd src-tauri

# Check compilation without building full binary
cargo check

# Run Rust unit tests (vault path safety, cryptographic routines)
cargo test

# Check formatting and lints
cargo clippy
```

### 5.3 Building Release Packages
```bash
# Build desktop native installers (MSI/NSIS on Windows, AppImage/deb on Linux, DMG on macOS)
npm run tauri build -- --features full-ssh-algos

# Build Android release APK
npm run android:build
```
The output installers will be located in:
- Desktop: `src-tauri/target/release/bundle/`
- Android: `src-tauri/gen/android/app/build/outputs/apk/release/`
