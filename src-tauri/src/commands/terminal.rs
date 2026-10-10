use russh::ChannelMsg;
use tauri::Emitter;
use crate::ssh_manager::{register_output_channel, send_terminal_batch, OutputChannel, PtySize, SshState, TerminalCommand};

/// Registers a `Channel` as an output sink for `terminal_id` without opening
/// a PTY — used by attach-only split-pane viewers that watch a terminal
/// another `TerminalView` instance already owns and opened.
#[tauri::command]
pub async fn subscribe_terminal_output(
    state: tauri::State<'_, SshState>,
    terminal_id: String,
    channel: OutputChannel,
) -> Result<(), String> {
    register_output_channel(&state.output_channels, &terminal_id, channel).await;
    Ok(())
}

#[tauri::command]
pub async fn open_terminal(
    app: tauri::AppHandle,
    state: tauri::State<'_, SshState>,
    session_id: String,
    terminal_id: String,
    cols: u32,
    rows: u32,
    channel: OutputChannel,
) -> Result<(), String> {
    use crate::ssh_manager::{PtyChannel, PtyProgram};
    let PtyChannel { channel: mut pty_channel, commands: mut rx, resizes: mut resize_rx } =
        state.open_pty_channel(&session_id, &terminal_id, cols, rows, PtyProgram::Shell).await?;
    register_output_channel(&state.output_channels, &terminal_id, channel).await;

    let terminal_id_clone = terminal_id.clone();
    let app_clone = app.clone();
    let output_channels = state.output_channels.clone();

    tauri::async_runtime::spawn(async move {
        // Coalesce PTY output: accumulate channel bytes and flush at most every
        // ~8ms, or sooner once a burst passes FLUSH_CAP. Sending one message per
        // SSH packet (each a ~4x-bloated JSON byte array under the old base64
        // event path) flooded the WebView main thread on large output and froze
        // the whole tab; batching + raw binary channel delivery (see
        // `send_terminal_batch`) keeps the UI responsive under a firehose.
        // 8ms is imperceptible for interactive echo.
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
                msg_opt = pty_channel.wait() => {
                    match msg_opt {
                        Some(ChannelMsg::Data { ref data }) => {
                            let was_empty = out_buf.is_empty();
                            out_buf.extend_from_slice(data);
                            if out_buf.len() >= FLUSH_CAP {
                                send_terminal_batch(&output_channels, &terminal_id_clone, &mut out_buf).await;
                            } else if was_empty {
                                flush_timer.as_mut().reset(tokio::time::Instant::now() + FLUSH_WINDOW);
                            }
                        },
                        Some(ChannelMsg::ExtendedData { ref data, ext: _ }) => {
                            let was_empty = out_buf.is_empty();
                            out_buf.extend_from_slice(data);
                            if out_buf.len() >= FLUSH_CAP {
                                send_terminal_batch(&output_channels, &terminal_id_clone, &mut out_buf).await;
                            } else if was_empty {
                                flush_timer.as_mut().reset(tokio::time::Instant::now() + FLUSH_WINDOW);
                            }
                        },
                        // Flush whatever's buffered before the terminal goes away
                        // so the last screenful isn't lost.
                        Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) => {
                            clean_exit = true;
                            send_terminal_batch(&output_channels, &terminal_id_clone, &mut out_buf).await;
                            break;
                        },
                        Some(_) => {},
                        None => { send_terminal_batch(&output_channels, &terminal_id_clone, &mut out_buf).await; break; }, // channel closed (e.g. after disconnect_session)
                    }
                },
                _ = &mut flush_timer => {
                    send_terminal_batch(&output_channels, &terminal_id_clone, &mut out_buf).await;
                    // Park until the next buffered byte re-arms the timer.
                    flush_timer.as_mut().reset(park());
                },
                opt_cmd = rx.recv() => {
                    match opt_cmd {
                        Some(cmd) => match cmd {
                            TerminalCommand::Data(data) => {
                                if pty_channel.data(&data[..]).await.is_err() {
                                    // Flush the last buffered output before bailing on
                                    // a dead transport — the terminal UI is still mounted.
                                    send_terminal_batch(&output_channels, &terminal_id_clone, &mut out_buf).await;
                                    break;
                                }
                            }
                        },
                        None => {
                            let _ = pty_channel.close().await;
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
                    let _ = pty_channel.window_change(size.cols, size.rows, 0, 0).await;
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

/// Writes the session's saved SSH password followed by Enter straight into
/// the PTY — used by the "Paste saved password" terminal action for
/// `[sudo] password for user:` prompts. The plaintext password never crosses
/// into JS: it's looked up from `session_passwords` (the same map
/// `docker.rs`'s silent-sudo-elevation path reads) and written directly to
/// the terminal's input channel here.
#[tauri::command]
pub async fn write_saved_password(
    state: tauri::State<'_, SshState>,
    session_id: String,
    terminal_id: String,
) -> Result<bool, String> {
    let password = state.session_passwords.lock().await.get(&session_id).cloned();
    let Some(password) = password else { return Ok(false); };

    let tx = state.terminal_txs.lock().await.get(&terminal_id).cloned();
    let Some(tx) = tx else { return Ok(false); };

    let mut payload = password.into_bytes();
    payload.push(b'\n');
    let _ = tx.send(TerminalCommand::Data(payload)).await;
    Ok(true)
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
    state.output_channels.lock().await.remove(&terminal_id);
    Ok(())
}

#[cfg(desktop)]
#[tauri::command]
pub async fn open_local_terminal(
    app: tauri::AppHandle,
    state: tauri::State<'_, SshState>,
    terminal_id: String,
    cols: u32,
    rows: u32,
    cwd: Option<String>,
    shell: Option<String>,
    channel: OutputChannel,
) -> Result<(), String> {
    use portable_pty::{native_pty_system, CommandBuilder, PtySize as PortablePtySize};
    use std::io::{Read, Write};

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PortablePtySize {
            rows: rows.max(1) as u16,
            cols: cols.max(1) as u16,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("Failed to create local PTY: {e}"))?;

fn resolve_local_shell(input: Option<&str>) -> (String, Vec<String>) {
    #[cfg(windows)]
    {
        let raw = input.unwrap_or("").trim();
        match raw {
            "pwsh" | "pwsh.exe" => {
                let pwsh_paths = [
                    "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
                    "C:\\Program Files (x86)\\PowerShell\\7\\pwsh.exe",
                ];
                for p in &pwsh_paths {
                    if std::path::Path::new(p).exists() {
                        return (p.to_string(), vec!["-NoLogo".to_string()]);
                    }
                }
                ("pwsh.exe".to_string(), vec!["-NoLogo".to_string()])
            }
            "powershell" | "powershell.exe" => {
                let sys_powershell = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
                if std::path::Path::new(sys_powershell).exists() {
                    (sys_powershell.to_string(), vec!["-NoLogo".to_string()])
                } else {
                    ("powershell.exe".to_string(), vec!["-NoLogo".to_string()])
                }
            }
            "cmd" | "cmd.exe" => {
                let sys_cmd = "C:\\Windows\\System32\\cmd.exe";
                if std::path::Path::new(sys_cmd).exists() {
                    (sys_cmd.to_string(), vec![])
                } else {
                    ("cmd.exe".to_string(), vec![])
                }
            }
            "git-bash" | "bash" | "bash.exe" => {
                let git_bash_paths = [
                    "C:\\Program Files\\Git\\bin\\bash.exe",
                    "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
                    "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
                ];
                for p in &git_bash_paths {
                    if std::path::Path::new(p).exists() {
                        return (p.to_string(), vec!["--login".to_string(), "-i".to_string()]);
                    }
                }
                ("bash.exe".to_string(), vec!["--login".to_string(), "-i".to_string()])
            }
            "wsl" | "wsl.exe" => {
                let wsl_path = "C:\\Windows\\System32\\wsl.exe";
                if std::path::Path::new(wsl_path).exists() {
                    (wsl_path.to_string(), vec![])
                } else {
                    ("wsl.exe".to_string(), vec![])
                }
            }
            other => {
                if other.is_empty() {
                    // Prefer PowerShell 7 if available, otherwise fallback to Windows PowerShell
                    let pwsh7 = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";
                    if std::path::Path::new(pwsh7).exists() {
                        (pwsh7.to_string(), vec!["-NoLogo".to_string()])
                    } else {
                        let sys_powershell = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
                        if std::path::Path::new(sys_powershell).exists() {
                            (sys_powershell.to_string(), vec!["-NoLogo".to_string()])
                        } else {
                            ("powershell.exe".to_string(), vec!["-NoLogo".to_string()])
                        }
                    }
                } else if other.ends_with("bash.exe") {
                    (other.to_string(), vec!["--login".to_string(), "-i".to_string()])
                } else if !other.ends_with(".exe") && !other.contains('\\') && !other.contains('/') {
                    (format!("{}.exe", other), vec![])
                } else {
                    (other.to_string(), vec![])
                }
            }
        }
    }
    #[cfg(not(windows))]
    {
        let cmd = input.filter(|s| !s.trim().is_empty()).map(str::to_string).unwrap_or_else(|| {
            std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string())
        });
        (cmd, vec![])
    }
}

    let (shell_cmd, shell_args) = resolve_local_shell(shell.as_deref());

    let mut cmd = CommandBuilder::new(&shell_cmd);
    for arg in &shell_args {
        cmd.arg(arg);
    }
    if let Some(dir) = cwd.filter(|d| !d.trim().is_empty()) {
        cmd.cwd(dir);
    } else if let Some(base_dirs) = directories::BaseDirs::new() {
        cmd.cwd(base_dirs.home_dir());
    }

    let mut child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("Failed to spawn local shell ({shell_cmd}): {e}"))?;

    drop(pair.slave);

    let master = pair.master;
    let mut reader = master
        .try_clone_reader()
        .map_err(|e| format!("Failed to clone PTY reader: {e}"))?;
    let mut writer = master
        .take_writer()
        .map_err(|e| format!("Failed to take PTY writer: {e}"))?;

    let (tx, mut rx) = tokio::sync::mpsc::channel::<TerminalCommand>(32);
    let (resize_tx, mut resize_rx) = tokio::sync::watch::channel(PtySize { cols, rows });
    state.terminal_txs.lock().await.insert(terminal_id.clone(), tx);
    state.resize_txs.lock().await.insert(terminal_id.clone(), resize_tx);
    register_output_channel(&state.output_channels, &terminal_id, channel).await;
    let output_channels = state.output_channels.clone();

    let (pty_out_tx, mut pty_out_rx) = tokio::sync::mpsc::channel::<Vec<u8>>(128);

    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    if pty_out_tx.blocking_send(buf[..n].to_vec()).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });

    let terminal_id_clone = terminal_id.clone();
    let app_clone = app.clone();

    tauri::async_runtime::spawn(async move {
        const FLUSH_CAP: usize = 256 * 1024;
        const FLUSH_WINDOW: std::time::Duration = std::time::Duration::from_millis(8);
        let mut out_buf: Vec<u8> = Vec::new();
        let park = || tokio::time::Instant::now() + std::time::Duration::from_secs(24 * 3600);
        let flush_timer = tokio::time::sleep_until(park());
        tokio::pin!(flush_timer);
        let mut clean_exit = false;

        loop {
            tokio::select! {
                out_chunk = pty_out_rx.recv() => {
                    match out_chunk {
                        Some(data) => {
                            let was_empty = out_buf.is_empty();
                            out_buf.extend_from_slice(&data);
                            if out_buf.len() >= FLUSH_CAP {
                                send_terminal_batch(&output_channels, &terminal_id_clone, &mut out_buf).await;
                            } else if was_empty {
                                flush_timer.as_mut().reset(tokio::time::Instant::now() + FLUSH_WINDOW);
                            }
                        }
                        None => {
                            clean_exit = true;
                            send_terminal_batch(&output_channels, &terminal_id_clone, &mut out_buf).await;
                            break;
                        }
                    }
                }
                _ = &mut flush_timer => {
                    send_terminal_batch(&output_channels, &terminal_id_clone, &mut out_buf).await;
                    flush_timer.as_mut().reset(park());
                }
                opt_cmd = rx.recv() => {
                    match opt_cmd {
                        Some(cmd) => match cmd {
                            TerminalCommand::Data(data) => {
                                if writer.write_all(&data).is_err() {
                                    send_terminal_batch(&output_channels, &terminal_id_clone, &mut out_buf).await;
                                    break;
                                }
                                let _ = writer.flush();
                            }
                        },
                        None => {
                            break;
                        }
                    }
                }
                changed = resize_rx.changed() => {
                    if changed.is_err() { break; }
                    let size = *resize_rx.borrow();
                    let _ = master.resize(PortablePtySize {
                        rows: size.rows.max(1) as u16,
                        cols: size.cols.max(1) as u16,
                        pixel_width: 0,
                        pixel_height: 0,
                    });
                }
            }
        }

        let _ = child.kill();
        let _ = child.wait();

        let _ = app_clone.emit(&format!("terminal-closed-{}", terminal_id_clone), serde_json::json!({
            "clean_exit": clean_exit
        }));
    });

    Ok(())
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct LocalShellOption {
    pub id: String,
    pub name: String,
    pub command: String,
}

#[tauri::command]
pub async fn get_available_local_shells() -> Result<Vec<LocalShellOption>, String> {
    let mut shells = Vec::new();

    #[cfg(windows)]
    {
        let pwsh_paths = [
            "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
            "C:\\Program Files (x86)\\PowerShell\\7\\pwsh.exe",
        ];
        if pwsh_paths.iter().any(|p| std::path::Path::new(p).exists()) {
            shells.push(LocalShellOption {
                id: "pwsh".to_string(),
                name: "PowerShell 7 (pwsh)".to_string(),
                command: "pwsh.exe".to_string(),
            });
        }

        shells.push(LocalShellOption {
            id: "powershell".to_string(),
            name: "Windows PowerShell".to_string(),
            command: "powershell.exe".to_string(),
        });

        shells.push(LocalShellOption {
            id: "cmd".to_string(),
            name: "Command Prompt (CMD)".to_string(),
            command: "cmd.exe".to_string(),
        });

        let git_bash_paths = [
            "C:\\Program Files\\Git\\bin\\bash.exe",
            "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
        ];
        for p in &git_bash_paths {
            if std::path::Path::new(p).exists() {
                shells.push(LocalShellOption {
                    id: "git-bash".to_string(),
                    name: "Git Bash".to_string(),
                    command: (*p).to_string(),
                });
                break;
            }
        }

        let wsl_path = "C:\\Windows\\System32\\wsl.exe";
        if std::path::Path::new(wsl_path).exists() {
            shells.push(LocalShellOption {
                id: "wsl".to_string(),
                name: "WSL (Windows Subsystem for Linux)".to_string(),
                command: "wsl.exe".to_string(),
            });
        }
    }

    #[cfg(not(windows))]
    {
        if let Ok(sh) = std::env::var("SHELL") {
            shells.push(LocalShellOption {
                id: "default".to_string(),
                name: format!("Default Shell ({sh})"),
                command: sh,
            });
        }
        for (name, path) in [("Zsh", "/bin/zsh"), ("Bash", "/bin/bash"), ("Fish", "/usr/bin/fish"), ("Sh", "/bin/sh")] {
            if std::path::Path::new(path).exists() {
                shells.push(LocalShellOption {
                    id: name.to_lowercase(),
                    name: name.to_string(),
                    command: path.to_string(),
                });
            }
        }
    }

    Ok(shells)
}

#[cfg(mobile)]
#[tauri::command]
pub async fn open_local_terminal(
    _app: tauri::AppHandle,
    _state: tauri::State<'_, SshState>,
    _terminal_id: String,
    _cols: u32,
    _rows: u32,
    _cwd: Option<String>,
    _shell: Option<String>,
    _channel: OutputChannel,
) -> Result<(), String> {
    Err("Local terminal is not supported on Android".to_string())
}

#[cfg(mobile)]
#[tauri::command]
pub async fn get_available_local_shells() -> Result<Vec<LocalShellOption>, String> {
    Ok(vec![])
}

#[tauri::command]
pub fn set_ssh_keepalive_interval(secs: u64) -> Result<(), String> {
    crate::SSH_KEEPALIVE_SECS.store(secs, std::sync::atomic::Ordering::Relaxed);
    Ok(())
}


