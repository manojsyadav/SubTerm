import { useState, useRef, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Plus, Trash2, Edit2, Check, CheckCircle2, AlertTriangle, X, User } from "lucide-react";
import { useConfirm } from "../ui/confirm";
import {
  DEFAULT_PROFILE_ICONS,
  getProfileIcon,
  setProfileIcon,
  renameProfileIcon,
  deleteProfileIcon,
} from "../utils/profileMetadata";

export const SettingsProfileManagement = ({ onUnlocked }: { onUnlocked?: (name: string) => void }) => {
  const [profiles, setProfiles] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  // New Profile creation state
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newIcon, setNewIcon] = useState("👤");
  const [newPassword, setNewPassword] = useState("");
  const [newConfirmPassword, setNewConfirmPassword] = useState("");

  // Edit Profile state
  const [editingProfile, setEditingProfile] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editIcon, setEditIcon] = useState("👤");

  const confirm = useConfirm();
  const nameInputRef = useRef<HTMLInputElement | null>(null);
  const cleanErr = (e: unknown) => String(e).replace(/^\[[A-Z_]+\]\s*/, "");

  const reloadProfiles = async () => {
    try {
      const list = await invoke<string[]>("list_profiles");
      setProfiles(list);
    } catch {}
  };

  useEffect(() => {
    reloadProfiles();
  }, []);

  useEffect(() => {
    if (creating) requestAnimationFrame(() => nameInputRef.current?.focus());
  }, [creating]);

  const createNew = async () => {
    setError(null);
    const trimmed = newName.trim();
    if (!trimmed) {
      setError("Pick a name.");
      return;
    }
    if (!newPassword) {
      setError("Set a password.");
      return;
    }
    if (newPassword.length < 8) {
      setError("Use at least 8 characters.");
      return;
    }
    if (newPassword !== newConfirmPassword) {
      setError("Passwords don't match.");
      return;
    }
    setBusy(true);
    try {
      await invoke("create_profile", { name: trimmed, password: newPassword });
      setProfileIcon(trimmed, newIcon || "👤");
      setCreating(false);
      setNewName("");
      setNewPassword("");
      setNewConfirmPassword("");
      setInfo(`Profile "${trimmed}" created.`);
      if (onUnlocked) onUnlocked(trimmed);
      else await reloadProfiles();
    } catch (e: any) {
      setError(cleanErr(e));
    } finally {
      setBusy(false);
    }
  };

  const startEdit = (p: string) => {
    setEditingProfile(p);
    setEditName(p);
    setEditIcon(getProfileIcon(p));
    setError(null);
    setInfo(null);
  };

  const saveEdit = async (oldName: string) => {
    const trimmed = editName.trim();
    if (!trimmed) {
      setError("Profile name cannot be empty.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (trimmed !== oldName) {
        await invoke("rename_profile", { oldName, newName: trimmed });
        renameProfileIcon(oldName, trimmed);
      }
      setProfileIcon(trimmed, editIcon || "👤");
      setEditingProfile(null);
      setInfo(`Profile "${trimmed}" updated.`);
      await reloadProfiles();
    } catch (e: any) {
      setError(cleanErr(e));
    } finally {
      setBusy(false);
    }
  };

  const removeLocal = async (name: string) => {
    const ok = await confirm({
      title: "Delete Profile",
      message: `Are you sure you want to permanently delete profile "${name}"? All saved servers and credentials inside it will be removed.`,
      okLabel: "Delete Profile",
      destructive: true,
    });
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      await invoke("delete_profile", { name });
      deleteProfileIcon(name);
      setInfo(`Profile "${name}" deleted.`);
      await reloadProfiles();
    } catch (e: any) {
      setError(cleanErr(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="break-inside-avoid space-y-3 mb-4 sm:mb-8" id="profile-management-setting">
      <div className="flex items-center gap-2 text-zinc-400 font-bold uppercase tracking-widest text-xs">
        <User size={14} className="text-primary" /> Profile Management
      </div>

      <div className="bg-[#121215] border border-white/5 rounded-2xl p-6 space-y-4 shadow-xl">
        <p className="text-xs text-zinc-400 leading-relaxed">
          Create, customize, and manage encrypted profile vaults. Each profile contains its own isolated servers, logins, and configurations.
        </p>

        {error && (
          <div className="p-3 bg-rose-500/10 border border-rose-500/20 rounded-lg text-rose-200 text-xs flex gap-2 items-center">
            <AlertTriangle size={14} className="shrink-0" />
            <span>{error}</span>
          </div>
        )}
        {info && (
          <div className="p-3 bg-emerald-500/10 border border-emerald-500/20 rounded-lg text-emerald-100 text-xs flex gap-2 items-center">
            <CheckCircle2 size={14} className="shrink-0" />
            <span>{info}</span>
          </div>
        )}

        {/* Create Profile Drawer */}
        {creating ? (
          <div className="space-y-4 p-4 bg-black/60 border border-primary/30 rounded-xl animate-in fade-in">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-white flex items-center gap-1.5">
                <Plus size={14} className="text-primary" /> Create New Profile
              </span>
              <button onClick={() => setCreating(false)} className="text-zinc-500 hover:text-zinc-300">
                <X size={14} />
              </button>
            </div>

            <div className="space-y-3">
              {/* Icon Selector */}
              <div>
                <label className="text-[10px] font-bold uppercase text-zinc-400 tracking-wider block mb-1">
                  Profile Icon
                </label>
                <div className="flex flex-wrap gap-1.5 p-2 bg-black/40 border border-white/5 rounded-lg max-h-24 overflow-y-auto custom-scrollbar">
                  {DEFAULT_PROFILE_ICONS.map((ic) => (
                    <button
                      key={ic}
                      type="button"
                      onClick={() => setNewIcon(ic)}
                      className={`w-7 h-7 text-sm rounded flex items-center justify-center transition-all ${
                        newIcon === ic ? "bg-primary/30 border border-primary scale-110" : "hover:bg-white/10"
                      }`}
                    >
                      {ic}
                    </button>
                  ))}
                </div>
              </div>

              {/* Name & Passwords */}
              <div className="flex items-center gap-2">
                <span className="w-9 h-9 rounded-lg bg-white/5 border border-white/10 flex items-center justify-center text-lg shrink-0">
                  {newIcon}
                </span>
                <input
                  ref={nameInputRef}
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="Profile Name (e.g. Work, Personal, Client-A)"
                  className="flex-1 h-9 bg-black/50 border border-white/10 rounded-lg px-3 text-xs text-white outline-none focus:border-primary/50"
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <input
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  placeholder="Password (min 8 chars)"
                  className="w-full h-9 bg-black/50 border border-white/10 rounded-lg px-3 text-xs text-white outline-none focus:border-primary/50"
                />
                <input
                  type="password"
                  value={newConfirmPassword}
                  onChange={(e) => setNewConfirmPassword(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && createNew()}
                  placeholder="Confirm password"
                  className="w-full h-9 bg-black/50 border border-white/10 rounded-lg px-3 text-xs text-white outline-none focus:border-primary/50"
                />
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-1 border-t border-white/5">
              <button
                type="button"
                onClick={() => setCreating(false)}
                className="h-8 px-3 rounded-lg text-xs text-zinc-400 hover:text-white"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={createNew}
                disabled={busy || !newName.trim() || !newPassword}
                className="h-8 px-4 rounded-lg bg-primary text-zinc-950 font-bold text-xs hover:bg-primary/90 disabled:opacity-40"
              >
                Create Profile
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="w-full h-9 rounded-xl bg-white/[0.04] hover:bg-white/[0.08] border border-white/10 text-zinc-200 hover:text-white font-bold text-xs flex items-center justify-center gap-2 transition-colors"
          >
            <Plus size={14} className="text-primary" /> New Profile
          </button>
        )}

        {/* Existing Profiles List */}
        {profiles.length > 0 && (
          <div className="mt-4 border-t border-white/5 pt-4 space-y-2">
            <div className="text-[11px] font-bold text-zinc-500 uppercase tracking-widest mb-2 flex items-center justify-between">
              <span>Saved Profiles ({profiles.length})</span>
              <span className="text-[10px] text-zinc-600 font-normal">Click pencil to rename or change icon</span>
            </div>

            {profiles.map((p) => {
              const isEditing = editingProfile === p;
              const currentIcon = getProfileIcon(p);

              if (isEditing) {
                return (
                  <div key={p} className="p-3 bg-black/60 border border-primary/40 rounded-xl space-y-3">
                    <div className="text-xs font-semibold text-zinc-300">Edit Profile "{p}"</div>

                    {/* Icon picker */}
                    <div className="flex flex-wrap gap-1 p-1.5 bg-black/40 border border-white/5 rounded-lg max-h-20 overflow-y-auto custom-scrollbar">
                      {DEFAULT_PROFILE_ICONS.map((ic) => (
                        <button
                          key={ic}
                          type="button"
                          onClick={() => setEditIcon(ic)}
                          className={`w-6 h-6 text-xs rounded flex items-center justify-center transition-all ${
                            editIcon === ic ? "bg-primary/30 border border-primary scale-110" : "hover:bg-white/10"
                          }`}
                        >
                          {ic}
                        </button>
                      ))}
                    </div>

                    <div className="flex items-center gap-2">
                      <span className="w-8 h-8 rounded bg-white/5 border border-white/10 flex items-center justify-center text-sm shrink-0">
                        {editIcon}
                      </span>
                      <input
                        type="text"
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        onKeyDown={(e) => e.key === "Enter" && saveEdit(p)}
                        placeholder="Profile name"
                        className="flex-1 h-8 bg-black/60 border border-white/10 rounded-lg px-2.5 text-xs text-white outline-none focus:border-primary/50"
                      />
                    </div>

                    <div className="flex justify-end gap-2 pt-1">
                      <button
                        type="button"
                        onClick={() => setEditingProfile(null)}
                        className="h-7 px-2.5 rounded text-xs text-zinc-400 hover:text-zinc-200"
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        onClick={() => saveEdit(p)}
                        disabled={busy || !editName.trim()}
                        className="h-7 px-3 bg-primary text-zinc-950 font-bold rounded text-xs hover:bg-primary/90 disabled:opacity-40 flex items-center gap-1"
                      >
                        <Check size={12} /> Save Changes
                      </button>
                    </div>
                  </div>
                );
              }

              return (
                <div
                  key={p}
                  className="flex items-center justify-between p-3 rounded-xl bg-white/[0.02] hover:bg-white/[0.04] border border-white/5 text-sm font-medium text-zinc-300 transition-colors group"
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    <span className="text-base select-none">{currentIcon}</span>
                    <span className="font-semibold text-white truncate">{p}</span>
                  </div>

                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => startEdit(p)}
                      disabled={busy}
                      title="Rename or change icon"
                      className="p-1.5 rounded-lg hover:bg-white/10 text-zinc-400 hover:text-white transition-colors"
                    >
                      <Edit2 size={13} />
                    </button>
                    <button
                      type="button"
                      onClick={() => removeLocal(p)}
                      disabled={busy}
                      title="Delete profile"
                      className="p-1.5 rounded-lg hover:bg-rose-500/20 text-zinc-500 hover:text-rose-400 transition-colors"
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
};
