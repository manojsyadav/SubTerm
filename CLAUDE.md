# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

**SubTerm** — a cross-platform SSH / SFTP / terminal and infrastructure client, a
customized fork of [Submarine](https://github.com/sinaxhpm/submarine). **Tauri v2 (Rust,
Tokio)** backend, **React 18 + TypeScript + Vite** front end, compiled natively for
Windows, macOS, Linux and Android.

`docs/` is a full, maintained documentation suite — read the relevant page before changing
behaviour it describes:

| Page | For |
| :--- | :--- |
| `docs/ARCHITECTURE.md` | Module layout, state singletons, vault format, IPC |
| `docs/API_REFERENCE.md` | Every Tauri command, its arguments and events |
| `docs/SECURITY.md` | Argon2id/AES-256-GCM, lock states, TOFU, agent forwarding, KDF rotation |
| `docs/DEVELOPMENT.md` | Toolchain, cargo features, Android, Linux WebKit workarounds |
| `docs/TESTING.md` | What each suite covers and what gates CI |
| `docs/USER_GUIDE.md` | User-facing behaviour |
| `docs/RELEASE_NOTES.md` | The changelog — see "Documenting a change" below |
| `TODO.md` | The live queue |

## Commands

```bash
npm run dev            # vite only (no Tauri shell)
npm run tauri dev      # the desktop app
npm test               # vitest, ~35 files / ~200 tests
npm run typecheck      # tsc --noEmit
npm run lint           # eslint
cargo test / cargo clippy   # in src-tauri/
npm run build:portable      # Windows portable zip (scripts/build-portable.ps1)
npm run android:dev / android:build
```

CI gates `npm test`, `npm run typecheck`, `npm run lint`, `cargo check` and `cargo test`.
`origin` is Gitea (`10.0.0.20:222/Homelab/subTerm.git`) — run the checks locally rather
than relying on CI to catch you.

## Patterns to preserve

- **The front end never talks to the network.** Every SSH, SFTP, PTY, Docker and cloud
  operation is a `#[tauri::command]` in `src-tauri/src/commands/`; the webview only
  `invoke`s and `listen`s. A credential must not cross the bridge except where the
  existing commands already do it.
- **`lib.rs` stays thin** — `DbState`, profile-path helpers, `run()` with the
  `invoke_handler![]` registry. New commands go in a module under `commands/` by domain,
  with the engine (`monitor.rs`, `mirror.rs`, `tunnel.rs`) separate from its thin command
  wrappers.
- **Secrets live in the vault, zeroized in memory.** `master_key` and `session_password`
  are `Zeroizing`; the vault is Argon2id + AES-256-GCM over a zstd-compressed SQLite
  serialization. Never log one, never return one from a command, never write one into a
  generated file (the `.rdp` writer deliberately omits the password).
- **The KDF is read from the vault header's profile table, not hardcoded** — that is what
  makes rotation possible. Don't reintroduce constants (`docs/SECURITY.md` §9).
- **One session owns its resources.** Session ids key every live map in `SshState`; the
  SFTP page's file browser is its own session (`session-sftp-<id>`) precisely so it does
  not take over the server's SSH session or restart its saved port forwards. Keep that
  split in mind when adding anything that opens a connection for an existing server.
- **The embedded RDP helper is a separate crate** (`src-tauri/rdp-helper/`) with its own
  lockfile, because IronRDP's pinned crypto crates cannot share a dependency graph with
  `russh`. It communicates over framed stdio (`rdp-helper/src/wire.rs`). Do not merge it
  into the main crate.
- **Crypto backend is pinned to `ring`**, not russh's default `aws-lc-rs`, so Windows
  builds need no NASM. The `full-ssh-algos` feature only adds legacy algorithms
  (SHA-1 KEX/MAC, DSA, 3DES) for old appliances — it must not become the default.

## Documenting a change

A user-visible change goes in `docs/RELEASE_NOTES.md` under `[Unreleased]`, in the
matching section (`🚀 New Features`, `🐛 Bug Fixes`, `📦 Packaging`, `🏗️ Internal`), in
the house style: a bold `` `type(scope)` `` + plain-language title line, then a paragraph
describing what the user now sees, including the off switch if there is one. Update
`docs/USER_GUIDE.md` when the behaviour is something a user has to operate. Purely
internal refactors go under `🏗️ Internal` or nowhere.

## Conventions

- Conventional commit messages, with the reasoning for rejected alternatives in the body.
- Comments explain *why*, not *what*, and are sparse.
- Prose for users is plain English — no marketing adjectives, no feature-sheet voice.
- Tests sit next to the code under test (`src/fs/diff.test.ts`, `src/terminal/triggers.test.ts`).
  New non-trivial logic gets one.
