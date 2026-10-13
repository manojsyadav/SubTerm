import { useState, useEffect, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ShieldCheck, Search, Trash2, RefreshCw, Copy, Check, Server, Key, AlertTriangle } from "lucide-react";
import { useConfirm } from "../ui/confirm";

export interface KnownHostRecord {
  id: number;
  host: string;
  port: number;
  fingerprint: string;
  key_type: string;
}

export function SettingsKnownHosts() {
  const confirm = useConfirm();
  const [hosts, setHosts] = useState<KnownHostRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [copiedId, setCopiedId] = useState<number | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const fetchKnownHosts = async () => {
    setLoading(true);
    setActionError(null);
    try {
      const data = await invoke<KnownHostRecord[]>("get_known_hosts");
      setHosts(data || []);
    } catch (e) {
      console.error("Failed to fetch known hosts:", e);
      setActionError(String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchKnownHosts();
  }, []);

  const filteredHosts = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return hosts;
    return hosts.filter(
      (h) =>
        h.host.toLowerCase().includes(q) ||
        String(h.port).includes(q) ||
        h.fingerprint.toLowerCase().includes(q) ||
        h.key_type.toLowerCase().includes(q)
    );
  }, [hosts, query]);

  const handleCopyFingerprint = async (id: number, fp: string) => {
    try {
      await navigator.clipboard.writeText(fp);
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 1500);
    } catch (err) {
      console.error("Copy failed", err);
    }
  };

  const handleDeleteHost = async (host: KnownHostRecord) => {
    const ok = await confirm({
      title: "Revoke Trusted Host Key?",
      message: `Are you sure you want to remove the trusted key for ${host.host}:${host.port}? SubTerm will prompt you to verify the host fingerprint on your next connection.`,
      destructive: true,
    });
    if (!ok) return;

    try {
      await invoke("delete_known_host", { id: host.id });
      setHosts((prev) => prev.filter((h) => h.id !== host.id));
    } catch (e) {
      setActionError(`Failed to delete host key: ${e}`);
    }
  };

  const handleClearAll = async () => {
    const ok = await confirm({
      title: "Clear All Known Hosts?",
      message: "This will remove all trusted SSH fingerprints from your encrypted vault. You will be prompted to verify host keys for all servers on subsequent connections.",
      destructive: true,
    });
    if (!ok) return;

    try {
      await invoke("clear_all_known_hosts");
      setHosts([]);
    } catch (e) {
      setActionError(`Failed to clear known hosts: ${e}`);
    }
  };

  return (
    <>
      {/* Header card */}
      <div className="bg-[#121215] border border-white/5 rounded-2xl p-6 shadow-xl break-inside-avoid">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center text-emerald-400 shrink-0">
              <ShieldCheck size={20} />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-bold text-white tracking-tight">
                  SSH Known Hosts & Fingerprints
                </h3>
                <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-emerald-500/10 border border-emerald-500/20 text-emerald-300 font-mono">
                  {hosts.length} trusted
                </span>
              </div>
              <p className="text-xs text-zinc-400 mt-0.5">
                Host keys trusted during SSH handshakes, and RDP certificates (type rdp-tls). Saved in your AES-256-GCM encrypted vault.
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={fetchKnownHosts}
              disabled={loading}
              title="Refresh known hosts"
              className="h-8 px-2.5 rounded-xl bg-white/[0.04] hover:bg-white/[0.08] border border-white/10 text-zinc-300 text-xs font-semibold flex items-center gap-1.5 transition-all"
            >
              <RefreshCw size={12} className={loading ? "animate-spin" : ""} />
              <span>Refresh</span>
            </button>
            {hosts.length > 0 && (
              <button
                onClick={handleClearAll}
                className="h-8 px-3 rounded-xl bg-rose-500/10 hover:bg-rose-500/20 border border-rose-500/20 text-rose-300 text-xs font-semibold flex items-center gap-1.5 transition-all"
              >
                <Trash2 size={12} />
                <span>Clear All</span>
              </button>
            )}
          </div>
        </div>

        {actionError && (
          <div className="mt-4 p-3 rounded-xl bg-rose-500/10 border border-rose-500/20 text-rose-300 text-xs flex items-center gap-2">
            <AlertTriangle size={14} className="shrink-0" />
            <span>{actionError}</span>
          </div>
        )}

        {/* Search filter */}
        <div className="mt-5 relative">
          <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500 pointer-events-none" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter by host, port, algorithm, or fingerprint..."
            className="w-full h-9 pl-8 pr-3 bg-black/40 border border-white/10 rounded-xl text-xs text-zinc-100 placeholder:text-zinc-600 outline-none focus:border-primary/40 font-mono transition-all"
          />
        </div>
      </div>

      {/* Table Card */}
      <div className="bg-[#121215] border border-white/5 rounded-2xl overflow-hidden shadow-xl break-inside-avoid">
        {filteredHosts.length === 0 ? (
          <div className="py-16 text-center px-4">
            <div className="w-12 h-12 rounded-2xl bg-white/[0.03] border border-white/5 flex items-center justify-center text-zinc-600 mx-auto mb-3">
              <Key size={20} />
            </div>
            <p className="text-xs font-medium text-zinc-400">
              {query ? `No known hosts match "${query}"` : "No trusted host keys recorded yet"}
            </p>
            <p className="text-[11px] text-zinc-600 mt-1 max-w-sm mx-auto">
              When you connect to an SSH server and verify its host key fingerprint, it will be automatically recorded here.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs border-collapse">
              <thead>
                <tr className="border-b border-white/5 bg-white/[0.02] text-[10px] font-bold uppercase tracking-wider text-zinc-400">
                  <th className="py-3 px-4">Host : Port</th>
                  <th className="py-3 px-4">Algorithm</th>
                  <th className="py-3 px-4">Fingerprint (SHA256)</th>
                  <th className="py-3 px-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5 font-mono text-[11px]">
                {filteredHosts.map((h) => (
                  <tr key={h.id} className="hover:bg-white/[0.02] transition-colors group">
                    <td className="py-3 px-4 font-semibold text-zinc-100 flex items-center gap-2">
                      <Server size={13} className="text-zinc-500 shrink-0" />
                      <span className="truncate max-w-[200px]" title={`${h.host}:${h.port}`}>
                        {h.host}:{h.port}
                      </span>
                    </td>
                    <td className="py-3 px-4">
                      <span className="px-2 py-0.5 rounded-md bg-white/[0.05] border border-white/10 text-zinc-300 text-[10px]">
                        {h.key_type || "ssh-ed25519"}
                      </span>
                    </td>
                    <td className="py-3 px-4">
                      <div className="flex items-center gap-2">
                        <span className="text-zinc-400 truncate max-w-[240px] sm:max-w-xs" title={h.fingerprint}>
                          {h.fingerprint}
                        </span>
                        <button
                          type="button"
                          onClick={() => handleCopyFingerprint(h.id, h.fingerprint)}
                          title="Copy fingerprint to clipboard"
                          className="p-1 rounded text-zinc-500 hover:text-white hover:bg-white/10 transition-colors shrink-0"
                        >
                          {copiedId === h.id ? (
                            <Check size={12} className="text-emerald-400" />
                          ) : (
                            <Copy size={12} />
                          )}
                        </button>
                      </div>
                    </td>
                    <td className="py-3 px-4 text-right">
                      <button
                        type="button"
                        onClick={() => handleDeleteHost(h)}
                        title="Revoke / Delete host key"
                        className="px-2.5 py-1 rounded-lg bg-white/[0.03] hover:bg-rose-500/20 text-zinc-400 hover:text-rose-300 border border-white/5 hover:border-rose-500/30 text-[11px] font-medium transition-all inline-flex items-center gap-1.5"
                      >
                        <Trash2 size={11} />
                        <span>Revoke</span>
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
