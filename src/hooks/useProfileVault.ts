import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import type { Server, Credential, SshKey, Folder, SavedCommand, Note } from "../types";
import type { ConfirmOptions } from "../ui/confirm";
import { pullSyncedShortcuts } from "../shortcuts/useShortcutsStore";

const appWindow = getCurrentWindow();

export interface ProfileVaultSettings {
  autoSync: boolean;
  syncIntervalMin: number;
}

export interface UseProfileVaultOptions {
  settings: ProfileVaultSettings;
  onAutostartSessions?: (sessions: Server[]) => void;
  /** Called after unlock when nothing was autostarted, with the full server list. */
  onStartupView?: (servers: Server[]) => void;
  onLoggedOut?: () => void;
}

export function useProfileVault(options: UseProfileVaultOptions) {
  const [loading, setLoading] = useState(true);
  const [isUnlocked, setIsUnlocked] = useState(false);
  const [activeProfile, setActiveProfile] = useState<string | null>(null);
  const [cloudSyncing, setCloudSyncing] = useState(false);
  const [lastSyncLabel, setLastSyncLabel] = useState<string | null>(null);

  const [servers, setServers] = useState<Server[]>([]);
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [sshKeys, setSshKeys] = useState<SshKey[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [commands, setCommands] = useState<SavedCommand[]>([]);
  const [notes, setNotes] = useState<Note[]>([]);
  const [logs, setLogs] = useState<{ id: string; msg: string; type: string; time: string }[]>([]);

  const addLog = useCallback((msg: string, type = "info") => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setLogs((prev) => [...prev.slice(-99), { id, msg, type, time: new Date().toLocaleTimeString() }]);
  }, []);

  const refreshServers = useCallback(async () => {
    try {
      setServers(await invoke<Server[]>("get_servers"));
    } catch (e) {
      addLog(`SYNC_SERVERS: ${e}`, "error");
    }
  }, [addLog]);

  const refreshCredentials = useCallback(async () => {
    try {
      setCredentials(await invoke<Credential[]>("get_credentials"));
    } catch (e) {
      addLog(`SYNC_CREDENTIALS: ${e}`, "error");
    }
  }, [addLog]);

  const refreshSshKeys = useCallback(async () => {
    try {
      setSshKeys(await invoke<SshKey[]>("get_ssh_keys"));
    } catch (e) {
      addLog(`SYNC_SSH_KEYS: ${e}`, "error");
    }
  }, [addLog]);

  const refreshFolders = useCallback(async () => {
    try {
      setFolders(await invoke<Folder[]>("get_folders"));
    } catch (e) {
      addLog(`SYNC_FOLDERS: ${e}`, "error");
    }
  }, [addLog]);

  const refreshCommands = useCallback(async () => {
    try {
      setCommands(await invoke<SavedCommand[]>("get_commands"));
    } catch (e) {
      addLog(`SYNC_COMMANDS: ${e}`, "error");
    }
  }, [addLog]);

  const refreshNotes = useCallback(async () => {
    try {
      setNotes(await invoke<Note[]>("get_notes"));
    } catch (e) {
      addLog(`SYNC_NOTES: ${e}`, "error");
    }
  }, [addLog]);

  const refreshAll = useCallback(async () => {
    await Promise.all([
      refreshServers(),
      refreshCredentials(),
      refreshSshKeys(),
      refreshFolders(),
      refreshCommands(),
      refreshNotes(),
      pullSyncedShortcuts(localStorage.getItem("subterm_last_workspace") || "default")
        .catch((e) => addLog(`SYNC_SHORTCUTS: ${e}`, "error")),
    ]);
  }, [addLog, refreshServers, refreshCredentials, refreshSshKeys, refreshFolders, refreshCommands, refreshNotes]);

  // Window size restoration on init
  useEffect(() => {
    const init = async () => {
      try {
        const savedW = localStorage.getItem("submarine-window-width");
        const savedH = localStorage.getItem("submarine-window-height");
        if (savedW && savedH) {
          try {
            await appWindow.setSize(new LogicalSize(parseInt(savedW), parseInt(savedH)));
          } catch (e) {
            console.error("Window resize failed", e);
          }
        }
        await appWindow.onResized(async () => {
          const size = await appWindow.innerSize();
          const logical = size.toLogical(await appWindow.scaleFactor());
          localStorage.setItem("submarine-window-width", logical.width.toString());
          localStorage.setItem("submarine-window-height", logical.height.toString());
        });
      } catch (e) {
        console.error("Initialization error", e);
        addLog(`INIT_EXCEPTION: ${e}`, "error");
      } finally {
        setLoading(false);
      }
    };
    init();
  }, [addLog]);

  // Cloud sync
  const handleCloudSync = useCallback(async () => {
    setCloudSyncing(true);
    try {
      const report = await invoke<{ pushed: number; pulled: number }>("sync_now");
      await refreshAll();
      setLastSyncLabel(`Last synced ${new Date().toLocaleTimeString()}`);
      addLog(`Cloud sync complete — pushed ${report.pushed}, pulled ${report.pulled}.`, "success");
    } catch (e) {
      const msg = String(e);
      if (/NO_TOKEN|invalid_token|Missing auth|401/i.test(msg)) {
        addLog("Cloud sync: not signed in. Open the Cloud panel from the profile picker and sign in first.", "error");
      } else if (/NO_PROFILE_OPEN|DB_NOT_OPEN|NO_KEY|NO_HLC/i.test(msg)) {
        addLog("Cloud sync: no profile open — unlock a profile first.", "error");
      } else {
        addLog(`Cloud sync failed: ${msg}`, "error");
      }
    } finally {
      setCloudSyncing(false);
    }
  }, [addLog, refreshAll]);

  // Auto-sync refs & debouncer
  const autoSyncBusy = useRef(false);
  const isUnlockedRef = useRef(isUnlocked);
  useEffect(() => {
    isUnlockedRef.current = isUnlocked;
  }, [isUnlocked]);
  const cloudSyncingRef = useRef(cloudSyncing);
  useEffect(() => {
    cloudSyncingRef.current = cloudSyncing;
  }, [cloudSyncing]);
  const lastSyncAt = useRef(0);
  const refreshAllRef = useRef(refreshAll);
  refreshAllRef.current = refreshAll;

  const quietSync = useCallback(async () => {
    if (autoSyncBusy.current || cloudSyncingRef.current) return;
    if (!isUnlockedRef.current) return;
    autoSyncBusy.current = true;
    setCloudSyncing(true);
    try {
      const report = await invoke<{ pushed: number; pulled: number }>("sync_now");
      if (report.pulled > 0) await refreshAllRef.current();
      setLastSyncLabel(`Last synced ${new Date().toLocaleTimeString()}`);
    } catch {
      // Silent background sync
    } finally {
      lastSyncAt.current = Date.now();
      autoSyncBusy.current = false;
      setCloudSyncing(false);
    }
  }, []);

  const bumpTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bumpSync = useCallback(() => {
    if (!options.settings.autoSync) return;
    if (bumpTimer.current) clearTimeout(bumpTimer.current);
    bumpTimer.current = setTimeout(() => {
      quietSync();
    }, 6000);
  }, [options.settings.autoSync, quietSync]);

  useEffect(() => {
    if (options.settings.autoSync) return;
    if (bumpTimer.current) {
      clearTimeout(bumpTimer.current);
      bumpTimer.current = null;
    }
  }, [options.settings.autoSync]);

  useEffect(() => {
    if (!isUnlocked || !options.settings.autoSync) return;
    const INTERVAL_MS = Math.max(1, options.settings.syncIntervalMin || 5) * 60 * 1000;
    const initial = setTimeout(() => {
      quietSync();
    }, 4000);
    const id = setInterval(() => {
      quietSync();
    }, INTERVAL_MS);
    let focusTimer: ReturnType<typeof setTimeout> | null = null;
    const onFocus = () => {
      if (document.visibilityState === "hidden") return;
      if (Date.now() - lastSyncAt.current < INTERVAL_MS) return;
      if (focusTimer) clearTimeout(focusTimer);
      focusTimer = setTimeout(() => {
        quietSync();
      }, 1500);
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      clearTimeout(initial);
      clearInterval(id);
      if (focusTimer) clearTimeout(focusTimer);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [isUnlocked, options.settings.autoSync, options.settings.syncIntervalMin, quietSync]);

  const removeServer = useCallback(
    async (id: number) => {
      try {
        await invoke("delete_server", { id });
        refreshServers();
        bumpSync();
        addLog("Server removed.", "info");
      } catch (e) {
        addLog(`DELETE_EXCEPTION: ${e}`, "error");
      }
    },
    [refreshServers, bumpSync, addLog]
  );

  const removeFolder = useCallback(
    async (id: number) => {
      try {
        await invoke("delete_folder", { id });
        await Promise.all([refreshFolders(), refreshServers()]);
        bumpSync();
        addLog("Folder removed.", "info");
      } catch (e) {
        addLog(`DELETE_EXCEPTION: ${e}`, "error");
      }
    },
    [refreshFolders, refreshServers, bumpSync, addLog]
  );

  const renameFolder = useCallback(
    async (id: number, name: string) => {
      try {
        await invoke("rename_folder", { id, name });
        await refreshFolders();
        bumpSync();
        addLog(`Folder renamed to "${name}".`, "info");
      } catch (e) {
        addLog(`RENAME_EXCEPTION: ${e}`, "error");
        throw e;
      }
    },
    [refreshFolders, bumpSync, addLog]
  );

  const handleProfileUnlocked = useCallback(
    async (name: string) => {
      try {
        localStorage.setItem("subterm_last_workspace", name);
      } catch {}
      setActiveProfile(name);
      setIsUnlocked(true);
      addLog(`Profile "${name}" unlocked.`, "success");
      refreshAll();
      invoke<{ signed_in: boolean; email: string | null }>("cloud_status")
        .then((s) => invoke("set_editor_label", { label: s.signed_in && s.email ? s.email : "" }))
        .catch(() => {});

      try {
        const list = await invoke<Server[]>("get_servers");
        const toStart = list.filter((s) => s.autostart && s.protocol !== "rdp");
        if (toStart.length > 0) {
          options.onAutostartSessions?.(toStart);
          addLog(`Autostart: opened ${toStart.length} node${toStart.length === 1 ? "" : "s"}.`, "info");
        } else {
          options.onStartupView?.(list);
        }
      } catch (e) {
        addLog(`AUTOSTART_LOAD_FAILED: ${e}`, "error");
      }
    },
    [addLog, refreshAll, options]
  );

  const handleLogout = useCallback(
    async (
      sessions: { id: string }[],
      confirmFn: (opts: ConfirmOptions) => Promise<boolean>,
      onConfirmLogout: () => void
    ) => {
      if (sessions.length > 0) {
        const ok = await confirmFn({
          title: "Switch profile?",
          message: `You have ${sessions.length} open SSH session${sessions.length === 1 ? "" : "s"}. Switching will disconnect ${sessions.length === 1 ? "it" : "them all"} and take you back to the profile picker.`,
          okLabel: "Switch",
          cancelLabel: "Stay",
          destructive: true,
        });
        if (!ok) return;
        for (const s of sessions) {
          try {
            await invoke("disconnect_session", { sessionId: s.id });
          } catch (e) {
            console.error("disconnect on logout failed:", e);
          }
        }
      }
      try {
        await invoke("close_profile");
      } catch (e) {
        addLog(`LOGOUT_EXCEPTION: ${e}`, "error");
      }

      setIsUnlocked(false);
      setActiveProfile(null);
      setServers([]);
      setCredentials([]);
      setSshKeys([]);
      setFolders([]);
      setCommands([]);
      onConfirmLogout();
      addLog("Profile locked.", "info");
    },
    [addLog]
  );

  return {
    loading,
    isUnlocked,
    setIsUnlocked,
    activeProfile,
    setActiveProfile,
    cloudSyncing,
    lastSyncLabel,
    servers,
    setServers,
    credentials,
    setCredentials,
    sshKeys,
    setSshKeys,
    folders,
    setFolders,
    commands,
    setCommands,
    notes,
    setNotes,
    logs,
    setLogs,
    addLog,
    refreshServers,
    refreshCredentials,
    refreshSshKeys,
    refreshFolders,
    refreshCommands,
    refreshNotes,
    refreshAll,
    handleCloudSync,
    bumpSync,
    removeServer,
    removeFolder,
    renameFolder,
    handleProfileUnlocked,
    handleLogout,
  };
}
