//! One-time move of desktop data from the old bundle identifier `com.subterm.app`
//! (renamed because macOS treats a folder ending in `.app` as an app bundle) to
//! `com.subterm.desktop`. Android keeps `com.subterm.app` (tauri.android.conf.json),
//! so this only runs on desktop.
//!
//! Runs before Tauri starts, so the webview opens the copied storage (all saved
//! preferences live there). It only fills gaps: nothing already in the new folder
//! is overwritten, and webview storage is copied as a whole or not at all, because
//! mixing files from two copies of its database could corrupt it.

use std::path::Path;

pub const OLD_IDENTIFIER: &str = "com.subterm.app";
pub const NEW_IDENTIFIER: &str = "com.subterm.desktop";
const MARKER: &str = ".migrated-from-com.subterm.app";
/// Folders that are copied whole (only when missing in the new location).
const ATOMIC_DIRS: &[&str] = &["EBWebView", "WebKit", "webview"];

/// Migrate under every base folder Tauri uses for app data (on Windows the roaming
/// and local folders differ; elsewhere they are the same and the second is a no-op).
pub fn run() {
    let Some(base) = directories::BaseDirs::new() else { return };
    let mut bases = vec![base.data_dir().to_path_buf(), base.data_local_dir().to_path_buf()];
    bases.dedup();
    for b in bases {
        if let Err(e) = migrate(&b.join(OLD_IDENTIFIER), &b.join(NEW_IDENTIFIER)) {
            eprintln!("[MIGRATE] {}: {e}", b.display());
        }
    }
}

/// Copy `old` into `new` once. Returns Ok when there is nothing to do.
pub fn migrate(old: &Path, new: &Path) -> std::io::Result<()> {
    if !old.is_dir() || new.join(MARKER).exists() {
        return Ok(());
    }
    std::fs::create_dir_all(new)?;
    copy_missing(old, new)?;
    std::fs::write(new.join(MARKER), b"")
}

fn copy_missing(from: &Path, to: &Path) -> std::io::Result<()> {
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let src = entry.path();
        let dst = to.join(entry.file_name());
        let kind = entry.file_type()?;
        if kind.is_dir() {
            let atomic = ATOMIC_DIRS.iter().any(|d| entry.file_name() == *d);
            if atomic && dst.exists() {
                continue;
            }
            std::fs::create_dir_all(&dst)?;
            copy_missing(&src, &dst)?;
        } else if kind.is_file() && !dst.exists() {
            // A locked file (the old version still running) is skipped, not fatal.
            if let Err(e) = std::fs::copy(&src, &dst) {
                eprintln!("[MIGRATE] skipped {}: {e}", src.display());
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("subterm-migrate-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        d
    }

    #[test]
    fn copies_once_and_never_overwrites() {
        let root = tmp("basic");
        let (old, new) = (root.join(OLD_IDENTIFIER), root.join(NEW_IDENTIFIER));
        std::fs::create_dir_all(old.join("profiles")).unwrap();
        std::fs::write(old.join("profiles/work.subterm"), "old-vault").unwrap();
        std::fs::write(old.join("cloud.json"), "old-cloud").unwrap();
        std::fs::create_dir_all(&new).unwrap();
        std::fs::write(new.join("cloud.json"), "new-cloud").unwrap();

        migrate(&old, &new).unwrap();
        assert_eq!(std::fs::read_to_string(new.join("profiles/work.subterm")).unwrap(), "old-vault");
        assert_eq!(std::fs::read_to_string(new.join("cloud.json")).unwrap(), "new-cloud", "existing file kept");

        // Second run does nothing, even if the old folder gained files.
        std::fs::write(old.join("later.txt"), "x").unwrap();
        migrate(&old, &new).unwrap();
        assert!(!new.join("later.txt").exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn webview_storage_is_all_or_nothing() {
        let root = tmp("webview");
        let (old, new) = (root.join(OLD_IDENTIFIER), root.join(NEW_IDENTIFIER));
        std::fs::create_dir_all(old.join("EBWebView/Default")).unwrap();
        std::fs::write(old.join("EBWebView/Default/a.ldb"), "old").unwrap();
        std::fs::create_dir_all(new.join("EBWebView")).unwrap(); // the new version already ran
        migrate(&old, &new).unwrap();
        assert!(!new.join("EBWebView/Default/a.ldb").exists());

        let fresh = root.join("fresh");
        migrate(&old, &fresh).unwrap();
        assert!(fresh.join("EBWebView/Default/a.ldb").exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn nothing_to_do_without_old_data() {
        let root = tmp("none");
        migrate(&root.join(OLD_IDENTIFIER), &root.join(NEW_IDENTIFIER)).unwrap();
        assert!(!root.join(NEW_IDENTIFIER).exists());
    }
}
