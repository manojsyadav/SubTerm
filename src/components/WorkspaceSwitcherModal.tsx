import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  X, Check, Plus, Settings, Search,
  ArrowRight, ShieldCheck, AlertCircle, KeyRound,
  Layers, ChevronRight, Lock
} from "lucide-react";
import { getProfileIcon, setProfileIcon, DEFAULT_PROFILE_ICONS } from "../utils/profileMetadata";
import PasswordField from "./PasswordField";

interface Props {
  isOpen: boolean;
  onClose: () => void;
  activeProfile: string | null;
  onSwitchWorkspace: (name: string) => Promise<void>;
  onOpenSettings?: () => void;
}

export const WorkspaceSwitcherModal = ({
  isOpen,
  onClose,
  activeProfile,
  onSwitchWorkspace,
  onOpenSettings,
}: Props) => {
  const [profiles, setProfiles] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [switching, setSwitching] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Inline "New Workspace" creation form state
  const [isCreating, setIsCreating] = useState(false);
  const [newProfileName, setNewProfileName] = useState("");
  const [selectedIcon, setSelectedIcon] = useState("💼");
  const [createBusy, setCreateBusy] = useState(false);

  // Legacy password prompt if a profile has a different password
  const [legacyProfile, setLegacyProfile] = useState<string | null>(null);
  const [legacyPassword, setLegacyPassword] = useState("");
  const [legacyBusy, setLegacyBusy] = useState(false);

  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const newNameInputRef = useRef<HTMLInputElement | null>(null);

  const loadProfiles = async () => {
    try {
      setLoading(true);
      const list = await invoke<string[]>("list_profiles");
      setProfiles(list);
    } catch (e: unknown) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen) {
      setError(null);
      setSearch("");
      setIsCreating(false);
      setLegacyProfile(null);
      setLegacyPassword("");
      loadProfiles();
      setTimeout(() => {
        searchInputRef.current?.focus();
      }, 50);
    }
  }, [isOpen]);

  // Handle ESC key to dismiss
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (legacyProfile) {
          setLegacyProfile(null);
          setLegacyPassword("");
        } else if (isCreating) {
          setIsCreating(false);
        } else {
          onClose();
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, isCreating, legacyProfile, onClose]);

  if (!isOpen) return null;

  const handleSelect = async (profileName: string) => {
    if (profileName === activeProfile) {
      onClose();
      return;
    }
    setError(null);
    setSwitching(profileName);
    try {
      await onSwitchWorkspace(profileName);
      onClose();
    } catch (e: unknown) {
      const msg = String(e);
      if (msg.includes("NO_SESSION_PASSWORD") || msg.toLowerCase().includes("decrypt") || msg.includes("PASSWORD")) {
        // Needs legacy password to unlock & sync
        setLegacyProfile(profileName);
        setLegacyPassword("");
      } else {
        setError(msg);
      }
    } finally {
      setSwitching(null);
    }
  };

  const handleUnlockLegacy = async () => {
    if (!legacyProfile || !legacyPassword) return;
    setLegacyBusy(true);
    setError(null);
    try {
      await invoke("select_profile", { name: legacyProfile });
      await invoke("setup_master_db", { password: legacyPassword });
      // Now sync this profile to the master password if possible
      try {
        await invoke("sync_profile_password", { profileName: legacyProfile, oldPassword: legacyPassword });
      } catch {}
      await onSwitchWorkspace(legacyProfile);
      onClose();
    } catch (e: unknown) {
      setError("Incorrect password for this workspace.");
    } finally {
      setLegacyBusy(false);
    }
  };

  const handleCreateWorkspace = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const name = newProfileName.trim();
    if (!name) return;
    setCreateBusy(true);
    setError(null);
    try {
      // Empty password instructs Rust to use active session master password
      await invoke("create_profile", { name, password: "" });
      setProfileIcon(name, selectedIcon);
      await onSwitchWorkspace(name);
      onClose();
    } catch (e: unknown) {
      setError(String(e));
      setCreateBusy(false);
    }
  };

  const filtered = profiles.filter((p) =>
    p.toLowerCase().includes(search.toLowerCase().trim())
  );

  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 animate-in fade-in duration-150"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-md bg-[#131418] border border-white/10 rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[85vh] animate-in zoom-in-95 duration-150">
        {/* Header */}
        <div className="px-5 py-4 border-b border-white/5 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-xl bg-primary/10 border border-primary/20 flex items-center justify-center text-primary">
              <Layers size={17} />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-white tracking-tight leading-none">
                Switch Workspace
              </h2>
              <p className="text-[11px] text-zinc-400 mt-1">
                Instant 1-click workspace switching
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="w-7 h-7 rounded-lg text-zinc-400 hover:text-white hover:bg-white/5 flex items-center justify-center transition-colors"
          >
            <X size={15} />
          </button>
        </div>

        {/* Error notification */}
        {error && (
          <div className="mx-5 mt-3 px-3 py-2 bg-rose-500/10 border border-rose-500/20 rounded-xl text-rose-200 text-xs flex items-center gap-2">
            <AlertCircle size={14} className="shrink-0 text-rose-400" />
            <span className="flex-1 truncate">{error}</span>
            <button onClick={() => setError(null)} className="text-rose-400 hover:text-white">
              <X size={13} />
            </button>
          </div>
        )}

        {/* Legacy password modal view if needed */}
        {legacyProfile ? (
          <div className="p-5 flex flex-col gap-3">
            <div className="p-3 bg-amber-500/10 border border-amber-500/20 rounded-xl text-amber-200 text-xs flex items-start gap-2.5">
              <KeyRound size={16} className="shrink-0 text-amber-400 mt-0.5" />
              <div>
                <span className="font-semibold text-white">Legacy Workspace Password</span>
                <p className="text-zinc-300 text-[11.5px] mt-0.5">
                  "{legacyProfile}" was created before master password sync. Enter its current password to switch and sync it automatically.
                </p>
              </div>
            </div>
            <PasswordField
              value={legacyPassword}
              onChange={setLegacyPassword}
              placeholder="Workspace password..."
              autoFocus
              className="w-full h-10 px-3 bg-black/40 border border-white/10 rounded-xl text-xs text-white placeholder-zinc-500 focus:outline-none focus:border-primary/50"
              onKeyDown={(e) => {
                if (e.key === "Enter") handleUnlockLegacy();
              }}
            />
            <div className="flex gap-2 justify-end pt-1">
              <button
                type="button"
                onClick={() => setLegacyProfile(null)}
                className="h-8 px-3 rounded-lg text-xs text-zinc-400 hover:text-white hover:bg-white/5 transition-colors"
              >
                Back
              </button>
              <button
                type="button"
                onClick={handleUnlockLegacy}
                disabled={legacyBusy || !legacyPassword}
                className="h-8 px-4 rounded-lg bg-primary text-black font-semibold text-xs flex items-center gap-1.5 hover:shadow-[0_0_15px_rgba(var(--primary),0.3)] transition-all disabled:opacity-50"
              >
                {legacyBusy ? "Unlocking…" : "Unlock & Switch"}
                <ArrowRight size={13} />
              </button>
            </div>
          </div>
        ) : isCreating ? (
          /* Create New Workspace Form */
          <form onSubmit={handleCreateWorkspace} className="p-5 flex flex-col gap-3.5">
            <div className="text-xs font-semibold text-zinc-300">
              Create New Workspace
            </div>
            <div>
              <label className="block text-[11px] text-zinc-400 mb-1.5">
                Workspace Name
              </label>
              <input
                ref={newNameInputRef}
                type="text"
                autoFocus
                value={newProfileName}
                onChange={(e) => setNewProfileName(e.target.value)}
                placeholder="e.g. Work, Staging, Client A"
                className="w-full h-9 px-3 bg-black/40 border border-white/10 rounded-xl text-xs text-white placeholder-zinc-500 focus:outline-none focus:border-primary/50"
              />
            </div>
            <div>
              <label className="block text-[11px] text-zinc-400 mb-1.5">
                Select Icon
              </label>
              <div className="flex flex-wrap gap-1.5 p-2 bg-black/20 border border-white/5 rounded-xl">
                {DEFAULT_PROFILE_ICONS.slice(0, 12).map((icon) => (
                  <button
                    key={icon}
                    type="button"
                    onClick={() => setSelectedIcon(icon)}
                    className={`w-8 h-8 rounded-lg text-base flex items-center justify-center transition-all ${
                      selectedIcon === icon
                        ? "bg-primary/20 border border-primary/40 scale-105"
                        : "hover:bg-white/5 border border-transparent"
                    }`}
                  >
                    {icon}
                  </button>
                ))}
              </div>
            </div>
            <p className="text-[10px] text-zinc-500">
              ✨ Encrypted with your active Master Password. No separate password needed!
            </p>
            <div className="flex gap-2 justify-end pt-1">
              <button
                type="button"
                onClick={() => setIsCreating(false)}
                className="h-8 px-3 rounded-lg text-xs text-zinc-400 hover:text-white hover:bg-white/5 transition-colors"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={createBusy || !newProfileName.trim()}
                className="h-8 px-4 rounded-lg bg-primary text-black font-semibold text-xs flex items-center gap-1.5 hover:shadow-[0_0_15px_rgba(var(--primary),0.3)] transition-all disabled:opacity-50"
              >
                {createBusy ? "Creating…" : "Create & Open"}
                <ArrowRight size={13} />
              </button>
            </div>
          </form>
        ) : (
          /* Normal Workspace List */
          <>
            {/* Search Input (shown when >= 4 profiles) */}
            {profiles.length >= 4 && (
              <div className="px-5 pt-3">
                <div className="relative">
                  <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" />
                  <input
                    ref={searchInputRef}
                    type="text"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search workspaces..."
                    className="w-full h-8 pl-8 pr-3 bg-black/30 border border-white/10 rounded-xl text-xs text-white placeholder-zinc-500 focus:outline-none focus:border-primary/40"
                  />
                  {search && (
                    <button
                      type="button"
                      onClick={() => setSearch("")}
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-200"
                    >
                      <X size={11} />
                    </button>
                  )}
                </div>
              </div>
            )}

            {/* List */}
            <div className="p-4 overflow-y-auto max-h-[340px] space-y-1.5 custom-scrollbar">
              {loading ? (
                <div className="text-center text-xs text-zinc-500 py-8">
                  Loading workspaces…
                </div>
              ) : filtered.length === 0 ? (
                <div className="text-center text-xs text-zinc-500 py-8">
                  No matching workspaces found.
                </div>
              ) : (
                filtered.map((name) => {
                  const isActive = name === activeProfile;
                  const isCurrentSwitch = switching === name;
                  const icon = getProfileIcon(name);

                  return (
                    <button
                      key={name}
                      type="button"
                      disabled={isCurrentSwitch}
                      onClick={() => handleSelect(name)}
                      className={`w-full group text-left p-3 rounded-xl border transition-all flex items-center justify-between ${
                        isActive
                          ? "bg-primary/10 border-primary/30 shadow-[0_0_15px_rgba(var(--primary),0.08)]"
                          : "bg-white/[0.02] border-white/5 hover:bg-white/[0.06] hover:border-white/15"
                      }`}
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <div
                          className={`w-9 h-9 rounded-xl flex items-center justify-center text-lg select-none border transition-transform group-hover:scale-105 ${
                            isActive
                              ? "bg-primary/20 border-primary/30"
                              : "bg-white/5 border-white/10"
                          }`}
                        >
                          {icon}
                        </div>
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span
                              className={`text-xs font-semibold truncate ${
                                isActive ? "text-primary" : "text-white group-hover:text-zinc-100"
                              }`}
                            >
                              {name}
                            </span>
                            {isActive && (
                              <span className="px-1.5 py-0.5 rounded text-[9px] font-medium bg-emerald-500/15 border border-emerald-500/25 text-emerald-400">
                                Current
                              </span>
                            )}
                          </div>
                          <span className="text-[10px] text-zinc-500">
                            {isActive ? "Currently open" : "Click to switch instantly"}
                          </span>
                        </div>
                      </div>

                      <div className="shrink-0 flex items-center">
                        {isCurrentSwitch ? (
                          <div className="w-4 h-4 border-2 border-primary border-t-transparent rounded-full animate-spin" />
                        ) : isActive ? (
                          <div className="w-6 h-6 rounded-full bg-emerald-500/20 text-emerald-400 flex items-center justify-center">
                            <Check size={13} />
                          </div>
                        ) : (
                          <ChevronRight
                            size={15}
                            className="text-zinc-600 group-hover:text-zinc-300 group-hover:translate-x-0.5 transition-all"
                          />
                        )}
                      </div>
                    </button>
                  );
                })
              )}
            </div>

            {/* Bottom Actions Bar */}
            <div className="px-4 py-3 bg-white/[0.02] border-t border-white/5 flex items-center justify-between text-xs">
              <button
                type="button"
                onClick={() => {
                  setNewProfileName("");
                  setIsCreating(true);
                  setTimeout(() => newNameInputRef.current?.focus(), 50);
                }}
                className="h-8 px-2.5 rounded-lg text-zinc-400 hover:text-white hover:bg-white/5 flex items-center gap-1.5 transition-colors font-medium"
              >
                <Plus size={13} className="text-primary" />
                <span>New Workspace</span>
              </button>

              {onOpenSettings && (
                <button
                  type="button"
                  onClick={() => {
                    onClose();
                    onOpenSettings();
                  }}
                  className="h-8 px-2.5 rounded-lg text-zinc-500 hover:text-zinc-300 hover:bg-white/5 flex items-center gap-1.5 transition-colors"
                >
                  <Settings size={13} />
                  <span>Manage Workspaces</span>
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
};

export default WorkspaceSwitcherModal;
