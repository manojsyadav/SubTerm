//! Parallel ranged copy for large SFTP downloads.
//!
//! russh-sftp's `File` issues ONE read request at a time and waits for its reply,
//! so a single sequential read is bound by `chunk / round-trip-time` no matter how
//! much bandwidth the link has. Opening the same remote file several times (the
//! requests are multiplexed over the one SFTP channel) and letting each handle
//! pull a different byte range keeps several requests in flight at once.
//!
//! The copy helper is generic over `AsyncRead + AsyncSeek` so the range/offset
//! logic is unit-tested against in-memory readers rather than a live server.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncSeek, AsyncSeekExt, AsyncWrite, AsyncWriteExt, SeekFrom};

/// Below this size a single stream is used: the extra handles aren't worth it.
pub(crate) const PARALLEL_MIN_BYTES: u64 = 16 * 1024 * 1024;
/// Upper bound on simultaneous read streams for one file.
pub(crate) const MAX_STREAMS: usize = 4;
/// Never make a segment smaller than this.
pub(crate) const MIN_SEGMENT_BYTES: u64 = 8 * 1024 * 1024;
const CHUNK: usize = 256 * 1024;

/// Split `[0, total)` into at most `max_streams` contiguous `(start, end)` segments
/// (end exclusive), each at least `min_segment` long where possible. Covers the
/// whole range exactly once.
pub(crate) fn plan_segments(total: u64, max_streams: usize, min_segment: u64) -> Vec<(u64, u64)> {
    if total == 0 {
        return Vec::new();
    }
    let by_size = (total / min_segment.max(1)).max(1) as usize;
    let n = by_size.min(max_streams.max(1)) as u64;
    let base = total / n;
    let extra = total % n;
    let mut out = Vec::with_capacity(n as usize);
    let mut start = 0u64;
    for i in 0..n {
        let len = base + if i < extra { 1 } else { 0 };
        out.push((start, start + len));
        start += len;
    }
    out
}

pub(crate) enum CopyError {
    Cancelled,
    Failed(String),
}

/// Copy bytes `[start, end)` from `reader` into the already-existing local file at
/// the same offsets. Adds each written chunk to `transferred`. Stops early with
/// `Cancelled` when `cancel` is set; errors if the reader ends before `end`.
pub(crate) async fn copy_range<R>(
    reader: R,
    start: u64,
    end: u64,
    local_path: &str,
    transferred: &AtomicU64,
    cancel: &AtomicBool,
) -> Result<(), CopyError>
where
    R: AsyncRead + AsyncSeek + Unpin,
{
    let out = tokio::fs::OpenOptions::new()
        .write(true)
        .open(local_path)
        .await
        .map_err(|e| CopyError::Failed(format!("open local: {e}")))?;
    copy_stream(reader, out, start, end, transferred, cancel).await
}

/// Copy bytes `[start, end)` from `reader` to the SAME offsets in `writer`
/// (both are seeked to `start` first). The writer is flushed and shut down at
/// the end, which for an SFTP file waits for every pipelined write to be
/// acknowledged - so a failed write surfaces here rather than being lost.
pub(crate) async fn copy_stream<R, W>(
    mut reader: R,
    mut out: W,
    start: u64,
    end: u64,
    transferred: &AtomicU64,
    cancel: &AtomicBool,
) -> Result<(), CopyError>
where
    R: AsyncRead + AsyncSeek + Unpin,
    W: AsyncWrite + AsyncSeek + Unpin,
{
    out.seek(SeekFrom::Start(start)).await.map_err(|e| CopyError::Failed(format!("destination seek: {e}")))?;
    reader.seek(SeekFrom::Start(start)).await.map_err(|e| CopyError::Failed(format!("source seek: {e}")))?;

    let mut buf = vec![0u8; CHUNK];
    let mut pos = start;
    while pos < end {
        if cancel.load(Ordering::Relaxed) {
            return Err(CopyError::Cancelled);
        }
        let want = ((end - pos) as usize).min(CHUNK);
        let n = reader.read(&mut buf[..want]).await.map_err(|e| CopyError::Failed(format!("read: {e}")))?;
        if n == 0 {
            return Err(CopyError::Failed(format!("remote file ended early at byte {pos} (expected {end})")));
        }
        out.write_all(&buf[..n]).await.map_err(|e| CopyError::Failed(format!("write: {e}")))?;
        pos += n as u64;
        transferred.fetch_add(n as u64, Ordering::Relaxed);
    }
    out.flush().await.map_err(|e| CopyError::Failed(format!("flush: {e}")))?;
    out.shutdown().await.map_err(|e| CopyError::Failed(format!("close: {e}")))?;
    Ok(())
}

/// How a set of segment tasks ended.
pub(crate) enum DriveEnd {
    Done,
    Cancelled,
    Failed(String),
}

/// Wait for every spawned segment task, reporting progress about every 100 ms.
/// The first failure or cancellation aborts the rest.
pub(crate) async fn drive_tasks(
    mut set: tokio::task::JoinSet<Result<(), CopyError>>,
    transferred: &AtomicU64,
    report: &(dyn Fn(u64) + Sync),
) -> DriveEnd {
    let mut tick = tokio::time::interval(std::time::Duration::from_millis(100));
    let mut failure: Option<String> = None;
    let mut cancelled = false;
    while !set.is_empty() {
        tokio::select! {
            joined = set.join_next() => match joined {
                Some(Ok(Ok(()))) => {}
                Some(Ok(Err(CopyError::Cancelled))) => { cancelled = true; set.abort_all(); }
                Some(Ok(Err(CopyError::Failed(m)))) => { failure.get_or_insert(m); set.abort_all(); }
                Some(Err(e)) if !e.is_cancelled() => { failure.get_or_insert(format!("transfer task failed: {e}")); set.abort_all(); }
                _ => {}
            },
            _ = tick.tick() => report(transferred.load(Ordering::Relaxed)),
        }
    }
    match failure {
        Some(m) => DriveEnd::Failed(m),
        None if cancelled => DriveEnd::Cancelled,
        None => DriveEnd::Done,
    }
}

pub(crate) enum ParallelOutcome {
    Done,
    Cancelled(u64),
    Failed(String),
    /// Couldn't set up the extra handles (before any data moved) - caller falls back to one stream.
    Unsupported,
}

/// Download `remote_path` into `local_path` over several read streams at once.
/// `total` must be the remote size (>0). Progress is reported through `report`
/// roughly every 100 ms. On failure or cancel the partial local file is removed.
pub(crate) async fn download_parallel(
    sftp: &russh_sftp::client::SftpSession,
    remote_path: &str,
    local_path: &str,
    total: u64,
    cancel: &std::sync::Arc<AtomicBool>,
    report: &(dyn Fn(u64) + Sync),
) -> ParallelOutcome {
    let segments = plan_segments(total, MAX_STREAMS, MIN_SEGMENT_BYTES);
    if segments.len() < 2 {
        return ParallelOutcome::Unsupported;
    }

    // Open every remote handle first: if the server refuses extra handles we can
    // still fall back without having touched the local file.
    let mut readers = Vec::with_capacity(segments.len());
    for _ in &segments {
        match sftp.open(remote_path).await {
            Ok(f) => readers.push(f),
            Err(_) => return ParallelOutcome::Unsupported,
        }
    }

    let preallocated = async {
        let f = tokio::fs::File::create(local_path).await?;
        f.set_len(total).await
    }
    .await;
    if let Err(e) = preallocated {
        return ParallelOutcome::Failed(format!("Failed to create local file: {e}"));
    }

    let transferred = std::sync::Arc::new(AtomicU64::new(0));
    let mut set = tokio::task::JoinSet::new();
    for ((start, end), reader) in segments.iter().copied().zip(readers) {
        let (path, t, c) = (local_path.to_string(), transferred.clone(), cancel.clone());
        set.spawn(async move { copy_range(reader, start, end, &path, &t, &c).await });
    }

    let end = drive_tasks(set, &transferred, report).await;
    let done = transferred.load(Ordering::Relaxed);
    match end {
        DriveEnd::Failed(m) => {
            let _ = tokio::fs::remove_file(local_path).await;
            return ParallelOutcome::Failed(m);
        }
        DriveEnd::Cancelled => {
            let _ = tokio::fs::remove_file(local_path).await;
            return ParallelOutcome::Cancelled(done);
        }
        DriveEnd::Done => {}
    }
    if done != total {
        let _ = tokio::fs::remove_file(local_path).await;
        return ParallelOutcome::Failed(format!("incomplete download: got {done} of {total} bytes"));
    }
    ParallelOutcome::Done
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn data(len: usize) -> Vec<u8> {
        (0..len).map(|i| (i.wrapping_mul(31).wrapping_add(7)) as u8).collect()
    }

    fn temp_file(tag: &str, len: u64) -> String {
        let p = std::env::temp_dir().join(format!("subterm-par-{tag}-{}", std::process::id()));
        let f = std::fs::File::create(&p).unwrap();
        f.set_len(len).unwrap();
        p.to_string_lossy().into_owned()
    }

    #[test]
    fn segments_cover_the_range_exactly_once() {
        for total in [1u64, 7, 100, 16 << 20, (16 << 20) + 13, 1 << 30, 5_000_000_001] {
            for streams in [1usize, 2, 4, 8] {
                let segs = plan_segments(total, streams, MIN_SEGMENT_BYTES);
                assert!(!segs.is_empty() && segs.len() <= streams);
                assert_eq!(segs[0].0, 0);
                assert_eq!(segs.last().unwrap().1, total);
                for w in segs.windows(2) {
                    assert_eq!(w[0].1, w[1].0, "gap or overlap at total={total}");
                }
                assert!(segs.iter().all(|(s, e)| e > s));
            }
        }
        assert!(plan_segments(0, 4, MIN_SEGMENT_BYTES).is_empty());
    }

    #[test]
    fn small_files_get_one_segment_and_big_ones_are_capped() {
        assert_eq!(plan_segments(MIN_SEGMENT_BYTES - 1, 4, MIN_SEGMENT_BYTES).len(), 1);
        assert_eq!(plan_segments(MIN_SEGMENT_BYTES * 2, 4, MIN_SEGMENT_BYTES).len(), 2);
        assert_eq!(plan_segments(MIN_SEGMENT_BYTES * 100, 4, MIN_SEGMENT_BYTES).len(), 4);
    }

    #[tokio::test]
    async fn parallel_ranges_reassemble_the_exact_file() {
        let src = data(3 * CHUNK + 12_345);
        let path = temp_file("assemble", src.len() as u64);
        let transferred = AtomicU64::new(0);
        let cancel = AtomicBool::new(false);
        let segs = plan_segments(src.len() as u64, 3, 1);
        let mut tasks = Vec::new();
        for (s, e) in segs {
            let r = Cursor::new(src.clone());
            let (p, t, c) = (path.clone(), &transferred, &cancel);
            tasks.push(async move { copy_range(r, s, e, &p, t, c).await.map_err(|_| "copy failed") });
        }
        for r in futures_util::future::join_all(tasks).await {
            r.unwrap();
        }
        assert_eq!(std::fs::read(&path).unwrap(), src);
        assert_eq!(transferred.load(Ordering::Relaxed), src.len() as u64);
        let _ = std::fs::remove_file(&path);
    }

    #[tokio::test]
    async fn copy_stream_lands_each_segment_at_its_own_offset_in_the_destination() {
        let src = data(2 * CHUNK + 999);
        let path = temp_file("stream", src.len() as u64);
        let transferred = AtomicU64::new(0);
        let cancel = AtomicBool::new(false);
        let mid = (CHUNK + 17) as u64;
        for (s, e) in [(mid, src.len() as u64), (0, mid)] {
            let out = tokio::fs::OpenOptions::new().write(true).open(&path).await.unwrap();
            copy_stream(Cursor::new(src.clone()), out, s, e, &transferred, &cancel).await.ok().unwrap();
        }
        assert_eq!(std::fs::read(&path).unwrap(), src);
        assert_eq!(transferred.load(Ordering::Relaxed), src.len() as u64);
        let _ = std::fs::remove_file(&path);
    }

    #[tokio::test]
    async fn drive_tasks_reports_first_failure_and_cancels_the_rest() {
        let t = AtomicU64::new(0);
        let mut set = tokio::task::JoinSet::new();
        set.spawn(async { Err(CopyError::Failed("boom".into())) });
        set.spawn(async { tokio::time::sleep(std::time::Duration::from_secs(30)).await; Ok(()) });
        assert!(matches!(drive_tasks(set, &t, &|_| {}).await, DriveEnd::Failed(m) if m == "boom"));

        let mut ok = tokio::task::JoinSet::new();
        ok.spawn(async { Ok(()) });
        ok.spawn(async { Ok(()) });
        assert!(matches!(drive_tasks(ok, &t, &|_| {}).await, DriveEnd::Done));

        let mut c = tokio::task::JoinSet::new();
        c.spawn(async { Err(CopyError::Cancelled) });
        assert!(matches!(drive_tasks(c, &t, &|_| {}).await, DriveEnd::Cancelled));
    }

    #[tokio::test]
    async fn short_remote_file_is_an_error_not_silent_truncation() {
        let src = data(1000);
        let path = temp_file("short", 2000);
        let t = AtomicU64::new(0);
        let c = AtomicBool::new(false);
        let r = copy_range(Cursor::new(src), 0, 2000, &path, &t, &c).await;
        assert!(matches!(r, Err(CopyError::Failed(m)) if m.contains("ended early")));
        let _ = std::fs::remove_file(&path);
    }

    #[tokio::test]
    async fn cancel_stops_before_reading() {
        let path = temp_file("cancel", 1000);
        let t = AtomicU64::new(0);
        let c = AtomicBool::new(true);
        let r = copy_range(Cursor::new(data(1000)), 0, 1000, &path, &t, &c).await;
        assert!(matches!(r, Err(CopyError::Cancelled)));
        assert_eq!(t.load(Ordering::Relaxed), 0);
        let _ = std::fs::remove_file(&path);
    }
}
