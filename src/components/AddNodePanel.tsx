import { useState, useEffect } from "react";
import { useFeatureFlag } from "../featureFlags";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { Cpu, X, ArrowLeftRight, Shield, ShieldAlert, User, FolderPlus, Download, CheckSquare, Square, History, Zap, Radio, Server, HardDrive, Box, Database, Cloud, Wifi, Monitor, Terminal, Plus } from "lucide-react";
import PasswordField from "./PasswordField";
import { useTextPrompt } from "../ui/confirm";
import type { Server as ServerRecord, Folder, Credential, SshKey } from "../types";

// Compact "2h ago" style relative time for the attribution line.
function relTime(d: Date): string {
  const s = Math.floor((Date.now() - d.getTime()) / 1000);
  if (s < 45) return "just now";
  const m = Math.floor(s / 60); if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`;
  const dd = Math.floor(h / 24); if (dd < 30) return `${dd}d ago`;
  return d.toLocaleDateString();
}

// The HLC stamp is "{phys_ms}:{counter}:{node_id}" — the leading segment is the
// wall-clock millisecond the row was last written.
function hlcTime(stamp?: string | null): Date | null {
  if (!stamp) return null;
  const ms = parseInt(String(stamp).split(":")[0], 10);
  return Number.isFinite(ms) && ms > 0 ? new Date(ms) : null;
}

// Shape returned by the `parse_ssh_config` backend command. One entry per
// non-wildcard alias resolved from the user's OpenSSH config.
type ImportedHost = {
  host_alias: string;
  hostname: string;
  port: number;
  user: string;
  identity_file: string | null;
  proxy_jump: string | null;
};

// Best-effort message from a caught value (Tauri rejects with plain strings).
function errMessage(e: unknown): string {
  if (typeof e === "string") return e;
  const m = (e as { message?: unknown } | null | undefined)?.message;
  return (m as string) || String(e);
}

export interface TunnelDraft {
  /** Stable per-row id used as the React key. */
  rid?: string;
  local: string;
  remote: string;
  type: string;
}

export interface MirrorDraft {
  local: string;
  remote: string;
  soft_delete: boolean;
  excludes: string[];
  conflict_resolution: string;
}

/** Form state for the add/edit server panel. */
export interface NodeFormState {
  id: number | null;
  name: string;
  host: string;
  port: number;
  username: string;
  password: string;
  authType: string;
  credentialId: string;
  folderId: string;
  keyId: string;
  proxyType: string;
  proxyHost: string;
  proxyPort: number;
  tunnels: TunnelDraft[];
  autostart: boolean;
  mirrors: MirrorDraft[];
  color: string | null;
  notes: string;
  runOnConnect: string;
  jumpHostId: string;
  editedBy: string | null;
  updatedAt: string | null;
  password_dirty: boolean;
  is_production: boolean;
  icon: string;
  forward_agent: boolean;
  /** "ssh" (default) or "rdp" - RDP servers launch the system Remote Desktop client. */
  protocol?: string;
  wol_mac?: string;
  knock_ports?: string;
}

interface AddNodePanelProps {
  isOpen: boolean;
  onClose: () => void;
  newNode: NodeFormState;
  setNewNode: React.Dispatch<React.SetStateAction<NodeFormState>>;
  onSave: () => void;
  credentials?: Credential[];
  sshKeys?: SshKey[];
  refreshSshKeys?: () => void | Promise<unknown>;
  folders?: Folder[];
  refreshFolders: () => void | Promise<unknown>;
  refreshServers?: () => void | Promise<unknown>;
  servers?: ServerRecord[];
  isEditMode?: boolean;
  formError?: string;
  isMobile?: boolean;
  initialImportOpen?: boolean;
}

const AddNodePanel = ({ isOpen, onClose, newNode, setNewNode, onSave, credentials, sshKeys, refreshSshKeys, folders, refreshFolders, refreshServers, servers, isEditMode, formError, isMobile, initialImportOpen }: AddNodePanelProps) => {
  const textPrompt = useTextPrompt();
  const rdpEnabled = useFeatureFlag("rdpServers");
  const isRdp = newNode.protocol === "rdp";
  // Switching connection type also swaps the stock port (22 <-> 3389) unless the
  // user already typed a custom one, and RDP keeps no SSH key / saved-login link.
  const switchProtocol = (next: "ssh" | "rdp") => {
    if (next === (isRdp ? "rdp" : "ssh")) return;
    setNewNode((n) => ({
      ...n,
      protocol: next,
      port: next === "rdp" ? (n.port === 22 ? 3389 : n.port) : (n.port === 3389 ? 22 : n.port),
      ...(next === "rdp" ? { authType: "custom_pass", credentialId: "", keyId: "", password: "" } : {}),
    }));
  };
  const [isCreatingFolder, setIsCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");

  const [wolBusy, setWolBusy] = useState(false);
  const [wolStatus, setWolStatus] = useState<string | null>(null);
  const [knockBusy, setKnockBusy] = useState(false);
  const [knockStatus, setKnockStatus] = useState<string | null>(null);

  // SSH-config import modal state. Lives here so it's colocated with the
  // "Add server" flow — the button that triggers it sits in this panel's
  // header. `hosts` is the raw list returned by parse_ssh_config; `selected`
  // is the subset of aliases the user ticked; `busy` blocks the import
  // button while add_server calls are inflight so the user can't double-fire.
  const [importOpen, setImportOpen] = useState(false);
  const [importLoading, setImportLoading] = useState(false);
  const [importBusy, setImportBusy] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [importHosts, setImportHosts] = useState<ImportedHost[]>([]);
  const [importSelected, setImportSelected] = useState<Set<string>>(new Set());
  // Source selector for the import modal. `ssh` = the on-disk OpenSSH
  // config (desktop only); `paste` = a text blob pasted from PuTTY /
  // MobaXterm / a JSON export — parsed by the auto-detecting Rust
  // command so the user doesn't have to say which client it came from.
  const [importSource, setImportSource] = useState<"ssh" | "paste">("ssh");
  const [importPasteText, setImportPasteText] = useState("");

  // Open the picker: fetch fresh from ~/.ssh/config every time so users who
  // edit the file between imports see current contents. We keep the modal
  // open on empty results so the user gets an explicit "nothing to import"
  // message rather than a silent no-op.
  // Open the modal and immediately try the SSH-config path — that's the
  // most common source on desktop. If it errors (Android, no config file,
  // permissions), the user just switches to the "Paste" tab and drops in
  // their PuTTY/MobaXterm/JSON export instead.
  const openImportModal = async () => {
    setImportOpen(true);
    setImportSource("ssh");
    setImportPasteText("");
    setImportError(null);
    setImportHosts([]);
    setImportSelected(new Set());
    setImportLoading(true);
    try {
      const hosts = await invoke<ImportedHost[]>("parse_ssh_config", { path: null });
      setImportHosts(hosts);
    } catch (e: unknown) {
      setImportError(errMessage(e));
    } finally {
      setImportLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen && initialImportOpen) {
      openImportModal();
    }
  }, [isOpen, initialImportOpen]);

  // Parse whatever's in the textarea. Rust auto-detects the format so we
  // don't need three separate importers here.
  const parsePastedImport = async () => {
    setImportLoading(true);
    setImportError(null);
    setImportHosts([]);
    setImportSelected(new Set());
    try {
      const hosts = await invoke<ImportedHost[]>("parse_client_import", { text: importPasteText });
      setImportHosts(hosts);
    } catch (e: unknown) {
      setImportError(errMessage(e));
    } finally {
      setImportLoading(false);
    }
  };

  const switchImportSource = async (next: "ssh" | "paste") => {
    if (importBusy || importSource === next) return;
    setImportSource(next);
    setImportError(null);
    setImportHosts([]);
    setImportSelected(new Set());
    if (next === "ssh") {
      setImportLoading(true);
      try {
        const hosts = await invoke<ImportedHost[]>("parse_ssh_config", { path: null });
        setImportHosts(hosts);
      } catch (e: unknown) {
        setImportError(errMessage(e));
      } finally {
        setImportLoading(false);
      }
    }
  };

  const closeImportModal = () => {
    if (importBusy) return;
    setImportOpen(false);
    setImportError(null);
    setImportHosts([]);
    setImportSelected(new Set());
    setImportPasteText("");
  };

  const toggleSelectAll = () => {
    if (importSelected.size === importHosts.length) {
      setImportSelected(new Set());
    } else {
      setImportSelected(new Set(importHosts.map((h) => h.host_alias)));
    }
  };

  const toggleOne = (alias: string) => {
    setImportSelected((prev) => {
      const next = new Set(prev);
      if (next.has(alias)) next.delete(alias);
      else next.add(alias);
      return next;
    });
  };

  // Fire one `add_server` per selected host. We use auth_type "custom_pass"
  // with empty password so the row is valid but non-connecting until the
  // user edits it — matches the spec that key/password stay unset. Errors
  // per-host are surfaced but don't abort the batch; the modal shows how
  // many landed and how many failed.
  const importSelectedHosts = async () => {
    if (importSelected.size === 0 || importBusy) return;
    setImportBusy(true);
    setImportError(null);
    let ok = 0;
    let failed = 0;
    let lastErr: string | null = null;
    for (const host of importHosts) {
      if (!importSelected.has(host.host_alias)) continue;
      try {
        await invoke<number>("add_server", {
          name: host.host_alias,
          host: host.hostname || host.host_alias,
          port: host.port || 22,
          username: (host.user && host.user.trim()) ? host.user.trim() : "root",
          password: null,
          credentialId: null,
          folderId: null,
          proxyType: "none",
          proxyHost: "",
          proxyPort: 1080,
          tunnels: [],
          authType: "custom_pass",
          keyId: null,
          autostart: false,
          mirrors: [],
          color: null,
        });
        ok++;
      } catch (e: unknown) {
        failed++;
        lastErr = errMessage(e);
      }
    }
    setImportBusy(false);
    if (failed > 0) {
      setImportError(`${ok} imported, ${failed} failed${lastErr ? `: ${lastErr}` : ""}`);
    }
    if (refreshServers) {
      try { await refreshServers(); } catch { /* refresh failure isn't fatal */ }
    }
    if (failed === 0) {
      closeImportModal();
    }
  };

  const handleCreateFolder = async () => {
    if (!newFolderName.trim()) return;
    try {
      await invoke("add_folder", { name: newFolderName, parentId: null });
      setNewFolderName("");
      setIsCreatingFolder(false);
      refreshFolders();
    } catch (e) {
      console.error(e);
    }
  };

  const updateTunnel = (idx: number, field: "local" | "remote" | "type", value: string) => {
    const newT = [...newNode.tunnels];
    newT[idx][field] = value;
    setNewNode({ ...newNode, tunnels: newT });
  };

  return (
    <div className={`fixed inset-0 z-50 transition-all duration-500 flex justify-end ${isOpen ? 'bg-black/60 backdrop-blur-sm' : 'opacity-0 pointer-events-none'}`} onClick={onClose}>
      <div className={`w-full ${isMobile ? 'max-w-full' : 'max-w-[450px]'} bg-background border-l border-white/5 shadow-2xl transition-all duration-500 h-full flex flex-col ${isOpen ? 'translate-x-0' : 'translate-x-full'}`} onClick={(e) => e.stopPropagation()}>

        {/* Header */}
        <div className="flex justify-between items-center p-6 border-b border-white/5 shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 bg-primary/10 rounded-lg flex items-center justify-center text-primary shadow-inner border border-primary/20">
              <Cpu size={16} />
            </div>
            <h2 className="text-[14px] font-bold text-white tracking-tight">Server details</h2>
          </div>
          <div className="flex items-center gap-2">
            {/* Import only makes sense when creating a fresh row — editing an
                existing server is a rename/reconfigure flow, not an import.
                Available on Android now that the modal supports a "Paste
                PuTTY / MobaXterm / JSON" source that doesn't need a local
                ~/.ssh/config. The SSH-config tab still errors gracefully
                there — the user just picks the paste tab. */}
            {!isEditMode && (
              <button
                onClick={openImportModal}
                title="Import from ~/.ssh/config"
                className="h-8 px-2.5 flex items-center gap-1.5 text-[11px] font-bold text-primary bg-primary/10 border border-primary/30 hover:bg-primary/20 rounded-xl transition-all"
              >
                <Download size={12} />
                <span className="hidden sm:inline">Import from ~/.ssh/config</span>
                <span className="sm:hidden">Import</span>
              </button>
            )}
            <button onClick={onClose} className="w-8 h-8 flex items-center justify-center text-zinc-500 hover:text-white bg-black border border-white/5 hover:bg-white/10 rounded-xl transition-all shadow-inner">
              <X size={16} />
            </button>
          </div>
        </div>

        {/* Scrollable Content */}
        <div className="p-6 flex-1 overflow-y-auto custom-scrollbar space-y-6">
          {formError && <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-xl text-red-500 text-[12px] font-bold">{formError}</div>}

          <div className="grid grid-cols-1 gap-4">
            <div className="space-y-1.5">
              <label className="text-[11px] font-bold text-zinc-400 ml-1">Name</label>
              <input type="text" className="w-full h-9 bg-[#1a1a1e] rounded-lg px-3 text-[12px] text-white border border-white/10 outline-none focus:border-primary/50 focus:bg-[#232328] transition-all shadow-inner" placeholder="e.g. Work server" value={newNode.name} onChange={e => setNewNode({ ...newNode, name: e.target.value })} />
            </div>

            {(rdpEnabled || isRdp) && (
              <div className="space-y-1.5">
                <label className="text-[11px] font-bold text-zinc-400 ml-1">Connection type</label>
                <div role="radiogroup" aria-label="Connection type" className="inline-flex rounded-lg border border-white/10 overflow-hidden">
                  {([
                    { id: "ssh", label: "SSH / SFTP" },
                    { id: "rdp", label: "Remote Desktop (RDP)" },
                  ] as const).map((o) => {
                    const on = (isRdp ? "rdp" : "ssh") === o.id;
                    return (
                      <button
                        key={o.id}
                        type="button"
                        role="radio"
                        aria-checked={on}
                        onClick={() => switchProtocol(o.id)}
                        className={`h-8 px-3 text-[11px] font-semibold transition-all ${on ? "bg-primary/20 text-primary" : "bg-[#1a1a1e] text-zinc-400 hover:text-zinc-200"}`}
                      >
                        {o.label}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            <div className="space-y-1.5">
              <label className="text-[11px] font-bold text-zinc-400 ml-1">Folder</label>
              {!isCreatingFolder ? (
                <div className="flex gap-2">
                  <select className="flex-1 h-9 bg-[#1a1a1e] rounded-lg px-3 text-[12px] text-white border border-white/10 outline-none focus:border-primary/50 focus:bg-[#232328] transition-all shadow-inner" value={newNode.folderId} onChange={e => setNewNode({ ...newNode, folderId: e.target.value })}>
                    <option value="" className="bg-[#1a1a1e] text-zinc-500">-- Root --</option>
                    {folders?.map((f) => <option key={f.id} value={f.id.toString()} className="bg-[#1a1a1e] text-white">{f.name}</option>)}
                  </select>
                  <button onClick={() => setIsCreatingFolder(true)} className="w-9 h-9 bg-white/5 border border-white/10 rounded-lg text-primary hover:bg-white/10 transition-all flex items-center justify-center shrink-0">
                    <FolderPlus size={14} />
                  </button>
                </div>
              ) : (
                <div className="flex gap-2 animate-in fade-in">
                  <input type="text" className="flex-1 h-9 bg-[#1a1a1e] rounded-lg px-3 text-[12px] text-white border border-white/10 outline-none focus:border-primary/50 transition-all shadow-inner" placeholder="Folder name…" value={newFolderName} onChange={e => setNewFolderName(e.target.value)} onKeyDown={e => e.key === 'Enter' && handleCreateFolder()} />
                  <button onClick={handleCreateFolder} className="h-9 px-3 bg-primary text-black font-bold text-[12px] rounded-lg hover:bg-primary transition-all">Add</button>
                  <button onClick={() => setIsCreatingFolder(false)} className="w-9 h-9 bg-white/5 text-zinc-400 rounded-lg hover:bg-white/10 transition-all flex justify-center items-center shrink-0"><X size={14} /></button>
                </div>
              )}
            </div>

            <div className="space-y-1.5">
              <label className="text-[11px] font-bold text-zinc-400 ml-1">Node Icon & Type</label>
              <div className="flex items-center gap-1.5 flex-wrap">
                {[
                  { id: "server",   label: "Server",     icon: Server },
                  { id: "nas",      label: "Storage/NAS",icon: HardDrive },
                  { id: "docker",   label: "Docker/VM",  icon: Box },
                  { id: "database", label: "Database",   icon: Database },
                  { id: "cloud",    label: "Cloud/VPS",  icon: Cloud },
                  { id: "cpu",      label: "Compute",    icon: Cpu },
                  { id: "router",   label: "Router/IoT", icon: Wifi },
                  { id: "shield",   label: "Security",   icon: Shield },
                  { id: "desktop",  label: "Desktop",    icon: Monitor },
                  { id: "terminal", label: "Shell",      icon: Terminal },
                ].map(({ id, label, icon: IconComp }) => {
                  const selected = (newNode.icon || "server") === id;
                  return (
                    <button
                      key={id}
                      type="button"
                      title={label}
                      onClick={() => setNewNode({ ...newNode, icon: id })}
                      className={`h-7 px-2.5 rounded-lg flex items-center gap-1.5 text-[11px] font-medium border transition-all ${
                        selected
                          ? "bg-primary/20 border-primary/50 text-primary shadow-sm font-semibold"
                          : "bg-[#1a1a1e] border-white/10 text-zinc-400 hover:text-zinc-200 hover:border-white/20"
                      }`}
                    >
                      <IconComp size={12} className={selected ? "text-primary" : "text-zinc-400"} />
                      <span>{label}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="space-y-1.5">
              <label className="text-[11px] font-bold text-zinc-400 ml-1">Tag colour</label>
              <div className="flex items-center gap-2 flex-wrap">
                {[
                  { name: "Default", value: null,      cls: "bg-zinc-500" },
                  { name: "Rose",    value: "#f43f5e", cls: "bg-rose-500" },
                  { name: "Amber",   value: "#f59e0b", cls: "bg-amber-500" },
                  { name: "Emerald", value: "#10b981", cls: "bg-emerald-500" },
                  { name: "Sky",     value: "#0ea5e9", cls: "bg-sky-500" },
                  { name: "Indigo",  value: "#6366f1", cls: "bg-indigo-500" },
                  { name: "Fuchsia", value: "#d946ef", cls: "bg-fuchsia-500" },
                  { name: "Slate",   value: "#64748b", cls: "bg-slate-500" },
                ].map((p) => {
                  const selected = (newNode.color ?? null) === p.value;
                  return (
                    <button
                      key={p.name}
                      type="button"
                      title={p.name}
                      onClick={() => setNewNode({ ...newNode, color: p.value })}
                      className={`w-6 h-6 rounded-full ${p.cls} ring-2 ring-transparent hover:ring-white/30 transition-all ${selected ? "ring-white" : ""}`}
                    />
                  );
                })}
              </div>
            </div>

            <div className="grid grid-cols-4 gap-4">
              <div className="col-span-3 space-y-1.5">
                <label className="text-[11px] font-bold text-zinc-400 ml-1">Host</label>
                <input type="text" className="w-full h-9 bg-[#1a1a1e] rounded-lg px-3 text-[12px] text-white border border-white/10 outline-none focus:border-primary/50 focus:bg-[#232328] transition-all shadow-inner" placeholder="192.168.1.1 or example.com" value={newNode.host} onChange={e => setNewNode({ ...newNode, host: e.target.value })} />
              </div>
              <div className="space-y-1.5">
                <label className="text-[11px] font-bold text-zinc-400 ml-1">Port</label>
                <input type="number" className="w-full h-9 bg-[#1a1a1e] rounded-lg px-3 text-[12px] text-white border border-white/10 outline-none focus:border-primary/50 focus:bg-[#232328] transition-all shadow-inner" value={newNode.port} onChange={e => setNewNode({ ...newNode, port: parseInt(e.target.value) })} />
              </div>
            </div>

          </div>

          {isRdp ? (
            <div className="pt-5 border-t border-white/5 space-y-1.5">
              <label className="text-[11px] font-bold text-zinc-400 ml-1">Username (optional)</label>
              <input
                type="text"
                className="w-full h-9 bg-[#1a1a1e] rounded-lg px-3 text-[12px] text-white border border-white/10 outline-none focus:border-primary/50 focus:bg-[#232328] transition-all shadow-inner"
                placeholder="e.g. Administrator or DOMAIN\\user"
                value={newNode.username}
                onChange={(e) => setNewNode({ ...newNode, username: e.target.value })}
              />
              <p className="text-[11px] text-zinc-500 ml-1 leading-relaxed">
                Opens your system's Remote Desktop client. The password is asked there; SubTerm does not store or send one.
              </p>
            </div>
          ) : (
          <div className="pt-5 border-t border-white/5 space-y-4">
            <div className="flex justify-between items-center">
              <label className="text-[11px] font-bold text-zinc-400">How to log in</label>
              <select
                className="bg-transparent text-[12px] font-bold text-primary outline-none cursor-pointer"
                value={newNode.authType}
                onChange={(e) => setNewNode({ ...newNode, authType: e.target.value })}
              >
                <option value="vault" className="bg-[#121215] text-primary">Use a saved login</option>
                <option value="custom_pass" className="bg-[#121215] text-primary">Type a password</option>
                <option value="custom_key" className="bg-[#121215] text-primary">Use an SSH key</option>
              </select>
            </div>

            {newNode.authType === 'vault' && (() => {
              const selectedCred = credentials?.find((c) => c.id?.toString() === newNode.credentialId?.toString());
              return (
                <div className="space-y-3 animate-in fade-in slide-in-from-top-1">
                  <div className="space-y-1.5">
                    <label className="text-[11px] font-bold text-zinc-400 ml-1">Saved login</label>
                    <select className="w-full h-9 bg-[#1a1a1e] rounded-lg px-3 text-[12px] text-zinc-300 border border-white/10 outline-none focus:border-primary/50 transition-all shadow-inner" value={newNode.credentialId} onChange={e => setNewNode({ ...newNode, credentialId: e.target.value })}>
                      <option value="" className="bg-[#1a1a1e] text-zinc-500">-- Pick one --</option>
                      {credentials?.map((c) => <option key={c.id} value={c.id.toString()} className="bg-[#1a1a1e] text-zinc-300">{c.name} ({c.username})</option>)}
                    </select>
                  </div>
                  {selectedCred && (
                    <div className="px-3 py-2 bg-primary/5 border border-primary/20 rounded-lg text-[11px] font-mono text-zinc-300 flex items-center gap-2">
                      <User size={11} className="text-primary shrink-0" />
                      <span className="text-zinc-500">Sign in as</span>
                      <span className="text-primary font-bold">{selectedCred.username || "—"}</span>
                      <span className="text-zinc-600 ml-auto text-[10px]">{selectedCred.auth_type === 'key' ? 'using key' : 'using password'}</span>
                    </div>
                  )}
                </div>
              );
            })()}

            {newNode.authType === 'custom_pass' && (
              <div className="space-y-3 animate-in fade-in">
                <div className="space-y-1.5">
                  <label className="text-[11px] font-bold text-zinc-400 ml-1">Username</label>
                  <input type="text" placeholder="root" value={newNode.username || ""} onChange={e => setNewNode({ ...newNode, username: e.target.value })} className="w-full h-9 bg-[#1a1a1e] rounded-lg px-3 text-[12px] text-white border border-white/10 outline-none focus:border-primary/50 transition-all shadow-inner" />
                </div>
                <div className="space-y-1.5">
                  <label className="text-[11px] font-bold text-zinc-400 ml-1">Password</label>
                  <PasswordField
                    value={newNode.password || ""}
                    onChange={(v) => setNewNode({ ...newNode, password: v, password_dirty: true })}
                    className="w-full h-9 bg-[#1a1a1e] rounded-lg px-3 text-[12px] text-white border border-white/10 outline-none focus:border-primary/50 transition-all shadow-inner"
                    placeholder="••••••"
                  />
                </div>
              </div>
            )}

            {newNode.authType === 'custom_key' && (
              <div className="space-y-3 animate-in fade-in">
                <div className="space-y-1.5">
                  <label className="text-[11px] font-bold text-zinc-400 ml-1">Username</label>
                  <input type="text" placeholder="root" value={newNode.username || ""} onChange={e => setNewNode({ ...newNode, username: e.target.value })} className="w-full h-9 bg-[#1a1a1e] rounded-lg px-3 text-[12px] text-white border border-white/10 outline-none focus:border-primary/50 transition-all shadow-inner" />
                </div>
                <div className="space-y-1.5">
                  <label className="text-[11px] font-bold text-zinc-400 ml-1">SSH key</label>
                  <div className="flex gap-1.5">
                    <select className="flex-1 min-w-0 h-9 bg-[#1a1a1e] rounded-lg px-3 text-[12px] text-zinc-300 border border-white/10 outline-none focus:border-primary/50 transition-all shadow-inner" value={newNode.keyId} onChange={e => setNewNode({ ...newNode, keyId: e.target.value })}>
                      <option value="" className="bg-[#1a1a1e] text-zinc-500">-- Pick a key --</option>
                      {sshKeys?.map((k) => <option key={k.id} value={k.id.toString()} className="bg-[#1a1a1e] text-zinc-300">{k.name}</option>)}
                    </select>
                    {/* Quick-generate so picking a key doesn't force the user to
                        cancel out of editing this server, go to Settings, make
                        a key, then come back and re-open this same form. */}
                    <button
                      type="button"
                      title="Generate a new SSH key"
                      onClick={async () => {
                        const name = await textPrompt({
                          title: "Generate SSH key",
                          message: "Give this key a name — it's just for your reference here in SubTerm.",
                          placeholder: "e.g. laptop-2026",
                          okLabel: "Generate",
                          validate: (v) => v.length === 0 ? "Name is required" : null,
                        });
                        if (!name) return;
                        try {
                          await invoke("generate_ssh_key", { name });
                          await refreshSshKeys?.();
                          const keys = await invoke<SshKey[]>("get_ssh_keys");
                          const created = keys.find((k) => k.name === name);
                          if (created) setNewNode({ ...newNode, keyId: created.id.toString() });
                        } catch { /* generate failure surfaces via the keys list staying unchanged */ }
                      }}
                      className="h-9 w-9 shrink-0 flex items-center justify-center bg-[#1a1a1e] rounded-lg border border-white/10 text-zinc-400 hover:text-primary hover:border-primary/40 transition-all"
                    >
                      <Plus size={14} />
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
          )}

          <div className="pt-5 border-t border-white/5 space-y-4">
            {!isRdp && (<>
            <div className="flex justify-between items-center">
              <label className="text-[11px] font-bold text-zinc-400">Proxy</label>
              <select className="bg-transparent text-[12px] font-bold text-zinc-300 outline-none cursor-pointer" value={newNode.proxyType} onChange={e => setNewNode({ ...newNode, proxyType: e.target.value })}>
                <option value="none" className="bg-[#121215] text-zinc-400">No proxy</option>
                <option value="socks5" className="bg-[#121215] text-zinc-400">SOCKS5</option>
                <option value="http" className="bg-[#121215] text-zinc-400">HTTP</option>
              </select>
            </div>

            {newNode.proxyType !== 'none' && (
              <div className="grid grid-cols-4 gap-3 animate-in fade-in">
                <input
                  className="col-span-3 h-9 bg-[#1a1a1e] rounded-lg px-3 text-[12px] text-white border border-white/10 outline-none focus:border-primary/50 transition-all shadow-inner"
                  placeholder="Proxy Host"
                  value={newNode.proxyHost || ""}
                  onChange={e => setNewNode({ ...newNode, proxyHost: e.target.value })}
                />
                <input
                  type="number"
                  className="h-9 bg-[#1a1a1e] rounded-lg px-3 text-[12px] text-white border border-white/10 outline-none focus:border-primary/50 transition-all shadow-inner"
                  placeholder="Port"
                  value={newNode.proxyPort || ""}
                  onChange={e => setNewNode({ ...newNode, proxyPort: parseInt(e.target.value) || 0 })}
                />
              </div>
            )}

            {/* ProxyJump — bounce through another saved node to reach this one
                (like `ssh -J bastion target`). Distinct from the SOCKS/HTTP
                proxy above: that's a plain TCP proxy, this is a full SSH hop
                that opens a direct-tcpip channel to the target. Self is filtered
                out so a node can't jump through itself. */}
            <div className="flex justify-between items-center gap-3">
              <label className="text-[11px] font-bold text-zinc-400 shrink-0">Jump via</label>
              <select
                className="flex-1 min-w-0 h-9 bg-[#1a1a1e] rounded-lg px-3 text-[12px] text-zinc-300 border border-white/10 outline-none focus:border-primary/50 focus:bg-[#232328] transition-all shadow-inner"
                value={newNode.jumpHostId || ""}
                onChange={e => setNewNode({ ...newNode, jumpHostId: e.target.value })}
              >
                <option value="" className="bg-[#1a1a1e] text-zinc-500">Direct — no jump host</option>
                {(servers || [])
                  .filter((s) => s.id !== newNode.id)
                  .map((s) => (
                    <option key={s.id} value={s.id.toString()} className="bg-[#1a1a1e] text-zinc-300">
                      {s.name} ({s.host})
                    </option>
                  ))}
              </select>
            </div>

            <div className="space-y-2.5">
              <div className="flex justify-between items-center">
                <span className="text-[11px] font-bold text-zinc-400">Port forwarding</span>
                <button onClick={() => setNewNode({ ...newNode, tunnels: [...newNode.tunnels, { rid: `t-${Date.now()}-${Math.random().toString(36).slice(2,7)}`, local: "1080", remote: "", type: "D" }] })} className="text-[11px] font-bold text-primary hover:text-primary transition-colors">+ Add</button>
              </div>

              <div className="space-y-2">
                {newNode.tunnels?.map((t, idx: number) => (
                  // `rid` is a stable per-row id added on Add. Falling
                  // back to idx for legacy rows that lack it; new rows
                  // always carry rid so deletions / reorders preserve
                  // each input's focus and cursor state.
                  <div key={t.rid ?? idx} className="flex items-center gap-2 p-2 bg-[#1a1a1e] rounded-lg border border-white/5 group transition-all hover:border-primary/30">
                    <select
                      className="bg-transparent text-[11px] font-black outline-none text-primary uppercase tracking-wider cursor-pointer pl-1"
                      value={t.type}
                      onChange={e => updateTunnel(idx, 'type', e.target.value)}
                    >
                      <option value="D" className="bg-[#1a1a1e] text-primary">Dynamic</option>
                      <option value="L" className="bg-[#1a1a1e] text-primary">Local</option>
                      <option value="R" className="bg-[#1a1a1e] text-primary">Remote</option>
                    </select>

                    <div className="h-4 w-px bg-white/10 mx-1" />

                    <input
                      className="flex-1 min-w-0 bg-transparent text-[12px] font-mono outline-none text-zinc-300 placeholder:text-zinc-700"
                      placeholder={
                        t.type === 'D' ? "Port (1080)" :
                        t.type === 'R' ? "Server bind (8080 or 0.0.0.0:8080)" :
                                         "Local (8080 or 0.0.0.0:8080)"
                      }
                      value={t.local}
                      onChange={e => updateTunnel(idx, 'local', e.target.value)}
                    />

                    {t.type !== 'D' && (
                      <>
                        <ArrowLeftRight size={10} className="text-zinc-700 shrink-0 mx-1" />
                        <input
                          className="flex-1 min-w-0 bg-transparent text-[12px] font-mono outline-none text-primary placeholder:text-zinc-700"
                          placeholder="Remote (80)"
                          value={t.remote}
                          onChange={e => updateTunnel(idx, 'remote', e.target.value)}
                        />
                      </>
                    )}

                    <button onClick={() => setNewNode({ ...newNode, tunnels: newNode.tunnels.filter((_, i: number) => i !== idx) })} className="opacity-100 sm:opacity-0 sm:group-hover:opacity-100 w-6 h-6 flex items-center justify-center text-red-500 hover:bg-red-500/10 rounded transition-all shrink-0">
                      <X size={12} />
                    </button>
                  </div>
                ))}
              </div>
            </div>

            {/* Folder mirrors saved on this node — one-way local → remote
                sync. Stored alongside tunnels so they roam with the vault.
                Live management (start / stop / log) lives in the Mirror
                panel inside an open session. */}
            <div className="space-y-2.5">
              <div className="flex justify-between items-center">
                <span className="text-[11px] font-bold text-zinc-400">Folder mirrors</span>
                <button
                  type="button"
                  onClick={() => setNewNode({
                    ...newNode,
                    mirrors: [...(newNode.mirrors || []), { local: "", remote: "", soft_delete: true, excludes: [], conflict_resolution: "local" }],
                  })}
                  className="text-[11px] font-bold text-primary hover:text-primary transition-colors"
                >+ Add</button>
              </div>
              <div className="space-y-2">
                {(newNode.mirrors || []).map((m, idx: number) => (
                  <div key={idx} className="p-2.5 bg-[#1a1a1e] rounded-lg border border-white/5 group space-y-1.5">
                    <div className="flex items-center gap-2">
                      <input
                        className="flex-1 min-w-0 h-7 bg-black/40 rounded px-2 text-[11.5px] font-mono text-zinc-200 border border-white/10 outline-none focus:border-primary/50"
                        placeholder="/local/path"
                        value={m.local}
                        onChange={(e) => {
                          const next = [...newNode.mirrors];
                          next[idx] = { ...next[idx], local: e.target.value };
                          setNewNode({ ...newNode, mirrors: next });
                        }}
                      />
                      <ArrowLeftRight size={10} className="text-zinc-700 shrink-0 mx-1" />
                      <input
                        className="flex-1 min-w-0 h-7 bg-black/40 rounded px-2 text-[11.5px] font-mono text-zinc-200 border border-white/10 outline-none focus:border-primary/50"
                        placeholder="/remote/path"
                        value={m.remote}
                        onChange={(e) => {
                          const next = [...newNode.mirrors];
                          next[idx] = { ...next[idx], remote: e.target.value };
                          setNewNode({ ...newNode, mirrors: next });
                        }}
                      />
                      <button
                        type="button"
                        onClick={() => setNewNode({ ...newNode, mirrors: newNode.mirrors.filter((_, i: number) => i !== idx) })}
                        className="opacity-100 sm:opacity-0 sm:group-hover:opacity-100 w-6 h-6 flex items-center justify-center text-red-500 hover:bg-red-500/10 rounded transition-all shrink-0"
                      >
                        <X size={12} />
                      </button>
                    </div>
                    <div className="flex items-center gap-3 pl-1">
                      <label className="flex items-center gap-1.5 text-[10.5px] text-zinc-400 select-none cursor-pointer">
                        <input
                          type="checkbox"
                          checked={m.soft_delete !== false}
                          onChange={(e) => {
                            const next = [...newNode.mirrors];
                            next[idx] = { ...next[idx], soft_delete: e.target.checked };
                            setNewNode({ ...newNode, mirrors: next });
                          }}
                          className="accent-primary"
                        />
                        <span>Soft delete</span>
                      </label>
                      <select
                        value={m.conflict_resolution || "local"}
                        onChange={(e) => {
                          const next = [...newNode.mirrors];
                          next[idx] = { ...next[idx], conflict_resolution: e.target.value };
                          setNewNode({ ...newNode, mirrors: next });
                        }}
                        title="Initial-sync conflict resolution: which side overwrites when a file exists on both with different content. Files missing on one side always copy across."
                        className="h-6 px-1.5 bg-black/30 border border-white/10 rounded text-[10.5px] text-zinc-300 outline-none focus:border-primary/40"
                      >
                        <option value="local">Local wins</option>
                        <option value="remote">Remote wins</option>
                        <option value="newer">Newer wins</option>
                      </select>
                      <input
                        className="flex-1 min-w-0 h-6 bg-transparent rounded px-1 text-[10.5px] font-mono text-zinc-400 placeholder:text-zinc-700 outline-none"
                        placeholder="Excludes: .git, node_modules, *.swp"
                        value={(m.excludes || []).join(", ")}
                        onChange={(e) => {
                          const parts = e.target.value.split(",").map((s) => s.trim()).filter(Boolean);
                          const next = [...newNode.mirrors];
                          next[idx] = { ...next[idx], excludes: parts };
                          setNewNode({ ...newNode, mirrors: next });
                        }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Wake-on-LAN & Port Knocking (Task 4.6) */}
            <div className="space-y-2.5 pt-1">
              <span className="text-[11px] font-bold text-zinc-400 flex items-center gap-1.5">
                <Zap size={12} className="text-amber-400" />
                <span>Wake-on-LAN & Port Knocking</span>
              </span>
              <div className="p-3 bg-[#1a1a1e] rounded-lg border border-white/5 space-y-2.5">
                <div>
                  <label className="text-[10px] font-bold uppercase tracking-wider text-zinc-400 block mb-1">
                    MAC Address (Wake-on-LAN)
                  </label>
                  <div className="flex items-center gap-2">
                    <input
                      className="flex-1 min-w-0 h-8 bg-black/40 rounded px-2.5 text-[11.5px] font-mono text-zinc-200 border border-white/10 outline-none focus:border-primary/50"
                      placeholder="AA:BB:CC:DD:EE:FF"
                      value={newNode.wol_mac || ""}
                      onChange={(e) => setNewNode({ ...newNode, wol_mac: e.target.value })}
                    />
                    <button
                      type="button"
                      disabled={!newNode.wol_mac?.trim() || wolBusy}
                      onClick={async () => {
                        setWolBusy(true);
                        try {
                          await invoke("send_wake_on_lan", { macAddress: (newNode.wol_mac ?? "").trim(), broadcastIp: null });
                          setWolStatus("Magic packet broadcasted!");
                          setTimeout(() => setWolStatus(null), 3500);
                        } catch (err: unknown) {
                          setWolStatus(`WoL failed: ${String(err)}`);
                        } finally {
                          setWolBusy(false);
                        }
                      }}
                      className="h-8 px-2.5 rounded bg-amber-500/15 border border-amber-500/30 text-amber-300 hover:bg-amber-500/25 text-[10px] font-bold uppercase tracking-wider flex items-center gap-1 disabled:opacity-40 transition-colors shrink-0"
                    >
                      <Zap size={11} />
                      <span>{wolBusy ? "Sending…" : "Send WoL"}</span>
                    </button>
                  </div>
                </div>

                <div>
                  <label className="text-[10px] font-bold uppercase tracking-wider text-zinc-400 block mb-1">
                    Port Knock Sequence (comma-separated)
                  </label>
                  <div className="flex items-center gap-2">
                    <input
                      className="flex-1 min-w-0 h-8 bg-black/40 rounded px-2.5 text-[11.5px] font-mono text-zinc-200 border border-white/10 outline-none focus:border-primary/50"
                      placeholder="e.g. 7000, 8000, 9000"
                      value={newNode.knock_ports || ""}
                      onChange={(e) => setNewNode({ ...newNode, knock_ports: e.target.value })}
                    />
                    <button
                      type="button"
                      disabled={!newNode.knock_ports?.trim() || !newNode.host?.trim() || knockBusy}
                      onClick={async () => {
                        setKnockBusy(true);
                        try {
                          const ports = (newNode.knock_ports ?? "")
                            .split(",")
                            .map((p: string) => parseInt(p.trim(), 10))
                            .filter((n: number) => !isNaN(n) && n > 0 && n <= 65535);
                          await invoke("perform_port_knock", { host: newNode.host.trim(), ports, delayMs: 100 });
                          setKnockStatus(`Knocked ${ports.length} ports!`);
                          setTimeout(() => setKnockStatus(null), 3500);
                        } catch (err: unknown) {
                          setKnockStatus(`Knock failed: ${String(err)}`);
                        } finally {
                          setKnockBusy(false);
                        }
                      }}
                      className="h-8 px-2.5 rounded bg-sky-500/15 border border-sky-500/30 text-sky-300 hover:bg-sky-500/25 text-[10px] font-bold uppercase tracking-wider flex items-center gap-1 disabled:opacity-40 transition-colors shrink-0"
                    >
                      <Radio size={11} />
                      <span>{knockBusy ? "Knocking…" : "Knock"}</span>
                    </button>
                  </div>
                </div>

                {(wolStatus || knockStatus) && (
                  <div className="text-[10.5px] font-mono text-primary py-0.5">
                    {wolStatus || knockStatus}
                  </div>
                )}
              </div>
            </div>

            {/* Autostart toggle — when on, the node opens a session and
                connects automatically right after the user unlocks the
                profile. Useful for the one or two servers you always have
                a shell on. */}
            <div className="flex items-center justify-between gap-3 pt-1">
              <div className="min-w-0">
                <div className="text-[11px] font-bold text-zinc-300">Autostart</div>
                <div className="text-[10.5px] text-zinc-500 leading-snug">
                  Open + connect this node automatically when the app launches.
                </div>
              </div>
              <button
                type="button"
                onClick={() => setNewNode({ ...newNode, autostart: !newNode.autostart })}
                role="switch"
                aria-checked={!!newNode.autostart}
                className={`relative shrink-0 w-11 h-6 rounded-full transition-colors ${
                  newNode.autostart ? "bg-primary" : "bg-white/10"
                }`}
              >
                <span
                  className={`absolute top-0.5 left-0.5 w-5 h-5 bg-zinc-100 rounded-full shadow transition-transform ${
                    newNode.autostart ? "translate-x-5" : "translate-x-0"
                  }`}
                />
              </button>
            </div>

            {/* Forward SSH Agent — orthogonal to the auth method above (how we
                log into THIS server). When on, the server we connect to can
                use whatever local agent is running (OpenSSH agent, Pageant,
                1Password, KeePassXC, Vaultwarden's SSH agent) to authenticate
                onward — e.g. `ssh` to a further host, `git` over SSH — without
                SubTerm ever touching those keys itself. Requires a running
                local agent; harmless no-op if forwarding isn't actually used. */}
            <div className="flex items-center justify-between gap-3 pt-1">
              <div className="min-w-0">
                <div className="text-[11px] font-bold text-zinc-300">Forward SSH Agent</div>
                <div className="text-[10.5px] text-zinc-500 leading-snug">
                  Let this server use your local SSH agent for further hops (requires one running).
                </div>
              </div>
              <button
                type="button"
                onClick={() => setNewNode({ ...newNode, forward_agent: !newNode.forward_agent })}
                role="switch"
                aria-checked={!!newNode.forward_agent}
                className={`relative shrink-0 w-11 h-6 rounded-full transition-colors ${
                  newNode.forward_agent ? "bg-primary" : "bg-white/10"
                }`}
              >
                <span
                  className={`absolute top-0.5 left-0.5 w-5 h-5 bg-zinc-100 rounded-full shadow transition-transform ${
                    newNode.forward_agent ? "translate-x-5" : "translate-x-0"
                  }`}
                />
              </button>
            </div>

            </>)}

            {/* Production Environment Toggle */}
            <div className="flex items-center justify-between gap-3 pt-2 pb-1 border-t border-white/5">
              <div className="min-w-0">
                <div className="text-[11px] font-bold text-rose-400 flex items-center gap-1.5">
                  <ShieldAlert size={13} className="shrink-0 text-rose-400" />
                  Production Environment
                </div>
                <div className="text-[10.5px] text-zinc-500 leading-snug">
                  Enables destructive command interception (rm -rf, reboot, drop db) & visual hazard alerts.
                </div>
              </div>
              <button
                type="button"
                onClick={() => setNewNode({ ...newNode, is_production: !newNode.is_production })}
                role="switch"
                aria-checked={!!newNode.is_production}
                className={`relative shrink-0 w-11 h-6 rounded-full transition-colors ${
                  newNode.is_production ? "bg-rose-500 shadow-[0_0_10px_rgba(244,63,94,0.3)]" : "bg-white/10"
                }`}
              >
                <span
                  className={`absolute top-0.5 left-0.5 w-5 h-5 bg-zinc-100 rounded-full shadow transition-transform ${
                    newNode.is_production ? "translate-x-5" : "translate-x-0"
                  }`}
                />
              </button>
            </div>

            {/* Per-node notes — free-form, plain text. Lives on the server
                row (servers.notes column) and never crosses the network. The
                primary use case is small runbooks: which user owns root,
                where the deploy script lives, contact for the box, etc. */}
            <div className="space-y-1.5 pt-1">
              <label className="text-[11px] font-bold text-zinc-400 ml-1 flex items-center gap-2">
                <span>Notes</span>
                <span className="text-[10px] text-zinc-600 font-normal normal-case tracking-normal">
                  Description, runbook, contacts — only for this server.
                </span>
              </label>
              <textarea
                value={newNode.notes || ""}
                onChange={(e) => setNewNode({ ...newNode, notes: e.target.value })}
                placeholder="e.g. Prod web. Reboot windows Sun 04:00 UTC. Deploy via `make ship`. Pager: @ops"
                rows={6}
                className="w-full bg-[#1a1a1e] rounded-lg p-3 text-[12px] text-white border border-white/10 outline-none focus:border-primary/50 focus:bg-[#232328] transition-all shadow-inner font-mono leading-relaxed resize-y"
              />
              {/* Attribution — who last changed this node and when. Populated by
                  the sync layer; most useful on shared / multi-device profiles. */}
              {isEditMode && (newNode.updatedAt || newNode.editedBy) && (() => {
                const when = hlcTime(newNode.updatedAt);
                return (
                  <div className="flex items-center gap-1.5 text-[11px] text-zinc-500 ml-1 pt-0.5">
                    <History size={11} className="text-zinc-600 shrink-0" />
                    <span>
                      Last edited{when ? ` ${relTime(when)}` : ""}
                      {newNode.editedBy ? <> by <span className="text-zinc-300 font-medium">{newNode.editedBy}</span></> : ""}
                      {when && <span className="text-zinc-600" title={when.toLocaleString()}> · {when.toLocaleDateString()}</span>}
                    </span>
                  </div>
                );
              })()}
            </div>

            {/* On-connect commands — auto-typed into the FIRST terminal the
                first time you connect to this server (not on reconnects, not
                on extra shells you open later). One command per line. */}
            {!isRdp && (<div className="space-y-1.5 pt-1">
              <label className="text-[11px] font-bold text-zinc-400 ml-1 flex items-center gap-2">
                <span>Run on connect</span>
                <span className="text-[10px] text-zinc-600 font-normal normal-case tracking-normal">
                  Commands auto-run once on the first terminal. One per line.
                </span>
              </label>
              <textarea
                value={newNode.runOnConnect || ""}
                onChange={(e) => setNewNode({ ...newNode, runOnConnect: e.target.value })}
                placeholder={"e.g.\ncd /var/www\nsource .venv/bin/activate\ntail -f storage/logs/app.log"}
                rows={4}
                spellCheck={false}
                className="w-full bg-[#1a1a1e] rounded-lg p-3 text-[12px] text-white border border-white/10 outline-none focus:border-primary/50 focus:bg-[#232328] transition-all shadow-inner font-mono leading-relaxed resize-y"
              />
            </div>)}
          </div>
        </div>

        {/* Footer */}
        <div className="p-6 border-t border-white/5 shrink-0">
          <button onClick={onSave} className="w-full h-10 bg-primary text-black font-bold rounded-lg text-[13px] tracking-tight hover:bg-primary hover:shadow-[0_0_20px_rgba(var(--primary),0.3)] transition-all active:scale-[0.98] flex items-center justify-center gap-2">
            <Cpu size={14} /> {isEditMode ? "Save changes" : "Save server"}
          </button>
        </div>
      </div>

      {/* SSH-config import modal. Portaled to <body> so it overlays the
          Add Server panel cleanly and isn't clipped by the panel's flex
          layout. Click-outside on the backdrop dismisses; the panel itself
          stops propagation so clicks inside don't close it. */}
      {importOpen && createPortal(
        <div
          className="fixed inset-0 z-[10000] bg-black/70 backdrop-blur-sm flex items-center justify-center p-4"
          onClick={closeImportModal}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="ssh-import-title"
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-[520px] max-h-[80vh] flex flex-col bg-[#121214] border border-white/10 rounded-xl shadow-2xl animate-in zoom-in-95 fade-in duration-150"
          >
            {/* Modal header */}
            <div className="flex items-center justify-between p-4 border-b border-white/5 shrink-0">
              <div className="flex items-center gap-2">
                <Download size={14} className="text-primary" />
                <h3 id="ssh-import-title" className="text-[12px] font-black uppercase tracking-widest text-zinc-100">
                  Import SSH hosts
                </h3>
              </div>
              <button
                onClick={closeImportModal}
                disabled={importBusy}
                className="w-7 h-7 flex items-center justify-center text-zinc-500 hover:text-white bg-white/[0.04] border border-white/10 hover:bg-white/10 rounded-lg transition-all disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <X size={12} />
              </button>
            </div>

            {/* Source selector — two ways to feed hosts in:
                    ssh    → parse the local OpenSSH config (desktop only)
                    paste  → drop text from PuTTY, MobaXterm, or a JSON
                             export; Rust auto-detects the format so the
                             user doesn't need to say which client it came
                             from. */}
            <div className="px-4 py-2 border-b border-white/5 flex items-center gap-1 shrink-0">
              <button
                onClick={() => switchImportSource("ssh")}
                disabled={importBusy}
                className={`h-7 px-3 rounded-lg text-[10.5px] font-bold uppercase tracking-wider transition-all ${
                  importSource === "ssh"
                    ? "bg-primary/10 text-primary border border-primary/30"
                    : "text-zinc-400 border border-white/5 hover:text-white hover:bg-white/[0.04]"
                }`}
              >
                From ~/.ssh/config
              </button>
              <button
                onClick={() => switchImportSource("paste")}
                disabled={importBusy}
                className={`h-7 px-3 rounded-lg text-[10.5px] font-bold uppercase tracking-wider transition-all ${
                  importSource === "paste"
                    ? "bg-primary/10 text-primary border border-primary/30"
                    : "text-zinc-400 border border-white/5 hover:text-white hover:bg-white/[0.04]"
                }`}
              >
                Paste PuTTY / MobaXterm / JSON
              </button>
            </div>

            {/* Body — one of loading / error / empty / list. */}
            <div className="flex-1 overflow-y-auto custom-scrollbar p-3">
              {importSource === "paste" && importHosts.length === 0 && !importLoading && (
                <div className="space-y-2 mb-2">
                  <div className="text-[11px] text-zinc-400 leading-relaxed px-1">
                    Paste an export from another SSH client. Recognised sources:
                    <ul className="mt-1.5 ml-4 list-disc space-y-0.5 text-zinc-500 text-[10.5px]">
                      <li><b className="text-zinc-300">PuTTY</b> — export via <code className="text-zinc-300">regedit /e ... HKCU\Software\SimonTatham\PuTTY\Sessions</code>, open the .reg file, paste its contents.</li>
                      <li><b className="text-zinc-300">MobaXterm</b> — Export sessions → open <code className="text-zinc-300">.mxtsessions</code>, paste.</li>
                      <li><b className="text-zinc-300">JSON</b> — an array of <code className="text-zinc-300">{`{name,host,port,user}`}</code> or Termius-style <code className="text-zinc-300">{`{label,address,port,username}`}</code>.</li>
                    </ul>
                  </div>
                  <textarea
                    value={importPasteText}
                    onChange={(e) => setImportPasteText(e.target.value)}
                    placeholder={`Paste your export here…\n\nExample JSON:\n[\n  {"name":"prod-web","host":"1.2.3.4","port":22,"user":"root"},\n  {"name":"db","host":"10.0.0.5","user":"admin"}\n]`}
                    rows={10}
                    className="w-full bg-black/40 border border-white/10 rounded-lg p-3 text-[11px] font-mono text-zinc-200 placeholder:text-zinc-600 focus:border-primary/40 focus:outline-none resize-none custom-scrollbar"
                  />
                  <div className="flex justify-end">
                    <button
                      onClick={parsePastedImport}
                      disabled={!importPasteText.trim()}
                      className="h-8 px-3 rounded-lg text-[11px] font-bold uppercase tracking-wider bg-primary/10 text-primary border border-primary/30 hover:bg-primary/20 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
                    >
                      Parse pasted text
                    </button>
                  </div>
                </div>
              )}

              {importLoading && (
                <div className="p-6 text-center text-[12px] text-zinc-400">
                  {importSource === "ssh" ? "Reading ~/.ssh/config…" : "Parsing pasted text…"}
                </div>
              )}

              {!importLoading && importError && importHosts.length === 0 && (
                <div className="m-2 p-3 bg-red-500/10 border border-red-500/20 rounded-lg text-red-400 text-[12px] font-mono whitespace-pre-wrap break-words">
                  {importError}
                </div>
              )}

              {!importLoading && !importError && importSource === "ssh" && importHosts.length === 0 && (
                <div className="p-6 text-center text-[12px] text-zinc-500">
                  No importable hosts found in ~/.ssh/config.
                </div>
              )}

              {!importLoading && importHosts.length > 0 && (
                <>
                  {/* Sticky select-all row so users can bulk-toggle a long
                      list without scrolling back up. */}
                  <div className="sticky top-0 z-10 -mx-3 -mt-3 mb-2 px-4 py-2 bg-[#121214] border-b border-white/5 flex items-center justify-between">
                    <button
                      onClick={toggleSelectAll}
                      className="flex items-center gap-2 text-[11px] font-bold text-zinc-300 hover:text-white transition-colors"
                    >
                      {importSelected.size === importHosts.length
                        ? <CheckSquare size={13} className="text-primary" />
                        : <Square size={13} className="text-zinc-500" />}
                      <span>Select all ({importHosts.length})</span>
                    </button>
                    <span className="text-[11px] text-zinc-500 font-mono">
                      {importSelected.size} selected
                    </span>
                  </div>

                  <div className="space-y-1.5">
                    {importHosts.map((h) => {
                      const isSel = importSelected.has(h.host_alias);
                      return (
                        <label
                          key={h.host_alias}
                          className={`flex items-start gap-3 p-2.5 rounded-lg border cursor-pointer transition-all ${
                            isSel
                              ? "bg-primary/10 border-primary/40"
                              : "bg-[#1a1a1e] border-white/5 hover:border-white/20"
                          }`}
                        >
                          <input
                            type="checkbox"
                            checked={isSel}
                            onChange={() => toggleOne(h.host_alias)}
                            className="mt-0.5 accent-primary shrink-0"
                          />
                          <div className="flex-1 min-w-0">
                            <div className="text-[12.5px] font-bold text-white truncate">
                              {h.host_alias}
                            </div>
                            <div className="text-[11px] font-mono text-zinc-400 truncate">
                              {h.user ? `${h.user}@` : ""}{h.hostname}:{h.port}
                            </div>
                            {(h.identity_file || h.proxy_jump) && (
                              <div className="mt-0.5 text-[10.5px] text-zinc-600 truncate">
                                {h.identity_file && <span className="mr-2">key: {h.identity_file}</span>}
                                {h.proxy_jump && <span>jump: {h.proxy_jump}</span>}
                              </div>
                            )}
                          </div>
                        </label>
                      );
                    })}
                  </div>

                  {importError && importHosts.length > 0 && (
                    <div className="mt-3 p-2 bg-red-500/10 border border-red-500/20 rounded-lg text-red-400 text-[11px] font-mono">
                      {importError}
                    </div>
                  )}
                </>
              )}
            </div>

            {/* Modal footer */}
            <div className="p-3 border-t border-white/5 shrink-0 flex items-center justify-end gap-2">
              <button
                onClick={closeImportModal}
                disabled={importBusy}
                className="px-3 h-8 rounded-lg text-[11px] font-bold uppercase tracking-wider bg-white/[0.04] border border-white/10 text-zinc-300 hover:bg-white/[0.08] hover:text-white disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Cancel
              </button>
              <button
                onClick={importSelectedHosts}
                disabled={importBusy || importSelected.size === 0 || importLoading}
                className="px-3 h-8 rounded-lg text-[11px] font-bold uppercase tracking-wider bg-primary/15 border border-primary/40 text-primary hover:bg-primary/25 disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5"
              >
                <Download size={11} />
                {importBusy ? "Importing…" : `Import ${importSelected.size} selected`}
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
};

export default AddNodePanel;