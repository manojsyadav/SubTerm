use std::sync::Arc;
use russh::ChannelMsg;
use tauri::Emitter;
use crate::ssh_manager::{emit_terminal_batch, PtySize, SshState, TerminalCommand};

#[tauri::command]
pub async fn open_terminal(
    app: tauri::AppHandle,
    state: tauri::State<'_, SshState>,
    session_id: String,
    terminal_id: String,
    cols: u32,
    rows: u32,
) -> Result<(), String> {
    let session_arc = {
        let mut connections = state.connections.lock().await;
        if let Some(sess) = connections.get_mut(&session_id) {
            Arc::clone(sess)
        } else {
            return Err("Session not connected".into());
        }
    };

    let session = session_arc.lock().await;
    let mut channel = session.channel_open_session().await.map_err(|e| e.to_string())?;

    // Request PTY
    channel
        .request_pty(false, "xterm-256color", cols, rows, 0, 0, &[])
        .await
        .map_err(|e| e.to_string())?;
    channel.request_shell(true).await.map_err(|e| e.to_string())?;

    let (tx, mut rx) = tokio::sync::mpsc::channel::<TerminalCommand>(32);
    // Last-wins watch channel for PTY resizes. The PTY task selects on
    // changes; bursty resize events (e.g. window drag) collapse to the
    // final value rather than competing with keystrokes on the data
    // mpsc. Seed with the initial size so the watch is always populated.
    let (resize_tx, mut resize_rx) = tokio::sync::watch::channel(PtySize { cols, rows });
    state.terminal_txs.lock().await.insert(terminal_id.clone(), tx);
    state.resize_txs.lock().await.insert(terminal_id.clone(), resize_tx);

    let terminal_id_clone = terminal_id.clone();
    let app_clone = app.clone();

    tauri::async_runtime::spawn(async move {
        // Coalesce PTY output: accumulate channel bytes and flush at most every
        // ~8ms, or sooner once a burst passes FLUSH_CAP. Emitting one event per
        // SSH packet (each a ~4x-bloated JSON byte array) flooded the WebView
        // main thread on large output and froze the whole tab; batching + the
        // base64 payload in emit_terminal_batch keeps the UI responsive under a
        // firehose. 8ms is imperceptible for interactive echo.
        const FLUSH_CAP: usize = 256 * 1024;
        // Flush at most every 8ms measured FROM THE FIRST buffered byte —
        // imperceptible for interactive echo, but enough to collapse a firehose
        // into a handful of events.
        const FLUSH_WINDOW: std::time::Duration = std::time::Duration::from_millis(8);
        let mut out_buf: Vec<u8> = Vec::new();
        // A flush timer armed ONLY while bytes are buffered. When the buffer is
        // empty its deadline is parked far in the future, so an open-but-idle
        // terminal wakes this task zero times (a free-running interval would fire
        // ~125x/sec doing nothing). The buffer going empty -> non-empty re-arms
        // it to now + FLUSH_WINDOW; a flush parks it again.
        let park = || tokio::time::Instant::now() + std::time::Duration::from_secs(24 * 3600);
        let flush_timer = tokio::time::sleep_until(park());
        tokio::pin!(flush_timer);
        let mut clean_exit = false;
        loop {
            tokio::select! {
                msg_opt = channel.wait() => {
                    match msg_opt {
                        Some(ChannelMsg::Data { ref data }) => {
                            let was_empty = out_buf.is_empty();
                            out_buf.extend_from_slice(data);
                            if out_buf.len() >= FLUSH_CAP {
                                emit_terminal_batch(&app_clone, &terminal_id_clone, &mut out_buf);
                            } else if was_empty {
                                flush_timer.as_mut().reset(tokio::time::Instant::now() + FLUSH_WINDOW);
                            }
                        },
                        Some(ChannelMsg::ExtendedData { ref data, ext: _ }) => {
                            let was_empty = out_buf.is_empty();
                            out_buf.extend_from_slice(data);
                            if out_buf.len() >= FLUSH_CAP {
                                emit_terminal_batch(&app_clone, &terminal_id_clone, &mut out_buf);
                            } else if was_empty {
                                flush_timer.as_mut().reset(tokio::time::Instant::now() + FLUSH_WINDOW);
                            }
                        },
                        // Flush whatever's buffered before the terminal goes away
                        // so the last screenful isn't lost.
                        Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) => {
                            clean_exit = true;
                            emit_terminal_batch(&app_clone, &terminal_id_clone, &mut out_buf);
                            break;
                        },
                        Some(_) => {},
                        None => { emit_terminal_batch(&app_clone, &terminal_id_clone, &mut out_buf); break; }, // channel closed (e.g. after disconnect_session)
                    }
                },
                _ = &mut flush_timer => {
                    emit_terminal_batch(&app_clone, &terminal_id_clone, &mut out_buf);
                    // Park until the next buffered byte re-arms the timer.
                    flush_timer.as_mut().reset(park());
                },
                opt_cmd = rx.recv() => {
                    match opt_cmd {
                        Some(cmd) => match cmd {
                            TerminalCommand::Data(data) => {
                                if channel.data(&data[..]).await.is_err() {
                                    // Flush the last buffered output before bailing on
                                    // a dead transport — the terminal UI is still mounted.
                                    emit_terminal_batch(&app_clone, &terminal_id_clone, &mut out_buf);
                                    break;
                                }
                            }
                        },
                        None => {
                            let _ = channel.close().await;
                            break;
                        }
                    }
                },
                // `changed().await` resolves on every Sender::send(). We
                // then read the LATEST value with .borrow() so coalesced
                // bursts collapse to one window_change call.
                changed = resize_rx.changed() => {
                    if changed.is_err() { break; } // all senders dropped
                    let size = *resize_rx.borrow();
                    let _ = channel.window_change(size.cols, size.rows, 0, 0).await;
                }
            }
        }
        let _ = app_clone.emit(&format!("terminal-closed-{}", terminal_id_clone), serde_json::json!({
            "clean_exit": clean_exit
        }));
    });

    Ok(())
}

#[tauri::command]
pub async fn write_terminal_data(
    state: tauri::State<'_, SshState>,
    terminal_id: String,
    data: Vec<u8>,
) -> Result<(), String> {
    // Clone the Sender OUT of the map, then release the map lock before we
    // await on send(). If we held the guard across the send, a saturated
    // 32-slot mpsc on a slow SSH link would block every other terminal's
    // write path — one slow terminal freezes the entire app-wide typing
    // experience because the shared map guard is a global gate.
    // mpsc::Sender is cheap to clone.
    let tx = state.terminal_txs.lock().await.get(&terminal_id).cloned();
    if let Some(tx) = tx {
        let _ = tx.send(TerminalCommand::Data(data)).await;
    }
    Ok(())
}

#[tauri::command]
pub async fn resize_terminal(
    state: tauri::State<'_, SshState>,
    terminal_id: String,
    cols: u32,
    rows: u32,
) -> Result<(), String> {
    if let Some(tx) = state.resize_txs.lock().await.get(&terminal_id) {
        // send_replace overwrites the current value unconditionally —
        // perfect for a coalescing last-wins channel.
        let _ = tx.send(PtySize { cols, rows });
    }
    Ok(())
}

#[tauri::command]
pub async fn close_terminal(
    state: tauri::State<'_, SshState>,
    terminal_id: String,
) -> Result<(), String> {
    state.terminal_txs.lock().await.remove(&terminal_id);
    state.resize_txs.lock().await.remove(&terminal_id);
    Ok(())
}
