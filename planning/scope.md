# Scope

## What SubTerm is

A cross-platform SSH, SFTP, terminal and infrastructure client — a customized fork of
[Submarine](https://github.com/sinaxhpm/submarine) — built on Tauri v2 (Rust) and
React 18. Desktop (Windows, macOS, Linux) and Android.

The shape of the product: **one window that replaces a terminal, an SFTP client, a tunnel
manager and a small slice of a monitoring tool**, with credentials in a zero-knowledge
local vault rather than in a cloud account.

## In scope

- SSH terminals, SFTP, local shells, port forwarding (`-L`, `-R`, `-D`), agent forwarding.
- A zero-knowledge encrypted profile vault (Argon2id + AES-256-GCM), with optional
  end-to-end-encrypted sync and profile sharing.
- Remote desktop: via the OS client, and embedded through a bundled helper.
- Operational conveniences on a connected host: Docker, processes, services, file
  compare, folder sync, monitoring, network probes.
- Production-server safeguards, because the same window reaches prod and a sandbox.

## Out of scope, deliberately

| Not doing | Why |
| :--- | :--- |
| Password recovery of any kind | The key is derived from the master password. Anything that could restore access for the owner could restore it for an attacker. |
| Storing credentials server-side, or any plaintext sync | Zero-knowledge is the reason to choose this over a hosted client. |
| A built-in SubTerm cloud as the only sync option | The endpoint is configurable; bring your own backend. |
| An RDP password store | The OS client and the helper ask for it; SubTerm never holds one. |
| `aws-lc-rs` as the crypto backend | `ring` keeps Windows builds free of NASM. |
| `full-ssh-algos` by default | SHA-1 KEX, DSA and 3DES exist for old appliances, opt-in. |

## Completeness against the standard set

The estate's standard set is defined by `D:\REPO\HomeLab\project-scaffolder`. This
repository **predates it and keeps its own documentation suite**, which is larger than the
standard set and uses different filenames. The decision is to keep the suite and map onto
the standard set rather than duplicate it:

| Standard file | Here |
| :--- | :--- |
| `docs/architecture.md` | `docs/ARCHITECTURE.md` |
| `docs/api-reference.md` | `docs/API_REFERENCE.md` (Tauri IPC commands and events — this app has no HTTP API) |
| `docs/security.md` | `docs/SECURITY.md` |
| `docs/development.md` | `docs/DEVELOPMENT.md` |
| `docs/user-guide.md` | `docs/USER_GUIDE.md` |
| `docs/getting-started.md` | `README.md` + `docs/DEVELOPMENT.md` |
| `docs/configuration.md` | `docs/USER_GUIDE.md` (settings are a UI panel, not a config file) |
| `docs/data-model.md` | `docs/DATA_MODEL.md` |
| `docs/troubleshooting.md` | `docs/TROUBLESHOOTING.md` |
| `docs/runbook.md` | `docs/RUNBOOK.md` |
| `docs/backup-and-recovery.md` | `docs/BACKUP_AND_RECOVERY.md` |
| `CHANGELOG.md` | `docs/RELEASE_NOTES.md` |
| `planning/todo.md` | `TODO.md` |
| `release/` | the GitHub Release workflow; there is no compose bundle for a desktop app |

Also present and outside the standard set: `docs/TESTING.md`, `docs/PERFORMANCE.md`,
`docs/IOS.md`.

`scaffold.sh --check` will report this repository incomplete. That is the expected result
for the reason above, not a backlog item.
