// Session diagnostics: the Info-panel's read-only probes (OS/network/ports/
// processes/services/docker overview), OS detection, iptables/nft chain
// inspection, and the systemctl/kill-process actions. All run over a fresh
// exec channel on the already-connected SSH session — none of this touches
// the interactive PTY.

use crate::ssh_manager::SshState;

// Read-only Info-panel probes. Each tab fetches its own section on first
// click — the user explicitly wanted lazy per-tab fetch instead of one
// upfront mega-probe. Splitting the scripts keeps each round-trip small
// (≤200 ms typical) and lets a failing section never block the others.
const INFO_SCRIPT_OVERVIEW: &str = r#"echo __SUB_INFO_OV_SEP__
hostname 2>/dev/null
echo __SUB_INFO_OV_SEP__
( . /etc/os-release 2>/dev/null && printf "%s" "$PRETTY_NAME" ) || cat /etc/issue 2>/dev/null
echo __SUB_INFO_OV_SEP__
uname -r 2>/dev/null
echo __SUB_INFO_OV_SEP__
uname -m 2>/dev/null
echo __SUB_INFO_OV_SEP__
uptime -p 2>/dev/null || uptime 2>/dev/null
echo __SUB_INFO_OV_SEP__
nproc 2>/dev/null || grep -c ^processor /proc/cpuinfo 2>/dev/null
echo __SUB_INFO_OV_SEP__
free -h 2>/dev/null
echo __SUB_INFO_OV_SEP__
df -h 2>/dev/null
echo __SUB_INFO_OV_SEP__
who 2>/dev/null
echo __SUB_INFO_OV_SEP__
cat /proc/loadavg 2>/dev/null
"#;

const INFO_SCRIPT_NETWORK: &str = r#"echo __SUB_INFO_NET_SEP__
ip -4 addr show 2>/dev/null || ifconfig 2>/dev/null
echo __SUB_INFO_NET_SEP__
ip route 2>/dev/null || route -n 2>/dev/null
echo __SUB_INFO_NET_SEP__
cat /etc/resolv.conf 2>/dev/null
echo __SUB_INFO_NET_SEP__
for t in filter nat mangle raw security; do
  OUT=$(iptables -t $t -n -L 2>/dev/null)
  if [ -z "$OUT" ]; then OUT=$(sudo -n iptables -t $t -n -L 2>/dev/null); fi
  if [ -n "$OUT" ]; then printf '__SUB_IPT_TABLE__%s\n%s\n' "$t" "$OUT"; fi
done
echo __SUB_INFO_NET_SEP__
if command -v nft >/dev/null 2>&1; then
  OUT=$(nft list ruleset 2>/dev/null)
  if [ -z "$OUT" ]; then OUT=$(sudo -n nft list ruleset 2>/dev/null); fi
  printf '%s' "$OUT"
fi
"#;

// The frontend parser (InfoPanel.tsx's `detectPortsEngine`) keys off a literal
// `ENGINE:<name>` line printed before the data — it has no other way to tell
// which columns `body` is in, or that neither tool exists at all.
const INFO_SCRIPT_PORTS: &str = r#"if command -v ss >/dev/null 2>&1; then
  echo "ENGINE:ss"
  ss -tulpn 2>/dev/null || sudo -n ss -tulpn 2>/dev/null
elif command -v netstat >/dev/null 2>&1; then
  echo "ENGINE:netstat"
  netstat -tulpn 2>/dev/null || sudo -n netstat -tulpn 2>/dev/null
else
  echo "ENGINE:none"
fi
"#;

// Same contract as above, via `PSFMT:<full|aux|none>` — `parseProcesses` reads
// the first line to know whether `comm` is in `full`'s 6-column position or
// `aux`'s, and `none` means `ps` isn't on this host at all (e.g. a
// procps-less minimal/Alpine image), not just that the preferred format failed.
const INFO_SCRIPT_PROCESSES: &str = r#"if ps -eo pid,user,pcpu,pmem,rss,comm >/dev/null 2>&1; then
  echo "PSFMT:full"
  ps -eo pid,user,pcpu,pmem,rss,comm --sort=-pcpu
elif ps aux >/dev/null 2>&1; then
  echo "PSFMT:aux"
  ps aux
else
  echo "PSFMT:none"
fi
"#;

// Same contract as above, via `ENGINE:<systemd|none>` — `parseServices` only
// knows how to read `systemctl list-units` columns, so a `service`-based
// fallback host (no systemd) is reported as unavailable rather than shown
// with the wrong column layout.
const INFO_SCRIPT_SERVICES: &str = r#"if command -v systemctl >/dev/null 2>&1; then
  echo "ENGINE:systemd"
  systemctl list-units --type=service --all --no-pager --no-legend 2>/dev/null
else
  echo "ENGINE:none"
fi
"#;

const INFO_SCRIPT_DOCKER: &str = r#"if ! command -v docker >/dev/null 2>&1; then
  echo __SUB_INFO_NODOCKER__
  exit 0
fi
docker ps -a --format '{{json .}}' 2>/dev/null
echo __SUB_INFO_DOCK_SEP__
docker volume ls --format '{{json .}}' 2>/dev/null
echo __SUB_INFO_DOCK_SEP__
docker images --format '{{json .}}' 2>/dev/null
echo __SUB_INFO_DOCK_SEP__
docker system df 2>/dev/null
"#;

#[derive(serde::Serialize, Default)]
pub(crate) struct InfoSectionResult {
    data: String,
    truncated: bool,
    exec_ms: u64,
}

// Run a script through a fresh exec channel on the live SSH session and
// return everything it printed (up to a 1 MB cap). Stays read-only — the
// callers in this module only invoke shell built-ins and inspection tools.
async fn run_info_script(
    state: &SshState,
    session_id: &str,
    script: &str,
    timeout_secs: u64,
) -> Result<InfoSectionResult, String> {
    use tokio::io::AsyncReadExt;
    use std::sync::Arc;

    let session_arc = {
        let connections = state.connections.lock().await;
        connections.get(session_id).map(Arc::clone)
            .ok_or_else(|| "Session not connected".to_string())?
    };

    let start = std::time::Instant::now();
    let channel = {
        let session = session_arc.lock().await;
        session.channel_open_session().await.map_err(|e| e.to_string())?
    };
    channel.exec(true, script.as_bytes()).await.map_err(|e| e.to_string())?;
    let mut stream = channel.into_stream();

    // 1 MB cap — defends the UI against pathological output (e.g. a server
    // with thousands of veth interfaces or hundreds of stopped containers).
    const MAX_BYTES: usize = 1024 * 1024;
    let mut buf: Vec<u8> = Vec::with_capacity(64 * 1024);
    let mut truncated = false;
    let read_fut = async {
        let mut tmp = [0u8; 8192];
        loop {
            match stream.read(&mut tmp).await {
                Ok(0) => break,
                Ok(n) => {
                    if buf.len() + n > MAX_BYTES {
                        let remaining = MAX_BYTES.saturating_sub(buf.len());
                        if remaining > 0 {
                            buf.extend_from_slice(&tmp[..remaining]);
                        }
                        truncated = true;
                        let mut sink = [0u8; 8192];
                        while stream.read(&mut sink).await.unwrap_or(0) > 0 {}
                        break;
                    }
                    buf.extend_from_slice(&tmp[..n]);
                }
                Err(_) => break,
            }
        }
    };
    tokio::time::timeout(std::time::Duration::from_secs(timeout_secs), read_fut)
        .await
        .map_err(|_| format!("probe timed out after {}s", timeout_secs))?;

    Ok(InfoSectionResult {
        data: String::from_utf8_lossy(&buf).into_owned(),
        truncated,
        exec_ms: start.elapsed().as_millis() as u64,
    })
}

#[tauri::command]
pub(crate) async fn ssh_info_probe_section(
    state: tauri::State<'_, SshState>,
    session_id: String,
    section: String,
) -> Result<InfoSectionResult, String> {
    let (script, timeout) = match section.as_str() {
        "overview" => (INFO_SCRIPT_OVERVIEW, 10u64),
        "network"  => (INFO_SCRIPT_NETWORK, 10u64),
        "ports"    => (INFO_SCRIPT_PORTS, 10u64),
        "processes" => (INFO_SCRIPT_PROCESSES, 10u64),
        "services" => (INFO_SCRIPT_SERVICES, 15u64),
        "docker"   => (INFO_SCRIPT_DOCKER, 20u64),
        other => return Err(format!("unknown info section: {}", other)),
    };
    run_info_script(&state, &session_id, script, timeout).await
}

#[tauri::command]
pub(crate) async fn detect_session_os(
    state: tauri::State<'_, SshState>,
    session_id: String,
) -> Result<serde_json::Value, String> {
    let probe = r#"if [ -f /etc/os-release ]; then echo "OSTYPE:linux"; grep -E '^(ID|VERSION_ID|PRETTY_NAME)=' /etc/os-release; uname -r 2>/dev/null; elif command -v uname >/dev/null 2>&1; then echo "OSTYPE:$(uname -s)"; uname -r 2>/dev/null; [ -f /etc/version ] && cat /etc/version; else echo "OSTYPE:windows"; cmd.exe /c "ver" 2>/dev/null; fi"#;
    let out = run_exec_capture(&state, &session_id, probe, 8).await.unwrap_or_default();
    // Windows OpenSSH runs cmd or PowerShell, where the sh probe above is a syntax error and
    // prints no OSTYPE line. cmd expands %OS% and PowerShell $env:OS, both to "Windows_NT"; sh
    // prints neither. (`cmd /c ver` breaks: sshd wraps it as cmd /c "cmd /c ver".)
    let out = if out.contains("OSTYPE:") {
        out
    } else {
        let os = run_exec_capture(&state, &session_id, "echo %OS% $env:OS", 8).await.unwrap_or_default();
        if os.contains("Windows_NT") { "OSTYPE:windows".to_string() } else { out }
    };
    Ok(parse_os_probe(&out))
}

/// The OS of a server from the detect_session_os probe output.
fn parse_os_probe(out: &str) -> serde_json::Value {
    let mut os_type = "linux".to_string();
    let mut distro = "Linux".to_string();
    let mut distro_id = "linux".to_string();
    let mut version = "".to_string();
    let mut kernel = "".to_string();

    for line in out.lines().map(str::trim) {
        if line.starts_with("OSTYPE:") {
            let val = line.trim_start_matches("OSTYPE:").to_lowercase();
            if val.contains("darwin") {
                os_type = "darwin".to_string();
                distro = "macOS".to_string();
                distro_id = "macos".to_string();
            } else if val.contains("bsd") {
                os_type = "bsd".to_string();
                distro = "FreeBSD".to_string();
                distro_id = "freebsd".to_string();
            } else if val.contains("windows") {
                os_type = "windows".to_string();
                distro = "Windows".to_string();
                distro_id = "windows".to_string();
            } else {
                os_type = "linux".to_string();
            }
        } else if line.starts_with("PRETTY_NAME=") {
            distro = line.trim_start_matches("PRETTY_NAME=").trim_matches('"').trim_matches('\'').to_string();
        } else if line.starts_with("ID=") {
            distro_id = line.trim_start_matches("ID=").trim_matches('"').trim_matches('\'').to_lowercase();
        } else if line.starts_with("VERSION_ID=") {
            version = line.trim_start_matches("VERSION_ID=").trim_matches('"').trim_matches('\'').to_string();
        } else if !line.is_empty() && !line.contains('=') && kernel.is_empty() && !line.starts_with("OSTYPE") {
            kernel = line.to_string();
        }
    }

    if distro.to_lowercase().contains("truenas") || distro_id.contains("truenas") {
        distro_id = "truenas".to_string();
        if distro.is_empty() || distro == "Linux" {
            distro = "TrueNAS".to_string();
        }
    }

    serde_json::json!({
        "os_type": os_type,
        "distro": distro,
        "distro_id": distro_id,
        "version": version,
        "kernel": kernel,
    })
}

#[tauri::command]
pub(crate) async fn get_session_telemetry(
    state: tauri::State<'_, SshState>,
    session_id: String,
) -> Result<serde_json::Value, String> {
    let probe = r#"if [ -f /proc/stat ]; then
  awk '
    /^cpu / { print "CPU_TOTAL:" ($2+$3+$4+$5+$6+$7+$8); print "CPU_IDLE:" ($5+$6); }
    /^MemTotal:/ { t=$2 } /^MemAvailable:/ { a=$2; ok=1 } /^MemFree:/ { f=$2 } /^Buffers:/ { b=$2 } /^Cached:/ { c=$2 }
    END { if (ok && t>0) printf "MEM_PERC:%.1f\n", ((t-a)/t)*100; else if (t>0) printf "MEM_PERC:%.1f\n", ((t-(f+b+c))/t)*100; }
  ' /proc/stat /proc/meminfo 2>/dev/null
  awk '{printf "LOAD:%.2f\n", $1}' /proc/loadavg 2>/dev/null
  for z in /sys/class/thermal/thermal_zone*/temp /sys/devices/virtual/thermal/thermal_zone*/temp; do
    if [ -r "$z" ]; then awk '{printf "TEMP:%.1f\n", $1/1000}' "$z" 2>/dev/null; break; fi
  done
elif command -v sysctl >/dev/null 2>&1; then
  top -l 1 -n 0 2>/dev/null | awk '/CPU usage:/ {sub(/%/, "", $3); printf "CPU_PERC:%.1f\n", $3} /PhysMem:/ {gsub(/[^0-9]/, "", $2); gsub(/[^0-9]/, "", $6); if ($2+$6>0) printf "MEM_PERC:%.1f\n", ($2/($2+$6))*100}'
fi"#;

    let out = run_exec_capture(&state, &session_id, probe, 5).await.unwrap_or_default();
    let mut cpu_total: Option<u64> = None;
    let mut cpu_idle: Option<u64> = None;
    let mut cpu_perc: Option<f64> = None;
    let mut mem_perc: Option<f64> = None;
    let mut load: Option<f64> = None;
    let mut temp_c: Option<f64> = None;

    for line in out.lines().map(str::trim) {
        if let Some(v) = line.strip_prefix("CPU_TOTAL:") {
            cpu_total = v.parse().ok();
        } else if let Some(v) = line.strip_prefix("CPU_IDLE:") {
            cpu_idle = v.parse().ok();
        } else if let Some(v) = line.strip_prefix("CPU_PERC:") {
            cpu_perc = v.parse().ok();
        } else if let Some(v) = line.strip_prefix("MEM_PERC:") {
            mem_perc = v.parse().ok();
        } else if let Some(v) = line.strip_prefix("LOAD:") {
            load = v.parse().ok();
        } else if let Some(v) = line.strip_prefix("TEMP:") {
            temp_c = v.parse().ok();
        }
    }

    Ok(serde_json::json!({
        "cpu_total": cpu_total,
        "cpu_idle": cpu_idle,
        "cpu_perc": cpu_perc,
        "mem_perc": mem_perc,
        "load": load,
        "temp_c": temp_c,
    }))
}

// Validate an iptables/nft table/chain identifier — strict allow-list.
// Chain names on real hosts are alphanumeric plus `-` `_` `.` and occasional
// `@`; anything else would risk shell injection when we splice into the
// command string. This function is the *only* thing keeping the below
// commands from executing arbitrary shell.
fn is_safe_fw_ident(s: &str) -> bool {
    if s.is_empty() || s.len() > 128 { return false; }
    s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | '@'))
}

// Two-stage firewall probe (lazy detail fetch). The network section returns
// a per-chain summary only; this command pulls the raw rules for one chain
// on user expand. Wire cost stays proportional to what the user actually
// looks at, not the size of the whole ruleset.
#[tauri::command]
pub(crate) async fn ssh_iptables_chain(
    state: tauri::State<'_, SshState>,
    session_id: String,
    table: String,
    chain: String,
) -> Result<String, String> {
    // Locked table allow-list; anything not here is rejected. Matches what
    // the probe script iterates over, plus `security` which some hardened
    // distros expose.
    if !matches!(table.as_str(), "filter" | "nat" | "mangle" | "raw" | "security") {
        return Err("invalid table".to_string());
    }
    if !is_safe_fw_ident(&chain) {
        return Err("invalid chain name".to_string());
    }
    // Retry with `sudo -n` when the direct call comes back empty — mirrors
    // the semantics of the summary probe so the expand behaves consistently
    // on hosts where only root can read the ruleset. `-v` adds the per-rule
    // `pkts`/`bytes` match-counter columns (human-readable K/M/G suffixes) so
    // the operator can see how much traffic each rule has actually handled.
    let cmd = format!(
        "OUT=$(iptables -t {t} -n -v -L {c} --line-numbers 2>/dev/null); \
if [ -z \"$OUT\" ]; then OUT=$(sudo -n iptables -t {t} -n -v -L {c} --line-numbers 2>/dev/null); fi; \
printf '%s' \"$OUT\"",
        t = table, c = chain
    );
    run_exec_capture(&state, &session_id, &cmd, 15).await
}

#[tauri::command]
pub(crate) async fn ssh_nft_chain(
    state: tauri::State<'_, SshState>,
    session_id: String,
    family: String,
    table: String,
    chain: String,
) -> Result<String, String> {
    if !matches!(family.as_str(), "ip" | "ip6" | "inet" | "arp" | "bridge" | "netdev") {
        return Err("invalid family".to_string());
    }
    if !is_safe_fw_ident(&table) || !is_safe_fw_ident(&chain) {
        return Err("invalid table or chain name".to_string());
    }
    let cmd = format!(
        "OUT=$(nft list chain {f} {t} {c} 2>/dev/null); \
if [ -z \"$OUT\" ]; then OUT=$(sudo -n nft list chain {f} {t} {c} 2>/dev/null); fi; \
printf '%s' \"$OUT\"",
        f = family, t = table, c = chain
    );
    run_exec_capture(&state, &session_id, &cmd, 15).await
}

#[derive(serde::Serialize)]
pub(crate) struct SystemctlActionResult {
    success: bool,
    exit_code: i32,
    stdout: String,
    stderr: String,
    used_sudo: bool,
}

async fn run_exec_capture_with_stdin(
    state: &SshState,
    session_id: &str,
    cmd: &str,
    timeout_secs: u64,
    stdin_data: Option<&str>,
) -> Result<String, String> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use std::sync::Arc;

    let session_arc = {
        let connections = state.connections.lock().await;
        connections.get(session_id).map(Arc::clone)
            .ok_or_else(|| "Session not connected".to_string())?
    };
    let channel = {
        let session = session_arc.lock().await;
        session.channel_open_session().await.map_err(|e| e.to_string())?
    };
    channel.exec(true, cmd.as_bytes()).await.map_err(|e| e.to_string())?;
    let mut stream = channel.into_stream();
    if let Some(input) = stdin_data {
        let _ = stream.write_all(input.as_bytes()).await;
        let _ = stream.flush().await;
    }
    let mut buf: Vec<u8> = Vec::with_capacity(4096);
    let read_fut = async {
        let mut tmp = [0u8; 4096];
        loop {
            match stream.read(&mut tmp).await {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if buf.len() + n > 64 * 1024 { break; }
                    buf.extend_from_slice(&tmp[..n]);
                }
            }
        }
    };
    tokio::time::timeout(std::time::Duration::from_secs(timeout_secs), read_fut)
        .await
        .map_err(|_| format!("exec timed out after {}s", timeout_secs))?;
    Ok(String::from_utf8_lossy(&buf).into_owned())
}

async fn run_exec_capture(
    state: &SshState,
    session_id: &str,
    cmd: &str,
    timeout_secs: u64,
) -> Result<String, String> {
    run_exec_capture_with_stdin(state, session_id, cmd, timeout_secs, None).await
}

fn parse_exit_marker(raw: &str) -> (i32, String) {
    if let Some(idx) = raw.rfind("__SUB_EXITCODE:") {
        let after = &raw[idx + "__SUB_EXITCODE:".len()..];
        let code = after.trim().split_whitespace().next().unwrap_or("1").parse().unwrap_or(1);
        let out = raw[..idx].trim_end_matches('\n').to_string();
        (code, out)
    } else {
        (1, raw.trim_end_matches('\n').to_string())
    }
}

#[tauri::command]
pub(crate) async fn ssh_systemctl_action(
    state: tauri::State<'_, SshState>,
    session_id: String,
    unit: String,
    action: String,
) -> Result<SystemctlActionResult, String> {
    // Locked allow-list. Anything not in this list is rejected outright
    // — we never want to dispatch arbitrary subcommands from the UI.
    let valid_action = matches!(action.as_str(), "start" | "stop" | "restart" | "reload" | "status");
    if !valid_action {
        return Err(format!("invalid action: {}", action));
    }
    // Reject hostile unit names. systemd unit names are restricted to
    // `[A-Za-z0-9:_.\\@-]+\.<suffix>` — adding any shell metachar here would
    // otherwise let the caller smuggle in a command.
    if unit.is_empty()
        || unit.len() > 256
        || !unit.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | '@' | ':' | '\\'))
    {
        return Err("invalid unit name".to_string());
    }

    // Try plain systemctl first (works if user is root or has polkit rules).
    // If that fails with permission-denied semantics, retry with `sudo -n` —
    // works on hosts that gave this user NOPASSWD sudo. The `-n` ensures we
    // never block on a tty password prompt that nobody can answer.
    let plain_cmd = format!("systemctl {} {} 2>&1; echo __SUB_EXITCODE:$?", action, unit);
    let raw1 = run_exec_capture(&state, &session_id, &plain_cmd, 30).await?;
    let (code1, out1) = parse_exit_marker(&raw1);
    let needs_sudo = code1 != 0 && (
        out1.contains("Interactive authentication required")
        || out1.contains("not authorized")
        || out1.contains("polkit")
        || out1.to_lowercase().contains("permission denied")
        || out1.to_lowercase().contains("access denied")
    );

    if code1 == 0 || !needs_sudo {
        return Ok(SystemctlActionResult {
            success: code1 == 0,
            exit_code: code1,
            stdout: out1,
            stderr: String::new(),
            used_sudo: false,
        });
    }

    let sudo_cmd = format!("sudo -n systemctl {} {} 2>&1; echo __SUB_EXITCODE:$?", action, unit);
    let raw2 = run_exec_capture(&state, &session_id, &sudo_cmd, 30).await?;
    let (mut code2, mut out2) = parse_exit_marker(&raw2);
    if code2 != 0 {
        let saved_password = {
            let pwds = state.session_passwords.lock().await;
            pwds.get(&session_id).cloned()
        };
        if let Some(pass) = saved_password {
            let sudo_stdin_cmd = format!("sudo -S -p '' systemctl {} {} 2>&1; echo __SUB_EXITCODE:$?", action, unit);
            let stdin_payload = format!("{}\n", pass);
            if let Ok(raw3) = run_exec_capture_with_stdin(&state, &session_id, &sudo_stdin_cmd, 30, Some(&stdin_payload)).await {
                let (code3, out3) = parse_exit_marker(&raw3);
                code2 = code3;
                out2 = out3;
            }
        }
    }
    Ok(SystemctlActionResult {
        success: code2 == 0,
        exit_code: code2,
        stdout: out2,
        stderr: String::new(),
        used_sudo: true,
    })
}

/// Signal a process by PID (Ports / Processes tab "kill" action). Tries the
/// user's own `kill` first, then `sudo -n kill` on a permission error — same
/// non-interactive sudo pattern as ssh_systemctl_action. Both the PID (a
/// validated i32) and the signal (an allow-listed name) are interpolated into
/// the shell command, so neither is attacker-controlled free text.
#[tauri::command]
pub(crate) async fn ssh_kill_process(
    state: tauri::State<'_, SshState>,
    session_id: String,
    pid: i32,
    signal: Option<String>,
) -> Result<SystemctlActionResult, String> {
    // Never signal PID <= 1 — that's init / the kernel and would be catastrophic.
    if pid <= 1 {
        return Err("refusing to signal PID <= 1".to_string());
    }
    let sig = signal.unwrap_or_else(|| "TERM".to_string());
    if !matches!(sig.as_str(), "TERM" | "KILL" | "HUP" | "INT") {
        return Err(format!("invalid signal: {}", sig));
    }

    let plain = format!("kill -{} {} 2>&1; echo __SUB_EXITCODE:$?", sig, pid);
    let raw1 = run_exec_capture(&state, &session_id, &plain, 15).await?;
    let (code1, out1) = parse_exit_marker(&raw1);
    let low = out1.to_lowercase();
    let needs_sudo = code1 != 0
        && (low.contains("not permitted")
            || low.contains("permission denied")
            || low.contains("operation not permitted"));

    if code1 == 0 || !needs_sudo {
        return Ok(SystemctlActionResult {
            success: code1 == 0,
            exit_code: code1,
            stdout: out1,
            stderr: String::new(),
            used_sudo: false,
        });
    }

    let sudo_cmd = format!("sudo -n kill -{} {} 2>&1; echo __SUB_EXITCODE:$?", sig, pid);
    let raw2 = run_exec_capture(&state, &session_id, &sudo_cmd, 15).await?;
    let (mut code2, mut out2) = parse_exit_marker(&raw2);
    if code2 != 0 {
        let saved_password = {
            let pwds = state.session_passwords.lock().await;
            pwds.get(&session_id).cloned()
        };
        if let Some(pass) = saved_password {
            let sudo_stdin_cmd = format!("sudo -S -p '' kill -{} {} 2>&1; echo __SUB_EXITCODE:$?", sig, pid);
            let stdin_payload = format!("{}\n", pass);
            if let Ok(raw3) = run_exec_capture_with_stdin(&state, &session_id, &sudo_stdin_cmd, 15, Some(&stdin_payload)).await {
                let (code3, out3) = parse_exit_marker(&raw3);
                code2 = code3;
                out2 = out3;
            }
        }
    }
    Ok(SystemctlActionResult {
        success: code2 == 0,
        exit_code: code2,
        stdout: out2,
        stderr: String::new(),
        used_sudo: true,
    })
}

/// Scale the whole UI (Settings > Appearance > Interface zoom). Uses the webview's own zoom
/// rather than CSS `zoom` so xterm's cell measurement and the fit addon stay correct.
#[tauri::command]
pub fn set_ui_zoom(webview_window: tauri::WebviewWindow, factor: f64) -> Result<(), String> {
    #[cfg(desktop)]
    {
        webview_window
            .set_zoom(factor.clamp(0.5, 2.0))
            .map_err(|e| format!("Could not set zoom: {e}"))
    }
    #[cfg(not(desktop))]
    {
        let _ = (webview_window, factor);
        Ok(())
    }
}

/// Whether SubTerm is registered to start when the user signs in (Settings > General). The OS owns
/// this state (Run key / LaunchAgent / autostart entry), so it is read live, not stored by the app.
#[tauri::command]
pub fn get_autostart(app: tauri::AppHandle) -> Result<bool, String> {
    #[cfg(desktop)]
    {
        use tauri_plugin_autostart::ManagerExt;
        app.autolaunch().is_enabled().map_err(|e| format!("Could not read the startup setting: {e}"))
    }
    #[cfg(not(desktop))]
    {
        let _ = app;
        Ok(false)
    }
}

#[tauri::command]
pub fn set_autostart(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    #[cfg(desktop)]
    {
        use tauri_plugin_autostart::ManagerExt;
        let launcher = app.autolaunch();
        let res = if enabled { launcher.enable() } else { launcher.disable() };
        res.map_err(|e| format!("Could not change the startup setting: {e}"))
    }
    #[cfg(not(desktop))]
    {
        let _ = (app, enabled);
        Err("Not available on this platform".into())
    }
}

#[cfg(test)]
mod os_probe_tests {
    use super::parse_os_probe;

    #[test]
    fn reads_linux_and_windows_hosts() {
        let linux = parse_os_probe("OSTYPE:linux\nID=ubuntu\nVERSION_ID=\"24.04\"\nPRETTY_NAME=\"Ubuntu 24.04 LTS\"\n6.8.0-45-generic\n");
        assert_eq!((linux["os_type"].as_str(), linux["distro_id"].as_str(), linux["version"].as_str()), (Some("linux"), Some("ubuntu"), Some("24.04")));
        let win = parse_os_probe("OSTYPE:windows");
        assert_eq!((win["os_type"].as_str(), win["distro"].as_str(), win["distro_id"].as_str()), (Some("windows"), Some("Windows"), Some("windows")));
    }
}
