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

/// Whether `write_saved_password` has anything to write, so the sudo-prompt
/// offer only shows for sessions that logged in with a saved password.
#[tauri::command]
pub async fn has_saved_password(
    state: tauri::State<'_, SshState>,
    session_id: String,
) -> Result<bool, String> {
    Ok(state.session_passwords.lock().await.contains_key(&session_id))
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

/// PowerShell prompt wrapper that reports each command's end (OSC 133;D with the
/// exit code) and the prompt start (OSC 133;A), so long-command notifications and
/// command blocks work without the user installing shell integration. `$global:?`
/// must be read first, before anything else in the function resets it.
///
/// Inside a git repository it also puts `[repo:branch ↑ahead ↓behind ●changes]`
/// before the prompt's closing `>` (`≡` when level with the upstream; green when
/// clean, yellow with changes), using posh-git's symbols. Prompts that don't end
/// in `>` (oh-my-posh, Starship) are left alone, as they draw their own.
pub(crate) fn pwsh_integration(osc133: bool, git_prompt: bool) -> String {
    let mut s = String::from("$global:__stPrompt = $function:prompt\n");
    if git_prompt {
        s.push_str(r#"$global:__stGit = [bool](Get-Command git -CommandType Application -ErrorAction SilentlyContinue)
function global:__stGitSegment {
  $top = $PWD.Path
  while ($top -and -not (Test-Path -LiteralPath "$top\.git")) {
    $p = Split-Path -Parent $top
    if ($p -eq $top) { $top = $null; break }
    $top = $p
  }
  if (-not $top) { return '' }
  $h = ''; $o = ''; $up = $false; $ahead = 0; $behind = 0; $n = 0
  foreach ($l in (git --no-optional-locks status --porcelain=v2 --branch 2>$null)) {
    if ($l.StartsWith('# branch.oid ')) { $o = $l.Substring(13) }
    elseif ($l.StartsWith('# branch.head ')) { $h = $l.Substring(14) }
    elseif ($l.StartsWith('# branch.upstream ')) { $up = $true }
    elseif ($l.StartsWith('# branch.ab ')) { $p = $l.Split(' '); $ahead = [int]$p[2].Substring(1); $behind = [int]$p[3].Substring(1) }
    elseif (-not $l.StartsWith('#')) { $n++ }
  }
  if ($h -eq '(detached)') { $h = $o.Substring(0, [Math]::Min(7, $o.Length)) }
  $s = (Split-Path -Leaf $top) + ':' + $h
  if ($up) {
    if ($ahead) { $s += ' ' + [char]0x2191 + $ahead }
    if ($behind) { $s += ' ' + [char]0x2193 + $behind }
    if (-not ($ahead -or $behind)) { $s += ' ' + [char]0x2261 }
  }
  if ($n) { $s += ' ' + [char]0x25CF + $n }
  $e = [char]27
  " $e[$(if ($n) { 33 } else { 32 })m[$s]$e[0m"
}
"#);
    }
    s.push_str("function global:prompt {\n");
    if osc133 {
        s.push_str(r#"  $ok = $global:?
  $c = if ($ok) { 0 } elseif ($global:LASTEXITCODE) { $global:LASTEXITCODE } else { 1 }
  $e = [char]27; $b = [char]7
"#);
    }
    s.push_str("  $p = & $global:__stPrompt\n");
    if git_prompt {
        s.push_str(r#"  if ($global:__stGit -and $p -match '>+ ?$') {
    # Running git would overwrite the exit code the user may check next.
    $lec = $global:LASTEXITCODE
    $g = try { __stGitSegment } catch { '' }
    $global:LASTEXITCODE = $lec
    if ($g) { $p = $p.Substring(0, $p.Length - $Matches[0].Length) + $g + $Matches[0] }
  }
"#);
    }
    if osc133 {
        s.push_str("  \"$e]133;D;$c$b$e]133;A;subterm=local$b\" + $p\n");
    } else {
        s.push_str("  $p\n");
    }
    s.push_str("}\n");
    s
}

/// bash equivalent; a PROMPT_COMMAND set in the user's .bashrc replaces it. The git
/// segment is spliced into PS1 once, before a trailing `\$ `; a PS1 ending any other
/// way (Git Bash's own `__git_ps1` prompt, custom themes) is not touched. The
/// symbols are octal escapes so the value stays ASCII through WSLENV.
pub(crate) fn bash_prompt_command(osc133: bool, git_prompt: bool) -> String {
    let mut parts = Vec::new();
    if osc133 {
        parts.push(r#"__st_rc=$?; printf '\033]133;D;%s\007\033]133;A;subterm=local\007' "$__st_rc""#.to_string());
    }
    if git_prompt {
        parts.push(r#"__st_d=$PWD; while [ -n "$__st_d" ] && [ ! -e "$__st_d/.git" ]; do __st_p=${__st_d%/*}; [ "$__st_p" = "$__st_d" ] && __st_p=; __st_d=$__st_p; done; __st_git=; if [ -n "$__st_d" ]; then __st_git=$(git --no-optional-locks status --porcelain=v2 --branch 2>/dev/null | awk -v r="${__st_d##*/}" '$2=="branch.oid"{o=substr($3,1,7)} $2=="branch.head"{h=$3} $2=="branch.upstream"{u=1} $2=="branch.ab"{a=substr($3,2)+0;b=substr($4,2)+0} !/^#/{n++} END{if(h=="(detached)")h=o; s=r":"h; if(u){if(a)s=s" \342\206\221"a; if(b)s=s" \342\206\223"b; if(!a&&!b)s=s" \342\211\241"} if(n)s=s" \342\227\217"n; printf " \001\033[%sm\002[%s]\001\033[0m\002", (n?33:32), s}'); fi; case $PS1 in *__st_git*) ;; *'\$ ') PS1="${PS1%\\$ }\${__st_git}\\$ ";; esac"#.to_string());
    }
    parts.join("; ")
}

#[cfg_attr(mobile, allow(dead_code))]
enum ShellIntegration {
    Args(Vec<String>),
    Env(Vec<(&'static str, String)>),
}

/// How to add OSC 133 markers to `shell_cmd`, if it is a shell we know how to hook.
/// cmd has no prompt hook. WSL only passes variables listed in WSLENV through.
/// The `subterm=local` tag on the prompt marker tells this shell's prompt apart
/// from a remote shell's one, inside an ssh started from it.
#[cfg_attr(mobile, allow(dead_code))]
fn shell_integration(shell_cmd: &str, osc133: bool, git_prompt: bool) -> Option<ShellIntegration> {
    if !osc133 && !git_prompt {
        return None;
    }
    let name = std::path::Path::new(shell_cmd)
        .file_stem()
        .map(|s| s.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    match name.as_str() {
        "pwsh" | "powershell" => {
            use base64::Engine as _;
            // -EncodedCommand takes base64 of UTF-16LE and sidesteps all argument quoting.
            let script = pwsh_integration(osc133, git_prompt);
            let utf16: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
            Some(ShellIntegration::Args(vec![
                "-NoExit".into(),
                "-EncodedCommand".into(),
                base64::engine::general_purpose::STANDARD.encode(utf16),
            ]))
        }
        "bash" => {
            let script = bash_prompt_command(osc133, git_prompt);
            Some(ShellIntegration::Env(vec![("PROMPT_COMMAND", script)]))
        }
        "wsl" => {
            let script = bash_prompt_command(osc133, git_prompt);
            let wslenv = match std::env::var("WSLENV") {
                Ok(v) if !v.is_empty() => format!("{v}:PROMPT_COMMAND/u"),
                _ => "PROMPT_COMMAND/u".into(),
            };
            Some(ShellIntegration::Env(vec![("PROMPT_COMMAND", script), ("WSLENV", wslenv)]))
        }
        _ => None,
    }
}

/// The program for a local shell name from the picker ("" means the default).
#[cfg_attr(mobile, allow(dead_code))]
pub(crate) fn resolve_local_shell(input: Option<&str>) -> (String, Vec<String>) {
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
    shell_integration_on: Option<bool>,
    git_prompt_on: Option<bool>,
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

    let (shell_cmd, shell_args) = resolve_local_shell(shell.as_deref());

    let mut cmd = CommandBuilder::new(&shell_cmd);
    for arg in &shell_args {
        cmd.arg(arg);
    }
    let osc133 = shell_integration_on.unwrap_or(false);
    let git_prompt = git_prompt_on.unwrap_or(false);
    if osc133 || git_prompt {
        match shell_integration(&shell_cmd, osc133, git_prompt) {
            Some(ShellIntegration::Args(args)) => args.iter().for_each(|a| cmd.arg(a)),
            Some(ShellIntegration::Env(vars)) => vars.iter().for_each(|(k, v)| cmd.env(k, v)),
            None => {}
        }
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

    // On Windows (ConPTY) the PTY reader does not hit EOF when the shell exits
    // while we still hold the master, so `exit` would leave the tab hanging.
    // Wait on the child directly and signal the pump loop when it ends.
    let mut killer = child.clone_killer();
    let (exit_tx, mut exit_rx) = tokio::sync::oneshot::channel::<()>();
    std::thread::spawn(move || {
        let _ = child.wait();
        let _ = exit_tx.send(());
    });

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
                _ = &mut exit_rx => {
                    // Shell exited: let the reader flush its last output, then close.
                    tokio::time::sleep(std::time::Duration::from_millis(150)).await;
                    while let Ok(data) = pty_out_rx.try_recv() {
                        out_buf.extend_from_slice(&data);
                    }
                    clean_exit = true;
                    send_terminal_batch(&output_channels, &terminal_id_clone, &mut out_buf).await;
                    break;
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

        let _ = killer.kill();

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
    _shell_integration_on: Option<bool>,
    _git_prompt_on: Option<bool>,
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

#[tauri::command]
pub fn set_host_key_policy(strict: bool) -> Result<(), String> {
    crate::ssh_manager::HOST_KEY_STRICT.store(strict, std::sync::atomic::Ordering::Relaxed);
    Ok(())
}

#[tauri::command]
pub fn set_ssh_connect_timeout(secs: u64) -> Result<(), String> {
    crate::commands::connection::SSH_CONNECT_TIMEOUT_SECS.store(secs.clamp(3, 120), std::sync::atomic::Ordering::Relaxed);
    Ok(())
}



#[cfg(test)]
mod shell_integration_tests {
    use super::*;

    #[test]
    fn hooks_powershell_bash_and_wsl() {
        use base64::Engine as _;
        let Some(ShellIntegration::Args(args)) = shell_integration("/usr/bin/pwsh", true, true) else { panic!("pwsh") };
        assert_eq!(&args[..2], ["-NoExit", "-EncodedCommand"]);
        let raw = base64::engine::general_purpose::STANDARD.decode(&args[2]).unwrap();
        let units: Vec<u16> = raw.chunks(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
        assert_eq!(String::from_utf16(&units).unwrap(), pwsh_integration(true, true));
        assert!(matches!(shell_integration("powershell.exe", true, true), Some(ShellIntegration::Args(_))));
        let Some(ShellIntegration::Env(vars)) = shell_integration("/bin/bash", true, true) else { panic!("bash") };
        assert_eq!(vars[0].0, "PROMPT_COMMAND");
        assert!(vars[0].1.contains("133;A;subterm=local"));
        assert!(vars[0].1.contains("__st_git"));
        let Some(ShellIntegration::Env(vars)) = shell_integration("wsl.exe", true, true) else { panic!("wsl") };
        assert!(vars.iter().any(|(k, v)| *k == "WSLENV" && v.ends_with("PROMPT_COMMAND/u")));
        assert!(shell_integration("cmd.exe", true, true).is_none());
        assert!(shell_integration("/usr/bin/zsh", true, true).is_none());

        // When git prompt is disabled, no git segment in pwsh or bash:
        let Some(ShellIntegration::Args(args_no_git)) = shell_integration("/usr/bin/pwsh", true, false) else { panic!("pwsh") };
        let raw = base64::engine::general_purpose::STANDARD.decode(&args_no_git[2]).unwrap();
        let units: Vec<u16> = raw.chunks(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
        let pwsh_no_git = String::from_utf16(&units).unwrap();
        assert!(pwsh_no_git.contains("133;A;subterm=local"));
        assert!(!pwsh_no_git.contains("__stGitSegment"));

        let Some(ShellIntegration::Env(bash_no_git)) = shell_integration("/bin/bash", true, false) else { panic!("bash") };
        assert!(bash_no_git[0].1.contains("133;A;subterm=local"));
        assert!(!bash_no_git[0].1.contains("__st_git"));

        // When both are off, no integration:
        assert!(shell_integration("/usr/bin/pwsh", false, false).is_none());
        assert!(shell_integration("/bin/bash", false, false).is_none());
    }

    /// Runs the real PROMPT_COMMAND in a scratch repository (where bash and git exist).
    #[cfg(unix)]
    #[test]
    fn bash_prompt_shows_the_git_segment() {
        use std::process::Command;
        let dir = std::env::temp_dir().join(format!("subterm-ps1-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let init = Command::new("git").args(["init", "-q", "-b", "main"]).current_dir(&dir).output();
        if !init.map(|o| o.status.success()).unwrap_or(false) { return; }
        std::fs::write(dir.join("a.txt"), "x").unwrap();
        let script = r#"PS1='\w\$ '; eval "$PROMPT_COMMAND" >/dev/null; printf '%s' "${PS1@P}""#;
        let Ok(out) = Command::new("bash").args(["--norc", "-c", script]).env("PROMPT_COMMAND", bash_prompt_command(true, true)).current_dir(&dir).output() else { return };
        let ps1 = String::from_utf8_lossy(&out.stdout);
        let name = dir.file_name().unwrap().to_string_lossy();
        assert!(ps1.contains(&format!("[{name}:main \u{25CF}1]")), "{ps1}");
        assert!(ps1.ends_with("$ "), "{ps1}");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
