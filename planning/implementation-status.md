# Implementation Status

As of 2026-10-14. Version `0.4.1` (`package.json`, `src-tauri/tauri.conf.json`), latest
tag `v0.4.0`, with an `[Unreleased]` section open in
[`../docs/RELEASE_NOTES.md`](../docs/RELEASE_NOTES.md).

## Shipped and in use

| Area | State |
| :--- | :--- |
| SSH terminals, SFTP, local shells | Working on Windows, macOS, Linux, Android |
| Port forwarding (`-L`, `-R`, SOCKS5 `-D`) | Working, with saved tunnels per server |
| Agent forwarding | Working; per-server toggle, proxies bytes only |
| Profile vault | Argon2id + AES-256-GCM, in-memory SQLite, atomic saves |
| Cloud Sync | Zero-knowledge, HLC last-writer-wins per row, configurable endpoint |
| Profile sharing | Per-member sealed-box key wrapping, invite/accept/revoke |
| Monitoring, Docker, Processes, Services | Working, per connected host |
| Production safeguards | `PROD` badge, Safe Mode, destructive-command interception |
| RDP | OS client, plus **embedded (beta)**: clipboard, sound, resize, pinned certificate |
| Shell integration | Built-in for local PowerShell and bash (OSC 133); not `cmd` or WSL |

## Partial, by design

- **Embedded RDP is beta.** Text clipboard, remote sound and resize-to-window work;
  it is a bundled helper process, not a full RDP client.
- **`full-ssh-algos` is opt-in**, so an appliance that only offers SHA-1 KEX, DSA or 3DES
  needs a special build rather than a setting.
- **The update check queries a repository that is not public**, so it currently returns
  404 and finds nothing. There is no self-installing updater — that would need the Tauri
  updater plugin and a signing key.
- **KDF rotation is designed but not implemented.** No vault has ever been written with
  anything but `VAULT_VERSION = 1` and one Argon2id profile; the migration path is
  specified in [`../docs/SECURITY.md`](../docs/SECURITY.md) §9 for the day it is needed.

## Tested

~35 Vitest files / ~200 tests over the pure front-end logic (diffing, export, triggers,
`ssh`/`sftp` detection, quick-target parsing), `cargo test` over the vault, HLC, sync
engine and tunnel pumps, plus `tsc`, ESLint and `cargo check` — all five gated by CI.

A live SSH protocol smoke test (`cargo run --example russh_smoke_test`) is run on
protocol and dependency upgrades, not every build.

**Not covered by automated tests:** multi-platform UI, window virtualization, hardware
sleep/resume, native biometrics, packaged-build behaviour. These are click-through on
real hardware at release time, and the backlog's largest single item is exactly that
click-through for the settings/navigation overhaul.

## Known gaps

Tracked in [`../TODO.md`](../TODO.md). The headline ones:

- A packaged-Windows click-through of everything in the current `[Unreleased]` block has
  not been done — automated checks only.
- Background notifications and clipboard-clear-on-lock depend on webview/OS permissions
  that tests cannot cover.
- The nested-`ssh` guard still does not clear on a silent `ssh` exit inside a local
  bash/WSL shell, because those prompts look remote.
