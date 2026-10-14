# Runbook

Operational procedures for maintaining SubTerm: cutting a release, responding to a
dependency advisory, rotating credentials, and the recurring maintenance that is easy to
forget. User-facing symptoms are in [`TROUBLESHOOTING.md`](TROUBLESHOOTING.md); setup is
in [`DEVELOPMENT.md`](DEVELOPMENT.md).

---

## 1. Before anything ships

```bash
npm test            # vitest
npm run typecheck   # tsc --noEmit
npm run lint        # eslint
cd src-tauri && cargo test && cargo clippy
```

CI gates all five. `origin` is Gitea, so CI reports after a merge rather than blocking
one — run them locally.

---

## 2. Cutting a release

1. **Decide the version.** It is stamped into `Cargo.toml` and `tauri.conf.json` by the
   workflow from the tag, so the tag is the source of truth. Do not hand-edit the
   manifests to match.
2. **Move `[Unreleased]` in [`RELEASE_NOTES.md`](RELEASE_NOTES.md)** to a
   `## [vX.Y.Z] — YYYY-MM-DD` section, keeping the sub-sections. Write the summary last,
   from what actually landed.
3. **Run the checks** (§1) and smoke-test the app on at least one platform.
4. **Tag and push:**

   ```bash
   git tag v0.4.2
   git push origin v0.4.2
   ```

5. The Release workflow builds Windows, macOS (arm64) and Linux x64, builds the Arch
   package, zips the macOS `.app` and the portable Windows build, and uploads everything
   as a **draft** GitHub Release.
6. **Download and check at least one installer before publishing the draft.** The
   `subterm-rdp-helper` is built and bundled separately from the main binary; a release
   that silently omits it leaves embedded RDP broken with no error at build time.
7. Publish the draft.

Dry run without cutting a release: the workflow's **Run workflow** button, any version
string, `publish_release: false`.

For a local Windows portable build: `npm run build:portable`.

---

## 3. A dependency advisory

The precedent to follow is `russh` 0.40.2 → 0.63 for RUSTSEC-2026-0154/-0153:

1. Check whether the advisory affects a path SubTerm uses at all — document the answer in
   the commit message either way.
2. Upgrade, then confirm **the crypto backend is still `ring`**, not `aws-lc-rs`. The pin
   exists so Windows builds need no NASM; a transitive default flipping it will not fail
   until someone builds on a clean Windows machine.
3. Confirm `full-ssh-algos` still only adds legacy algorithms and still needs no extra
   toolchain.
4. Run the live SSH smoke test — unit tests do not exercise the protocol:

   ```bash
   cargo run --example russh_smoke_test
   ```

   It does a real connect, publickey auth, channel exec, reverse port forward and SFTP.
   Run it for **any** change to `russh`, `ssh_manager.rs`, `tunnel.rs` or the auth ladder,
   not only for advisories.
5. Note the version change and the reasoning in `RELEASE_NOTES.md` under `🏗️ Internal`.

`rdp-helper` has **its own lockfile** and must be upgraded separately; IronRDP's pinned
crypto crates cannot share a dependency graph with `russh`, which is the whole reason it
is a separate crate.

---

## 4. Credential and key rotation

| Thing | How | Blast radius |
| :--- | :--- | :--- |
| Master password | Settings → Profiles → Change master password. Issues a **new salt** and re-encrypts. | That profile, on every device after the next sync |
| A stored SSH key | Replace it in the vault, then `ssh-copy-id` the new public key from the session context menu before removing the old one from `authorized_keys` | Every server using that key |
| Cloud Sync token | Sign out and back in; `cloud_token.json` is rewritten | That device |
| A host key you no longer trust | Settings → Known Hosts → remove the entry. The next connect re-prompts (TOFU). | One host |

A changed host key shows a red warning rather than silently accepting — that is the
expected behaviour on a server rebuild, and also what a man-in-the-middle looks like.
Verify out of band before accepting.

---

## 5. A store or protocol change breaks a feature

Symptoms that mean "an upstream changed", not "we have a bug":

- **SSH connects but the Info panel tabs say "not available"** — the probe scripts' marker
  lines (`PSFMT:` / `ENGINE:`) did not appear. Check the probe output on that host
  directly.
- **Embedded RDP fails immediately** — the helper process is missing or failed to start.
  Check it exists beside the main binary; rebuild with
  `npm run build:rdp-helper` (Windows) or `npm run build:rdp-helper:unix`.
- **A host refuses the handshake after an OS upgrade** — it has dropped a legacy
  algorithm, or needs one `default` excludes. Try a `full-ssh-algos` build before
  changing anything.

---

## 6. Recurring maintenance

| Cadence | Task |
| :--- | :--- |
| Each release | Verify every bundle installs and launches on its platform; verify the RDP helper shipped |
| Each dependency bump touching SSH | `russh_smoke_test` |
| Quarterly | Review `KDF_PROFILES` against current Argon2 guidance ([`SECURITY.md`](SECURITY.md) §9). Nothing has needed rotation yet |
| Quarterly | Confirm the identifier migration path still works from a `com.subterm.app` folder — it is one-time code that only runs on machines nobody tests on |
| Whenever a platform SDK moves | Rebuild Android; the NDK and Rust target set drift |

---

## 7. Things not to do

- **Do not re-enable `access_log`-style request logging or any logging of a session
  password.** The sudo-prompt fill and the paste-saved-password action both handle
  plaintext; neither may ever reach a log.
- **Do not hard-delete a syncable row.** Soft-delete it — see
  [`DATA_MODEL.md`](DATA_MODEL.md) §3.
- **Do not bump `VAULT_VERSION` for a SQL schema change**, or `SCHEMA_VERSION` for a
  crypto change.
- **Do not add a recovery path for a forgotten master password.** There is deliberately
  none; anything that could restore access could restore it for an attacker too.
