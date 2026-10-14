# Troubleshooting

Symptom first. Build and toolchain problems are in [`DEVELOPMENT.md`](DEVELOPMENT.md);
maintenance procedures are in [`RUNBOOK.md`](RUNBOOK.md).

---

## Unlocking and profiles

| Symptom | Cause | Fix |
| :--- | :--- | :--- |
| `[CRYPTO] DECRYPT_FAILURE` | Wrong master password — **or** a corrupt file. AES-GCM fails closed, so the two look identical. | Retype (check caps/layout). Then try a backup copy. There is no password recovery. |
| `UNSUPPORTED_VERSION` / `SCHEMA_AHEAD_OF_BINARY` | The vault was written by a newer SubTerm | Upgrade. The older binary refuses rather than guessing, on purpose. |
| Profiles gone after an update | The app-data folder moved from `com.subterm.app` to `com.subterm.desktop` | Copy the `*.subterm` files across by hand. The automatic migration only fills gaps, never overwrites. |
| Settings reset, but servers intact | Preferences are held by the webview, not the vault, and do not always survive a reinstall or identifier change on macOS/Linux | Import your preferences export (Settings → General → Backup & Restore). Export before the *next* upgrade. |
| Signed out of everything after restart | Expected if the vault locked; sessions do not outlive a lock | — |
| Locked unexpectedly while working | *Auto-lock when idle* counts mouse/keyboard/wheel/touch only — **terminal output is not activity**, so a long-running job does not keep it awake | Settings → General → Security |

## Connecting

| Symptom | Cause | Fix |
| :--- | :--- | :--- |
| Host key warning in red | The server's key changed — a rebuild, or a man-in-the-middle | Verify the fingerprint out of band, then clear the entry in Settings → Known Hosts |
| Handshake fails on an old appliance | `default` excludes SHA-1 KEX/MAC, DSA host keys and 3DES | Build with `--features full-ssh-algos` |
| Connection drops across a NAT or VPN | Idle timeout upstream | Raise the keep-alive interval (15–120s) on the server |
| Reconnect loop after sleep | Not a fault: sleep/resume and network-change watchers retry with capped backoff (2–30s) and show "Reconnecting · attempt N" | Wait, or disconnect |
| Agent forwarding does nothing | The per-server toggle is off, or no local agent is running | Enable it on the server; check the OpenSSH agent / Pageant / 1Password / KeePassXC is up |
| Blank username rejected | It resolves from the matching `Host` entry in `~/.ssh/config` only if there is one | Set the username, or add the `Host` entry |

## Terminal and SFTP

| Symptom | Cause | Fix |
| :--- | :--- | :--- |
| Saving a root-owned file appears to work but changes nothing | Fixed: the save now stages to a temp file and `mv`s it, retrying under `sudo`. On an older build, this failed silently | Upgrade |
| `�` in terminal output | Fixed: a character split across two chunks used to be decoded twice | Upgrade |
| Drag-and-drop lands on the wrong pane at >100% display scaling | Fixed | Upgrade |
| A dropped file does not appear on the remote host | On an SSH session each file is uploaded to `/tmp/subterm-drop-…` first; check `/tmp` is writable and has space | — |
| Command blocks / exit codes missing on a local shell | Shell integration wraps PowerShell's prompt and sets `PROMPT_COMMAND` for bash. A `PROMPT_COMMAND` already in your `.bashrc` wins; local `cmd` and WSL are not covered | — |
| Info panel's Processes / Services / Ports say "not available" | The probe's marker line did not come back from the host | Run the probe by hand on that host; see [`RUNBOOK.md`](RUNBOOK.md) §5 |

## Remote desktop

| Symptom | Cause | Fix |
| :--- | :--- | :--- |
| Embedded RDP never starts | The `subterm-rdp-helper` process is missing | Confirm it shipped beside the binary; rebuild with `npm run build:rdp-helper` (or `:unix`) |
| RDP asks to trust a certificate | By design — the fingerprint is pinned on first connect | Check the `SHA256:` value, then **Trust and connect**. It is stored under Known Hosts as type `rdp-tls` |
| RDP screen lags on a slow link | Updates are merged and sent at most ~30×/s already | Reduce the window size |

## Sync

| Symptom | Cause | Fix |
| :--- | :--- | :--- |
| A deleted server came back | Something hard-deleted the row instead of soft-deleting it, so a peer re-sent it | See [`DATA_MODEL.md`](DATA_MODEL.md) §3 — this is a bug, report it |
| Two devices disagree after an edit | Last-writer-wins by HLC stamp, per row. The later stamp won | — |
| Shortcuts did not follow the profile | Mac and Windows/Linux keep separate sets on purpose (Cmd vs Ctrl) | — |
| Sync restored data I meant to delete | Sync is a replica, not a backup | [`BACKUP_AND_RECOVERY.md`](BACKUP_AND_RECOVERY.md) |

## Platform-specific

**Linux, Mesa ≥ 24 (Fedora 40+, Ubuntu 24.04+, Arch):** WebKit2GTK's hardware
acceleration can abort with `SIGABRT` on DMA-BUF / Wayland-EGL mismatches. `subterm_lib::run()`
defaults `WEBKIT_DISABLE_HARDWARE_ACCELERATION`, `WEBKIT_DISABLE_DMABUF_RENDERER`,
`WEBKIT_DISABLE_COMPOSITING_MODE`, `GDK_BACKEND=x11` and the sandbox overrides to work
around it — **unless you have already exported them**, which is also how you override one
while debugging. The full table is in [`DEVELOPMENT.md`](DEVELOPMENT.md) §4; if the window
renders blank or black, those are the variables to experiment with.

**Windows:** no NASM is needed — the crypto backend is pinned to `ring` precisely to avoid
it. If a build suddenly demands NASM, a dependency has flipped to `aws-lc-rs`; fix the
pin rather than installing NASM.

**macOS:** the desktop identifier no longer ends in `.app` (macOS treats such folders as
app bundles). Preferences may not carry across the change; profiles do.

**Android:** keeps the `com.subterm.app` identifier, so phone updates were unaffected by
the desktop rename. Profile export is not available there.

---

## When it is none of these

1. Reproduce with a **fresh throwaway profile**. If it goes away, the issue is in the
   vault's data, not the code.
2. Check whether the same thing happens on a plain local shell — that separates terminal
   problems from SSH ones.
3. For anything protocol-shaped, run `cargo run --example russh_smoke_test` and see
   whether a bare connect, exec, forward and SFTP all succeed.
4. Note the version from Settings → About before reporting anything.
