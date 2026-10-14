# Backup and Recovery

SubTerm is a desktop app, so "recovery" means one of three things: getting a profile back,
getting your preferences back, or getting into a vault whose password is in doubt. Only
the first two are possible.

> **There is no recovery from a forgotten master password.** The key is derived from the
> password with Argon2id; nothing else can produce it. No reset link, no recovery code, no
> support path. The vault file becomes random bytes. This is the design, not a gap.

---

## 1. What to back up

| Item | Where | Replaceable? |
| :--- | :--- | :--- |
| **Profile files** (`*.subterm`, legacy `*.submarine`) | `<app data>/profiles/` | **No** — servers, credentials, SSH keys, snippets, notes, known hosts |
| **Preferences export** | Wherever you save it from Settings | By re-configuring by hand |
| `cloud_token.json` | App data root | Yes — sign in again |
| Window state, caches | App data root | Yes |

App data root by platform:

| OS | Path |
| :--- | :--- |
| Windows | `%APPDATA%\com.subterm.desktop\` |
| macOS | `~/Library/Application Support/com.subterm.desktop/` |
| Linux | `~/.config/com.subterm.desktop/` |
| Android | the app's private storage, identifier `com.subterm.app` |

Desktop used `com.subterm.app` before the identifier change; the app copies forward from
it on first start and never overwrites anything already in the new folder.

---

## 2. Backing up a profile

**From the app:** Profiles → the profile's menu → **Export**. It copies the encrypted file
byte for byte — nothing is decrypted, so the exported file is exactly as safe as the
original and still needs its master password.

**By hand:** copy the `*.subterm` file out of `profiles/`. Do it with SubTerm closed or at
least with the profile locked: a save is an atomic temp-write-and-rename, so a copy taken
mid-save gets either the old file or the new one, but a copy taken while you are actively
editing will simply be a few seconds stale.

Export is desktop-only; the Android build refuses it.

Worth knowing:

- **The export carries everything**, including private keys and saved passwords. Its
  security is the master password and nothing else. Treat the file like a key file.
- **Each profile is separately encrypted**, so backing up one does not back up another.
- **Cloud Sync is not a backup.** It is a zero-knowledge replica: delete a server and the
  deletion syncs. It protects against a dead laptop, not against a mistake.

---

## 3. Backing up preferences

Settings → General → **Backup & Restore** → Export. This covers appearance, feature
toggles, terminal settings — the webview-held preferences, and *not* servers, credentials
or keys.

Do this **before upgrading or migrating on macOS or Linux**, where preferences are held by
the webview and may not carry across an app identifier change or a reinstall.

---

## 4. Restoring

### A profile

1. Profiles → **Import**, pick the `.subterm` file, give it a name.
2. Unlock it with the master password it was exported under — the password travels with
   the file, not with the installation.

Or drop the file into `profiles/` with the app closed; it appears on next start.

A profile from before Cloud Sync existed has no DEK; one is minted on open and persisted
immediately. Nothing to do.

### Preferences

Settings → General → Backup & Restore → Import.

### A whole machine

1. Install SubTerm.
2. Copy the profile files into `profiles/`.
3. Import the preferences export.
4. Sign in to Cloud Sync if you use it, and let it reconcile.

Shortcuts are stored per platform, so moving from Windows to macOS keeps the Windows set
intact and starts a fresh Mac set — expected.

---

## 5. Failure cases

| Symptom | Cause | What to do |
| :--- | :--- | :--- |
| `[CRYPTO] DECRYPT_FAILURE` on unlock | Wrong password — **or** a corrupt/truncated file. The two are indistinguishable by design: AES-GCM fails closed. | Retype carefully, check keyboard layout. Then try a backup copy. |
| `UNSUPPORTED_VERSION` | The file was written by a newer SubTerm | Upgrade. An older binary refuses rather than guessing. |
| `SCHEMA_AHEAD_OF_BINARY` | Same, at the SQL schema level | Upgrade. |
| Profile missing after an update | The app-data folder moved (`com.subterm.app` → `com.subterm.desktop`) | Check the old folder and copy the `*.subterm` files across; the automatic migration only fills gaps. |
| Settings reset after an update, servers intact | Preferences are webview-held and did not survive | Import the preferences export. |
| Monitors show paused after restart | Not a fault — every monitor is forced to paused on profile open, because pollers do not survive a restart | Start the ones you want. |
| Cloud sync restored a deleted server | It is a replica, not a backup | Restore from a file backup taken before the deletion. |

---

## 6. A reasonable routine

- Export each profile after any significant change to your server list, and keep the
  exports **somewhere other than the machine SubTerm runs on**.
- Export preferences before each upgrade.
- Keep the master password in a password manager. It is the single point of failure, and
  that is deliberate.
- Test a restore occasionally: import an export under a throwaway profile name and unlock
  it. An untested backup is a guess.
