//! Direct server-to-server copy for the dual-pane remote view.
//!
//! Data is read from the source session's SFTP channel and written to the
//! destination session's SFTP channel chunk by chunk, in memory. Nothing is
//! staged on the local disk. Large files use several read/write streams at once
//! (see `sftp_parallel`).

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;

use russh_sftp::client::SftpSession;
use russh_sftp::protocol::OpenFlags;

use super::sftp::{get_sftp_session, is_child_name, transfer_id};
use super::sftp_parallel::{
    copy_stream, drive_tasks, plan_segments, DriveEnd, MAX_STREAMS, MIN_SEGMENT_BYTES, PARALLEL_MIN_BYTES,
};
use crate::ssh_manager::SshState;

type CancelMap = Arc<tokio::sync::Mutex<std::collections::HashMap<String, Arc<AtomicBool>>>>;

struct CancelGuard {
    map: CancelMap,
    id: String,
}
impl Drop for CancelGuard {
    fn drop(&mut self) {
        if let Ok(mut g) = self.map.try_lock() {
            g.remove(&self.id);
        }
    }
}

fn base_name(path: &str) -> String {
    let n = path.trim_end_matches('/').rsplit('/').next().unwrap_or("");
    if n.is_empty() { "item".to_string() } else { n.to_string() }
}

/// True when `dst` is `src` itself or lies inside it (copying a folder into itself).
pub(crate) fn is_inside(src: &str, dst: &str) -> bool {
    let s = src.trim_end_matches('/');
    let d = dst.trim_end_matches('/');
    d == s || d.starts_with(&format!("{s}/"))
}

enum Leg {
    Done,
    Cancelled,
    Failed(String),
}

/// Copy one file `src_path` -> `dst_path`, adding every byte moved to `counter`.
async fn copy_file(
    src: &SftpSession,
    dst: &SftpSession,
    src_path: &str,
    dst_path: &str,
    size: u64,
    counter: &Arc<AtomicU64>,
    cancel: &Arc<AtomicBool>,
    report: &(dyn Fn(u64) + Sync),
) -> Leg {
    let segments = if size >= PARALLEL_MIN_BYTES {
        plan_segments(size, MAX_STREAMS, MIN_SEGMENT_BYTES)
    } else if size > 0 {
        vec![(0, size)]
    } else {
        Vec::new()
    };

    // Creating the destination (create + truncate) also gives us its first write handle.
    let first = match dst.create(dst_path).await {
        Ok(f) => f,
        Err(e) => return Leg::Failed(format!("create {dst_path}: {e}")),
    };
    if segments.is_empty() {
        let mut f = first;
        let _ = tokio::io::AsyncWriteExt::shutdown(&mut f).await;
        return Leg::Done;
    }

    let mut writers = vec![first];
    for _ in 1..segments.len() {
        match dst.open_with_flags(dst_path, OpenFlags::WRITE).await {
            Ok(f) => writers.push(f),
            Err(e) => {
                let _ = dst.remove_file(dst_path).await;
                return Leg::Failed(format!("open {dst_path}: {e}"));
            }
        }
    }
    let mut readers = Vec::with_capacity(segments.len());
    for _ in &segments {
        match src.open(src_path).await {
            Ok(f) => readers.push(f),
            Err(e) => {
                let _ = dst.remove_file(dst_path).await;
                return Leg::Failed(format!("open {src_path}: {e}"));
            }
        }
    }

    let before = counter.load(Ordering::Relaxed);
    let mut set = tokio::task::JoinSet::new();
    for (((start, end), reader), writer) in segments.iter().copied().zip(readers).zip(writers) {
        let (t, c) = (counter.clone(), cancel.clone());
        set.spawn(async move { copy_stream(reader, writer, start, end, &t, &c).await });
    }
    let end = drive_tasks(set, counter, report).await;
    match end {
        DriveEnd::Done => {
            if counter.load(Ordering::Relaxed) - before != size {
                let _ = dst.remove_file(dst_path).await;
                return Leg::Failed(format!("incomplete copy of {src_path}"));
            }
            Leg::Done
        }
        DriveEnd::Cancelled => {
            let _ = dst.remove_file(dst_path).await;
            Leg::Cancelled
        }
        DriveEnd::Failed(m) => {
            let _ = dst.remove_file(dst_path).await;
            Leg::Failed(m)
        }
    }
}

struct PlannedFile {
    src: String,
    dst: String,
    size: u64,
}

/// Walk `src_root`, creating the matching directories under `dst_root` and
/// returning the files to copy. Symlinks are skipped, and so is any entry whose
/// name the server lists in an unsafe form (separators, `..`).
async fn plan_tree(
    src: &SftpSession,
    dst: &SftpSession,
    src_root: &str,
    dst_root: &str,
    cancel: &AtomicBool,
) -> Result<Vec<PlannedFile>, String> {
    let mut files = Vec::new();
    let mut stack = vec![(src_root.trim_end_matches('/').to_string(), dst_root.trim_end_matches('/').to_string())];
    while let Some((sdir, ddir)) = stack.pop() {
        if cancel.load(Ordering::Relaxed) {
            return Err("cancelled".into());
        }
        if dst.metadata(&ddir).await.is_err() {
            dst.create_dir(&ddir).await.map_err(|e| format!("mkdir {ddir}: {e}"))?;
        }
        let entries = src.read_dir(&sdir).await.map_err(|e| format!("read_dir {sdir}: {e}"))?;
        for entry in entries {
            let name = entry.file_name();
            if name == "." || name == ".." {
                continue;
            }
            if !is_child_name(&name) {
                return Err(format!("{sdir}: the server listed an unsafe entry name {name:?}"));
            }
            let (s, d) = (format!("{sdir}/{name}"), format!("{ddir}/{name}"));
            let ft = entry.file_type();
            if ft.is_symlink() {
                continue;
            }
            if ft.is_dir() {
                stack.push((s, d));
            } else if ft.is_file() {
                files.push(PlannedFile { src: s, dst: d, size: entry.metadata().size.unwrap_or(0) });
            }
        }
    }
    Ok(files)
}

/// Copy a file or folder from one open session to another without touching the
/// local disk. `dst_path` is the full path of the new item (for a folder, the
/// folder to create). Progress is emitted on `sftp-transfer-<event_session_id>`
/// as one card per call. Refuses to replace an existing destination unless
/// `overwrite` is true (`EXISTS:<path>` sentinel, like the other transfers).
#[tauri::command]
pub async fn sftp_copy_between_sessions(
    app: tauri::AppHandle,
    state: tauri::State<'_, SshState>,
    src_session_id: String,
    src_path: String,
    dst_session_id: String,
    dst_path: String,
    is_dir: bool,
    overwrite: Option<bool>,
    event_session_id: String,
) -> Result<(), String> {
    use tauri::Emitter;

    if is_inside(&src_path, &dst_path) && src_session_id == dst_session_id {
        return Err("Cannot copy an item onto itself or into itself".into());
    }
    let src = get_sftp_session(&state, &src_session_id).await?;
    let dst = get_sftp_session(&state, &dst_session_id).await?;

    if overwrite != Some(true) && dst.metadata(&dst_path).await.is_ok() {
        return Err(format!("EXISTS:{dst_path}"));
    }

    let id = transfer_id();
    let name = base_name(&src_path);
    let event_name = format!("sftp-transfer-{event_session_id}");
    let cancel = Arc::new(AtomicBool::new(false));
    let cancels_map = Arc::clone(&state.transfer_cancels);
    cancels_map.lock().await.insert(id.clone(), Arc::clone(&cancel));
    let _guard = CancelGuard { map: Arc::clone(&cancels_map), id: id.clone() };

    let total = Arc::new(AtomicU64::new(0));
    let emit = |bytes: u64, status: &str, error: Option<String>| {
        let _ = app.emit(
            &event_name,
            serde_json::json!({
                "id": &id, "name": &name, "kind": "upload",
                "bytes": bytes, "total": total.load(Ordering::Relaxed),
                "status": status, "error": error,
            }),
        );
    };
    emit(0, "progress", None);

    let counter = Arc::new(AtomicU64::new(0));
    let progress = |b: u64| emit(b, "progress", None);

    let files: Vec<PlannedFile> = if is_dir {
        match plan_tree(&src, &dst, &src_path, &dst_path, &cancel).await {
            Ok(f) => f,
            Err(e) if e == "cancelled" => {
                emit(0, "cancelled", None);
                return Err("cancelled".into());
            }
            Err(e) => {
                emit(0, "error", Some(e.clone()));
                return Err(e);
            }
        }
    } else {
        let size = match src.metadata(&src_path).await {
            Ok(m) => m.size.unwrap_or(0),
            Err(e) => {
                let msg = format!("stat {src_path}: {e}");
                emit(0, "error", Some(msg.clone()));
                return Err(msg);
            }
        };
        vec![PlannedFile { src: src_path.clone(), dst: dst_path.clone(), size }]
    };
    total.store(files.iter().map(|f| f.size).sum(), Ordering::Relaxed);
    emit(0, "progress", None);

    for f in &files {
        match copy_file(&src, &dst, &f.src, &f.dst, f.size, &counter, &cancel, &progress).await {
            Leg::Done => {}
            Leg::Cancelled => {
                emit(counter.load(Ordering::Relaxed), "cancelled", None);
                return Err("cancelled".into());
            }
            Leg::Failed(e) => {
                emit(counter.load(Ordering::Relaxed), "error", Some(e.clone()));
                return Err(e);
            }
        }
    }
    emit(counter.load(Ordering::Relaxed), "done", None);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_copying_into_itself() {
        assert!(is_inside("/a/b", "/a/b"));
        assert!(is_inside("/a/b/", "/a/b/c"));
        assert!(is_inside("/a/b", "/a/b/c/d"));
        assert!(!is_inside("/a/b", "/a/bc"));
        assert!(!is_inside("/a/b", "/a"));
        assert!(!is_inside("/a/b", "/x/a/b"));
    }

    #[test]
    fn base_name_handles_trailing_slashes_and_root() {
        assert_eq!(base_name("/var/log/syslog"), "syslog");
        assert_eq!(base_name("/var/www/"), "www");
        assert_eq!(base_name("/"), "item");
    }
}
