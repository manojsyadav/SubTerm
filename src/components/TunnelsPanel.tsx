import { useEffect, useRef, useState, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  Plus, X, Activity, AlertTriangle, Globe, ArrowRight,
  ArrowDownLeft, Square, FileText, Trash2, ExternalLink,
  RefreshCw, Radio, Zap, Check, ChevronDown, ChevronRight
} from "lucide-react";

// Tunnels panel — lists active SSH port-forwards for a session and lets the
// user start / stop them on the fly. The full set is also auto-started from
// the server's saved tunnel rules at connect time (see initiate_connection).

export interface DiscoveredPort {
  port: number;
  protocol: "tcp" | "udp";
  address: string;
  process?: string;
}

const COMMON_PORT_NAMES: Record<number, string> = {
  80: "HTTP Web Server",
  443: "HTTPS Web Server",
  1080: "SOCKS Proxy",
  3000: "Node / Dev Server",
  3306: "MySQL / MariaDB",
  5000: "Flask / Python API",
  5173: "Vite Dev Server",
  5432: "PostgreSQL Database",
  6379: "Redis Store",
  8000: "HTTP Dev Server",
  8080: "HTTP Alternate",
  8443: "HTTPS Alternate",
  9000: "Portainer / PHP-FPM",
  9090: "Prometheus",
  9200: "Elasticsearch",
  27017: "MongoDB Database",
};

interface TunnelStatus {
  id: string;
  session_id: string;
  kind: string;        // "dynamic" | "local" | "remote"
  listen_addr: string;
  target: string;
  state: string;       // "starting" | "listening" | "error" | "closed"
  error?: string;
  conns_total: number;
  conns_active: number;
  bytes_in: number;
  bytes_out: number;
}

interface TunnelLogEntry {
  tunnel_id: string;
  ts_ms: number;
  level: "info" | "warn" | "error";
  event: string;        // "listen" | "connect" | "close" | "fail" | "stop" | "shutdown"
  target?: string;
  peer?: string;
  message?: string;
}

// Cap the rolling log buffer so a chatty SOCKS proxy doesn't grow the array
// unbounded across a long session. 200 is enough to scroll back through the
// last few minutes of activity on a busy tunnel without burning React render
// time on a 10k-entry list.
const LOG_CAP = 200;

interface TunnelsPanelProps {
  sessionId: string;
  // The node this session belongs to. When present (> 0), tunnel add/remove is
  // persisted back to the node's saved rules so ad-hoc changes survive to the
  // next open. Absent/0 for quick-connect sessions with no saved node.
  serverId?: number;
  disabled?: boolean;
}

const KIND_TO_SPEC: Record<string, "D" | "L" | "R"> = {
  dynamic: "D", local: "L", remote: "R",
};

const TunnelsPanel = ({ sessionId, serverId, disabled = false }: TunnelsPanelProps) => {
  const [tunnels, setTunnels] = useState<Record<string, TunnelStatus>>({});
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<{ type: "D" | "L" | "R"; local: string; remote: string }>({
    type: "D", local: "1080", remote: "",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [logs, setLogs] = useState<TunnelLogEntry[]>([]);
  const [logsOpen, setLogsOpen] = useState(true);
  const [logFilter, setLogFilter] = useState<string | null>(null); // tunnel id, null = all
  const logScrollRef = useRef<HTMLDivElement>(null);
  const autoScrollRef = useRef(true);

  // Auto-discovery state
  const [scanning, setScanning] = useState(false);
  const [discoveredPorts, setDiscoveredPorts] = useState<DiscoveredPort[]>([]);
  const [discoveredExpanded, setDiscoveredExpanded] = useState(true);
  const [scanError, setScanError] = useState<string | null>(null);
  const [forwardingPort, setForwardingPort] = useState<number | null>(null);

  // Active local ports set for conflict detection
  const activeLocalPorts = useMemo(() => {
    const set = new Set<number>();
    for (const t of Object.values(tunnels)) {
      const p = t.listen_addr.includes(":") ? t.listen_addr.slice(t.listen_addr.lastIndexOf(":") + 1) : t.listen_addr;
      const num = parseInt(p, 10);
      if (!isNaN(num)) set.add(num);
    }
    return set;
  }, [tunnels]);

  const getNextFreePort = (startPort: number): number => {
    let p = startPort < 1024 ? 8080 : startPort;
    while (activeLocalPorts.has(p)) {
      p++;
    }
    return p;
  };

  const draftLocalPortNum = useMemo(() => {
    const pStr = draft.local.trim();
    const p = pStr.includes(":") ? pStr.slice(pStr.lastIndexOf(":") + 1) : pStr;
    const n = parseInt(p, 10);
    return isNaN(n) ? null : n;
  }, [draft.local]);

  const draftHasConflict = draftLocalPortNum !== null && activeLocalPorts.has(draftLocalPortNum);
  const suggestedPort = draftLocalPortNum !== null ? getNextFreePort(draftLocalPortNum + 1) : 8080;

  const scanRemotePorts = async () => {
    if (scanning || disabled) return;
    setScanning(true);
    setScanError(null);
    try {
      const cmd = "ss -tulpn 2>/dev/null || ss -tln 2>/dev/null || netstat -tulpn 2>/dev/null";
      const out = await invoke<string>("sftp_exec_command", { sessionId, command: cmd });
      const lines = out.split("\n");
      const found: DiscoveredPort[] = [];
      const seen = new Set<number>();

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) continue;
        const lower = line.toLowerCase();
        if (!lower.includes("listen") && !lower.includes("unconn")) continue;

        const isTcp = lower.startsWith("tcp");
        const isUdp = lower.startsWith("udp");
        if (!isTcp && !isUdp) continue;

        // Extract port and address
        const portMatch = line.match(/(?:(?:[0-9a-fA-F:\.]+|\*|\[[0-9a-fA-F:]+\])):(\d{2,5})\s+/);
        if (!portMatch) continue;
        const port = parseInt(portMatch[1], 10);
        if (isNaN(port) || port < 1 || port > 65535 || port === 22 || seen.has(port)) continue;

        const addrMatch = line.match(/([0-9a-fA-F:\.]+|\*|\[[0-9a-fA-F:]+\]):(\d{2,5})\s+/);
        const address = addrMatch ? addrMatch[1] : "0.0.0.0";

        let process: string | undefined;
        const ssProcMatch = line.match(/users:\(\("([^"]+)"/);
        if (ssProcMatch) {
          process = ssProcMatch[1];
        } else {
          const netstatProcMatch = line.match(/\d+\/([a-zA-Z0-9_\-\.]+)/);
          if (netstatProcMatch) {
            process = netstatProcMatch[1];
          }
        }

        seen.add(port);
        found.push({
          port,
          protocol: isTcp ? "tcp" : "udp",
          address,
          process: process || COMMON_PORT_NAMES[port],
        });
      }

      found.sort((a, b) => a.port - b.port);
      setDiscoveredPorts(found);
      setDiscoveredExpanded(true);
      if (found.length === 0) {
        setScanError("No open listening ports detected (or command requires sudo).");
      }
    } catch (err: any) {
      setScanError(`Scan failed: ${String(err)}`);
    } finally {
      setScanning(false);
    }
  };

  const forwardDiscoveredPort = async (discovered: DiscoveredPort) => {
    if (forwardingPort !== null || disabled) return;
    setForwardingPort(discovered.port);
    setError(null);
    const localPort = getNextFreePort(discovered.port);
    try {
      await invoke("start_tunnel", {
        sessionId,
        spec: {
          type: "L",
          local: String(localPort),
          remote: `127.0.0.1:${discovered.port}`,
        },
      });
      persistTunnels();
    } catch (e: any) {
      setError(`Failed to forward port ${discovered.port}: ${String(e)}`);
    } finally {
      setForwardingPort(null);
    }
  };

  const getExistingTunnelForPort = (port: number) => {
    return Object.values(tunnels).find(
      (t) => t.kind === "local" && (t.target === `127.0.0.1:${port}` || t.target === `localhost:${port}` || t.target.endsWith(`:${port}`))
    );
  };

  // Initial snapshot
  const reload = async () => {
    try {
      const list: TunnelStatus[] = await invoke("list_tunnels", { sessionId });
      const next: Record<string, TunnelStatus> = {};
      for (const t of list) next[t.id] = t;
      setTunnels(next);
    } catch (e: any) {
      setError(String(e));
    }
  };

  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // Live updates: every status transition (starting → listening, new
  // connection counted, error, closed) fires a per-session event.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    listen<TunnelStatus>(`tunnel-update-${sessionId}`, (event) => {
      const t = event.payload;
      if (!t || !t.id) return;
      setTunnels((prev) => {
        if (t.state === "closed") {
          const { [t.id]: _, ...rest } = prev;
          return rest;
        }
        return { ...prev, [t.id]: t };
      });
    }).then((fn) => { unlisten = fn; });
    return () => { if (unlisten) unlisten(); };
  }, [sessionId]);

  // Connection log: per-session stream of accepted / refused / closed
  // connections. Kept in a rolling buffer so the panel scrolls back through
  // recent activity without unbounded memory growth.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    listen<TunnelLogEntry>(`tunnel-log-${sessionId}`, (event) => {
      const entry = event.payload;
      if (!entry || !entry.tunnel_id) return;
      setLogs((prev) => {
        const next = prev.length >= LOG_CAP ? prev.slice(prev.length - LOG_CAP + 1) : prev.slice();
        next.push(entry);
        return next;
      });
    }).then((fn) => { unlisten = fn; });
    return () => { if (unlisten) unlisten(); };
  }, [sessionId]);

  // Auto-scroll to bottom when new logs come in — but only if the user
  // hasn't scrolled up to read older entries. Detect "user at bottom" by
  // checking the scroll position against the scroll height before pushing
  // the autoscroll.
  useEffect(() => {
    const el = logScrollRef.current;
    if (!el || !autoScrollRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [logs]);

  const onLogScroll = () => {
    const el = logScrollRef.current;
    if (!el) return;
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    autoScrollRef.current = dist < 32;
  };

  const addTunnel = async () => {
    if (busy) return;
    setBusy(true); setError(null);
    // Catch obvious port mistakes (0, 65536+, non-numeric tail) in the UI so
    // we don't roundtrip to Rust just to bind() and fail. Accepts bare port
    // ("8080") or host:port ("0.0.0.0:8080") for L/R; D always wants a bare
    // port. Targets are intentionally NOT pre-resolved — DNS is the backend's
    // problem.
    const localStr = draft.local.trim();
    const portPart = localStr.includes(":") ? localStr.slice(localStr.lastIndexOf(":") + 1) : localStr;
    const portNum = Number(portPart);
    if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
      setError(`Listen port must be between 1 and 65535 (got "${portPart}")`);
      setBusy(false);
      return;
    }
    if (draft.type !== "D") {
      const target = draft.remote.trim();
      const colonIdx = target.lastIndexOf(":");
      const targetPort = colonIdx > 0 ? Number(target.slice(colonIdx + 1)) : NaN;
      if (!target || colonIdx <= 0 || !Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65535) {
        setError(`Target must be host:port with a valid port (got "${target}")`);
        setBusy(false);
        return;
      }
    }
    try {
      await invoke("start_tunnel", {
        sessionId,
        spec: { type: draft.type, local: draft.local, remote: draft.remote },
      });
      setAdding(false);
      setDraft({ type: "D", local: "1080", remote: "" });
      // Save the new tunnel to the node so it comes back next time.
      persistTunnels();
      // The list updates via the live event — no manual reload needed.
    } catch (e: any) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  // Save the session's current tunnel set back to the node so ad-hoc changes
  // survive to the next open. No-op for quick-connect (no serverId); best-effort
  // (a save failure must never block the tunnel action the user just took).
  const persistTunnels = () => {
    if (!serverId || serverId <= 0) return;
    invoke("persist_session_tunnels", { sessionId, serverId }).catch(() => {});
  };

  const stopOne = async (id: string) => {
    try {
      await invoke("stop_tunnel", { tunnelId: id });
      // Persist the removal so a stopped tunnel doesn't return next open.
      persistTunnels();
    } catch (e: any) { setError(String(e)); }
  };

  const arr = Object.values(tunnels);

  return (
    <div className="flex-1 flex flex-col h-full bg-[#09090b] overflow-hidden relative">
      {disabled && (
        <div className="absolute inset-0 z-30 bg-black/55 backdrop-blur-[1px] flex items-center justify-center text-zinc-300 text-xs font-mono uppercase">
          <span className="px-3 py-1.5 bg-red-500/15 border border-red-500/30 rounded text-red-300">
            Session disconnected
          </span>
        </div>
      )}

      {/* Header: counts + scan + add button */}
      <div className="shrink-0 px-3 py-2 flex items-center justify-between border-b border-white/5 bg-[#121214]">
        <div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-widest text-zinc-400">
          <Activity size={12} />
          <span>{arr.length} {arr.length === 1 ? "tunnel" : "tunnels"}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            onClick={scanRemotePorts}
            disabled={scanning || disabled}
            title="Scan remote listening ports via SSH (ss / netstat)"
            className="h-6 px-2 rounded text-[10px] font-bold uppercase tracking-wider bg-white/[0.04] text-zinc-300 border border-white/10 hover:bg-white/10 hover:text-white flex items-center gap-1.5 disabled:opacity-50 transition-colors"
          >
            <RefreshCw size={11} className={scanning ? "animate-spin text-primary" : "text-zinc-400"} />
            <span>{scanning ? "Scanning…" : "Scan Remote"}</span>
          </button>
          <button
            onClick={() => { setAdding((a) => !a); setError(null); }}
            className="h-6 px-2.5 rounded text-[10px] font-bold uppercase tracking-wider bg-primary/15 text-primary border border-primary/30 hover:bg-primary/25 flex items-center gap-1.5"
          >
            {adding ? <X size={11} /> : <Plus size={11} />}
            <span>{adding ? "Cancel" : "Add"}</span>
          </button>
        </div>
      </div>

      {/* Discovered Remote Ports Section */}
      {(discoveredPorts.length > 0 || scanning || scanError) && (
        <div className="shrink-0 border-b border-white/5 bg-[#101014]">
          <div
            onClick={() => setDiscoveredExpanded(!discoveredExpanded)}
            className="px-3 py-1.5 flex items-center justify-between cursor-pointer hover:bg-white/[0.02] select-none"
          >
            <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-emerald-400">
              <Radio size={11} className={scanning ? "animate-pulse" : ""} />
              <span>Discovered Remote Ports ({discoveredPorts.length})</span>
            </div>
            <div className="text-zinc-500">
              {discoveredExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            </div>
          </div>
          {discoveredExpanded && (
            <div className="px-3 pb-2.5 pt-1 space-y-1.5 max-h-48 overflow-y-auto">
              {scanError && (
                <div className="text-[10px] font-mono text-amber-400/90 py-0.5">{scanError}</div>
              )}
              {discoveredPorts.map((dp) => {
                const existing = getExistingTunnelForPort(dp.port);
                const isForwardingThis = forwardingPort === dp.port;
                const localPortStr = existing ? (existing.listen_addr.includes(":") ? existing.listen_addr.split(":").pop() : existing.listen_addr) : null;
                return (
                  <div
                    key={`${dp.protocol}-${dp.port}`}
                    className="flex items-center justify-between gap-2 p-1.5 rounded bg-white/[0.02] border border-white/5 text-[11px] font-mono hover:border-white/10"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="px-1 py-0.5 rounded text-[9px] font-bold uppercase bg-emerald-500/10 text-emerald-300 border border-emerald-500/20 shrink-0">
                        {dp.protocol} {dp.port}
                      </span>
                      <div className="min-w-0 flex flex-col">
                        <span className="text-zinc-200 font-medium truncate">
                          {dp.process || "Unknown Service"}
                        </span>
                        <span className="text-[9px] text-zinc-500 truncate">
                          bind: {dp.address}
                        </span>
                      </div>
                    </div>

                    <div className="flex items-center gap-1.5 shrink-0">
                      {existing ? (
                        <div className="flex items-center gap-1">
                          <span className="px-1.5 py-0.5 rounded text-[9px] font-bold bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 flex items-center gap-1">
                            <Check size={9} /> :{localPortStr}
                          </span>
                          {existing.state === "listening" && (
                            <button
                              onClick={() => {
                                if (localPortStr) {
                                  invoke("open_external_url", { url: `http://localhost:${localPortStr}` }).catch(console.error);
                                }
                              }}
                              title={`Open http://localhost:${localPortStr} in browser`}
                              className="p-1 rounded text-zinc-400 hover:text-emerald-400 hover:bg-white/10"
                            >
                              <ExternalLink size={11} />
                            </button>
                          )}
                        </div>
                      ) : (
                        <button
                          onClick={() => forwardDiscoveredPort(dp)}
                          disabled={isForwardingThis || busy}
                          className="h-5 px-2 rounded text-[9.5px] font-bold uppercase tracking-wider bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 hover:bg-emerald-500/25 flex items-center gap-1 disabled:opacity-50"
                        >
                          <Zap size={10} />
                          <span>{isForwardingThis ? "Forwarding…" : "Forward"}</span>
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Add form — fields stacked top-to-bottom so the 1/3-width tool pane
          doesn't squeeze both inputs into illegible slivers. */}
      {adding && (
        <div className="shrink-0 p-3 border-b border-white/5 bg-[#0f0f12] space-y-2">
          <div className="flex items-center gap-2">
            <select
              value={draft.type}
              onChange={(e) => setDraft({ ...draft, type: e.target.value as "D" | "L" | "R" })}
              className="h-7 px-1.5 bg-white/[0.04] border border-white/10 rounded text-[11px] text-primary font-bold uppercase shrink-0"
            >
              <option value="D" className="bg-[#1a1a1e]">Dynamic</option>
              <option value="L" className="bg-[#1a1a1e]">Local</option>
              <option value="R" className="bg-[#1a1a1e]">Remote</option>
            </select>
            <input
              value={draft.local}
              onChange={(e) => setDraft({ ...draft, local: e.target.value })}
              placeholder={
                draft.type === "D" ? "Listen port (1080)" :
                draft.type === "L" ? "Local addr (8080 or 0.0.0.0:8080)" :
                                      "Server bind (8080 or 0.0.0.0:8080)"
              }
              className="flex-1 min-w-0 h-7 px-2 bg-white/[0.04] border border-white/10 rounded text-[11px] font-mono text-zinc-200"
            />
          </div>
          {draftHasConflict && (
            <div className="flex items-center justify-between gap-2 p-2 rounded bg-amber-500/10 border border-amber-500/30 text-amber-300 text-[10.5px] font-mono">
              <div className="flex items-center gap-1.5 min-w-0">
                <AlertTriangle size={12} className="shrink-0 text-amber-400" />
                <span className="truncate">Port {draftLocalPortNum} is already forwarded by an active tunnel.</span>
              </div>
              <button
                type="button"
                onClick={() => setDraft((d) => ({ ...d, local: String(suggestedPort) }))}
                className="px-2 py-0.5 rounded bg-amber-500/20 hover:bg-amber-500/30 text-amber-200 text-[10px] font-bold uppercase shrink-0 transition-colors"
              >
                Switch to {suggestedPort}
              </button>
            </div>
          )}
          {draft.type !== "D" && (
            <div className="flex items-center gap-2 pl-1">
              <ArrowRight size={12} className="text-zinc-500 shrink-0" />
              <input
                value={draft.remote}
                onChange={(e) => setDraft({ ...draft, remote: e.target.value })}
                placeholder={draft.type === "L" ? "Target host:port (eg intranet:80)" : "Local target host:port"}
                className="flex-1 min-w-0 h-7 px-2 bg-white/[0.04] border border-white/10 rounded text-[11px] font-mono text-zinc-200"
              />
            </div>
          )}
          <div className="flex items-start justify-between gap-2">
            <span className="text-[10px] text-zinc-500 font-mono flex-1 leading-snug">
              {draft.type === "D" && "SOCKS5 proxy on this machine; traffic exits via the server."}
              {draft.type === "L" && "Connections to your local addr are tunneled to the target through the server."}
              {draft.type === "R" && "Server listens on bind addr (defaults to 0.0.0.0); incoming connections are forwarded back here. Needs GatewayPorts in sshd_config to listen externally."}
            </span>
            <button
              onClick={addTunnel}
              disabled={busy}
              className="h-7 px-3 rounded text-[10px] font-bold uppercase tracking-wider bg-primary/15 text-primary border border-primary/30 hover:bg-primary/25 disabled:opacity-50 shrink-0"
            >
              {busy ? "…" : "Start"}
            </button>
          </div>
          {error && (
            <div className="text-[10.5px] text-rose-400 font-mono flex items-start gap-1.5">
              <AlertTriangle size={11} className="mt-0.5 shrink-0" /> <span className="break-words">{error}</span>
            </div>
          )}
        </div>
      )}

      {/* List */}
      <div className="flex-1 overflow-auto p-2 space-y-1.5">
        {arr.length === 0 ? (
          <div className="text-center py-12 text-zinc-500 text-[11px] font-mono">
            No active tunnels.<br />
            <span className="text-zinc-600 text-[10px]">Add one above, or define rules on the node.</span>
          </div>
        ) : (
          arr.map((t) => {
            const stateTone =
              t.state === "listening" ? "border-emerald-500/30 bg-emerald-950/30 text-emerald-300" :
              t.state === "starting"  ? "border-indigo-500/30 bg-indigo-950/30 text-indigo-300" :
              t.state === "error"     ? "border-rose-500/30 bg-rose-950/30 text-rose-300" :
                                        "border-white/10 bg-white/[0.03] text-zinc-400";
            const KindIcon = t.kind === "dynamic" ? Globe : t.kind === "remote" ? ArrowDownLeft : ArrowRight;
            return (
              <div key={t.id} className={`rounded border ${stateTone} p-2 font-mono text-[11px]`}>
                <div className="flex items-center gap-2">
                  <KindIcon size={12} className="shrink-0" />
                  <span className="font-bold uppercase tracking-wider text-[10px] opacity-80">{t.kind}</span>
                  <span className="text-zinc-300 truncate flex-1">{t.listen_addr}</span>
                  {t.kind !== "dynamic" && (
                    <>
                      <ArrowRight size={11} className="text-zinc-500 shrink-0" />
                      <span className="text-zinc-400 truncate flex-1">{t.target}</span>
                    </>
                  )}
                  <button
                    onClick={() => setLogFilter(logFilter === t.id ? null : t.id)}
                    title={logFilter === t.id ? "Show all tunnels in log" : "Filter log to this tunnel"}
                    className={`ml-1 p-0.5 rounded shrink-0 ${
                      logFilter === t.id
                        ? "bg-primary/20 text-primary"
                        : "text-zinc-400 hover:text-primary hover:bg-white/10"
                    }`}
                  >
                    <FileText size={11} />
                  </button>
                  {t.kind === "local" && t.state === "listening" && (
                    <button
                      onClick={() => {
                        const port = t.listen_addr.includes(":") ? t.listen_addr.split(":").pop() : t.listen_addr;
                        if (port) {
                          invoke("open_external_url", { url: `http://localhost:${port}` }).catch(console.error);
                        }
                      }}
                      title={`Open http://localhost:${t.listen_addr.includes(":") ? t.listen_addr.split(":").pop() : t.listen_addr} in browser`}
                      className="p-0.5 rounded shrink-0 text-zinc-400 hover:text-emerald-400 hover:bg-white/10"
                    >
                      <ExternalLink size={11} />
                    </button>
                  )}
                  <button
                    onClick={() => stopOne(t.id)}
                    title="Stop"
                    className="p-0.5 rounded hover:bg-white/10 text-zinc-400 hover:text-rose-400 shrink-0"
                  >
                    <Square size={11} />
                  </button>
                </div>
                <div className="mt-1 flex items-center gap-3 text-[10px] text-zinc-500">
                  <span className={`px-1.5 rounded ${
                    t.state === "listening" ? "bg-emerald-500/15 text-emerald-300" :
                    t.state === "starting"  ? "bg-indigo-500/15 text-indigo-300" :
                    t.state === "error"     ? "bg-rose-500/15 text-rose-300" :
                                              "bg-white/5 text-zinc-400"
                  }`}>
                    {t.state}
                  </span>
                  <span title="connections currently bridged / total accepted since start">
                    <span className={t.conns_active > 0 ? "text-emerald-300" : "text-zinc-500"}>
                      {t.conns_active}
                    </span>
                    <span className="opacity-50"> active</span>
                    <span className="opacity-30"> · </span>
                    <span>{t.conns_total} total</span>
                  </span>
                  {t.error && (
                    <span className="text-rose-400 truncate" title={t.error}>· {t.error}</span>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Activity log — rolling feed of connect / close / fail events across
          all tunnels in this session, or filtered to one via the row icon.
          Auto-scrolls to bottom unless the user has scrolled up to read
          older entries. */}
      <div className="shrink-0 border-t border-white/5 bg-[#0c0c0e]">
        <div className="px-3 py-1.5 flex items-center justify-between border-b border-white/5">
          <button
            onClick={() => setLogsOpen((o) => !o)}
            className="text-[10px] font-bold uppercase tracking-widest text-zinc-400 hover:text-zinc-200 flex items-center gap-1.5"
          >
            <FileText size={11} />
            <span>Log</span>
            <span className="text-zinc-600 font-normal">
              ({logFilter ? logs.filter((l) => l.tunnel_id === logFilter).length : logs.length})
            </span>
            {logFilter && (
              <span className="ml-1 px-1.5 rounded bg-primary/15 text-primary text-[9px]">filtered</span>
            )}
          </button>
          <div className="flex items-center gap-1">
            {logFilter && (
              <button
                onClick={() => setLogFilter(null)}
                title="Show all tunnels"
                className="px-1.5 text-[9px] uppercase tracking-wider text-zinc-500 hover:text-zinc-200"
              >
                Clear filter
              </button>
            )}
            <button
              onClick={() => setLogs([])}
              title="Clear log"
              className="p-1 text-zinc-500 hover:text-rose-400 rounded hover:bg-white/5"
            >
              <Trash2 size={11} />
            </button>
            <button
              onClick={() => setLogsOpen((o) => !o)}
              title={logsOpen ? "Collapse" : "Expand"}
              className="p-1 text-zinc-500 hover:text-zinc-200 rounded hover:bg-white/5"
            >
              {logsOpen ? <ArrowDownLeft size={11} className="rotate-90" /> : <ArrowDownLeft size={11} className="-rotate-90" />}
            </button>
          </div>
        </div>
        {logsOpen && (
          <div
            ref={logScrollRef}
            onScroll={onLogScroll}
            className="h-40 overflow-auto px-2 py-1 font-mono text-[10.5px] leading-relaxed space-y-0.5"
          >
            {(() => {
              const visible = logFilter ? logs.filter((l) => l.tunnel_id === logFilter) : logs;
              if (visible.length === 0) {
                return (
                  <div className="text-zinc-600 text-center py-4">
                    No log entries {logFilter ? "for this tunnel" : "yet"}.
                  </div>
                );
              }
              return visible.map((l, i) => {
                const ts = new Date(l.ts_ms);
                const hh = String(ts.getHours()).padStart(2, "0");
                const mm = String(ts.getMinutes()).padStart(2, "0");
                const ss = String(ts.getSeconds()).padStart(2, "0");
                const tone =
                  l.level === "error" ? "text-rose-300" :
                  l.level === "warn"  ? "text-amber-300" :
                                        "text-zinc-400";
                const eventTone =
                  l.event === "fail"    ? "bg-rose-500/15 text-rose-300" :
                  l.event === "connect" ? "bg-emerald-500/15 text-emerald-300" :
                  l.event === "close"   ? "bg-white/5 text-zinc-500" :
                  l.event === "listen"  ? "bg-indigo-500/15 text-indigo-300" :
                  l.event === "stop" || l.event === "shutdown"
                                        ? "bg-amber-500/15 text-amber-300" :
                                          "bg-white/5 text-zinc-500";
                return (
                  <div key={i} className="flex items-start gap-1.5">
                    <span className="text-zinc-600 shrink-0">{hh}:{mm}:{ss}</span>
                    <span className={`px-1 rounded text-[9px] uppercase font-bold shrink-0 ${eventTone}`}>
                      {l.event}
                    </span>
                    <span className={`flex-1 break-all ${tone}`}>
                      {l.target && <span className="text-zinc-200">{l.target}</span>}
                      {l.peer && <span className="text-zinc-600"> ← {l.peer}</span>}
                      {l.message && (
                        <span className={l.target || l.peer ? "text-zinc-500 ml-1" : ""}>
                          {l.target || l.peer ? "· " : ""}{l.message}
                        </span>
                      )}
                    </span>
                  </div>
                );
              });
            })()}
          </div>
        )}
      </div>
    </div>
  );
};

export default TunnelsPanel;
