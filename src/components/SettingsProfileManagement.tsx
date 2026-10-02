import { useState, useRef, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Plus, Trash2, Edit2, Check, CheckCircle2, AlertTriangle, X,
  User, ShieldCheck, ArrowLeftRight, Key, Lock
} from "lucide-react";
import { useConfirm, useTextPrompt } from "../ui/confirm";
import {
  DEFAULT_PROFILE_ICONS,
  getProfileIcon,
  setProfileIcon,
  renameProfileIcon,
  deleteProfileIcon,
} from "../utils/profileMetadata";

export const SettingsProfileManagement = ({
  onUnlocked,
  activeProfile,
  onSwitchProfile,
  isUnlocked = false,
  onRequestUnlock,
}: {
  onUnlocked?: (name: string) => void;
  activeProfile?: string | null;
  onSwitchProfile?: (name: string) => void;
  isUnlocked?: boolean;
  onRequestUnlock?: () => void;
}) => {
  const [profiles, setProfiles] = useState<string[]>([]);
  const [syncStatusMap, setSyncStatusMap] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  // New Profile creation state
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newIcon, setNewIcon] = useState("👤");
  const [useCustomPassword, setUseCustomPassword] = useState(false);
  const [newPassword, setNewPassword] = useState("");
  const [newConfirmPassword, setNewConfirmPassword] = useState("");

  // Edit Profile state
  const [editingProfile, setEditingProfile] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editIcon, setEditIcon] = useState("👤");

  // Change Master Password state
  const [changingMasterPw, setChangingMasterPw] = useState(false);
  const [newMasterPw, setNewMasterPw] = useState("");
  const [confirmMasterPw, setConfirmMasterPw] = useState("");

  const confirm = useConfirm();
  const textPrompt = useTextPrompt();
  const nameInputRef = useRef<HTMLInputElement | null>(null);
  const cleanErr = (e: unknown) => String(e).replace(/^\[[A-Z_]+\]\s*/, "");

  const reloadProfiles = async () => {
    try {
      const list = await invoke<string[]>("list_profiles");
      setProfiles(list);
      try {
        const statuses = await invoke<{ name: string; synced: boolean }[]>("get_profiles_sync_status");
        const map: Record<string, boolean> = {};
        for (const s of statuses) {
          map[s.name] = s.synced;
        }
        setSyncStatusMap(map);
      } catch {}
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
      setError("Pick a workspace name.");
      return;
    }
    if (useCustomPassword) {
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
    }
    setBusy(true);
    try {
      await invoke("create_profile", {
        name: trimmed,
        password: useCustomPassword ? newPassword : null,
      });
      setProfileIcon(trimmed, newIcon || "👤");
      setCreating(false);
      setNewName("");
      setNewPassword("");
      setNewConfirmPassword("");
      setUseCustomPassword(false);
      setInfo(`Workspace "${trimmed}" created.`);
      if (onUnlocked) onUnlocked(trimmed);
      else await reloadProfiles();
    } catch (e: any) {
      setError(cleanErr(e));
    } finally {
      setBusy(false);
    }
  };

  const handleSyncToMasterPassword = async (profileName: string) => {
    setError(null);
    setInfo(null);
    const pass = await textPrompt({
      title: `Sync "${profileName}" to Master Password`,
      message: `Enter the current password for workspace "${profileName}" to re-encrypt it with your Unified Master Password:`,
      placeholder: "Current password",
      password: true,
      okLabel: "Sync to Master Password",
      cancelLabel: "Cancel",
    });
    if (!pass) return;

    setBusy(true);
    try {
      await invoke("sync_profile_password", { name: profileName, currentPassword: pass });
      setInfo(`Workspace "${profileName}" is now synced to your Unified Master Password!`);
      await reloadProfiles();
    } catch (e: any) {
      setError(cleanErr(e));
    } finally {
      setBusy(false);
    }
  };

  const handleChangeMasterPassword = async () => {
    setError(null);
    if (!newMasterPw || newMasterPw.length < 8) {
      setError("New password must be at least 8 characters.");
      return;
    }
    if (newMasterPw !== confirmMasterPw) {
      setError("Passwords don't match.");
      return;
    }
    setBusy(true);
    try {
      await invoke("change_master_password", { newPassword: newMasterPw });
      setChangingMasterPw(false);
      setNewMasterPw("");
      setConfirmMasterPw("");
      setInfo("Master Password updated successfully!");
      await reloadProfiles();
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

  const hasUnsyncedProfiles = profiles.some((p) => syncStatusMap[p] === false);

  return (
    <section className="break-inside-avoid space-y-3 mb-4 sm:mb-8" id="profile-management-setting">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-zinc-400 font-bold uppercase tracking-widest text-xs">
          <User size={14} className="text-primary" /> Profile & Workspace Management
        </div>
        {isUnlocked ? (
          <button
            type="button"
            onClick={() => {
              setChangingMasterPw(!changingMasterPw);
              setCreating(false);
              setEditingProfile(null);
            }}
            className="text-[11px] font-semibold text-zinc-400 hover:text-primary flex items-center gap-1.5 transition-colors"
          >
            <Lock size={12} /> Change Master Password
          </button>
        ) : (
          <button
            type="button"
            onClick={onRequestUnlock}
            className="text-[11px] font-semibold text-amber-400/70 hover:text-amber-300 flex items-center gap-1.5 transition-colors"
            title="Unlock vault to access this option"
          >
            <Lock size={12} /> Locked
          </button>
        )}
      </div>

      <div className="bg-[#121215] border border-white/5 rounded-2xl p-6 space-y-4 shadow-xl">
        <p className="text-xs text-zinc-400 leading-relaxed">
          Manage encrypted workspaces. All workspaces can be synchronized to your single Unified Master Password for 1-click zero-prompt switching.
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

        {/* Change Master Password Drawer — requires unlock */}
        {!isUnlocked && (
          <div className="p-3 bg-amber-500/10 border border-amber-500/20 rounded-xl flex items-center gap-3">
            <Lock size={15} className="text-amber-400 shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="text-[11.5px] text-amber-200 font-semibold">Vault is locked</p>
              <p className="text-[11px] text-amber-300/70 mt-0.5">Unlock SubTerm to rename, delete, or change passwords for workspaces.</p>
            </div>
            {onRequestUnlock && (
              <button
                type="button"
                onClick={onRequestUnlock}
                className="shrink-0 h-7 px-3 rounded-lg bg-amber-400 text-zinc-950 font-bold text-xs hover:bg-amber-300 transition-colors"
              >
                Unlock
              </button>
            )}
          </div>
        )}

        {/* Change Master Password Drawer */}
        {isUnlocked && changingMasterPw && (
          <div className="space-y-3 p-4 bg-black/60 border border-amber-500/30 rounded-xl animate-in fade-in">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-white flex items-center gap-1.5">
                <Lock size={14} className="text-amber-400" /> Change Master Password
              </span>
              <button onClick={() => setChangingMasterPw(false)} className="text-zinc-500 hover:text-zinc-300">
                <X size={14} />
              </button>
            </div>
            <p className="text-[11px] text-zinc-400">
              Sets a new Master Password for your current workspace and session.
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <input
                type="password"
                value={newMasterPw}
                onChange={(e) => setNewMasterPw(e.target.value)}
                placeholder="New Master Password (min 8 chars)"
                className="w-full h-9 bg-black/50 border border-white/10 rounded-lg px-3 text-xs text-white outline-none focus:border-amber-400/50"
              />
              <input
                type="password"
                value={confirmMasterPw}
                onChange={(e) => setConfirmMasterPw(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleChangeMasterPassword()}
                placeholder="Confirm New Password"
                className="w-full h-9 bg-black/50 border border-white/10 rounded-lg px-3 text-xs text-white outline-none focus:border-amber-400/50"
              />
            </div>
            <div className="flex justify-end gap-2 pt-1 border-t border-white/5">
              <button
                type="button"
                onClick={() => setChangingMasterPw(false)}
                className="h-8 px-3 rounded-lg text-xs text-zinc-400 hover:text-white"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleChangeMasterPassword}
                disabled={busy || !newMasterPw}
                className="h-8 px-4 rounded-lg bg-amber-400 text-zinc-950 font-bold text-xs hover:bg-amber-300 disabled:opacity-40"
              >
                Update Password
              </button>
            </div>
          </div>
        )}

        {/* Create Profile Drawer */}
        {creating ? (
          <div className="space-y-4 p-4 bg-black/60 border border-primary/30 rounded-xl animate-in fade-in">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-white flex items-center gap-1.5">
                <Plus size={14} className="text-primary" /> Create New Workspace
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

              {/* Name */}
              <div className="flex items-center gap-2">
                <span className="w-9 h-9 rounded-lg bg-white/5 border border-white/10 flex items-center justify-center text-lg shrink-0">
                  {newIcon}
                </span>
                <input
                  ref={nameInputRef}
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && !useCustomPassword && createNew()}
                  placeholder="Workspace Name (e.g. Work, Personal, Client-A)"
                  className="flex-1 h-9 bg-black/50 border border-white/10 rounded-lg px-3 text-xs text-white outline-none focus:border-primary/50"
                />
              </div>

              {/* Protection Notice */}
              <div className="rounded-lg bg-primary/10 border border-primary/20 p-2.5 flex items-start gap-2.5">
                <ShieldCheck size={16} className="text-primary shrink-0 mt-0.5" />
                <div className="flex-1 text-[11px] leading-tight">
                  <span className="font-semibold text-white">Protected by Master Password</span>
                  <p className="text-zinc-400 mt-0.5">
                    This workspace unlocks automatically whenever SubTerm is open — zero extra password prompts.
                  </p>
                </div>
              </div>

              <label className="flex items-center gap-2 cursor-pointer select-none text-[11px] text-zinc-400 hover:text-zinc-300">
                <input
                  type="checkbox"
                  className="accent-primary rounded"
                  checked={useCustomPassword}
                  onChange={(e) => setUseCustomPassword(e.target.checked)}
                />
                <span>Set custom password for this workspace (advanced)</span>
              </label>

              {useCustomPassword && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 animate-in fade-in">
                  <input
                    type="password"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    placeholder="Custom password (min 8 chars)"
                    className="w-full h-9 bg-black/50 border border-white/10 rounded-lg px-3 text-xs text-white outline-none focus:border-primary/50"
                  />
                  <input
                    type="password"
                    value={newConfirmPassword}
                    onChange={(e) => setNewConfirmPassword(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && createNew()}
                    placeholder="Confirm custom password"
                    className="w-full h-9 bg-black/50 border border-white/10 rounded-lg px-3 text-xs text-white outline-none focus:border-primary/50"
                  />
                </div>
              )}
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
                disabled={busy || !newName.trim() || (useCustomPassword && !newPassword)}
                className="h-8 px-4 rounded-lg bg-primary text-zinc-950 font-bold text-xs hover:bg-primary/90 disabled:opacity-40"
              >
                Create Workspace
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => {
              setCreating(true);
              setChangingMasterPw(false);
            }}
            className="w-full h-9 rounded-xl bg-white/[0.04] hover:bg-white/[0.08] border border-white/10 text-zinc-200 hover:text-white font-bold text-xs flex items-center justify-center gap-2 transition-colors"
          >
            <Plus size={14} className="text-primary" /> New Workspace / Profile
          </button>
        )}

        {/* Unsynced Banner */}
        {hasUnsyncedProfiles && (
          <div className="p-3 bg-amber-500/10 border border-amber-500/20 rounded-xl text-amber-200 text-xs flex items-center gap-2.5">
            <AlertTriangle size={15} className="text-amber-400 shrink-0" />
            <div className="flex-1 text-[11.5px]">
              Some workspaces have a different password. Click <span className="font-semibold text-amber-300">Sync to Master Password</span> to convert them to 1-click zero-prompt switching.
            </div>
          </div>
        )}

        {/* Existing Profiles List */}
        {profiles.length > 0 && (
          <div className="mt-4 border-t border-white/5 pt-4 space-y-2">
            <div className="text-[11px] font-bold text-zinc-500 uppercase tracking-widest mb-2 flex items-center justify-between">
              <span>Saved Workspaces ({profiles.length})</span>
              <span className="text-[10px] text-zinc-600 font-normal">Click pencil to rename or change icon</span>
            </div>

            {profiles.map((p) => {
              const isEditing = editingProfile === p;
              const currentIcon = getProfileIcon(p);
              const isActive = activeProfile === p;
              const isSynced = syncStatusMap[p] !== false;

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
                          className={`w-6 h-6 text-sm rounded flex items-center justify-center transition-all ${
                            editIcon === ic ? "bg-primary/30 border border-primary scale-110" : "hover:bg-white/10"
                          }`}
                        >
                          {ic}
                        </button>
                      ))}
                    </div>

                    <div className="flex items-center gap-2">
                      <span className="w-8 h-8 rounded-lg bg-white/5 border border-white/10 flex items-center justify-center text-base shrink-0">
                        {editIcon}
                      </span>
                      <input
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        onKeyDown={(e) => e.key === "Enter" && saveEdit(p)}
                        placeholder="Profile Name"
                        className="flex-1 h-8 bg-black/50 border border-white/10 rounded-lg px-2.5 text-xs text-white outline-none focus:border-primary/50"
                      />
                    </div>

                    <div className="flex justify-end gap-2 pt-1 border-t border-white/5">
                      <button
                        type="button"
                        onClick={() => setEditingProfile(null)}
                        className="h-7 px-2.5 rounded text-xs text-zinc-400 hover:text-white"
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
                  className={`flex items-center justify-between p-3 rounded-xl border text-sm font-medium transition-colors group ${
                    isActive
                      ? "bg-primary/10 border-primary/30 text-white"
                      : "bg-white/[0.02] hover:bg-white/[0.04] border-white/5 text-zinc-300"
                  }`}
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    <span className="text-base select-none">{currentIcon}</span>
                    <span className="font-semibold text-white truncate">{p}</span>
                    {isActive ? (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-primary/20 text-primary border border-primary/30 shrink-0">
                        <Check size={10} /> Active Workspace
                      </span>
                    ) : isSynced ? (
                      <span className="hidden sm:inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 shrink-0">
                        <ShieldCheck size={11} /> Master Password
                      </span>
                    ) : (
                      <span className="hidden sm:inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-amber-500/10 text-amber-300 border border-amber-500/20 shrink-0">
                        <Key size={11} /> Custom Password
                      </span>
                    )}
                  </div>

                  <div className="flex items-center gap-1.5 shrink-0">
                    {!isSynced && (
                      <button
                        type="button"
                        onClick={() => handleSyncToMasterPassword(p)}
                        disabled={busy}
                        title="Re-encrypt with Unified Master Password"
                        className="h-7 px-2.5 rounded-lg bg-amber-500/15 hover:bg-amber-500/25 border border-amber-500/30 text-amber-300 text-xs font-semibold flex items-center gap-1.5 transition-colors"
                      >
                        <Key size={11} /> Sync Password
                      </button>
                    )}
                    {!isActive && onSwitchProfile && (
                      <button
                        type="button"
                        onClick={() => onSwitchProfile(p)}
                        disabled={busy}
                        title="Switch to this workspace"
                        className="h-7 px-2.5 rounded-lg bg-white/5 hover:bg-primary/20 text-zinc-300 hover:text-primary text-xs font-semibold flex items-center gap-1.5 transition-colors border border-white/5 hover:border-primary/30"
                      >
                        <ArrowLeftRight size={12} /> Switch
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => startEdit(p)}
                      disabled={busy || !isUnlocked}
                      title={!isUnlocked ? "Unlock vault to rename" : "Rename or change icon"}
                      className="p-1.5 rounded-lg hover:bg-white/10 text-zinc-400 hover:text-white transition-colors disabled:opacity-30 disabled:hover:bg-transparent disabled:cursor-not-allowed"
                    >
                      <Edit2 size={13} />
                    </button>
                    <button
                      type="button"
                      onClick={() => removeLocal(p)}
                      disabled={busy || isActive || !isUnlocked}
                      title={isActive ? "Cannot delete active workspace" : !isUnlocked ? "Unlock vault to delete" : "Delete profile"}
                      className="p-1.5 rounded-lg hover:bg-rose-500/20 text-zinc-500 hover:text-rose-400 disabled:opacity-30 disabled:hover:bg-transparent disabled:cursor-not-allowed transition-colors"
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
