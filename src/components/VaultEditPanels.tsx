import type { ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { TerminalSquare, StickyNote, Shield, Key, X } from "lucide-react";
import PasswordField from "./PasswordField";

// Four near-identical "slide-over CRUD panel" components extracted out of
// DesktopApp.tsx (part of the ongoing decomposition tracked in TODO.md) —
// each edits one vault-stored entity (command snippet, note, credential,
// SSH key). Deliberately kept in one file rather than four: they share the
// exact same shell (slide-over chrome, header, footer Save button, inline
// form-error banner) and splitting them further would just be more files to
// jump between for no real separation-of-concerns benefit. State for each
// entity being edited stays lifted in DesktopApp.tsx (the "New X" / "Edit X"
// buttons elsewhere in that file set it), passed down as props — these
// components own only their own rendering and the save handler.

interface PanelShellProps {
  isOpen: boolean;
  onClose: () => void;
  icon: ReactNode;
  title: string;
  maxWidth: string;
  formError: string;
  children: ReactNode;
  onSave: () => void;
}

const PanelShell = ({ isOpen, onClose, icon, title, maxWidth, formError, children, onSave }: PanelShellProps) => (
  <div className={`fixed inset-0 z-50 transition-all duration-500 flex justify-end ${isOpen ? 'bg-black/80 backdrop-blur-sm' : 'opacity-0 pointer-events-none'}`} onClick={onClose}>
    <div className={`w-full ${maxWidth} bg-[#09090b] border-l border-white/5 shadow-2xl transition-all duration-500 h-full flex flex-col ${isOpen ? 'translate-x-0' : 'translate-x-full'}`} onClick={(e) => e.stopPropagation()}>
      <div className="flex justify-between items-center p-6 border-b border-white/5 shrink-0">
        <h2 className="text-[15px] font-bold text-white tracking-tight flex items-center gap-2">
          {icon}
          {title}
        </h2>
        <button onClick={onClose} className="w-7 h-7 flex items-center justify-center text-zinc-500 hover:text-white bg-black border border-white/5 hover:bg-white/10 rounded-full transition-all">
          <X size={16} />
        </button>
      </div>
      <div className="p-6 flex-1 overflow-y-auto space-y-6">
        {formError && <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-xl text-red-500 text-[12px] font-bold">{formError}</div>}
        {children}
      </div>
      <div className="p-6 border-t border-white/5 shrink-0">
        <button
          onClick={onSave}
          className="w-full h-10 bg-primary text-black font-bold rounded-lg text-[13px] tracking-tight hover:brightness-110 transition-all active:scale-[0.98] shadow-[0_0_15px_rgba(var(--primary),0.2)] flex items-center justify-center gap-2"
        >
          Save
        </button>
      </div>
    </div>
  </div>
);

export interface CommandEditPanelProps {
  isOpen: boolean;
  onClose: () => void;
  data: { id: number | null; title: string; content: string; serverId: number | null; tags: string };
  setData: (d: CommandEditPanelProps["data"]) => void;
  servers: any[];
  formError: string;
  setFormError: (s: string) => void;
  addLog: (msg: string, type?: string) => void;
  refreshCommands: () => void;
  bumpSync: () => void;
}

export const CommandEditPanel = ({ isOpen, onClose, data, setData, servers, formError, setFormError, addLog, refreshCommands, bumpSync }: CommandEditPanelProps) => (
  <PanelShell
    isOpen={isOpen}
    onClose={() => { onClose(); setFormError(""); }}
    icon={<TerminalSquare size={18} className="text-primary" />}
    title={data.id ? "Edit command" : "New command"}
    maxWidth="max-w-[400px]"
    formError={formError}
    onSave={async () => {
      if (!data.title || !data.content) {
        addLog("Title and Content are required.", "error");
        return;
      }
      try {
        const action = data.id
          ? invoke("edit_command", { id: data.id, title: data.title, content: data.content, serverId: data.serverId, tags: data.tags })
          : invoke("add_command", { title: data.title, content: data.content, serverId: data.serverId, tags: data.tags });
        await action;
        onClose();
        refreshCommands();
        bumpSync();
        addLog("Command saved.", "success");
      } catch (e) {
        setFormError(`Failed to save command: ${e}`);
        addLog(`COMMAND_SAVE_ERROR: ${e}`, "error");
      }
    }}
  >
    <div className="space-y-1.5">
      <label className="text-[12px] font-bold text-zinc-400 ml-1">Title</label>
      <input type="text" className="w-full h-10 bg-black rounded-lg px-3 text-[13px] text-white border border-white/10 outline-none focus:border-primary/50 focus:bg-zinc-900/50 transition-all shadow-inner" placeholder="e.g. Update packages" value={data.title} onChange={e => setData({ ...data, title: e.target.value })} />
    </div>
    <div className="space-y-1.5 flex-1 flex flex-col h-64">
      <label className="text-[12px] font-bold text-zinc-400 ml-1">Command</label>
      <textarea className="w-full flex-1 bg-black rounded-lg p-3 text-[13px] text-zinc-300 font-mono border border-white/10 outline-none focus:border-primary/50 focus:bg-zinc-900/50 transition-all shadow-inner custom-scrollbar resize-none" placeholder="sudo apt update && sudo apt upgrade -y" value={data.content} onChange={e => setData({ ...data, content: e.target.value })} />
    </div>
    <div className="space-y-1.5">
      <label className="text-[12px] font-bold text-zinc-400 ml-1">Scope</label>
      <select
        className="w-full h-10 bg-black rounded-lg px-3 text-[13px] text-white border border-white/10 outline-none focus:border-primary/50 focus:bg-zinc-900/50 transition-all shadow-inner"
        value={data.serverId ?? ""}
        onChange={e => setData({ ...data, serverId: e.target.value ? parseInt(e.target.value, 10) : null })}
      >
        <option value="">Global (every server)</option>
        {servers.map((s: any) => (
          <option key={s.id} value={s.id}>{s.name || s.host}</option>
        ))}
      </select>
    </div>
    <div className="space-y-1.5">
      <label className="text-[12px] font-bold text-zinc-400 ml-1">Tags (comma-separated)</label>
      <input type="text" className="w-full h-10 bg-black rounded-lg px-3 text-[13px] text-white border border-white/10 outline-none focus:border-primary/50 focus:bg-zinc-900/50 transition-all shadow-inner" placeholder="e.g. maintenance, docker" value={data.tags} onChange={e => setData({ ...data, tags: e.target.value })} />
    </div>
  </PanelShell>
);

export interface NoteEditPanelProps {
  isOpen: boolean;
  onClose: () => void;
  data: { id: number | null; title: string; body: string };
  setData: (d: NoteEditPanelProps["data"]) => void;
  formError: string;
  setFormError: (s: string) => void;
  addLog: (msg: string, type?: string) => void;
  refreshNotes: () => void;
  bumpSync: () => void;
}

export const NoteEditPanel = ({ isOpen, onClose, data, setData, formError, setFormError, addLog, refreshNotes, bumpSync }: NoteEditPanelProps) => (
  <PanelShell
    isOpen={isOpen}
    onClose={() => { onClose(); setFormError(""); }}
    icon={<StickyNote size={18} className="text-primary" />}
    title={data.id ? "Edit note" : "New note"}
    maxWidth="max-w-[480px]"
    formError={formError}
    onSave={async () => {
      if (!data.title.trim() && !data.body.trim()) {
        setFormError("Add a title or some content first.");
        return;
      }
      try {
        const action = data.id
          ? invoke("edit_note", { id: data.id, title: data.title, body: data.body })
          : invoke("add_note", { title: data.title, body: data.body });
        await action;
        onClose();
        refreshNotes();
        bumpSync();
        addLog("Note saved.", "success");
      } catch (e) {
        setFormError(`Failed to save note: ${e}`);
        addLog(`NOTE_SAVE_ERROR: ${e}`, "error");
      }
    }}
  >
    <div className="space-y-1.5">
      <label className="text-[12px] font-bold text-zinc-400 ml-1">Title</label>
      <input type="text" className="w-full h-10 bg-black rounded-lg px-3 text-[13px] text-white border border-white/10 outline-none focus:border-primary/50 focus:bg-zinc-900/50 transition-all shadow-inner" placeholder="e.g. Production credentials reminder" value={data.title} onChange={e => setData({ ...data, title: e.target.value })} />
    </div>
    <div className="space-y-1.5 flex-1 flex flex-col min-h-[240px]">
      <label className="text-[12px] font-bold text-zinc-400 ml-1">Content</label>
      <textarea className="w-full flex-1 bg-black rounded-lg p-3 text-[13px] text-zinc-300 border border-white/10 outline-none focus:border-primary/50 focus:bg-zinc-900/50 transition-all shadow-inner custom-scrollbar resize-none leading-relaxed" placeholder="Write anything — markdown, paths, secrets you'd otherwise forget…" value={data.body} onChange={e => setData({ ...data, body: e.target.value })} />
    </div>
  </PanelShell>
);

export interface CredentialEditPanelProps {
  isOpen: boolean;
  onClose: () => void;
  data: any;
  setData: (d: any) => void;
  sshKeys: any[];
  formError: string;
  setFormError: (s: string) => void;
  addLog: (msg: string, type?: string) => void;
  refreshCredentials: () => void;
  bumpSync: () => void;
}

export const CredentialEditPanel = ({ isOpen, onClose, data, setData, sshKeys, formError, setFormError, addLog, refreshCredentials, bumpSync }: CredentialEditPanelProps) => (
  <PanelShell
    isOpen={isOpen}
    onClose={() => { onClose(); setFormError(""); }}
    icon={<Shield size={18} className="text-primary" />}
    title={data.id ? "Edit login" : "New login"}
    maxWidth="max-w-[400px]"
    formError={formError}
    onSave={async () => {
      if (!data.name) {
        setFormError("Name is required.");
        addLog("Name is required.", "error");
        return;
      }
      if (data.auth_type === "key" && !data.key_id) {
        setFormError("Please select a linked SSH Private Key.");
        addLog("Please select a linked SSH Private Key.", "error");
        return;
      }
      try {
        const payload = {
          name: data.name,
          authType: data.auth_type || "password",
          username: data.username?.trim() ? data.username.trim() : "root",
          password: data.auth_type === "key" ? null : (data.password || null),
          keyId: data.auth_type === "key" ? (data.key_id ? parseInt(data.key_id.toString()) : null) : null
        };
        const action = data.id
          ? invoke("edit_credential", { id: data.id, ...payload })
          : invoke("add_credential", payload);
        await action;
        onClose();
        refreshCredentials();
        bumpSync();
        addLog("Credential saved.", "success");
      } catch (e) {
        setFormError(`Failed to save credential: ${e}`);
        addLog(`CRED_SAVE_ERROR: ${e}`, "error");
      }
    }}
  >
    <div className="space-y-1.5">
      <label className="text-[12px] font-bold text-zinc-400 ml-1">Name</label>
      <input type="text" className="w-full h-10 bg-black rounded-lg px-3 text-[13px] text-white border border-white/10 outline-none focus:border-primary/50 focus:bg-zinc-900/50 transition-all shadow-inner" placeholder="e.g. Work server" value={data.name} onChange={e => setData({ ...data, name: e.target.value })} />
    </div>
    <div className="space-y-1.5">
      <label className="text-[12px] font-bold text-zinc-400 ml-1">Username</label>
      <input type="text" className="w-full h-10 bg-black rounded-lg px-3 text-[13px] text-white border border-white/10 outline-none focus:border-primary/50 focus:bg-zinc-900/50 transition-all shadow-inner" placeholder="root" value={data.username} onChange={e => setData({ ...data, username: e.target.value })} />
    </div>
    <div className="space-y-4 pt-2">
      <div className="flex justify-between items-center">
        <label className="text-[12px] font-bold text-zinc-400 ml-1">Sign in with</label>
        <select
          className="bg-transparent text-[12px] font-bold text-primary outline-none cursor-pointer"
          value={data.auth_type || "password"}
          onChange={e => setData({ ...data, auth_type: e.target.value })}
        >
          <option value="password" className="bg-[#121215] text-primary">Password</option>
          <option value="key" className="bg-[#121215] text-primary">SSH key</option>
        </select>
      </div>
    </div>
    {data.auth_type === "key" ? (
      <div className="space-y-1.5 animate-in fade-in">
        <label className="text-[12px] font-bold text-zinc-400 ml-1">Pick a key</label>
        <select
          className="w-full h-10 bg-black rounded-lg px-3 text-[13px] text-zinc-300 border border-white/10 outline-none focus:border-primary/50 transition-all shadow-inner"
          value={data.key_id?.toString() || ""}
          onChange={e => setData({ ...data, key_id: e.target.value ? parseInt(e.target.value) : null })}
        >
          <option value="" className="bg-black text-zinc-500">-- Pick a key --</option>
          {sshKeys?.map((k: any) => (
            <option key={k.id} value={k.id.toString()} className="bg-black text-white">{k.name}</option>
          ))}
        </select>
      </div>
    ) : (
      <div className="space-y-1.5 animate-in fade-in">
        <label className="text-[12px] font-bold text-zinc-400 ml-1">Password</label>
        <PasswordField
          value={data.password || ""}
          onChange={(v) => setData({ ...data, password: v })}
          className="w-full h-10 bg-black rounded-lg px-3 text-[13px] text-white border border-white/10 outline-none focus:border-primary/50 focus:bg-zinc-900/50 transition-all shadow-inner"
        />
      </div>
    )}
  </PanelShell>
);

export interface KeyEditPanelProps {
  isOpen: boolean;
  onClose: () => void;
  data: any;
  setData: (d: any) => void;
  formError: string;
  setFormError: (s: string) => void;
  addLog: (msg: string, type?: string) => void;
  refreshSshKeys: () => void;
  bumpSync: () => void;
}

export const KeyEditPanel = ({ isOpen, onClose, data, setData, formError, setFormError, addLog, refreshSshKeys, bumpSync }: KeyEditPanelProps) => (
  <PanelShell
    isOpen={isOpen}
    onClose={() => { onClose(); setFormError(""); }}
    icon={<Key size={18} className="text-primary" />}
    title={data.id ? "Edit SSH key" : "New SSH key"}
    maxWidth="max-w-[450px]"
    formError={formError}
    onSave={async () => {
      if (!data.name || !data.private_key) {
        addLog("Name and Private Key are required.", "error");
        return;
      }
      try {
        const payload = {
          name: data.name,
          publicKey: data.public_key,
          privateKey: data.private_key,
          passphrase: data.passphrase || null
        };
        const action = data.id
          ? invoke("edit_ssh_key", { id: data.id, ...payload })
          : invoke("add_ssh_key", payload);
        await action;
        onClose();
        refreshSshKeys();
        bumpSync();
        addLog("SSH Key saved.", "success");
      } catch (e) {
        setFormError(`Failed to save SSH Key: ${e}`);
        addLog(`KEY_SAVE_ERROR: ${e}`, "error");
      }
    }}
  >
    <div className="space-y-1.5">
      <label className="text-[12px] font-bold text-zinc-400 ml-1">Name</label>
      <input type="text" className="w-full h-10 bg-black rounded-lg px-3 text-[13px] text-white border border-white/10 outline-none focus:border-primary/50 focus:bg-zinc-900/50 transition-all shadow-inner" placeholder="e.g. My laptop key" value={data.name} onChange={e => setData({ ...data, name: e.target.value })} />
    </div>
    <div className="space-y-1.5">
      <label className="text-[12px] font-bold text-zinc-400 ml-1">Public key</label>
      <textarea className="w-full h-24 bg-black rounded-lg p-3 text-[13px] text-zinc-400 font-mono border border-white/10 outline-none focus:border-primary/50 focus:bg-zinc-900/50 transition-all shadow-inner custom-scrollbar resize-none" placeholder="ssh-ed25519 ..." value={data.public_key} onChange={e => setData({ ...data, public_key: e.target.value })} />
    </div>
    <div className="space-y-1.5">
      <label className="text-[12px] font-bold text-zinc-400 ml-1">Private key</label>
      <textarea className="w-full h-32 bg-black rounded-lg p-3 text-[13px] text-zinc-400 font-mono border border-white/10 outline-none focus:border-primary/50 focus:bg-zinc-900/50 transition-all shadow-inner custom-scrollbar resize-none" placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" value={data.private_key} onChange={e => setData({ ...data, private_key: e.target.value })} />
    </div>
    <div className="space-y-1.5">
      <label className="text-[12px] font-bold text-zinc-400 ml-1">Passphrase (if any)</label>
      <PasswordField
        value={data.passphrase || ""}
        onChange={(v) => setData({ ...data, passphrase: v })}
        className="w-full h-10 bg-black rounded-lg px-3 text-[13px] text-white border border-white/10 outline-none focus:border-primary/50 focus:bg-zinc-900/50 transition-all shadow-inner"
      />
    </div>
  </PanelShell>
);
