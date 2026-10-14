# SubTerm Testing & Quality Assurance Guide

This document details the test suites, validation procedures, and live protocol smoke-testing harnesses available in the SubTerm codebase.

---

## 1. Testing Architecture Overview

SubTerm employs a tiered testing strategy designed to balance fast feedback loops with protocol correctness:

| Layer | Target | Tooling | Frequency / Gate |
|---|---|---|---|
| **Frontend Unit Tests** | Pure business logic, diff engine, export formatters, terminal triggers | Vitest | CI Gate (`npm test`) & local dev |
| **Frontend Static Analysis** | TypeScript type safety & React hooks conventions | `tsc`, ESLint | CI Gate (`npm run typecheck`, `npm run lint`) |
| **Backend Unit Tests** | Vault encryption, Argon2id/AES-256-GCM, HLC clock, sync engine, tunnel pumps | Cargo test | CI Gate (`cargo test`) & local dev |
| **Backend Static Analysis** | Rust type system, borrow checker, idiomatic lints | `cargo check`, `cargo clippy` | CI Gate (`cargo check`) |
| **Live SSH Protocol Smoke Test** | Real SSH2 connect, publickey auth, channel exec, reverse port forwarding, SFTP | `russh_smoke_test.rs` | Protocol/dep upgrades (`cargo run --example ...`) |
| **Manual Click-Through** | Multi-platform UI, window virtualization, hardware sleep/resume, native biometrics | Physical hardware / live sessions | Major releases |

---

## 2. Frontend Testing

### 2.1 Unit Tests (Vitest)
Pure TypeScript modules (diffing algorithms, server list import/export, terminal alert triggers, settings logic) and React components are tested using [Vitest](https://vitest.dev/). There are 35 test files and about 200 tests:

```bash
# Run all frontend unit tests once
npm test

# Run tests in interactive watch mode
npx vitest
```

Test files live adjacent to the source code under test:
- `src/fs/diff.test.ts`: Unified diff computation and chunking for SFTP file compare.
- `src/export/serverExport.test.ts`: Serialization of server profiles into portable JSON/CSV formats, verifying credential stripping.
- `src/terminal/triggers.test.ts`: Regex and keyword matching engine for terminal output alert triggers.
- `src/terminal/sshCommand.test.ts`: Detecting a plain `ssh`/`sftp` connect (flags, `user@host`, ports, key paths), reading it from the screen line so Tab completion and history recall work, and recognising when the client has ended.
- `src/utils/quickTarget.test.ts`: What the Servers search box treats as a connection target (`10.0.0.5`, `user@host:port`, IPv6) versus a plain search word.
- `src/settingsDefaults.test.ts` and `src/settingsBackup.test.ts`: Changed-from-default detection and per-row/per-page/all reset, and the preferences export/import filter (machine-bound and credential-like keys are excluded; imported files are treated as untrusted).
- `src/ssh/reconnectPolicy.test.ts`, `src/hooks/useIdleLock.test.ts` (fake timers), `src/ui/reduceMotion.test.ts`, `src/ui/overwritePolicy.test.ts`, `src/util/desktopNotify.test.ts`, `src/editor/editorPrefs.test.ts`, `src/terminal/cursorColor.test.ts`: the pure logic behind the matching settings.

### 2.1.1 Component Tests (jsdom)
Components that matter for layout and behaviour are rendered with `react-dom` under jsdom (the file starts with `// @vitest-environment jsdom`; no testing-library is used, so tests dispatch DOM events inside `act`). Tauri's `invoke` and `listen` are mocked per file.
- `src/components/SettingsPanel.test.ts`: the seven pages and their order, that every page uses the same wide column container, the nested feature options, search jumping to a setting, changed-from-default dots and resets, lock gating, and a check that every rendered `data-setting` id is in the search index.
- `src/components/NodeGrid.test.ts`: the Servers header (split Add server menu, lightning button) and the Enter behaviour of the search box (open the single match, connect to an address, ignore a bare word).
- `src/components/Sidebar.test.ts` and `src/components/ServerPickerView.test.ts`: sidebar entries and order, and the SFTP/RDP server picker.
- `src/components/AiPanel.test.ts`: the AI panel with a mocked backend. Ask waits for approval and then continues, Skip runs nothing, Auto asks on production servers, the online-provider warning shows once, Explain sends on its own, Run & send returns the result, and container shells offer only Suggest. `src/ai/agentLoop.test.ts` covers the loop and the Auto allowlist.

### 2.2 TypeScript Typecheck & Linting
```bash
# Verify TypeScript compilation without emitting JS
npm run typecheck

# Run ESLint across TypeScript and React source files
npm run lint
```

---

## 3. Backend (Rust) Testing

### 3.1 Unit Tests
Backend tests cover path traversal sanitization, cryptographic primitives, hybrid logical clocks (HLC), conflict resolution in the SQLite sync engine, and tunnel data forwarding pumps:

```bash
cd src-tauri

# Run all 110+ unit tests
cargo test

# Run tests with the legacy SSH algorithm compatibility profile
cargo test --features full-ssh-algos
```

Key test suites:
- `identity::tests`: Argon2id KDF key derivation, envelope encryption, and DEK sealing.
- `hlc::tests`: Lamport physical/logical clock monotonicity and skew rejection.
- `commands::sync::sync_engine_tests`: CRDT-like last-write-wins (LWW) convergent replication and tombstone tracking.
- `tunnel::tunnel_tests`: Tokio bidirectional TCP channel streaming, half-close propagation, and keep-alive reaper.
- `tests::dir_entry_name_*`: Path traversal (`../`) and separator defense in SFTP directory listings.
- `commands::servers::saved_server_lookup_tests`: matching a typed `ssh` target to saved servers (host, optional user, alias, port, RDP and deleted rows excluded).
- `commands::servers::history_prune_tests`: command-history size and age limits against an in-memory table.
- `ssh_manager::host_key_policy_tests`: the strict host-key policy decision (refuse only untrusted keys).
- `commands::ai::tests`: OpenAI-style and Anthropic stream parsing (text, split tool-call arguments, Ollama calls without index), tool results grouped into one Anthropic turn, keeping the tail of long output, and a real local `ai_exec` with exit code and stderr.
- `commands::ai::tests::live_tool_call_round_trip` (ignored by default) talks to a real model. Run it with `SUBTERM_AI_LIVE_URL=http://localhost:11434/v1 SUBTERM_AI_LIVE_MODEL=qwen3.5:4b cargo test live_ -- --ignored --nocapture`. For Claude, set `SUBTERM_AI_LIVE_KIND=anthropic` and `SUBTERM_AI_LIVE_KEY` as well.

### 3.2 Compilation & Clippy Checks
```bash
cd src-tauri

# Rapid compilation validation
cargo check

# Advisory lints and idiom checks
cargo clippy
```

---

## 4. Live SSH Protocol Smoke Testing (`russh_smoke_test`)

Because unit tests use in-memory mocks and cannot simulate a real SSH2 wire handshake, SubTerm includes a standalone integration smoke test in [`src-tauri/examples/russh_smoke_test.rs`](../src-tauri/examples/russh_smoke_test.rs).

### 4.1 What the Smoke Test Covers
The harness executes 7 end-to-end verification steps against an active OpenSSH server:
1. **Local Echo Target**: Starts a local TCP echo listener to verify forwarded traffic.
2. **Client Configuration**: Assembles `russh::client::Config` using SubTerm's production cipher/KEX preferences.
3. **TCP Connection**: Establishes a raw TCP stream to the target SSH port.
4. **Public Key Authentication**: Loads an OpenSSH private key and executes public key authentication via `PrivateKeyWithHashAlg`.
5. **Session Channel & Command Exec**: Opens a session channel, executes `echo RUSSH_SMOKE_TEST_OK`, and verifies standard output and exit codes.
6. **Reverse TCP Port Forwarding**: Calls `tcpip_forward` on the server and routes traffic through the `Channel<Msg>` + `ChannelOpenHandle` bridge (the exact callback pattern used by SSH Agent Forwarding).
7. **SFTP Subsystem Round-Trip**: Opens an SFTP channel via `russh-sftp`, writes a unique file, reads it back, checks data integrity, and removes it.

### 4.2 Prerequisites
You need access to an active SSH server (local or remote) where your public key is added to `~/.ssh/authorized_keys`.

For a quick local test on Linux/macOS or Windows OpenSSH Server:
```bash
# Stand up or verify sshd is listening (e.g. on port 2222 or 22)
ssh -p 2222 -i ~/.ssh/id_ed25519 user@127.0.0.1 "echo OK"
```

### 4.3 Running the Smoke Test

Set the target connection environment variables and run:

```bash
cd src-tauri

# Run against a local test sshd on port 2222
SMOKE_SSH_PORT=2222 \
SMOKE_SSH_KEY="/path/to/private_key" \
SMOKE_SSH_USER="your_username" \
cargo run --example russh_smoke_test
```

On Windows (PowerShell):
```powershell
$env:SMOKE_SSH_PORT = "2222"
$env:SMOKE_SSH_KEY = "$HOME/.ssh/id_ed25519"
$env:SMOKE_SSH_USER = "$env:USERNAME"
cargo run --example russh_smoke_test
```

### 4.4 Configurable Environment Variables

| Variable | Default | Purpose |
|---|---|---|
| `SMOKE_SSH_PORT` | `2222` | Port of the target SSH server |
| `SMOKE_SSH_KEY` | `client_key` | Path to the client private key file (PEM/OpenSSH format) |
| `SMOKE_SSH_USER` | `manoj` | Username to authenticate as |
| `SMOKE_SFTP_DIR` | `.` | Remote directory where the test file is created and cleaned up |

### 4.5 Testing Legacy Algorithms Profile
To verify compatibility with older SSH servers offering legacy Diffie-Hellman groups, HMAC-SHA1, or DSA keys:
```bash
cargo run --example russh_smoke_test --features full-ssh-algos
```

---

## 5. CI / CD Quality Gates

SubTerm's continuous integration workflow ([`.github/workflows/ci.yml`](../.github/workflows/ci.yml)) automatically runs on all pull requests and pushes to `main`:

```yaml
- name: Lint and Typecheck
  run: |
    npm run typecheck
    npm run lint
    npm test

- name: Rust Checks and Tests
  run: |
    cargo check
    cargo test
```

A pull request will be blocked from merging if any TypeScript error, lint failure, or Rust test regression is introduced.
