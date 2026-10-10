import React, { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  X, Activity, Radio, Wifi, Shield, Server,
  CheckCircle2, XCircle, Clock, Play, RefreshCw, Zap
} from "lucide-react";

import type { Server as ServerRecord } from "../types";

type NetTab = "probe" | "multiscan" | "wol" | "knock";

export interface PortProbeResult {
  host: string;
  port: number;
  open: boolean;
  latency_ms: number;
  error?: string | null;
}

const COMMON_PORTS = [
  { port: 22, name: "SSH", desc: "Remote Shell / SFTP" },
  { port: 80, name: "HTTP", desc: "Web Server" },
  { port: 443, name: "HTTPS", desc: "Secure Web / SSL" },
  { port: 3389, name: "RDP", desc: "Remote Desktop" },
  { port: 5432, name: "PostgreSQL", desc: "Database" },
  { port: 3306, name: "MySQL", desc: "Database" },
  { port: 8080, name: "HTTP-Alt", desc: "App Server / Proxy" },
  { port: 6379, name: "Redis", desc: "Cache / Key-Value" },
];

export const NetworkToolsModal = ({
  isOpen,
  onClose,
  servers = [],
  initialHost = "",
}: {
  isOpen: boolean;
  onClose: () => void;
  servers?: Pick<ServerRecord, "id" | "name" | "host">[];
  initialHost?: string;
}) => {
  const [activeTab, setActiveTab] = useState<NetTab>("probe");
  const [host, setHost] = useState(initialHost || (servers[0]?.host || ""));
  const [port, setPort] = useState<number>(22);
  const [probing, setProbing] = useState(false);
  const [singleResult, setSingleResult] = useState<PortProbeResult | null>(null);

  // Multi-scan state
  const [scanning, setScanning] = useState(false);
  const [scanResults, setScanResults] = useState<PortProbeResult[]>([]);

  // WoL state
  const [macAddress, setMacAddress] = useState("");
  const [broadcastIp, setBroadcastIp] = useState("255.255.255.255");
  const [wolStatus, setWolStatus] = useState<string | null>(null);

  // Port knock state
  const [knockPorts, setKnockPorts] = useState("7000, 8000, 9000");
  const [knockStatus, setKnockStatus] = useState<string | null>(null);

  if (!isOpen) return null;

  const handleProbe = async () => {
    if (!host.trim()) return;
    setProbing(true);
    setSingleResult(null);
    try {
      const res = await invoke<PortProbeResult>("probe_tcp_port", {
        host: host.trim(),
        port: Number(port) || 22,
        timeoutMs: 3000,
      });
      setSingleResult(res);
    } catch (err) {
      setSingleResult({
        host: host.trim(),
        port: Number(port) || 22,
        open: false,
        latency_ms: 0,
        error: String(err),
      });
    } finally {
      setProbing(false);
    }
  };

  const handleScanCommon = async () => {
    if (!host.trim()) return;
    setScanning(true);
    setScanResults([]);
    try {
      const ports = COMMON_PORTS.map((p) => p.port);
      const res = await invoke<PortProbeResult[]>("batch_probe_ports", {
        host: host.trim(),
        ports,
        timeoutMs: 2000,
      });
      setScanResults(res);
    } catch (err) {
      console.error(err);
    } finally {
      setScanning(false);
    }
  };

  const handleSendWoL = async () => {
    if (!macAddress.trim()) return;
    setWolStatus("Sending magic packet…");
    try {
      await invoke("send_wake_on_lan", {
        macAddress: macAddress.trim(),
        broadcastIp: broadcastIp.trim() || null,
      });
      setWolStatus("Magic packet broadcasted successfully!");
    } catch (err) {
      setWolStatus(`WoL failed: ${err}`);
    }
  };

  const handlePortKnock = async () => {
    if (!host.trim()) return;
    setKnockStatus("Knocking ports sequence…");
    try {
      const ports = knockPorts
        .split(",")
        .map((s) => parseInt(s.trim(), 10))
        .filter((n) => !isNaN(n) && n > 0 && n <= 65535);
      await invoke("perform_port_knock", {
        host: host.trim(),
        ports,
        delayMs: 150,
      });
      setKnockStatus("Port knock sequence completed!");
    } catch (err) {
      setKnockStatus(`Knock failed: ${err}`);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[9999] bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 animate-in fade-in"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-xl bg-[#121215] border border-white/10 rounded-2xl shadow-2xl overflow-hidden flex flex-col font-sans text-xs"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-white/5 bg-white/[0.02]">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-sky-500/10 border border-sky-500/20 flex items-center justify-center text-sky-400">
              <Activity size={17} />
            </div>
            <div>
              <h2 className="text-sm font-bold text-white tracking-tight">Network Diagnostics & Tools</h2>
              <p className="text-[11px] text-zinc-400">Probe TCP latency, audit ports, or send Wake-on-LAN</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-lg text-zinc-400 hover:text-white hover:bg-white/5 transition-colors"
          >
            <X size={15} />
          </button>
        </div>

        {/* Tab switcher */}
        <div className="flex border-b border-white/5 bg-black/20 px-5 pt-2 gap-2">
          {([
            { id: "probe", label: "TCP Port Probe", icon: Activity },
            { id: "multiscan", label: "Service Audit", icon: RefreshCw },
            { id: "wol", label: "Wake-on-LAN", icon: Radio },
            { id: "knock", label: "Port Knocking", icon: Shield },
          ] as { id: NetTab; label: string; icon: typeof Activity }[]).map((tab) => {
            const Icon = tab.icon;
            const active = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`flex items-center gap-1.5 px-3 py-2 border-b-2 font-medium transition-colors ${
                  active
                    ? "border-sky-400 text-sky-300 bg-white/[0.02]"
                    : "border-transparent text-zinc-400 hover:text-zinc-200"
                }`}
              >
                <Icon size={13} />
                <span>{tab.label}</span>
              </button>
            );
          })}
        </div>

        {/* Body */}
        <div className="p-5 space-y-4 max-h-[70vh] overflow-y-auto custom-scrollbar">
          {/* Host input (shared for probe, multiscan, knock) */}
          {activeTab !== "wol" && (
            <div className="space-y-1.5">
              <label className="text-[11px] font-bold text-zinc-400 uppercase tracking-wider flex items-center justify-between">
                <span>Target Host or IP</span>
                {servers.length > 0 && (
                  <span className="text-zinc-500 font-normal lowercase">or pick from servers</span>
                )}
              </label>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={host}
                  onChange={(e) => setHost(e.target.value)}
                  placeholder="e.g. 192.168.1.100 or server.domain.com"
                  className="flex-1 h-9 px-3 bg-black/40 border border-white/10 rounded-lg text-white font-mono text-xs focus:border-sky-400/50 outline-none"
                />
                {servers.length > 0 && (
                  <select
                    onChange={(e) => {
                      if (e.target.value) setHost(e.target.value);
                    }}
                    className="h-9 px-2 bg-black/40 border border-white/10 rounded-lg text-zinc-300 text-xs focus:border-sky-400/50 outline-none"
                    defaultValue=""
                  >
                    <option value="" disabled>Saved Servers…</option>
                    {servers.map((s) => (
                      <option key={s.id} value={s.host}>
                        {s.name} ({s.host})
                      </option>
                    ))}
                  </select>
                )}
              </div>
            </div>
          )}

          {/* TAB 1: Single Port Probe */}
          {activeTab === "probe" && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <label className="text-[11px] font-bold text-zinc-400 uppercase tracking-wider">Port</label>
                  <input
                    type="number"
                    value={port}
                    onChange={(e) => setPort(parseInt(e.target.value, 10) || 22)}
                    className="w-full h-9 px-3 bg-black/40 border border-white/10 rounded-lg text-white font-mono text-xs focus:border-sky-400/50 outline-none"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-[11px] font-bold text-zinc-400 uppercase tracking-wider">Presets</label>
                  <select
                    value={port}
                    onChange={(e) => setPort(parseInt(e.target.value, 10))}
                    className="w-full h-9 px-2 bg-black/40 border border-white/10 rounded-lg text-zinc-300 text-xs focus:border-sky-400/50 outline-none"
                  >
                    {COMMON_PORTS.map((p) => (
                      <option key={p.port} value={p.port}>
                        {p.port} — {p.name} ({p.desc})
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <button
                onClick={handleProbe}
                disabled={probing || !host.trim()}
                className="w-full h-9 rounded-lg bg-sky-500 hover:bg-sky-400 disabled:opacity-50 text-zinc-950 font-bold flex items-center justify-center gap-2 transition-colors shadow-lg shadow-sky-500/10"
              >
                {probing ? <RefreshCw size={14} className="animate-spin" /> : <Play size={14} />}
                <span>{probing ? "Probing Port…" : "Probe Port & Measure Latency"}</span>
              </button>

              {/* Probe Result Card */}
              {singleResult && (
                <div
                  className={`p-4 rounded-xl border flex items-start gap-3 animate-in fade-in ${
                    singleResult.open
                      ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-200"
                      : "bg-rose-500/10 border-rose-500/30 text-rose-200"
                  }`}
                >
                  {singleResult.open ? (
                    <CheckCircle2 size={18} className="text-emerald-400 shrink-0 mt-0.5" />
                  ) : (
                    <XCircle size={18} className="text-rose-400 shrink-0 mt-0.5" />
                  )}
                  <div className="flex-1 space-y-1">
                    <div className="flex items-center justify-between">
                      <span className="font-bold text-[13px]">
                        {singleResult.open ? "Port Open & Reachable" : "Port Unreachable / Closed"}
                      </span>
                      <span className="font-mono text-xs font-semibold px-2 py-0.5 rounded bg-black/40 border border-white/10">
                        {singleResult.latency_ms} ms
                      </span>
                    </div>
                    <p className="text-[11px] opacity-80 font-mono">
                      {singleResult.host}:{singleResult.port}
                      {singleResult.error ? ` — ${singleResult.error}` : " — TCP handshake established"}
                    </p>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* TAB 2: Multi-port Audit */}
          {activeTab === "multiscan" && (
            <div className="space-y-4">
              <button
                onClick={handleScanCommon}
                disabled={scanning || !host.trim()}
                className="w-full h-9 rounded-lg bg-sky-500 hover:bg-sky-400 disabled:opacity-50 text-zinc-950 font-bold flex items-center justify-center gap-2 transition-colors shadow-lg shadow-sky-500/10"
              >
                {scanning ? <RefreshCw size={14} className="animate-spin" /> : <RefreshCw size={14} />}
                <span>{scanning ? "Scanning Services…" : "Audit Standard Ports (22, 80, 443, 3306, 5432…)"}</span>
              </button>

              {scanResults.length > 0 && (
                <div className="border border-white/5 rounded-xl overflow-hidden divide-y divide-white/5 bg-black/30">
                  {scanResults.map((res) => {
                    const preset = COMMON_PORTS.find((p) => p.port === res.port);
                    return (
                      <div key={res.port} className="flex items-center justify-between px-3.5 py-2.5">
                        <div className="flex items-center gap-2.5">
                          <span
                            className={`w-2 h-2 rounded-full ${
                              res.open ? "bg-emerald-400" : "bg-zinc-600"
                            }`}
                          />
                          <div>
                            <span className="font-bold font-mono text-white text-xs">{res.port}</span>
                            <span className="text-zinc-400 ml-2">
                              {preset?.name} ({preset?.desc})
                            </span>
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-[11px] text-zinc-400">{res.latency_ms} ms</span>
                          <span
                            className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider ${
                              res.open
                                ? "bg-emerald-500/20 text-emerald-300"
                                : "bg-zinc-800 text-zinc-400"
                            }`}
                          >
                            {res.open ? "Open" : "Closed"}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* TAB 3: Wake-on-LAN */}
          {activeTab === "wol" && (
            <div className="space-y-4">
              <div className="space-y-1.5">
                <label className="text-[11px] font-bold text-zinc-400 uppercase tracking-wider">
                  Target MAC Address
                </label>
                <input
                  type="text"
                  value={macAddress}
                  onChange={(e) => setMacAddress(e.target.value)}
                  placeholder="e.g. 00:11:22:33:44:55 or 00-11-22-33-44-55"
                  className="w-full h-9 px-3 bg-black/40 border border-white/10 rounded-lg text-white font-mono text-xs focus:border-sky-400/50 outline-none"
                />
              </div>

              <div className="space-y-1.5">
                <label className="text-[11px] font-bold text-zinc-400 uppercase tracking-wider">
                  Broadcast IP (optional)
                </label>
                <input
                  type="text"
                  value={broadcastIp}
                  onChange={(e) => setBroadcastIp(e.target.value)}
                  placeholder="255.255.255.255"
                  className="w-full h-9 px-3 bg-black/40 border border-white/10 rounded-lg text-white font-mono text-xs focus:border-sky-400/50 outline-none"
                />
              </div>

              <button
                onClick={handleSendWoL}
                disabled={!macAddress.trim()}
                className="w-full h-9 rounded-lg bg-sky-500 hover:bg-sky-400 disabled:opacity-50 text-zinc-950 font-bold flex items-center justify-center gap-2 transition-colors"
              >
                <Radio size={14} />
                <span>Send Magic Packet (Wake-on-LAN)</span>
              </button>

              {wolStatus && (
                <div className="p-3 bg-white/5 border border-white/10 rounded-lg text-zinc-300 font-mono text-xs">
                  {wolStatus}
                </div>
              )}
            </div>
          )}

          {/* TAB 4: Port Knocking */}
          {activeTab === "knock" && (
            <div className="space-y-4">
              <div className="space-y-1.5">
                <label className="text-[11px] font-bold text-zinc-400 uppercase tracking-wider">
                  Ports Knock Sequence
                </label>
                <input
                  type="text"
                  value={knockPorts}
                  onChange={(e) => setKnockPorts(e.target.value)}
                  placeholder="e.g. 7000, 8000, 9000"
                  className="w-full h-9 px-3 bg-black/40 border border-white/10 rounded-lg text-white font-mono text-xs focus:border-sky-400/50 outline-none"
                />
                <p className="text-[10px] text-zinc-500">
                  Sends rapid SYN packets to these ports in order to trigger firewall port-knocking daemons.
                </p>
              </div>

              <button
                onClick={handlePortKnock}
                disabled={!host.trim() || !knockPorts.trim()}
                className="w-full h-9 rounded-lg bg-sky-500 hover:bg-sky-400 disabled:opacity-50 text-zinc-950 font-bold flex items-center justify-center gap-2 transition-colors"
              >
                <Shield size={14} />
                <span>Execute Port Knock Sequence</span>
              </button>

              {knockStatus && (
                <div className="p-3 bg-white/5 border border-white/10 rounded-lg text-zinc-300 font-mono text-xs">
                  {knockStatus}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
