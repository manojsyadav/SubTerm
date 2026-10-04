# SubTerm Backlog & TODO Roadmap

This document tracks active development tasks, pending architectural optimizations, and planned features for future SubTerm releases.

> Completed work isn't tracked here — see [`docs/RELEASE_NOTES.md`](docs/RELEASE_NOTES.md) for what's shipped and git history for implementation detail. This file lists only what's still open.

### Legend

| Label | Meaning |
|---|---|
| 🔴 **P1** | High priority — user-visible correctness, major UX gap, or competitive blocker |
| 🟡 **P2** | Medium priority — valuable improvement, ships when capacity allows |
| 🟢 **P3** | Low priority — nice-to-have, exploratory, or long-horizon feature |
| **S** (Small) | < 1 day — isolated change, minimal risk |
| **M** (Medium) | 1–3 days — self-contained feature, a few files |
| **L** (Large) | 3–7 days — cross-cutting change, multiple subsystems |
| **XL** (X-Large) | 1–3 weeks — new protocol, platform target, or major architecture shift |

---

## 🏗️ Engineering Health: Architecture, Testing & CI

- [ ] 🔴 **P1 · M** — **Finish `DesktopApp.tsx` Decomposition** (partial progress)
  - `src/hooks/useSessionManager.ts`, `useWallManager.ts`, and `useProfileVault.ts` are already extracted and wired in. The four vault-entity CRUD slide-over panels (command/note/credential/SSH key) were also pulled out into `src/components/VaultEditPanels.tsx`, but [`src/DesktopApp.tsx`](file:///d:/REPO/SubTerm/src/DesktopApp.tsx) is still ~2,991 lines — well short of the original <400-line target.
  - Remaining candidates: the Library view (commands/notes search + cards), Settings-panel wiring, and node-grid/session-view routing — all more entangled than the panels already extracted.
  - No component-level test coverage exists yet (see the "Reduce `any`" item doesn't cover this either) — each further cut needs manual click-through verification, not just `npm run typecheck`.
  - **Validation:** `npm run typecheck` passes; all tabs, wall, and vault operations behave identically; manual click-through of whatever view is touched.

- [ ] 🟡 **P2 · L** — **Triage `.unwrap()` / `.expect()` in the Rust Backend**
  - 219 occurrences across `src-tauri/src` (168 in `lib.rs` alone, 23 in `tunnel.rs`, 15 in `identity.rs`). A panic in any of these can crash the whole Tauri process, killing every open SSH session, not just one request.
  - Prioritize paths touching untrusted network input (SSH packet/channel handling) and on-disk vault/config parsing — replace with `Result` propagation and surfaced errors.
  - **Validation:** `grep -rc unwrap\|expect` count trends down in connection/vault-handling modules; fuzzed/malformed inputs no longer crash the app.

- [ ] 🟢 **P3 · L** — **Reduce `any` / `as any` in the TypeScript Frontend**
  - 239 occurrences across `src/**/*.tsx`/`*.ts` with no lint rule currently flagging new ones.
  - Backfill proper types incrementally, starting with session/file-path handling code where a mistyped value has real consequences.
  - **Validation:** `grep -rc ": any\|as any"` count trends down; new PRs can't introduce more once ESLint's `no-explicit-any` is enabled.

---

## ⚡ Core Performance & IPC Optimizations

- [ ] 🟡 **P2 · L** — **SFTP Pipelined Transfers & Concurrent Chunking**
  - Implement multi-stream concurrent byte-range chunking for large single-file transfers across parallel SFTP channels.
  - Automatically saturate high-bandwidth, high-latency WAN links beyond the current 256 KiB sequential pipelined stream.

---

## 🚀 Strategic Power Features (Competitive Differentiators)

- [ ] 🟡 **P2 · L** — **Terminal Session Recording & Export (.cast / Asciinema)**
  - Native timed session recorder capturing stdout, stdin, and resize events according to the Asciinema v2 (`.cast`) standard.
  - Export to `.cast` files, raw terminal log dumps, or animated SVG/GIF for runbooks, documentation, and compliance audit trails.
  - In-app playback preview modal with play/pause, scrub slider, and playback speed controls.

- [ ] 🟡 **P2 · S/M** — **Cloud Sync Enhancements & Conflict Resolution**
  - Expand self-hosted cloud sync API with visual diffing for simultaneous modifications across multiple devices.
  - Granular push/pull synchronization for server definitions, credentials, snippet runbooks, and keyboard shortcuts.
  - Flagged as undersized at **S** — the visual-diffing + granular-sync scope reads more like an **M/L**; re-triage before picking up.

- [ ] 🟢 **P3 · XL** — **Dual-Pane Remote-to-Remote SFTP Sync**
  - Side-by-side split SFTP view (Commander / WinSCP style) allowing direct transfers between two distinct remote SSH servers.
  - Stream data directly from Server A to Server B in memory without staging unencrypted files onto the local host disk.

---

## 🌐 Network, Protocols & Multi-Platform

- [ ] 🟡 **P2 · XL** — **Native Tailscale / Tailcat Mesh Support**
  - Direct userspace Tailscale mesh network transport to seamlessly discover and connect to Tailscale nodes by MagicDNS name without manual local proxy configurations.
  - _Note: Evaluated in PR #44; deferred due to binary footprint, CGo toolchain requirements, and the fact that OS-level Tailscale already routes transparently through standard SSH. Revisit if embedded Go build pipeline becomes viable._

- [ ] 🟢 **P3 · XL** — **RDP Functionality (Remote Desktop Protocol)**
  - Native Remote Desktop Protocol (RDP) session tabs alongside SSH, SFTP, and Docker for managing Windows infrastructure.

- [ ] 🟢 **P3 · XL** — **iOS / iPadOS Support**
  - Target compilation and packaging for iPadOS and iOS devices, pairing with SubTerm's mobile accessory keybar.

---

## ⚠️ Known Follow-Ups From Recent Work

- [ ] 🔴 **P1** — **Live-verify the `russh` 0.63 upgrade against a real server**
  - The 0.40.2 → 0.63.3 upgrade (fixing RUSTSEC-2026-0153/0154) compiles clean and passes all 81 unit tests in both build profiles, but has **not** been exercised against a live SSH server in this environment.
  - Needs a manual pass covering: SSH connect + auth (password, key, keyboard-interactive), SFTP transfer, port forwarding (`-L`/`-R`/-D`), and — especially — SSH agent forwarding, whose bridge was rewritten (not just signature-adapted) to use a direct `Channel<Msg>` stream instead of the old `ChannelId` + manual routing map.
  - If this surfaces a regression, the previous pin (`russh = "0.40.2"`) and its known advisory are the fallback — see git history at the commit upgrading `src-tauri/Cargo.toml`.

- [ ] 🟡 **P2 · S** — **Manual click-through for session-only verified features**
  - Several features this session were validated by `typecheck`/`lint`/`build`/unit tests only, not live interaction — bundling as one follow-up pass rather than one line each:
    - Server list virtualization in `NodeGrid.tsx` (scroll + drag-reorder on a 500+-server fleet, resize across the 1024/1280px breakpoints).
    - Terminal output over the new Tauri binary IPC channel (firehose throughput, split-pane/Fleet-Wall multi-viewer attach, reconnect).
    - Cross-pane file diff/compare tool (`FileDiffModal`) and the four extracted `VaultEditPanels` (open/edit/save/cancel for a command, note, credential, SSH key).
    - Sudo-elevated SFTP file save to a root-owned path, with and without a saved session password.
