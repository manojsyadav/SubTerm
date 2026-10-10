import { invoke } from "@tauri-apps/api/core";
import { Plus, Key, Shield, Edit2, Trash2, User } from "lucide-react";
import type { Credential, SshKey } from "../types";
import type { CredentialEditData, KeyEditData } from "./VaultEditPanels";

// The "Logins" view (saved passwords + SSH keys) — extracted out of
// DesktopApp.tsx (part of the ongoing decomposition tracked in TODO.md).
// Pure extraction: all state (which panel is open, edit data) stays lifted
// in DesktopApp.tsx, passed down as props; no behavior change.

export interface LoginsViewProps {
  credentials: Credential[];
  sshKeys: SshKey[];
  addLog: (msg: string, type?: string) => void;
  confirm: (opts: { title: string; message: string; destructive?: boolean }) => Promise<boolean>;
  refreshCredentials: () => void;
  refreshSshKeys: () => void;
  bumpSync: () => void;
  setEditCredData: (d: CredentialEditData) => void;
  setIsCredPanelOpen: (b: boolean) => void;
  setEditKeyData: (d: KeyEditData) => void;
  setIsKeyPanelOpen: (b: boolean) => void;
  textPrompt: (opts: { title: string; message: string; placeholder?: string; okLabel?: string; validate?: (v: string) => string | null }) => Promise<string | null>;
}

export const LoginsView = ({
  credentials, sshKeys, addLog, confirm,
  refreshCredentials, refreshSshKeys, bumpSync,
  setEditCredData, setIsCredPanelOpen, setEditKeyData, setIsKeyPanelOpen,
  textPrompt,
}: LoginsViewProps) => (
  <div className="flex-1 flex flex-col p-4 sm:p-8 space-y-6 sm:space-y-8 animate-in overflow-y-auto custom-scrollbar">
    <header className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-3 border-b border-zinc-700 pb-5 sm:pb-6 shrink-0">
      <div className="min-w-0">
        <h2 className="text-[18px] sm:text-[22px] font-bold text-white tracking-tight">Logins</h2>
        <p className="hidden sm:block text-[13px] text-zinc-400">Your saved passwords and SSH keys.</p>
      </div>
      <div className="flex flex-wrap gap-2">
        <button
          onClick={() => { setEditCredData({ id: null, name: "", auth_type: "password", username: "", password: "", key_id: null }); setIsCredPanelOpen(true); }}
          title="Add Password"
          className="h-9 px-2.5 sm:px-4 bg-zinc-900 text-zinc-200 text-[12px] sm:text-[13px] font-bold rounded-xl border border-white/5 hover:bg-zinc-800 transition-all flex items-center gap-1.5"
        >
          <Plus size={14} /> <span className="hidden sm:inline">Add Password</span><span className="sm:hidden">Password</span>
        </button>
        <button
          onClick={() => { setEditKeyData({ id: null, name: "", public_key: "", private_key: "", passphrase: "" }); setIsKeyPanelOpen(true); }}
          title="Add Key"
          className="h-9 px-2.5 sm:px-4 bg-zinc-900 text-zinc-200 text-[12px] sm:text-[13px] font-bold rounded-xl border border-white/5 hover:bg-zinc-800 transition-all flex items-center gap-1.5"
        >
          <Plus size={14} /> <span className="hidden sm:inline">Add Key</span><span className="sm:hidden">Key</span>
        </button>
        <button
          onClick={async () => {
            // Native window.prompt is a no-op in Tauri's Android
            // WebView — themed useTextPrompt works everywhere.
            const name = await textPrompt({
              title: "Generate SSH key",
              message: "Give this key a name — it's just for your reference here in SubTerm.",
              placeholder: "e.g. laptop-2026",
              okLabel: "Generate",
              validate: (v) => v.length === 0 ? "Name is required" : null,
            });
            if (name) invoke("generate_ssh_key", { name }).then(() => refreshSshKeys());
          }}
          title="Generate Key"
          className="h-9 px-2.5 sm:px-4 bg-primary text-black text-[12px] sm:text-[13px] font-bold rounded-xl shadow-lg shadow-primary/20 flex items-center gap-1.5"
        >
          <Key size={14} /> <span className="hidden sm:inline">Generate Key</span><span className="sm:hidden">Generate</span>
        </button>
      </div>
    </header>

    <div className="space-y-10 pb-10">
      <section>
        <h3 className="text-[13px] font-bold text-zinc-400 mb-4 flex items-center gap-2">
          <Shield size={14} /> Saved passwords
        </h3>
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-2">
          {credentials.length === 0 ? (
            <div className="col-span-full py-10 text-center text-zinc-600 text-[14px] italic border border-dashed border-white/5 rounded-2xl">Nothing here yet.</div>
          ) : (
            credentials.map(c => (
              <div key={c.id} className="bg-[#16161a] border border-white/5 rounded-xl p-3 group relative hover:border-primary/30 transition-all">
                <div className="flex justify-between items-start mb-1">
                  <h4 className="text-[14px] font-bold text-zinc-100 truncate pr-8">{c.name}</h4>
                  <div className="flex items-center gap-2 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity absolute right-3 top-3">
                    <button onClick={async () => {
                      // Credentials list now ships `has_password` instead of plaintext;
                      // pull the secret on demand for the edit sheet.
                      let pw = "";
                      if (c.has_password) {
                        try { pw = (await invoke<string | null>("reveal_credential_password", { id: c.id })) || ""; }
                        catch (e) { addLog(`REVEAL_CRED_FAILED: ${e}`, "error"); }
                      }
                      setEditCredData({ ...c, password: pw });
                      setIsCredPanelOpen(true);
                    }} className="text-zinc-500 hover:text-white"><Edit2 size={14} /></button>
                    <button onClick={async () => {
                      const ok = await confirm({ title: "Delete saved password?", message: `“${c.name}” will be removed. Servers using this login will lose it.`, destructive: true });
                      if (!ok) return;
                      invoke("delete_credential", { id: c.id }).then(() => { refreshCredentials(); bumpSync(); });
                    }} className="text-zinc-500 hover:text-red-500"><Trash2 size={14} /></button>
                  </div>
                </div>
                <div className="flex flex-col gap-0.5">
                  <div className="flex items-center gap-2 text-[11px] text-zinc-500 font-medium">
                    <User size={10} /> {c.username}
                  </div>
                  <div className="flex items-center gap-2 text-[11px] text-zinc-500 font-medium">
                    <Key size={10} /> {c.has_password ? "••••••••" : "Using SSH key"}
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      </section>

      <section>
        <h3 className="text-[13px] font-bold text-zinc-400 mb-4 flex items-center gap-2">
          <Key size={14} /> SSH keys
        </h3>
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-2">
          {sshKeys.length === 0 ? (
            <div className="col-span-full py-10 text-center text-zinc-600 text-[14px] italic border border-dashed border-white/5 rounded-2xl">No keys saved yet.</div>
          ) : (
            sshKeys.map((k) => (
              <div key={k.id} className="bg-[#16161a] border border-white/5 rounded-xl p-3 group relative hover:border-primary/30 transition-all">
                <div className="flex justify-between items-start mb-1">
                  <h4 className="text-[14px] font-bold text-zinc-100 truncate pr-8">{k.name}</h4>
                  <div className="flex items-center gap-2 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity absolute right-3 top-3">
                    <button onClick={async () => {
                      // Same pattern as credentials — pull the private key + passphrase
                      // on demand instead of leaking them in the list response.
                      let secrets: { private_key?: string|null; passphrase?: string|null } = {};
                      if (k.has_private_key || k.has_passphrase) {
                        try { secrets = await invoke<{ private_key?: string | null; passphrase?: string | null }>("reveal_ssh_key", { id: k.id }); }
                        catch (e) { addLog(`REVEAL_KEY_FAILED: ${e}`, "error"); }
                      }
                      setEditKeyData({
                        ...k,
                        private_key: secrets.private_key || "",
                        passphrase: secrets.passphrase || "",
                      });
                      setIsKeyPanelOpen(true);
                    }} className="text-zinc-500 hover:text-white"><Edit2 size={14} /></button>
                    <button onClick={async () => {
                      const ok = await confirm({ title: "Delete SSH key?", message: `“${k.name}” will be removed. This key cannot be recovered.`, destructive: true });
                      if (!ok) return;
                      invoke("delete_ssh_key", { id: k.id }).then(() => { refreshSshKeys(); bumpSync(); });
                    }} className="text-zinc-500 hover:text-red-500"><Trash2 size={14} /></button>
                  </div>
                </div>
                <div className="flex flex-col gap-0.5">
                  <div className="flex items-center gap-2 text-[10px] text-zinc-500 font-mono truncate">
                    {k.public_key.substring(0, 24)}...
                  </div>
                  <div className="text-[10px] text-primary/50 font-medium">
                    Private key
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      </section>
    </div>
  </div>
);
