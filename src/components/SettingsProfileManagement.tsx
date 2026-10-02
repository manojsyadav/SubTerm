import { useState, useRef, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Plus, Trash2, Upload, Download, CheckCircle2, AlertTriangle, X } from "lucide-react";
import { IS_ANDROID } from "../util/platform";
import { useConfirm } from "../ui/confirm";

interface Row { name: string; local: boolean; cloud: any | null; }

export const SettingsProfileManagement = ({ onUnlocked }: { onUnlocked?: (name: string) => void }) => {
  const [profiles, setProfiles] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newConfirmPassword, setNewConfirmPassword] = useState("");
  const [importStaged, setImportStaged] = useState<{ sourcePath: string; name: string } | null>(null);

  const confirm = useConfirm();
  const nameInputRef = useRef<HTMLInputElement | null>(null);
  const importNameRef = useRef<HTMLInputElement | null>(null);
  const cleanErr = (e: unknown) => String(e).replace(/^\[[A-Z_]+\]\s*/, "");

  const reloadProfiles = async () => {
    try {
      const list = await invoke<string[]>("list_profiles");
      setProfiles(list);
    } catch {}
  };

  useEffect(() => { reloadProfiles(); }, []);

  useEffect(() => {
    if (creating) requestAnimationFrame(() => nameInputRef.current?.focus());
  }, [creating]);

  const createNew = async () => {
    setError(null);
    if (!newName.trim()) { setError("Pick a name."); return; }
    if (!newPassword) { setError("Set a password."); return; }
    if (newPassword.length < 8) { setError("Use at least 8 characters."); return; }
    if (newPassword !== newConfirmPassword) { setError("Passwords don't match."); return; }
    setBusy(true);
    try {
      await invoke("create_profile", { name: newName.trim(), password: newPassword });
      if (onUnlocked) onUnlocked(newName.trim());
      else await reloadProfiles();
      setCreating(false);
    } catch (e: any) { setError(String(e)); } finally { setBusy(false); }
  };

  const exportProfile = async (name: string) => {
    setBusy(true); setError(null); setInfo(null);
    try {
      const saved = await invoke<string | null>("export_profile", { name });
      if (saved) setInfo(`Exported to ${saved}`);
    } catch (e: any) { setError(cleanErr(e)); } finally { setBusy(false); }
  };

  const startImport = async () => {
    setError(null); setInfo(null); setBusy(true);
    try {
      const picked = await invoke<[string, string] | null>("import_profile_pick");
      if (!picked) { setBusy(false); return; }
      setImportStaged({ sourcePath: picked[0], name: picked[1] });
      requestAnimationFrame(() => importNameRef.current?.select());
    } catch (e: any) { setError(cleanErr(e)); } finally { setBusy(false); }
  };

  const commitImport = async () => {
    if (!importStaged) return;
    const trimmed = importStaged.name.trim();
    if (!trimmed) { setError("Pick a name."); return; }
    setBusy(true); setError(null);
    try {
      await invoke("import_profile_save", { sourcePath: importStaged.sourcePath, name: trimmed });
      setImportStaged(null);
      setInfo(`Imported as "${trimmed}".`);
      reloadProfiles();
    } catch (e: any) { setError(cleanErr(e)); } finally { setBusy(false); }
  };

  const removeLocal = async (name: string) => {
    const ok = await confirm({ title: "Delete Profile", message: `Are you sure you want to delete ${name}?`, okLabel: "Delete", destructive: true });
    if (!ok) return;
    setBusy(true); setError(null);
    try { await invoke("delete_profile", { name }); await reloadProfiles(); } catch (e: any) { setError(cleanErr(e)); } finally { setBusy(false); }
  };

  return (
    <section className="break-inside-avoid space-y-3 mb-4 sm:mb-8">
      <div className="flex items-center gap-2 text-zinc-400 font-bold uppercase tracking-widest text-xs">
        <Plus size={14} /> Profile Management
      </div>
      <div className="bg-[#121215] border border-white/5 rounded-2xl p-6 space-y-4 shadow-xl">
        {error && <div className="p-3 bg-rose-500/10 border border-rose-500/20 rounded-lg text-rose-200 text-xs flex gap-2"><AlertTriangle size={14} />{error}</div>}
        {info && <div className="p-3 bg-emerald-500/10 border border-emerald-500/20 rounded-lg text-emerald-100 text-xs flex gap-2"><CheckCircle2 size={14} />{info}</div>}
        
        {importStaged && (
          <div className="p-4 bg-zinc-900 border border-primary/30 rounded-lg space-y-2">
            <div className="text-xs text-zinc-300">Importing profile. Pick a name:</div>
            <input ref={importNameRef} value={importStaged.name} onChange={(e) => setImportStaged({ ...importStaged, name: e.target.value })} onKeyDown={(e) => e.key === "Enter" && commitImport()} className="w-full h-9 bg-black/40 border border-white/10 rounded-lg px-3 text-sm text-white" />
            <div className="flex gap-2">
              <button onClick={commitImport} disabled={busy} className="h-9 px-4 rounded-lg bg-primary text-black font-bold text-xs">Import</button>
              <button onClick={() => setImportStaged(null)} className="h-9 px-4 rounded-lg bg-white/10 text-white font-bold text-xs">Cancel</button>
            </div>
          </div>
        )}

        {creating ? (
          <div className="space-y-3 p-4 bg-white/[0.02] border border-white/5 rounded-lg">
            <div className="text-sm font-bold text-white mb-2">Create New Profile</div>
            <input ref={nameInputRef} value={newName} onChange={e => setNewName(e.target.value)} placeholder="Profile name" className="w-full h-9 bg-black/40 border border-white/10 rounded-lg px-3 text-sm text-white" />
            <input type="password" value={newPassword} onChange={e => setNewPassword(e.target.value)} placeholder="Password (min 8 chars)" className="w-full h-9 bg-black/40 border border-white/10 rounded-lg px-3 text-sm text-white" />
            <input type="password" value={newConfirmPassword} onChange={e => setNewConfirmPassword(e.target.value)} onKeyDown={e => e.key === "Enter" && createNew()} placeholder="Confirm password" className="w-full h-9 bg-black/40 border border-white/10 rounded-lg px-3 text-sm text-white" />
            <div className="flex gap-2 pt-2">
              <button onClick={createNew} disabled={busy} className="h-9 px-4 rounded-lg bg-primary text-black font-bold text-xs">Create</button>
              <button onClick={() => setCreating(false)} className="h-9 px-4 rounded-lg bg-white/10 text-white font-bold text-xs">Cancel</button>
            </div>
          </div>
        ) : (
          <div className="flex gap-2">
            <button onClick={() => setCreating(true)} className="flex-1 h-9 rounded-lg bg-white/[0.05] border border-white/10 text-zinc-300 hover:text-white font-bold text-xs flex items-center justify-center gap-2 transition-colors"><Plus size={14}/> New Profile</button>
            {!IS_ANDROID && <button onClick={startImport} disabled={busy} className="flex-1 h-9 rounded-lg bg-white/[0.05] border border-white/10 text-zinc-300 hover:text-white font-bold text-xs flex items-center justify-center gap-2 transition-colors"><Upload size={14}/> Import Profile</button>}
          </div>
        )}

        {profiles.length > 0 && (
          <div className="mt-4 border-t border-white/5 pt-4 space-y-2">
            <div className="text-xs font-bold text-zinc-500 uppercase tracking-widest mb-3">Local Profiles</div>
            {profiles.map(p => (
              <div key={p} className="flex items-center justify-between p-3 rounded-lg bg-white/[0.02] border border-white/5 text-sm font-medium text-zinc-300">
                <span>{p}</span>
                <div className="flex items-center gap-2">
                  {!IS_ANDROID && <button onClick={() => exportProfile(p)} disabled={busy} title="Export" className="p-1.5 rounded-md hover:bg-white/10 text-zinc-400 hover:text-zinc-200 transition-colors"><Download size={14}/></button>}
                  <button onClick={() => removeLocal(p)} disabled={busy} title="Delete" className="p-1.5 rounded-md hover:bg-rose-500/20 text-rose-400 hover:text-rose-300 transition-colors"><Trash2 size={14}/></button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
};
