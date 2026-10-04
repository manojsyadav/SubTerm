import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import {
  Plus, X, RefreshCw, Terminal, Key, Trash2,
  ArrowLeftRight, Shield, User, Cpu, TerminalSquare, List, Edit2,
  StickyNote, Search, Square, Copy, ChevronLeft, MoreVertical, Radio,
  ChevronDown, Columns, Rows, LayoutGrid, Pin, PinOff, Command, Lock, LogOut, Activity, UserCheck, Check,
  Layers, Settings, Play
} from "lucide-react";
import { useBroadcast } from "./ui/broadcast";
import { useProfileIcon, getProfileIcon } from "./utils/profileMetadata";

import MasterUnlockPage from "./components/MasterUnlockPage";
import WorkspaceSwitcherModal from "./components/WorkspaceSwitcherModal";
import logoUrl from "./assets/logo.png";
import PasswordField from "./components/PasswordField";
import QuickConnectModal, { QuickAuth } from "./components/QuickConnectModal";
import { useConfirm, useTextPrompt } from "./ui/confirm";
import { RenameInput } from "./ui/renameInput";
import { useIsNarrow } from "./hooks/useViewport";
import { Sidebar } from "./components/Sidebar";
import { NodeGrid } from "./components/NodeGrid";
import AddNodePanel from "./components/AddNodePanel";
import { renderServerIcon } from "./components/ServerIcon";
import TerminalView from "./components/TerminalView";
import SettingsPanel from "./components/SettingsPanel";
import { NetworkToolsModal } from "./components/NetworkToolsModal";
import { SessionView } from "./components/SessionView";
import MonitoringPanel from "./components/MonitoringPanel";
import { ErrorBoundary } from "./ui/ErrorBoundary";
import { useGlobalShortcuts } from "./hooks/useGlobalShortcuts";
import { CommandPalette } from "./components/CommandPalette";
import { getActiveShortcut } from "./shortcuts";
import { useProfileVault } from "./hooks/useProfileVault";
import { useSessionManager, Session } from "./hooks/useSessionManager";
import { useWallManager, WallItem, SessionTerm } from "./hooks/useWallManager";
import { parseSnippetVariables } from "./utils/snippetTemplate";
import { SnippetParamModal } from "./components/SnippetParamModal";

const appWindow = getCurrentWindow();

const hexToRgb = (hex: string) => {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `${r} ${g} ${b}`;
};

function LockedVaultNotice({ onUnlock, onOpenLocal }: { onUnlock: () => void; onOpenLocal: () => void }) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center p-8 text-center bg-radial from-amber-500/[0.03] via-transparent to-transparent animate-in fade-in duration-300">
      <div className="w-16 h-16 rounded-2xl bg-amber-500/10 border border-amber-500/20 flex items-center justify-center text-amber-400 mb-4 shadow-xl shadow-amber-500/5">
        <Lock size={28} />
      </div>
      <h3 className="text-lg font-bold text-white tracking-tight mb-1.5">Vault is Locked</h3>
      <p className="text-xs text-zinc-400 max-w-sm mb-6 leading-relaxed">
        Your remote servers, SSH credentials, and snippets are protected by your master password. Enter your Master Password to unlock your workspace.
      </p>
      <div className="flex items-center gap-3">
        <button
          onClick={onUnlock}
          className="h-9 px-5 rounded-xl bg-primary text-black font-bold text-xs hover:bg-primary/90 transition-all flex items-center gap-2 shadow-lg shadow-primary/20 hover:scale-[1.02] active:scale-[0.98]"
        >
          <Lock size={13} />
          <span>Unlock Vault</span>
        </button>
        <button
          onClick={onOpenLocal}
          className="h-9 px-4 rounded-xl bg-white/[0.05] hover:bg-white/[0.1] border border-white/10 text-zinc-300 hover:text-white font-medium text-xs transition-all flex items-center gap-2"
        >
          <Terminal size={13} className="text-emerald-400" />
          <span>Open Local Shell</span>
        </button>
      </div>
    </div>
  );
}

function DesktopApp() {
  const broadcast = useBroadcast();
  const [broadcastMenuOpen, setBroadcastMenuOpen] = useState(false);

  const confirm = useConfirm();
  const textPrompt = useTextPrompt();

  const [appSettings, setAppSettings] = useState({
    primaryColor: localStorage.getItem('subterm-primary-color') || localStorage.getItem('submarine-primary-color') || '#60a5fa',
    backgroundColor: localStorage.getItem('subterm-bg-color') || localStorage.getItem('submarine-bg-color') || '#0a0a0c',
    terminalFontSize: parseInt(localStorage.getItem('subterm-terminal-font-size') || localStorage.getItem('submarine-terminal-font-size') || '14'),
    autoSync: (localStorage.getItem('subterm-auto-sync') || localStorage.getItem('submarine-auto-sync')) !== 'off',
    syncIntervalMin: Math.max(1, parseInt(localStorage.getItem('subterm-sync-interval-min') || localStorage.getItem('submarine-sync-interval-min') || '5', 10) || 5),
    cloudApiBase: localStorage.getItem('subterm-cloud-api-base') || localStorage.getItem('submarine-cloud-api-base') || '',
    autoCloseOnExit: localStorage.getItem('subterm-auto-close-on-exit') === 'true',
    downloadAuditOnExit: localStorage.getItem('subterm-download-audit-on-exit') === 'true',
    commandDismissSec: Math.max(0, parseInt(localStorage.getItem('subterm-command-dismiss-sec') || '4', 10) ?? 4),
    autoCopyOutput: localStorage.getItem('subterm-auto-copy-output') === 'true',
    showAuditDownload: localStorage.getItem('subterm-show-audit-download') !== 'false',
    showAuditCopy: localStorage.getItem('subterm-show-audit-copy') !== 'false',
    enableMonitoring: (localStorage.getItem('subterm-enable-monitoring') || localStorage.getItem('submarine-enable-monitoring')) !== 'false',
    terminalWebgl: localStorage.getItem('subterm-terminal-webgl') !== 'false',
    rightClickAction: localStorage.getItem('subterm-right-click-action') || 'menu',
    copyOnSelect: localStorage.getItem('subterm-copy-on-select') !== 'false',
    terminalTheme: localStorage.getItem('subterm-terminal-theme') || 'subterm-dark',
    terminalCursorStyle: localStorage.getItem('subterm-terminal-cursor-style') || 'block',
    terminalCursorBlink: localStorage.getItem('subterm-terminal-cursor-blink') !== 'false',
    terminalBell: localStorage.getItem('subterm-terminal-bell') || 'visual',
    terminalFontFamily: localStorage.getItem('subterm-terminal-font-family') || 'JetBrains Mono, Menlo, Monaco, Consolas, "Courier New", monospace',
    terminalLineHeight: parseFloat(localStorage.getItem('subterm-terminal-line-height') || '1.15'),
    terminalScrollback: parseInt(localStorage.getItem('subterm-terminal-scrollback') || '5000', 10),
    sshKeepaliveSec: parseInt(localStorage.getItem('subterm-ssh-keepalive-sec') || '20', 10),
    quickAccessServerIds: (() => {
      try {
        const raw = localStorage.getItem('subterm-quick-access-servers');
        if (raw) return JSON.parse(raw);
      } catch {}
      return [];
    })() as number[],
  });

  const wallManager = useWallManager();
  const {
    wallItems, setWallItems, wallCols, setWallCols,
    wallPickerOpen, setWallPickerOpen,
    sessionTerminals, sessionActiveTerm,
    handleTerminalsChange, wallHasTerminal,
    pinTerminalToWall, unpinTerminalFromWall, unpinSessionFromWall,
  } = wallManager;

  const vaultRef = useRef<any>(null);

  const sessionManager = useSessionManager({
    onSessionClosed: (sid) => {
      broadcast.removeSession(sid);
      unpinSessionFromWall(sid);
    },
    onAddLog: (msg, type) => vaultRef.current?.addLog(msg, type),
    onQuickNodeSaved: () => {
      vaultRef.current?.refreshServers();
      vaultRef.current?.bumpSync();
    },
  });

  const {
    sessions, setSessions,
    activeView, setActiveView,
    sessionStatuses, setSessionStatuses,
    handleSessionStatus,
    tabMenu, setTabMenu,
    mergedSessionIds, setMergedSessionIds,
    sessionSplitOrientation, setSessionSplitOrientation,
    sessionSplitRatios, setSessionSplitRatios,
    mobileSessionPickerOpen, setMobileSessionPickerOpen,
    getCloseHandler, closeSession,
    openServer, openMultipleServers, openQuickConnect, openLocalTerminal,
  } = sessionManager;

  const [tabNames, setTabNames] = useState<Record<string, string>>({});

  const vault = useProfileVault({
    settings: {
      autoSync: appSettings.autoSync,
      syncIntervalMin: appSettings.syncIntervalMin,
    },
    onAutostartSessions: (toStart) => {
      const newSessions: Session[] = toStart.map((s) => ({
        id: `session-${s.id}`,
        serverId: s.id,
        serverName: s.name,
        mirrors: s.mirrors,
      }));
      setSessions((prev) => {
        const seen = new Set(prev.map((p) => p.id));
        const fresh = newSessions.filter((n) => !seen.has(n.id));
        return [...prev, ...fresh];
      });
      setActiveView(newSessions[0].id);
    },
    onLoggedOut: () => {
      setSessions([]);
      setActiveView("nodes");
    },
  });

  const {
    loading, isUnlocked, setIsUnlocked, activeProfile, setActiveProfile,
    cloudSyncing, lastSyncLabel,
    servers, setServers, credentials, setCredentials,
    sshKeys, setSshKeys, folders, setFolders,
    commands, setCommands, notes, setNotes,
    logs, setLogs, addLog,
    refreshServers, refreshCredentials, refreshSshKeys,
    refreshFolders, refreshCommands, refreshNotes, refreshAll,
    handleCloudSync, bumpSync,
    removeServer, removeFolder, renameFolder,
    handleProfileUnlocked, handleLogout: vaultLogout,
  } = vault;

  const [activeSnippetParam, setActiveSnippetParam] = useState<{
    raw: string;
    title?: string;
    targetSessionId?: string;
  } | null>(null);

  const handleExecuteSnippet = useCallback((rawCommand: string, title?: string, targetSessionId?: string) => {
    const target = targetSessionId || (activeView.startsWith("session-") ? activeView : sessions[0]?.id);
    if (!target) {
      addLog("No active session to run command in. Open a server first.", "warning");
      return;
    }

    const vars = parseSnippetVariables(rawCommand);
    if (vars.length > 0) {
      setActiveSnippetParam({ raw: rawCommand, title, targetSessionId: target });
      return;
    }

    // Direct execution
    const text = rawCommand.endsWith("\n") || rawCommand.endsWith("\r") ? rawCommand : rawCommand + "\n";
    window.dispatchEvent(new CustomEvent(`submarine-terminal-exec-${target}`, { detail: { text } }));
  }, [activeView, sessions, addLog]);

  const [availableShells, setAvailableShells] = useState<{ id: string; name: string; command: string }[]>([]);
  const [shellMenuOpen, setShellMenuOpen] = useState(false);
  const [profileDropdownOpen, setProfileDropdownOpen] = useState(false);
  const [isWorkspaceSwitcherOpen, setIsWorkspaceSwitcherOpen] = useState(false);
  const [isUnlockModalOpen, setIsUnlockModalOpen] = useState(false);
  const { icon: profileIcon } = useProfileIcon(activeProfile);

  useEffect(() => {
    invoke<{ id: string; name: string; command: string }[]>("get_available_local_shells")
      .then((shells) => setAvailableShells(shells || []))
      .catch(() => {});
  }, []);

  // Terminal Triggers' "log" action dispatches this from TerminalView (a
  // leaf component several layers below) instead of threading addLog down
  // through SessionView — same decoupled-signal pattern as the existing
  // `submarine-open-copilot-${sessionId}` window events.
  useEffect(() => {
    const onTriggerLog = (e: Event) => {
      const detail = (e as CustomEvent<{ msg: string; type: "info" | "success" | "warning" | "error" }>).detail;
      if (detail) addLog(detail.msg, detail.type);
    };
    window.addEventListener("subterm-add-log", onTriggerLog);
    return () => window.removeEventListener("subterm-add-log", onTriggerLog);
  }, [addLog]);

  // Local-first launch: open default local shell on startup so user can run commands immediately
  useEffect(() => {
    if (sessions.length === 0) {
      openLocalTerminal();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  vaultRef.current = vault;

  const handleLogout = () => vaultLogout(sessions, confirm, () => {
    setSessions([]);
    setActiveView("nodes");
  });

  const handleLockProfile = async () => {
    const remoteSessions = sessions.filter((s) => !s.isLocal);
    if (remoteSessions.length > 0) {
      const ok = await confirm({
        title: "Lock SubTerm Vault?",
        message: `You have ${remoteSessions.length} open remote SSH session${remoteSessions.length === 1 ? "" : "s"}. Locking will disconnect them.`,
        okLabel: "Lock Vault",
        cancelLabel: "Cancel",
        destructive: true,
      });
      if (!ok) return;
      for (const s of remoteSessions) {
        try { await invoke("disconnect_session", { sessionId: s.id }); } catch {}
      }
    }
    try { await invoke("close_profile"); } catch {}
    setIsUnlocked(false);
    const remainingLocal = sessions.filter((s) => s.isLocal);
    if (remainingLocal.length === 0) {
      openLocalTerminal();
    } else {
      setSessions(remainingLocal);
      setActiveView(remainingLocal[0].id);
    }
    setServers([]);
    setCredentials([]);
    setSshKeys([]);
    setFolders([]);
    setCommands([]);
    setNotes([]);
    addLog(`Vault locked. Local terminal remains active.`, "info");
  };

  const [availableProfiles, setAvailableProfiles] = useState<string[]>([]);

  const reloadAvailableProfiles = useCallback(async () => {
    try {
      const list = await invoke<string[]>("list_profiles");
      setAvailableProfiles(list);
    } catch {}
  }, []);

  useEffect(() => {
    if (isUnlocked) {
      reloadAvailableProfiles();
    }
  }, [isUnlocked, reloadAvailableProfiles, activeProfile]);

  const switchWorkspace = async (targetProfile: string) => {
    if (targetProfile === activeProfile) return;
    setProfileDropdownOpen(false);

    if (sessions.length > 0) {
      const ok = await confirm({
        title: `Switch to "${targetProfile}"?`,
        message: `You have ${sessions.length} open SSH session${sessions.length === 1 ? "" : "s"}. Switching workspace will disconnect them.`,
        okLabel: "Switch Workspace",
        cancelLabel: "Cancel",
        destructive: true,
      });
      if (!ok) return;
    }

    for (const s of sessions) {
      try { await invoke("disconnect_session", { sessionId: s.id }); } catch {}
    }
    setSessions([]);
    setActiveView("nodes");

    try {
      await invoke("switch_profile_seamless", { targetName: targetProfile });
      await handleProfileUnlocked(targetProfile);
      addLog(`Switched to workspace "${targetProfile}".`, "success");
    } catch (err: any) {
      const msg = String(err);
      if (msg.includes("NO_SESSION_PASSWORD") || msg.toLowerCase().includes("decrypt") || msg.includes("PASSWORD")) {
        throw err;
      } else {
        addLog(`Failed to switch workspace: ${msg}`, "error");
        throw err;
      }
    }
  };

  const handleSwitchProfile = () => {
    setIsWorkspaceSwitcherOpen(true);
  };

  const handleSignOut = () => {
    vaultLogout(sessions, confirm, () => {
      setSessions([]);
      setActiveView("nodes");
    });
  };

  const handleOpenMultipleServers = (serversToOpen: any[]) => {
    openMultipleServers(serversToOpen, (newIds) => {
      broadcast.selectAll(newIds);
      addLog(`Fleet: Launched ${newIds.length} sessions with broadcast enabled`, "success");
    });
  };

  // Maximize state mirrored from the OS window so the title-bar button can
  // swap its icon (single square = maximize, overlapping squares = restore)
  // and so the double-click drag-region handler always knows the correct
  // direction to toggle. Tauri's onResized event fires for every maximize /
  // restore / OS-driven snap, so it's the authoritative signal.
  const [isMaximized, setIsMaximized] = useState(false);
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    appWindow.isMaximized().then(setIsMaximized).catch(() => {});
    appWindow.onResized(() => {
      appWindow.isMaximized().then(setIsMaximized).catch(() => {});
    }).then((fn) => { unlisten = fn; }).catch(() => {});
    return () => { if (unlisten) unlisten(); };
  }, []);
  const toggleMaximize = useCallback(() => {
    appWindow.toggleMaximize().catch(console.error);
  }, []);

  // Persist the user's current folder across NodeGrid unmount/remount cycles.
  // NodeGrid is conditionally rendered (`activeView === "nodes" && ...`), so
  // its local state used to vanish the moment the user opened a session tab
  // — and they'd come back to the root folder view instead of the folder
  // they were browsing. Lifting the state here keeps the position sticky
  // for the whole profile session.
  const [activeFolderId, setActiveFolderId] = useState<number | null>(null);
  const [isPanelOpen, setIsPanelOpen] = useState(false);
  const [isImportModalRequested, setIsImportModalRequested] = useState(false);
  const [isNetworkToolsOpen, setIsNetworkToolsOpen] = useState(false);
  const [isQuickConnectOpen, setIsQuickConnectOpen] = useState(false);
  const [isCommandPaletteOpen, setIsCommandPaletteOpen] = useState(false);
  const [isCommandPanelOpen, setIsCommandPanelOpen] = useState(false);
  const [editCommandData, setEditCommandData] = useState<{ id: number | null, title: string, content: string }>({ id: null, title: "", content: "" });

  const [isNotePanelOpen, setIsNotePanelOpen] = useState(false);
  const [editNoteData, setEditNoteData] = useState<{ id: number | null, title: string, body: string }>({ id: null, title: "", body: "" });
  // Shared query across Library sub-tabs. Persisting the string across a
  // Commands↔Notes switch lets the user narrow both lists with the same
  // typing — filter is applied against whichever array is active.
  const [libraryQuery, setLibraryQuery] = useState("");
  const [libraryTab, setLibraryTab] = useState<"commands" | "notes">("commands");

  const [isCredPanelOpen, setIsCredPanelOpen] = useState(false);
  const [editCredData, setEditCredData] = useState<any>({ id: null, name: "", auth_type: "password", username: "", password: "", key_id: null });
  
  const [isKeyPanelOpen, setIsKeyPanelOpen] = useState(false);
  const [editKeyData, setEditKeyData] = useState<any>({ id: null, name: "", public_key: "", private_key: "", passphrase: "" });
  const [formError, setFormError] = useState("");

  const defaultNode = {
    id: null as number | null,
    name: "", host: "", port: 22, username: "", password: "",
    // "custom_pass" picked as default because most users adding a new
    // server have a password in hand; the vault option is mainly useful
    // *after* they've saved a few credentials and want to reuse one.
    authType: "custom_pass", credentialId: "", folderId: "", keyId: "",
    proxyType: "none", proxyHost: "", proxyPort: 1080,
    tunnels: [] as { local: string, remote: string, type: string }[],
    autostart: false,
    mirrors: [] as { local: string, remote: string, soft_delete: boolean, excludes: string[], conflict_resolution: string }[],
    color: null as string | null,
    // Free-form per-node description / runbook text. Lives on the server row
    // in the encrypted vault. Empty string by default — the textarea in the
    // panel renders a placeholder when blank.
    notes: "" as string,
    // Commands auto-typed into the FIRST terminal on the INITIAL connect only
    // (never on reconnect or extra shells). Newline-separated. Empty = off.
    runOnConnect: "" as string,
    // ProxyJump: id (as a string, like credentialId/folderId) of another node
    // to bounce through. Empty = connect directly. parseInt'd to a number (or
    // null) at save time.
    jumpHostId: "" as string,
    // Read-only attribution shown in the edit panel: who last edited this node
    // (email, when set) + the HLC stamp of that edit. Null on a new node.
    editedBy: null as string | null,
    updatedAt: null as string | null,
    // True only after the user typed into the password field on this form
    // instance. If still false at save time, the backend uses
    // `preserve_password` to keep the existing DB column. Without this
    // flag a transient `reveal_server_password` failure would silently
    // wipe the stored secret.
    password_dirty: false,
    is_production: false,
    icon: "server",
    forward_agent: false,
  };

  // Live width-based "narrow viewport" flag. Replaces a one-shot UA check
  // that couldn't see a desktop window being shrunk by the user — the new
  // hook updates on every resize so layout swaps follow the actual width.
  const isMobile = useIsNarrow();

  const [newNode, setNewNode] = useState(defaultNode);

  useEffect(() => {
    const rgb = hexToRgb(appSettings.primaryColor);
    document.documentElement.style.setProperty('--primary', rgb);
    document.documentElement.style.setProperty('--primary-hex', appSettings.primaryColor);
    document.documentElement.style.setProperty('--background', appSettings.backgroundColor);
    localStorage.setItem('subterm-primary-color', appSettings.primaryColor);
    localStorage.setItem('subterm-bg-color', appSettings.backgroundColor);
    localStorage.setItem('subterm-terminal-font-size', appSettings.terminalFontSize.toString());
    localStorage.setItem('subterm-auto-sync', appSettings.autoSync ? 'on' : 'off');
    localStorage.setItem('subterm-sync-interval-min', String(appSettings.syncIntervalMin));
    localStorage.setItem('subterm-cloud-api-base', appSettings.cloudApiBase);
    localStorage.setItem('submarine-primary-color', appSettings.primaryColor);
    localStorage.setItem('submarine-bg-color', appSettings.backgroundColor);
    localStorage.setItem('submarine-terminal-font-size', appSettings.terminalFontSize.toString());
    localStorage.setItem('submarine-auto-sync', appSettings.autoSync ? 'on' : 'off');
    localStorage.setItem('submarine-sync-interval-min', String(appSettings.syncIntervalMin));
    localStorage.setItem('submarine-cloud-api-base', appSettings.cloudApiBase);
    localStorage.setItem('subterm-auto-close-on-exit', appSettings.autoCloseOnExit ? 'true' : 'false');
    localStorage.setItem('subterm-download-audit-on-exit', appSettings.downloadAuditOnExit ? 'true' : 'false');
    localStorage.setItem('subterm-command-dismiss-sec', String(appSettings.commandDismissSec));
    localStorage.setItem('subterm-auto-copy-output', appSettings.autoCopyOutput ? 'true' : 'false');
    localStorage.setItem('subterm-show-audit-download', appSettings.showAuditDownload ? 'true' : 'false');
    localStorage.setItem('subterm-show-audit-copy', appSettings.showAuditCopy ? 'true' : 'false');
    localStorage.setItem('subterm-enable-monitoring', appSettings.enableMonitoring ? 'true' : 'false');
    localStorage.setItem('submarine-enable-monitoring', appSettings.enableMonitoring ? 'true' : 'false');
    localStorage.setItem('subterm-terminal-webgl', appSettings.terminalWebgl !== false ? 'true' : 'false');
    localStorage.setItem('subterm-right-click-action', appSettings.rightClickAction || 'menu');
    localStorage.setItem('subterm-copy-on-select', appSettings.copyOnSelect !== false ? 'true' : 'false');
    localStorage.setItem('subterm-terminal-theme', appSettings.terminalTheme || 'subterm-dark');
    localStorage.setItem('subterm-terminal-cursor-style', appSettings.terminalCursorStyle || 'block');
    localStorage.setItem('subterm-terminal-cursor-blink', appSettings.terminalCursorBlink !== false ? 'true' : 'false');
    localStorage.setItem('subterm-terminal-bell', appSettings.terminalBell || 'visual');
    localStorage.setItem('subterm-terminal-font-family', appSettings.terminalFontFamily || 'JetBrains Mono, Menlo, Monaco, Consolas, "Courier New", monospace');
    localStorage.setItem('subterm-terminal-line-height', String(appSettings.terminalLineHeight || 1.15));
    localStorage.setItem('subterm-terminal-scrollback', String(appSettings.terminalScrollback || 5000));
    localStorage.setItem('subterm-ssh-keepalive-sec', String(appSettings.sshKeepaliveSec || 20));
    invoke('set_ssh_keepalive_interval', { secs: appSettings.sshKeepaliveSec || 20 }).catch(console.error);
    localStorage.setItem('subterm-quick-access-servers', JSON.stringify(appSettings.quickAccessServerIds || []));
    if (!appSettings.enableMonitoring) {
      if (activeView === 'monitor') {
        setActiveView('nodes');
      }
      invoke('monitor_pause_all').catch(console.error);
    }
    invoke('cloud_set_api_base', { url: appSettings.cloudApiBase }).catch(console.error);
    // Tell already-mounted terminals to re-fit with the new font size.
    // Without this dispatch the listener in TerminalView is dead code and
    // users have to close+reopen every terminal to see a size change.
    window.dispatchEvent(new CustomEvent('subterm-settings-changed'));
    window.dispatchEvent(new CustomEvent('submarine-settings-changed'));
  }, [appSettings]);

  useGlobalShortcuts({
    enabled: isUnlocked,
    sessions,
    activeView,
    setActiveView,
    onCloseSession: (sessId) => getCloseHandler(sessId)(),
    onOpenCommandPalette: () => isUnlocked && setIsCommandPaletteOpen(prev => !prev),
    onOpenLocalTerminal: openLocalTerminal,
  });

  // Window-close guard. Keep `sessions` mirrored into a ref so the close
  // handler (which is registered ONCE inside useEffect, capturing snapshot
  // state) always sees the latest array — without this we'd race against
  // the user opening/closing tabs and either over- or under-confirm.
  const sessionsRef = useRef(sessions);
  useEffect(() => { sessionsRef.current = sessions; }, [sessions]);

  // Intercept BOTH the in-app X button (which calls appWindow.close()) AND
  // OS-level closes (Alt+F4, taskbar context-menu close, system shutdown).
  // Both paths fire `onCloseRequested`. Showing a confirm when at least one
  // SSH session is connected prevents the most painful misclick: closing
  // the window mid-deploy / mid-edit and losing the terminal scrollback +
  // any in-flight SFTP transfers in one go. `appWindow.destroy()` bypasses
  // the close-requested hook so confirming actually exits — calling
  // `close()` again here would loop us straight back into the same prompt.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    appWindow.onCloseRequested(async (event) => {
      const n = sessionsRef.current.length;
      if (n === 0) return; // nothing to lose — let the close proceed
      event.preventDefault();
      const ok = await confirm({
        title: "Close SubTerm?",
        message: `${n} SSH session${n === 1 ? "" : "s"} ${n === 1 ? "is" : "are"} still connected. Closing now disconnects ${n === 1 ? "it" : "them all"} and aborts any in-flight transfers.`,
        okLabel: "Close anyway",
        cancelLabel: "Stay",
        destructive: true,
      });
      if (ok) {
        await appWindow.destroy();
      }
    }).then((fn) => { unlisten = fn; });
    return () => { if (unlisten) unlisten(); };
  }, [confirm]);

  const handleEditNode = async (server: any) => {
    // Servers come back from get_servers with `has_password` (boolean) but
    // no plaintext. Reveal the secret only when the user opens the edit
    // sheet — that way the password never sits in renderer memory during
    // the normal grid/sidebar lifetime.
    let revealedPassword = "";
    if (server.has_password) {
      try {
        const v = await invoke<string | null>("reveal_server_password", { id: server.id });
        revealedPassword = v || "";
      } catch (e) {
        addLog(`REVEAL_PASSWORD_FAILED: ${e}`, "error");
      }
    }
    setNewNode({
      id: server.id,
      name: server.name || "",
      host: server.host || "",
      port: server.port || 22,
      username: server.username || "",
      password: revealedPassword,
      authType: server.auth_type || (server.credential_id ? "vault" : "custom_pass"),
      credentialId: server.credential_id?.toString() || "",
      folderId: server.folder_id?.toString() || "",
      keyId: server.key_id?.toString() || "",
      proxyType: server.proxy_type || "none",
      proxyHost: server.proxy_host || "",
      proxyPort: server.proxy_port || 1080,
      tunnels: server.tunnels ? JSON.parse(server.tunnels) : [],
      autostart: !!server.autostart,
      mirrors: (() => {
        try { return JSON.parse(server.mirrors || "[]"); } catch { return []; }
      })(),
      color: server.color ?? null,
      notes: server.notes || "",
      runOnConnect: server.run_on_connect || "",
      jumpHostId: server.jump_host_id?.toString() || "",
      // Attribution (read-only display): who last edited + the HLC stamp.
      editedBy: server.edited_by ?? null,
      updatedAt: server.updated_at ?? null,
      // Starts clean — only flips true if the user types into the password
      // field. Save handler reads this to decide between `preserve_password`
      // and a real overwrite.
      password_dirty: false,
      is_production: Boolean(server.is_production),
      icon: server.icon || "server",
      forward_agent: Boolean(server.forward_agent),
    });
    setIsPanelOpen(true);
  };

  // Render helper, NOT a component — it is invoked as `{TitleBar()}` below,
  // never as `<TitleBar />`. Rendering it as a JSX element would give it a
  // fresh function identity on every DesktopApp render, so React would treat
  // it as a new component type and fully unmount + remount the whole title-bar
  // subtree (tab strip, pickers, window controls) on every render — throwing
  // away tab-strip scroll position and focus, and re-doing all that DOM work,
  // on every connect/reconnect and tab switch. Calling it inlines its JSX into
  // DesktopApp's own output with no component boundary, so React reconciles in
  const quickAccessServersList = useMemo(() => {
    const ids: number[] = appSettings.quickAccessServerIds || [];
    if (ids.length > 0) {
      return ids
        .map(id => servers.find(s => s.id === id))
        .filter((s): s is NonNullable<typeof s> => Boolean(s))
        .slice(0, 5);
    }
    return servers.slice(0, Math.min(3, servers.length));
  }, [appSettings.quickAccessServerIds, servers]);

  // place. It closes over DesktopApp scope and uses no hooks, so a plain call
  // is safe. Do NOT convert this to `<TitleBar />`.
  const TitleBar = () => (
    <div
      data-tauri-drag-region
      onDoubleClick={(e) => {
        // Native double-click-to-maximize on the drag region matches OS
        // expectations on Windows/macOS/KDE. Tauri's drag region itself
        // doesn't dispatch this for us, so we wire it explicitly. Skip
        // when the click landed on an interactive child (tabs, buttons)
        // since those mark themselves with `no-drag`.
        const target = e.target as HTMLElement;
        if (target.closest('.no-drag')) return;
        toggleMaximize();
      }}
      className="h-10 bg-[#0d0d10] border-b border-white/5 flex items-center justify-between px-3 select-none shrink-0 z-50 drag absolute top-0 left-0 right-0"
    >
      {/* Logo + product name: hidden on phones to give the tab strip the
          whole row. Desktop keeps the original 75 px left padding for
          macOS traffic lights, plus the icon and brand. */}
      <div className="hidden sm:flex items-center gap-2 pr-2 pl-[75px] md:pl-2 shrink-0" data-tauri-drag-region>
        <img src={logoUrl} alt="" draggable={false} className="h-6 w-auto max-w-[24px] object-contain select-none" />
        <span className="text-[12px] font-bold text-white tracking-tight">SubTerm</span>
      </div>

      {/* Profile / Unlock Pill (Top Left) */}
      <div className="hidden sm:flex items-center no-drag mr-1">
        {!isUnlocked ? (
          <button
            type="button"
            onClick={() => setIsUnlockModalOpen(true)}
            title="Unlock Vault"
            className="h-7 px-2.5 rounded-md bg-amber-500/10 hover:bg-amber-500/20 border border-amber-500/30 text-amber-300 hover:text-amber-200 text-[11px] font-semibold flex items-center gap-1.5 transition-all shadow-sm shadow-amber-500/5 group"
          >
            <Lock size={12} className="text-amber-400 group-hover:scale-110 transition-transform" />
            <span>Unlock</span>
          </button>
        ) : (
          <div className="relative">
            <button
              type="button"
              onClick={() => setProfileDropdownOpen((prev) => !prev)}
              title={`Workspace: ${activeProfile || "Default"}`}
              className="h-7 px-2.5 rounded-md bg-white/[0.05] hover:bg-white/[0.1] border border-white/10 text-zinc-200 hover:text-white text-[11px] font-medium flex items-center gap-1.5 transition-all shadow-sm"
            >
              <span className="text-xs select-none">{profileIcon || "💼"}</span>
              <span className="font-semibold max-w-[100px] truncate">{activeProfile || "Workspace"}</span>
              <ChevronDown size={11} className={`text-zinc-400 transition-transform ${profileDropdownOpen ? "rotate-180" : ""}`} />
            </button>

            {profileDropdownOpen && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setProfileDropdownOpen(false)} />
                <div className="absolute left-0 top-full mt-1.5 w-64 py-1.5 bg-[#141418] border border-white/10 rounded-xl shadow-2xl z-50 animate-in fade-in zoom-in-95 duration-150 text-[11.5px]">
                  {/* Header info */}
                  <div className="px-3 py-2 border-b border-white/5 flex items-center gap-2.5">
                    <div className="w-8 h-8 rounded-lg bg-white/5 border border-white/10 flex items-center justify-center text-base shrink-0 select-none">
                      {profileIcon || "💼"}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="font-bold text-white text-xs truncate">{activeProfile || "Default Workspace"}</div>
                      <div className="text-[10px] text-zinc-400 flex items-center gap-1">
                        <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 shrink-0" />
                        <span>Active Workspace</span>
                      </div>
                    </div>
                  </div>

                  {/* Switch Workspace */}
                  <div className="p-1">
                    <button
                      type="button"
                      onClick={() => {
                        setProfileDropdownOpen(false);
                        setIsWorkspaceSwitcherOpen(true);
                      }}
                      className="w-full text-left px-2.5 py-1.5 rounded-lg hover:bg-white/5 text-zinc-300 hover:text-white flex items-center justify-between transition-colors font-medium"
                    >
                      <div className="flex items-center gap-2">
                        <ArrowLeftRight size={13} className="text-primary" />
                        <span>Switch Workspace</span>
                      </div>
                      <kbd className="text-[9px] bg-black/40 px-1 py-0.5 rounded text-zinc-500 font-mono border border-white/5">1-click</kbd>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setProfileDropdownOpen(false);
                        setActiveView("settings");
                      }}
                      className="w-full text-left px-2.5 py-1.5 rounded-lg hover:bg-white/5 text-zinc-300 hover:text-white flex items-center gap-2 transition-colors font-medium"
                    >
                      <Settings size={13} className="text-zinc-400" />
                      <span>Workspace Settings</span>
                    </button>
                    <div className="border-t border-white/5 my-1" />
                    <button
                      type="button"
                      onClick={() => {
                        setProfileDropdownOpen(false);
                        handleLockProfile();
                      }}
                      className="w-full text-left px-2.5 py-1.5 rounded-lg hover:bg-amber-500/10 text-amber-300/90 hover:text-amber-300 flex items-center gap-2 transition-colors font-medium"
                    >
                      <Lock size={13} />
                      <span>Lock Vault</span>
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {/* Top Bar Bookmarks Strip: Local Shell + Quick Access Servers */}
      <div className="hidden sm:flex items-center gap-1 px-1.5 py-0.5 bg-white/[0.03] border border-white/5 rounded-lg no-drag shrink-0 mx-1">
        {/* Pinned Bookmark: Local Shell with Shell Flavor Selector */}
        <div className="relative flex items-center">
          <button
            type="button"
            onClick={() => openLocalTerminal()}
            title={`Open or Focus Local Terminal (${getActiveShortcut("openLocalTerminal")})`}
            className={`h-7 pl-2.5 pr-1.5 rounded-l-md flex items-center gap-1.5 text-[11px] font-medium transition-all ${
              activeView.startsWith("session-local-")
                ? "bg-emerald-500/20 text-emerald-300 border-y border-l border-emerald-500/40 shadow-sm font-semibold"
                : "text-zinc-400 hover:text-emerald-300 hover:bg-emerald-500/10 border-y border-l border-transparent hover:border-emerald-500/20"
            }`}
          >
            <Terminal size={12} className={activeView.startsWith("session-local-") ? "text-emerald-400" : "text-emerald-500/80"} />
            <span className="whitespace-nowrap tracking-tight font-medium">Local Shell</span>
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setShellMenuOpen((v) => !v);
            }}
            title="Select Shell (PowerShell, CMD, Git Bash, WSL)"
            className={`h-7 px-1.5 rounded-r-md flex items-center justify-center transition-all ${
              activeView.startsWith("session-local-")
                ? "bg-emerald-500/20 text-emerald-300 border-y border-r border-emerald-500/40 hover:bg-emerald-500/30"
                : "text-zinc-500 hover:text-emerald-300 hover:bg-emerald-500/10 border-y border-r border-transparent hover:border-emerald-500/20"
            }`}
          >
            <ChevronDown size={11} className={`transition-transform duration-150 ${shellMenuOpen ? "rotate-180" : ""}`} />
          </button>

          {/* Dropdown Menu */}
          {shellMenuOpen && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setShellMenuOpen(false)} />
              <div className="absolute left-0 top-full mt-1 w-64 py-1.5 bg-[#141418] border border-white/10 rounded-lg shadow-2xl z-50 animate-in fade-in zoom-in-95 duration-150 text-[11px]">
                <div className="px-3 py-1 text-[10px] font-bold uppercase tracking-wider text-zinc-400 border-b border-white/5 mb-1 flex items-center justify-between">
                  <span>Installed Shells</span>
                  <span className="text-[9px] text-zinc-500 font-normal">Choose flavor</span>
                </div>
                {availableShells.length > 0 ? (
                  availableShells.map((sh) => (
                    <button
                      key={sh.id}
                      type="button"
                      onClick={() => {
                        setShellMenuOpen(false);
                        openLocalTerminal(sh.id, false);
                      }}
                      className="w-full text-left px-3 py-1.5 hover:bg-emerald-500/10 text-zinc-300 hover:text-emerald-300 flex items-center justify-between group transition-colors"
                    >
                      <span className="font-medium truncate">{sh.name}</span>
                      <span className="text-[10px] text-zinc-500 font-mono group-hover:text-emerald-400/80 shrink-0 ml-2">{sh.id}</span>
                    </button>
                  ))
                ) : (
                  <div className="px-3 py-1.5 text-zinc-500 italic text-[10.5px]">Default OS Shell</div>
                )}
                <div className="border-t border-white/5 mt-1 pt-1">
                  <button
                    type="button"
                    onClick={() => {
                      setShellMenuOpen(false);
                      openLocalTerminal(undefined, true);
                    }}
                    className="w-full text-left px-3 py-1.5 hover:bg-white/5 text-zinc-400 hover:text-white flex items-center gap-2 transition-colors font-medium"
                  >
                    <Plus size={12} className="text-zinc-500" />
                    <span>+ New Tab (Default Shell)</span>
                  </button>
                </div>
              </div>
            </>
          )}
        </div>

        {/* Separator if quick access servers exist */}
        {quickAccessServersList.length > 0 && (
          <div className="w-[1px] h-4 bg-white/10 mx-0.5 shrink-0" />
        )}

        {/* Server Bookmarks */}
        {quickAccessServersList.map((server: any) => {
          const sess = sessions.find((s) => s.serverId === server.id || s.serverName === server.name);
          const isCurrent = Boolean(sess && activeView === sess.id);
          const isConn = Boolean(sess && sessionStatuses[sess.id] === "connected");
          const isConnIng = Boolean(sess && sessionStatuses[sess.id] === "connecting");
          const isProd = Boolean(server.is_production || /prod|production|live/i.test(server.name || ""));

          return (
            <div key={server.id} className="group relative flex items-center">
              <button
                type="button"
                onClick={() => {
                  if (!isUnlocked) {
                    setIsUnlockModalOpen(true);
                    return;
                  }
                  if (sess) {
                    if (!mergedSessionIds.includes(sess.id)) setMergedSessionIds([]);
                    setActiveView(sess.id);
                  } else {
                    openServer(server);
                  }
                }}
                title={
                  isCurrent
                    ? `${server.name} (Active Session)`
                    : sess
                    ? `Switch to ${server.name}`
                    : `Connect to ${server.name}`
                }
                className={`w-[130px] h-7 px-2 rounded-md flex items-center gap-1.5 text-[11px] font-medium transition-all overflow-hidden ${
                  isCurrent
                    ? "bg-[#182338] border border-blue-500/50 text-blue-200 shadow-sm font-semibold"
                    : isConn
                    ? "bg-white/[0.08] border border-white/15 text-zinc-200 hover:bg-white/[0.12] hover:text-white"
                    : "bg-white/[0.02] border border-white/5 text-zinc-400 hover:text-zinc-200 hover:bg-white/[0.06] hover:border-white/10"
                }`}
              >
                <span className="shrink-0" style={server.color ? { color: server.color } : {}}>
                  {renderServerIcon(server.icon || "server", 11)}
                </span>
                <span
                  className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                    isCurrent || isConn
                      ? "bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.8)]"
                      : isConnIng
                      ? "bg-amber-400 animate-pulse"
                      : "bg-zinc-600"
                  }`}
                />
                <span className="truncate flex-1 min-w-0 text-left tracking-tight">{server.name}</span>
                {isProd && (
                  <span className="px-1 py-0.2 rounded text-[7.5px] font-bold uppercase bg-rose-500/20 text-rose-300 border border-rose-500/30 shrink-0">
                    PROD
                  </span>
                )}
                {sess && (
                  <span
                    role="button"
                    tabIndex={0}
                    onClick={(e) => {
                      e.stopPropagation();
                      closeSession(sess.id);
                    }}
                    title="Disconnect session"
                    className="ml-0.5 w-3.5 h-3.5 rounded flex items-center justify-center text-zinc-400 hover:text-red-400 hover:bg-white/10 opacity-70 group-hover:opacity-100 transition-opacity shrink-0"
                  >
                    <X size={10} />
                  </span>
                )}
              </button>
            </div>
          );
        })}
      </div>

      {/* Mobile session picker — replaces the horizontal tab strip on
          narrow viewports so a phone doesn't spend its whole title row
          on 3-character truncated tabs. A single pill shows the current
          session (or a "Servers" placeholder when nothing is open); tap
          opens a dropdown listing every session with status + close +
          merge affordances. Desktop still gets the full scrolling tab
          strip below. */}
      {isMobile && sessions.length > 0 && (
        <div className="flex-1 flex items-end justify-start pb-1 no-drag pl-2 pr-1 min-w-0">
          <div className="relative w-full">
            <button
              type="button"
              onClick={() => setMobileSessionPickerOpen(v => !v)}
              className={`w-full h-7 px-3 rounded-md flex items-center gap-2 border transition-all ${
                activeView.startsWith('session-') || activeView === 'wall'
                  ? 'bg-primary/15 text-primary border-primary/40 shadow-inner'
                  : 'bg-white/[0.06] text-zinc-300 border-white/10'
              }`}
              aria-haspopup="listbox"
              aria-expanded={mobileSessionPickerOpen}
            >
              {(() => {
                const isWall = activeView === 'wall';
                const cur = sessions.find(s => s.id === activeView);
                const st = cur ? (sessionStatuses[cur.id] ?? 'connecting') : null;
                const dotTone =
                  st === 'connected'    ? 'bg-emerald-400' :
                  st === 'connecting'   ? 'bg-amber-400 animate-pulse' :
                  st === 'failed'       ? 'bg-rose-500' :
                  st === 'disconnected' ? 'bg-rose-500' :
                                          'bg-zinc-500';
                return (
                  <>
                    {isWall
                      ? <LayoutGrid size={12} className="shrink-0 text-primary" />
                      : (cur && <span className={`w-2 h-2 rounded-full shrink-0 ${dotTone}`} />)}
                    <span className="truncate flex-1 text-left text-[11px] font-bold">
                      {isWall
                        ? `Wall${wallItems.length > 0 ? ` · ${wallItems.length} pinned` : ''}`
                        : cur ? cur.serverName : `${sessions.length} open session${sessions.length === 1 ? '' : 's'}`}
                    </span>
                    {mergedSessionIds.length > 0 && (
                      <span className="shrink-0 h-4 px-1 rounded-full bg-primary/25 text-primary text-[9px] font-bold flex items-center gap-0.5">
                        <Columns size={8} /> +{mergedSessionIds.length}
                      </span>
                    )}
                    <ChevronDown size={12} className={`shrink-0 transition-transform ${mobileSessionPickerOpen ? 'rotate-180' : ''}`} />
                  </>
                );
              })()}
            </button>
            {mobileSessionPickerOpen && (
              <>
                <div className="fixed inset-0 z-[60]" onClick={() => setMobileSessionPickerOpen(false)} />
                <div
                  role="listbox"
                  className="absolute z-[70] top-8 left-0 right-0 bg-[#15151a] border border-white/10 rounded-xl shadow-2xl p-1.5 max-h-[60vh] overflow-y-auto custom-scrollbar"
                >
                  {sessions.map(s => {
                    const st = sessionStatuses[s.id] ?? 'connecting';
                    const dot =
                      st === 'connected'    ? 'bg-emerald-400' :
                      st === 'connecting'   ? 'bg-amber-400 animate-pulse' :
                      'bg-rose-500';
                    const isActive = activeView === s.id;
                    const isMerged = mergedSessionIds.includes(s.id);
                    return (
                      <div key={s.id} className="flex items-center gap-1">
                        <button
                          role="option"
                          aria-selected={isActive}
                          onClick={() => { setActiveView(s.id); setMobileSessionPickerOpen(false); }}
                          className={`flex-1 flex items-center gap-2 px-2.5 py-2 rounded-lg text-left transition-all ${
                            isActive
                              ? 'bg-primary/15 text-primary'
                              : isMerged
                                ? 'bg-primary/[0.05] text-primary/80'
                                : 'text-zinc-200 hover:bg-white/[0.06]'
                          }`}
                        >
                          <span className={`w-2 h-2 rounded-full shrink-0 ${dot}`} />
                          <span className="text-[12px] font-semibold truncate flex-1">{s.serverName}</span>
                          {s.isProduction && (
                            <span className="px-1.5 py-0.5 rounded text-[8px] font-bold uppercase bg-rose-500/20 text-rose-300 border border-rose-500/30 shrink-0">
                              PROD
                            </span>
                          )}
                          {isMerged && !isActive && (
                            <span className="text-[9px] font-bold uppercase tracking-wider text-primary/60">Split-in</span>
                          )}
                        </button>
                        {/* Merge/unmerge toggle — mobile equivalent of
                            the desktop tab context menu. Only offered
                            when the current view is another session AND
                            this row isn't the one on screen. */}
                        {activeView.startsWith('session-') && activeView !== s.id && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              if (isMerged) {
                                const next = mergedSessionIds.filter(id => id !== s.id);
                                // Below 2 members is a single view, not a split.
                                setMergedSessionIds(next.length < 2 ? [] : next);
                              } else {
                                // Fresh split: seed with the anchor so it
                                // holds visual position 0.
                                if (mergedSessionIds.length === 0) setMergedSessionIds([activeView, s.id]);
                                else setMergedSessionIds(prev => [...prev, s.id]);
                              }
                            }}
                            title={isMerged ? 'Remove from split view' : 'Split with current view'}
                            className={`h-8 w-8 shrink-0 rounded-lg flex items-center justify-center border transition-all ${
                              isMerged
                                ? 'bg-primary/15 text-primary border-primary/40'
                                : 'text-zinc-400 border-white/10 hover:bg-white/[0.06]'
                            }`}
                          >
                            <Columns size={13} />
                          </button>
                        )}
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            const sid = s.id;
                            invoke('disconnect_session', { sessionId: sid }).catch(() => {});
                            setSessions(prev => prev.filter(x => x.id !== sid));
                            setSessionStatuses(prev => { const { [sid]: _, ...rest } = prev; return rest; });
                            broadcast.removeSession(sid);
                            setMergedSessionIds(prev => {
                              const next = prev.filter(id => id !== sid);
                              return next.length < 2 ? [] : next;
                            });
                            unpinSessionFromWall(sid);
                            setActiveView(prev => (prev === sid ? 'nodes' : prev));
                          }}
                          title="Close session"
                          className="h-8 w-8 shrink-0 rounded-lg flex items-center justify-center text-zinc-400 hover:text-red-400 hover:bg-white/[0.06] transition-all"
                        >
                          <X size={13} />
                        </button>
                      </div>
                    );
                  })}
                  {/* Wall entry — mobile equivalent of the desktop Wall
                      tab. Same pinboard, same state; just a different
                      entry point since the horizontal tab strip is
                      replaced by this dropdown on phone. */}
                  <div className="border-t border-white/5 my-1" />
                  <button
                    onClick={() => {
                      setMergedSessionIds([]);
                      setActiveView('wall');
                      setMobileSessionPickerOpen(false);
                    }}
                    className={`w-full flex items-center gap-2 px-2.5 py-2 rounded-lg text-left transition-all ${
                      activeView === 'wall'
                        ? 'bg-primary/15 text-primary'
                        : 'text-zinc-200 hover:bg-white/[0.06]'
                    }`}
                  >
                    <LayoutGrid size={13} className="shrink-0" />
                    <span className="text-[12px] font-semibold flex-1">Wall</span>
                    {wallItems.length > 0 && (
                      <span className="text-[9px] font-bold uppercase tracking-wider text-primary/70">
                        {wallItems.length} pinned
                      </span>
                    )}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* Tab strip is a drag region; tabs themselves opt out via no-drag so
          clicking a tab selects it instead of dragging the window. On phone
          the horizontal scroll is replaced by the dropdown above; the
          strip below is hidden on mobile. */}
      <div
        data-tauri-drag-region
        className={`${isMobile ? 'hidden' : 'flex'} flex-1 gap-1 overflow-x-auto no-scrollbar h-full items-end pb-1`}
        onWheel={(e) => { e.currentTarget.scrollLeft += e.deltaY; }}
      >
        {sessions
          .filter((s) => !quickAccessServersList.some((qs: any) => qs.id === s.serverId || qs.name === s.serverName))
          .map(s => {
          const st = sessionStatuses[s.id] ?? "connecting";
          // Dot palette: green = connected, amber = connecting, red = failed
          // or disconnected. The pulse animation only runs while connecting
          // so a steady-state tab doesn't draw the eye every half second.
          const dotTone =
            st === "connected"    ? "bg-emerald-400" :
            st === "connecting"   ? "bg-amber-400 animate-pulse" :
            st === "failed"       ? "bg-rose-500" :
            st === "disconnected" ? "bg-rose-500" :
                                    "bg-zinc-500";
          const dotTitle =
            st === "connected"    ? "Connected" :
            st === "connecting"   ? "Connecting…" :
            st === "failed"       ? "Connection failed" :
            st === "disconnected" ? "Disconnected" :
                                    st;
          // Broadcast indicator: small orange dot next to the status dot when
          // this session is in the target set AND broadcast is armed. Kept
          // separate from the status dot so the user can still tell "is it
          // connected?" and "is it broadcasting?" at a glance.
          const isBroadcastTarget = broadcast.enabled && broadcast.targetSessionIds.has(s.id);
          const isMergedTab = mergedSessionIds.includes(s.id);
          return (
            <div
              key={s.id}
              onClick={(e) => {
                // Ctrl/⌘-click toggles this tab in the split beside the
                // currently-active session view — a quick keyboard-free
                // way to tile two servers together without going through
                // the right-click menu.
                if ((e.ctrlKey || e.metaKey) && activeView.startsWith('session-') && activeView !== s.id) {
                  setMergedSessionIds(prev => {
                    // Fresh split: seed with the anchor first so it holds
                    // position 0 for the rest of the split's lifetime.
                    if (prev.length === 0) return [activeView, s.id];
                    if (prev.includes(s.id)) {
                      const next = prev.filter(id => id !== s.id);
                      return next.length < 2 ? [] : next;
                    }
                    return [...prev, s.id];
                  });
                  return;
                }
                // Plain click on a tab that isn't part of the current
                // split exits the split — the user is asking for a
                // single-tab view of s.id, not "tile s.id next to the
                // sessions I had merged".
                if (!mergedSessionIds.includes(s.id)) setMergedSessionIds([]);
                setActiveView(s.id);
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                setTabMenu({ x: e.clientX, y: e.clientY, sessionId: s.id });
              }}
              onDoubleClick={(e) => {
                e.preventDefault();
                setTabMenu({ x: e.clientX, y: e.clientY, sessionId: s.id });
              }}
              // No max-width / no truncate: the user explicitly wants full
              // node names visible even when many sessions are open. The tab
              // row itself is horizontally scrollable (overflow-x-auto +
              // wheel-to-horizontal scroll above), so wider tabs just mean
              // more scrolling — they never hide the name behind an ellipsis.
              // `whitespace-nowrap` keeps long names on a single line; without
              // it a tab with a 30-char hostname would wrap into a two-line
              // pill and break the row's height.
              title={isMergedTab ? `${tabNames[s.id] ?? s.serverName} · split beside current view (Ctrl-click to unpair)` : (tabNames[s.id] ?? s.serverName)}
              className={`group no-drag flex items-center w-[130px] h-7 px-2 rounded-md cursor-pointer transition-all shrink-0 mr-1 overflow-hidden ${
                activeView === s.id
                  ? 'bg-primary/15 text-primary border border-primary/40 shadow-inner shadow-primary/10'
                  : isMergedTab
                    ? 'bg-primary/[0.05] text-primary/80 border border-primary/25 hover:bg-primary/10'
                    : 'bg-white/[0.06] text-zinc-300 border border-white/10 hover:bg-white/[0.1] hover:border-white/20 hover:text-white'
              }`}
            >
              <span
                title={dotTitle}
                className={`w-2 h-2 rounded-full mr-1.5 shrink-0 ${dotTone}`}
                aria-label={dotTitle}
              />
              {isBroadcastTarget && (
                <span
                  title="Broadcast target"
                  aria-label="Broadcast target"
                  className="w-1.5 h-1.5 rounded-full mr-1 shrink-0 bg-orange-400 shadow-[0_0_6px_rgba(251,146,60,0.7)]"
                />
              )}
              {isMergedTab && (
                <Columns size={9} className="text-primary/70 mr-1 shrink-0" />
              )}
              <span className="shrink-0 mr-1 opacity-80" style={s.color ? { color: s.color } : {}}>
                {renderServerIcon(s.icon || "server", 11)}
              </span>
              <span className="text-[11px] font-semibold truncate flex-1 min-w-0 text-left tracking-tight">{tabNames[s.id] ?? s.serverName}</span>
              {s.isProduction && (
                <span className="ml-1 px-1 py-0.2 rounded text-[7.5px] font-bold uppercase bg-rose-500/20 text-rose-300 border border-rose-500/30 shrink-0">
                  PROD
                </span>
              )}
              {/* Mobile-only actions trigger. On phone we surface the same
                  tabMenu (Reconnect / Disconnect / Close) here since there
                  is no right-click on touch — a single kebab is a cleaner
                  affordance than a naked X plus a hidden long-press menu.
                  The X below is desktop-only so we don't stack both. */}
              <button
                type="button"
                aria-label="Session actions"
                className="sm:hidden ml-1 h-5 w-5 flex items-center justify-center rounded hover:bg-white/5 shrink-0 text-zinc-400"
                onClick={(e) => {
                  e.stopPropagation();
                  const rect = e.currentTarget.getBoundingClientRect();
                  setTabMenu({ x: rect.left, y: rect.bottom, sessionId: s.id });
                }}
              >
                <MoreVertical size={13} />
              </button>
              {/* Desktop-only inline close. Hidden until hover so the tab
                  reads clean at rest; sizing (w-5 h-5, 12 px icon) matches
                  the terminal-tab close inside SessionView so both tab
                  strips look like siblings. */}
              <button
                type="button"
                aria-label="Close session"
                className="hidden sm:flex ml-1 h-5 w-5 items-center justify-center rounded hover:bg-white/5 shrink-0 opacity-0 group-hover:opacity-100 text-zinc-400 hover:text-red-400 transition-opacity"
                onClick={async (e) => {
                  e.stopPropagation();
                  // Only confirm when there's an actual live connection to
                  // drop — connecting/failed/disconnected close instantly.
                  // Status source of truth is the same sessionStatuses map
                  // that drives the coloured dot above.
                  if (sessionStatuses[s.id] === "connected") {
                    const ok = await confirm({
                      title: "Close this session?",
                      message: "The SSH connection will be dropped.",
                      okLabel: "Close",
                      destructive: true,
                    });
                    if (!ok) return;
                  }
                  setSessions(prev => prev.filter(sess => sess.id !== s.id));
                  setSessionStatuses(prev => {
                    const { [s.id]: _, ...rest } = prev;
                    return rest;
                  });
                  broadcast.removeSession(s.id);
                  unpinSessionFromWall(s.id);
                  setActiveView(prev => (prev === s.id ? "nodes" : prev));
                }}
              >
                <X size={12} />
              </button>
            </div>
          );
        })}
      </div>
      {/* Wall trigger — moved OUT of the scrollable tab strip and next
          to the Broadcast pill so both multi-session affordances live
          in the same "utility cluster" at the right edge of the title
          bar. Icon-only on every viewport (mobile inherits from
          Broadcast's compact pattern), badge for pin count so state is
          legible without text. Visible whenever there's at least one
          open session — the Wall itself only becomes useful with pins
          but the button is the discoverability entry point. */}
      {sessions.length >= 1 && (
        <div className="relative no-drag shrink-0 mx-1">
          <button
            type="button"
            onClick={() => {
              // Plain click on Wall exits any active session-split —
              // split-view and Wall are two different multi-view modes
              // and switching between them shouldn't leave stale
              // merged state behind.
              setMergedSessionIds([]);
              setActiveView("wall");
            }}
            title={wallItems.length > 0
              ? `Wall · ${wallItems.length} pinned terminal${wallItems.length === 1 ? '' : 's'}`
              : "Wall — pinboard for terminals across servers"}
            aria-label="Wall pinboard"
            className={`relative flex items-center justify-center w-7 h-7 rounded-full transition-all ${
              activeView === "wall"
                ? "bg-primary/15 border border-primary/40 text-primary shadow-inner shadow-primary/10"
                : "bg-white/[0.06] border border-white/10 text-zinc-400 hover:bg-white/[0.1] hover:text-white"
            }`}
          >
            <LayoutGrid size={12} />
            {wallItems.length > 0 && (
              <span
                className="absolute -top-1 -right-1 min-w-[14px] h-[14px] px-1 rounded-full bg-primary text-[9px] font-bold text-black flex items-center justify-center leading-none"
                aria-hidden="true"
              >
                {wallItems.length}
              </span>
            )}
          </button>
        </div>
      )}
      {/* Broadcast trigger — session-scoped multi-exec. Lives OUTSIDE the
          scrollable tab strip so it stays anchored at the right edge no
          matter how many tabs are open. Compact icon-only button (no
          "Broadcast" text) to reclaim titlebar space; the dropdown reveals
          the full checkbox picker. When armed, a small orange count badge
          hangs off the corner so the state is legible at a glance without
          words. Hidden until there are 2+ sessions since a single session
          has no one to broadcast to. */}
      {sessions.length >= 2 && (
        <div className="relative no-drag shrink-0 mx-1">
          <button
            type="button"
            onClick={() => setBroadcastMenuOpen(v => !v)}
            title={broadcast.enabled
              ? `Broadcasting to ${broadcast.targetSessionIds.size} session${broadcast.targetSessionIds.size === 1 ? "" : "s"}`
              : "Broadcast input to multiple sessions"}
            aria-label="Broadcast input"
            className={`relative flex items-center justify-center w-7 h-7 rounded-full transition-all ${
              broadcast.enabled
                ? "bg-orange-500/15 border border-orange-400/40 text-orange-300 shadow-inner shadow-orange-400/10"
                : "bg-white/[0.06] border border-white/10 text-zinc-400 hover:bg-white/[0.1] hover:text-white"
            }`}
          >
            <Radio size={12} className={broadcast.enabled ? "animate-pulse" : ""} />
            {broadcast.enabled && broadcast.targetSessionIds.size > 0 && (
              <span
                className="absolute -top-1 -right-1 min-w-[14px] h-[14px] px-1 rounded-full bg-orange-500 text-[9px] font-bold text-black flex items-center justify-center leading-none"
                aria-hidden="true"
              >
                {broadcast.targetSessionIds.size}
              </span>
            )}
          </button>
          {broadcastMenuOpen && (
            <>
              <div
                className="fixed inset-0 z-[60]"
                onClick={() => setBroadcastMenuOpen(false)}
              />
              <div className="absolute z-[70] top-full mt-1 right-0 w-[280px] bg-[#15151a] border border-white/10 rounded-lg shadow-2xl p-2 text-[11px]">
                <div className="flex items-center justify-between mb-2 px-1">
                  <label className="flex items-center gap-2 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      className="accent-orange-400"
                      checked={broadcast.enabled}
                      onChange={broadcast.toggleEnabled}
                    />
                    <span className="text-[11px] font-bold uppercase tracking-wider text-zinc-200">
                      Broadcast input
                    </span>
                  </label>
                  <button
                    onClick={() => setBroadcastMenuOpen(false)}
                    className="text-zinc-500 hover:text-white p-0.5"
                    aria-label="Close"
                  >
                    <X size={12} />
                  </button>
                </div>
                <div className="flex items-center gap-1.5 px-1 pb-2 border-b border-white/5">
                  <button
                    onClick={() => broadcast.selectAll(sessions.map(s => s.id))}
                    className="px-2 py-0.5 rounded bg-white/[0.04] border border-white/10 text-[10px] uppercase tracking-wider text-zinc-300 hover:bg-white/[0.08] hover:text-white"
                  >
                    All
                  </button>
                  <button
                    onClick={() => broadcast.selectNone()}
                    className="px-2 py-0.5 rounded bg-white/[0.04] border border-white/10 text-[10px] uppercase tracking-wider text-zinc-300 hover:bg-white/[0.08] hover:text-white"
                  >
                    None
                  </button>
                  <div className="flex-1" />
                  <span className={`text-[10px] font-bold uppercase tracking-wider ${
                    broadcast.enabled && broadcast.targetSessionIds.size >= 2
                      ? "text-orange-300"
                      : "text-zinc-500"
                  }`}>
                    {broadcast.enabled
                      ? (broadcast.targetSessionIds.size >= 2
                          ? `Live · ${broadcast.targetSessionIds.size}`
                          : "Pick 2+")
                      : "Off"}
                  </span>
                </div>
                <div className="max-h-[240px] overflow-y-auto custom-scrollbar mt-2 space-y-0.5">
                  {sessions.map(s => {
                    const checked = broadcast.targetSessionIds.has(s.id);
                    const st = sessionStatuses[s.id] ?? "connecting";
                    return (
                      <label
                        key={s.id}
                        className={`flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer ${
                          checked ? "bg-orange-500/10" : "hover:bg-white/[0.04]"
                        }`}
                      >
                        <input
                          type="checkbox"
                          className="accent-orange-400 shrink-0"
                          checked={checked}
                          onChange={() => broadcast.toggleTarget(s.id)}
                        />
                        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                          st === "connected" ? "bg-emerald-400" :
                          st === "connecting" ? "bg-amber-400" :
                          "bg-rose-500"
                        }`} />
                        <span className="truncate text-[11px] font-medium text-zinc-200 flex-1">
                          {s.serverName}
                        </span>
                      </label>
                    );
                  })}
                </div>
              </div>
            </>
          )}
        </div>
      )}
      {/* Window controls: desktop only. Android has its own gesture nav /
          system back button, and the WebView window has no minimise or
          maximise affordance to surface — so we hide the whole cluster on
          phone and reclaim ~120 px of titlebar for the tab strip. */}
      <div className="hidden sm:flex items-center h-full gap-1 no-drag">
        {isUnlocked && (
          <>
            <button
              type="button"
              onClick={() => setIsCommandPaletteOpen(true)}
              title={`Command Palette (${getActiveShortcut("commandPalette")})`}
              className="h-7 px-2 rounded-lg bg-white/[0.04] hover:bg-white/[0.09] border border-white/10 text-zinc-400 hover:text-zinc-200 text-[11px] flex items-center gap-1.5 transition-colors no-drag mr-1"
            >
              <Command size={11} className="text-primary" />
              <span className="hidden md:inline font-medium">Palette</span>
              <kbd className="hidden lg:inline text-[9px] bg-black/40 px-1 py-0.5 rounded text-zinc-400 font-mono border border-white/10">
                {getActiveShortcut("commandPalette")}
              </kbd>
            </button>

          </>
        )}
        <button
          onClick={() => appWindow.minimize()}
          title="Minimize"
          className="w-10 h-full flex items-center justify-center hover:bg-white/5 transition-colors"
        ><div className="w-3.5 h-[1.5px] bg-zinc-600" /></button>
        <button
          onClick={toggleMaximize}
          title={isMaximized ? "Restore" : "Maximize"}
          className="w-10 h-full flex items-center justify-center hover:bg-white/5 transition-colors group"
        >
          {isMaximized
            ? <Copy size={12} className="text-zinc-600 group-hover:text-zinc-300 scale-x-[-1]" />
            : <Square size={11} className="text-zinc-600 group-hover:text-zinc-300" />}
        </button>
        <button onClick={() => appWindow.close()} className="w-10 h-full flex items-center justify-center hover:bg-red-500 group transition-all"><X size={14} className="text-zinc-600 group-hover:text-white" /></button>
      </div>
      {tabMenu && (() => {
        const targetId = tabMenu.sessionId;
        const targetIndex = sessions.findIndex(s => s.id === targetId);
        const hasOthers = sessions.length > 1;
        const hasRight = targetIndex >= 0 && targetIndex < sessions.length - 1;
        // Build the "Split view with" picker: every OTHER open session is
        // a candidate. When the target tab is the active view, ticked
        // entries are the current mergedSessionIds. When the target is
        // a different tab, we haven't switched to it yet — ticking a row
        // both switches focus to the target AND initializes the merged
        // set with the picked partner(s), so users don't need a "click
        // to focus, right-click to split" two-step.
        const targetIsActive = activeView === targetId;
        const currentMerges = targetIsActive ? mergedSessionIds : [];
        const others = sessions.filter(s => s.id !== targetId);
        return (
        <>
          <div className="fixed inset-0 z-[60]" onClick={() => setTabMenu(null)} onContextMenu={(e) => { e.preventDefault(); setTabMenu(null); }} />
          <div
            className="fixed z-[70] bg-[#15151a] border border-white/10 rounded-md shadow-2xl py-1 min-w-[240px] text-[11px] no-drag"
            style={{ left: Math.min(tabMenu.x, window.innerWidth - 260), top: Math.min(tabMenu.y, window.innerHeight - 380) }}
          >
            <div className="px-3 py-1 text-[10px] font-bold uppercase tracking-wider text-zinc-400">
              Rename tab
            </div>
            <RenameInput
              initialValue={tabNames[targetId] ?? (sessions.find(s => s.id === targetId)?.serverName ?? "")}
              placeholder="Custom tab name…"
              onCommit={(newVal) => {
                const trimmed = newVal.trim();
                const defaultName = sessions.find(s => s.id === targetId)?.serverName;
                setTabNames(prev => {
                  if (trimmed && trimmed !== defaultName) {
                    return { ...prev, [targetId]: trimmed };
                  } else {
                    const { [targetId]: _, ...rest } = prev;
                    return rest;
                  }
                });
                setTabMenu(null);
              }}
              onCancel={() => setTabMenu(null)}
            />
            <div className="h-px bg-white/10 my-1" />

            <button
              className="w-full text-left px-3 py-1.5 hover:bg-primary/15 hover:text-primary text-zinc-200 flex items-center gap-2"
              onClick={() => {
                window.dispatchEvent(new CustomEvent(`session-reconnect-${targetId}`));
                setTabMenu(null);
              }}
            >Reconnect</button>
            <button
              className="w-full text-left px-3 py-1.5 hover:bg-white/10 text-zinc-200"
              onClick={() => {
                invoke("disconnect_session", { sessionId: targetId }).catch(console.error);
                setTabMenu(null);
              }}
            >Disconnect</button>

            {/* ssh-copy-id: append a saved public key to this server's
                ~/.ssh/authorized_keys over the already-authenticated
                session, so the user never has to leave SubTerm (or paste
                a key by hand) to set up passwordless login. Only offered
                while connected — there's no live channel to exec on
                otherwise. The key is single-quoted with embedded quotes
                escaped (`'\''`) so its comment field can't break out of
                the remote shell command. */}
            {sessionStatuses[targetId] === "connected" && sshKeys.length > 0 && (
              <>
                <div className="border-t border-white/5 my-1" />
                <div className="px-3 pt-1 pb-1.5 text-[9.5px] font-bold uppercase tracking-widest text-zinc-500">
                  Upload public key
                </div>
                <div className="max-h-[160px] overflow-y-auto custom-scrollbar">
                  {sshKeys.map((k: any) => (
                    <button
                      key={k.id}
                      className="w-full text-left px-3 py-1.5 hover:bg-primary/15 hover:text-primary text-zinc-200 flex items-center gap-2 truncate"
                      onClick={async () => {
                        setTabMenu(null);
                        const pubKey = (k.public_key || "").trim();
                        if (!pubKey) {
                          await confirm({ title: "No public key", message: `"${k.name}" has no public key saved.`, okLabel: "OK" });
                          return;
                        }
                        const escaped = pubKey.replace(/'/g, `'\\''`);
                        const cmd = `mkdir -p ~/.ssh && chmod 700 ~/.ssh && touch ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys && KEY='${escaped}'; grep -qxF "$KEY" ~/.ssh/authorized_keys || echo "$KEY" >> ~/.ssh/authorized_keys`;
                        try {
                          await invoke("sftp_exec_command", { sessionId: targetId, command: cmd });
                          await confirm({ title: "Public key uploaded", message: `"${k.name}" was appended to ~/.ssh/authorized_keys.`, okLabel: "OK" });
                        } catch (e) {
                          await confirm({ title: "Upload failed", message: String(e), okLabel: "OK" });
                        }
                      }}
                    >
                      <Key size={11} className="shrink-0 text-zinc-500" />
                      <span className="truncate">{k.name}</span>
                    </button>
                  ))}
                </div>
              </>
            )}

            {/* Pin/Unpin the session's currently-active terminal to
                the Wall — one-click convenience so users don't have to
                open the picker + tick a specific terminal for the
                common "just pin what I'm looking at" case. The picker
                remains for choosing a specific non-active terminal or
                pinning multiple at once. */}
            {(() => {
              const activeTid = sessionActiveTerm[targetId];
              const activeTermPinned = activeTid ? wallHasTerminal(activeTid) : false;
              const anyPinned = wallItems.some(i => i.sessionId === targetId);
              return (
                <>
                  {activeTid && (
                    <button
                      className="w-full text-left px-3 py-1.5 hover:bg-primary/15 hover:text-primary text-zinc-200 flex items-center gap-2"
                      onClick={() => {
                        if (activeTermPinned) unpinTerminalFromWall(activeTid);
                        else pinTerminalToWall(targetId, activeTid);
                        setTabMenu(null);
                      }}
                    >
                      {activeTermPinned
                        ? (<><PinOff size={12} className="text-zinc-500" /> Unpin active terminal</>)
                        : (<><Pin size={12} className="text-zinc-500" /> Pin active terminal to Wall</>)}
                    </button>
                  )}
                  {anyPinned && (
                    <button
                      className="w-full text-left px-3 py-1.5 hover:bg-rose-500/10 hover:text-rose-300 text-zinc-400 flex items-center gap-2 text-[10.5px]"
                      onClick={() => { unpinSessionFromWall(targetId); setTabMenu(null); }}
                    >
                      <PinOff size={11} /> Unpin ALL from this session
                    </button>
                  )}
                </>
              );
            })()}

            {/* Split view picker — the user's requested UX. Right-click
                any tab, tick which OTHER tabs you want tiled beside it.
                The right-clicked tab becomes the focused pane; ticked
                rows become side panes. Ticking auto-applies so there's
                no "Apply" button to hunt. Hidden entirely when there's
                only one open session (nothing to pair with). */}
            {others.length > 0 && (
              <>
                <div className="border-t border-white/5 my-1" />
                <div className="px-3 pt-1 pb-1.5 flex items-center justify-between">
                  <span className="text-[9.5px] font-bold uppercase tracking-widest text-zinc-500">
                    Split view with
                  </span>
                  {targetIsActive && currentMerges.length > 0 && (
                    <button
                      onClick={() => { setMergedSessionIds([]); setTabMenu(null); }}
                      className="text-[9.5px] font-bold uppercase tracking-wider text-zinc-500 hover:text-white"
                    >
                      Clear
                    </button>
                  )}
                </div>
                <div className="max-h-[200px] overflow-y-auto custom-scrollbar px-1 pb-1">
                  {others.map(s => {
                    const st = sessionStatuses[s.id] ?? "connecting";
                    const checked = currentMerges.includes(s.id);
                    return (
                      <label
                        key={s.id}
                        className={`flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer ${
                          checked ? "bg-primary/10" : "hover:bg-white/[0.04]"
                        }`}
                      >
                        <input
                          type="checkbox"
                          className="accent-primary shrink-0"
                          checked={checked}
                          onChange={() => {
                            // Ticking: switch focus to the right-clicked
                            // tab (if not already) and add the picked
                            // partner. Unticking: drop the partner from
                            // the split — and collapse the split entirely
                            // when it would fall below the 2-pane minimum.
                            if (checked) {
                              const next = mergedSessionIds.filter(id => id !== s.id);
                              setMergedSessionIds(next.length < 2 ? [] : next);
                            } else {
                              if (!targetIsActive) {
                                setActiveView(targetId);
                                setMergedSessionIds([targetId, s.id]);
                              } else if (mergedSessionIds.length === 0) {
                                setMergedSessionIds([targetId, s.id]);
                              } else {
                                setMergedSessionIds(prev => prev.includes(s.id) ? prev : [...prev, s.id]);
                              }
                            }
                          }}
                        />
                        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                          st === "connected" ? "bg-emerald-400" :
                          st === "connecting" ? "bg-amber-400" :
                          "bg-rose-500"
                        }`} />
                        <span className="truncate text-[11px] font-medium text-zinc-200 flex-1">
                          {s.serverName}
                        </span>
                      </label>
                    );
                  })}
                </div>
              </>
            )}

            <div className="border-t border-white/5 my-1" />
            <button
              className="w-full text-left px-3 py-1.5 hover:bg-rose-500/15 hover:text-rose-300 text-zinc-200"
              onClick={() => {
                const sid = targetId;
                invoke("disconnect_session", { sessionId: sid }).catch(() => {});
                setSessions(prev => prev.filter(sess => sess.id !== sid));
                setSessionStatuses(prev => { const { [sid]: _, ...rest } = prev; return rest; });
                broadcast.removeSession(sid);
                setMergedSessionIds(prev => {
                  const next = prev.filter(id => id !== sid);
                  return next.length < 2 ? [] : next;
                });
                unpinSessionFromWall(sid);
                setActiveView(prev => (prev === sid ? "nodes" : prev));
                setTabMenu(null);
              }}
            >Close tab</button>
            {hasOthers && (
              <button
                className="w-full text-left px-3 py-1.5 hover:bg-white/10 text-zinc-300 hover:text-white"
                onClick={() => {
                  const toClose = sessions.filter(s => s.id !== targetId).map(s => s.id);
                  for (const sid of toClose) {
                    invoke("disconnect_session", { sessionId: sid }).catch(() => {});
                    broadcast.removeSession(sid);
                    unpinSessionFromWall(sid);
                  }
                  setSessions(prev => prev.filter(sess => sess.id === targetId));
                  setSessionStatuses(prev => {
                    const status = prev[targetId];
                    return status ? { [targetId]: status } : {};
                  });
                  setMergedSessionIds([]);
                  setActiveView(targetId);
                  setTabMenu(null);
                }}
              >Close other tabs</button>
            )}
            {hasRight && (
              <button
                className="w-full text-left px-3 py-1.5 hover:bg-white/10 text-zinc-300 hover:text-white"
                onClick={() => {
                  const rightIdx = sessions.findIndex(s => s.id === targetId);
                  if (rightIdx < 0) return;
                  const toClose = sessions.slice(rightIdx + 1).map(s => s.id);
                  for (const sid of toClose) {
                    invoke("disconnect_session", { sessionId: sid }).catch(() => {});
                    broadcast.removeSession(sid);
                    unpinSessionFromWall(sid);
                  }
                  setSessions(prev => prev.filter(sess => !toClose.includes(sess.id)));
                  setSessionStatuses(prev => {
                    const next = { ...prev };
                    for (const sid of toClose) delete next[sid];
                    return next;
                  });
                  setMergedSessionIds(prev => {
                    const next = prev.filter(id => !toClose.includes(id));
                    return next.length < 2 ? [] : next;
                  });
                  if (toClose.includes(activeView)) {
                    setActiveView(targetId);
                  }
                  setTabMenu(null);
                }}
              >Close tabs to the right</button>
            )}
          </div>
        </>
        );
      })()}
    </div>
  );

  // h-full (not h-screen) so the layout tracks --vv-h from main.tsx —
  // when the Android soft keyboard opens the visualViewport shrinks and the
  // whole flex chain cascades above the keyboard instead of anchoring to
  // the un-shrunken layout viewport.
  if (loading) return <div className="h-full bg-black flex items-center justify-center font-mono text-xs text-primary animate-pulse">Loading…</div>;

  return (
    <div className="h-full w-full bg-background flex flex-col overflow-hidden text-zinc-200 select-none">
      {TitleBar()}
      {/* Layout swap: on desktop the sidebar is a left rail (row).
          On mobile we flip to flex-col-reverse so the sidebar component
          renders at the bottom while staying first in DOM order — keyboard
          tab-order stays intuitive and <main> grabs the full screen width
          (terminal gains the ~50px the vertical rail used to eat). */}
      <div className={`flex-1 flex ${isMobile ? 'flex-col-reverse' : ''} overflow-hidden pt-10`}>
        <Sidebar
          activeTab={activeView.startsWith('session-') ? 'nodes' : activeView}
          setActiveTab={setActiveView}
          isMobile={isMobile}
          isUnlocked={isUnlocked}
          onUnlock={() => setIsUnlockModalOpen(true)}
          onLogout={handleLogout}
          onLock={handleLockProfile}
          onSwitchProfile={() => (isUnlocked ? setIsWorkspaceSwitcherOpen(true) : setIsUnlockModalOpen(true))}
          enableMonitoring={appSettings.enableMonitoring}
        />

        <main className="flex-1 flex flex-col min-w-0 min-h-0 bg-transparent relative">
          {!isUnlocked && (activeView === "nodes" || activeView === "vault" || activeView === "library" || activeView === "monitor") ? (
            <LockedVaultNotice
              onUnlock={() => setIsUnlockModalOpen(true)}
              onOpenLocal={() => openLocalTerminal()}
            />
          ) : (
            <>
              {activeView === "nodes" && (
                <NodeGrid
                servers={servers}
                folders={folders}
                activeFolderId={activeFolderId}
                onActiveFolderChange={setActiveFolderId}
                onOpenServer={openServer}
                onOpenMultipleServers={openMultipleServers}
                onEditServer={handleEditNode}
                onAddClick={(folderId?: number | null) => {
                  // When invoked from inside a folder header, seed the new
                  // node's folderId so the user doesn't have to re-pick the
                  // folder they just clicked into. Bare invocation (from the
                  // root grid's "Add server" card) stays at the empty default.
                  setNewNode({
                    ...defaultNode,
                    folderId: folderId != null ? String(folderId) : "",
                  });
                  setIsPanelOpen(true);
                }}
                onImportSSHConfig={() => {
                  setNewNode({ ...defaultNode });
                  setIsImportModalRequested(true);
                  setIsPanelOpen(true);
                }}
                onOpenNetworkTools={() => setIsNetworkToolsOpen(true)}
                onQuickConnect={() => setIsQuickConnectOpen(true)}
                onOpenLocalTerminal={openLocalTerminal}
                onRemoveServer={removeServer}
                onRemoveFolder={removeFolder}
                onRenameFolder={renameFolder}
                onCloneServer={async (id: number) => {
                  try { await invoke("clone_server", { id }); refreshServers(); bumpSync(); addLog("Node cloned.", "success"); }
                  catch (e) { addLog(`CLONE_ERROR: ${e}`, "error"); }
                }}
                onReorderServers={async (ids: number[]) => {
                  // Rethrow on failure so NodeGrid drops its optimistic order
                  // override and reverts to the real (unchanged) arrangement.
                  try { await invoke("reorder_servers", { ids }); await refreshServers(); bumpSync(); }
                  catch (e) { addLog(`REORDER_ERROR: ${e}`, "error"); throw e; }
                }}
                isMobile={isMobile}
              />
            )}

            {activeView === "settings" && (
              <SettingsPanel
                settings={appSettings}
                setSettings={setAppSettings}
                servers={servers}
                isMobile={isMobile}
                onOpenLogs={() => setActiveView("logs")}
                onClose={() => setActiveView("nodes")}
                onUnlocked={handleProfileUnlocked}
                onSync={handleCloudSync}
                syncing={cloudSyncing}
                lastSyncLabel={lastSyncLabel}
                activeProfile={activeProfile}
                onSwitchProfile={switchWorkspace}
                isUnlocked={isUnlocked}
                onRequestUnlock={() => setIsUnlockModalOpen(true)}
              />
            )}

            {activeView === "vault" && (
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
                        sshKeys.map((k: any) => (
                          <div key={k.id} className="bg-[#16161a] border border-white/5 rounded-xl p-3 group relative hover:border-primary/30 transition-all">
                            <div className="flex justify-between items-start mb-1">
                              <h4 className="text-[14px] font-bold text-zinc-100 truncate pr-8">{k.name}</h4>
                              <div className="flex items-center gap-2 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity absolute right-3 top-3">
                                <button onClick={async () => {
                                  // Same pattern as credentials — pull the private key + passphrase
                                  // on demand instead of leaking them in the list response.
                                  let secrets: { private_key?: string|null; passphrase?: string|null } = {};
                                  if (k.has_private_key || k.has_passphrase) {
                                    try { secrets = await invoke<any>("reveal_ssh_key", { id: k.id }); }
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
            )}

            {/* Sessions live in an absolute layer that overlays the rest of
                `main` — that way each session's xterm stays mounted at its
                real measured size across tab switches, but doesn't take any
                layout space when the user navigates to notes / settings /
                etc. The previous `display:none` toggle caused a 0×0 →
                real-size reflow on every switch and corrupted the prompt
                with stacked fragments like `[root@local[root@local`. */}
            {(() => {
              // When the current view is a session and mergedSessionIds has
              // entries, tile the focused session and its merged partners
              // side-by-side inside the same canvas — the user's "put two
              // main tabs together as panes" request. Hidden sessions stay
              // mounted (absolute-positioned, opacity 0) so scrollback and
              // PTY state survive; visible ones are explicitly positioned
              // via left/width so the tile widths match the visible count
              // without triggering a display-mode flip that could reset
              // xterm layout.
              const viewIsSession = activeView.startsWith("session-") && sessions.some(s => s.id === activeView);
              // mergedSessionIds semantics: when non-empty it lists ALL
              // tiled panes (including the currently focused one) in
              // visual order. Visual order is deliberately independent
              // of activeView so that clicking a tile to focus it does
              // NOT slide the tile to position 0 — the user reported
              // the left pane "jumping to the other server" on focus
              // change and that reorder was the cause.
              const isTiled = viewIsSession
                && mergedSessionIds.length >= 2
                && mergedSessionIds.includes(activeView);
              const visibleIds = isTiled
                ? mergedSessionIds.filter(id => sessions.some(s => s.id === id))
                : (viewIsSession ? [activeView] : []);
              const visibleSessions = visibleIds.map(id => sessions.find(s => s.id === id)).filter(Boolean) as Session[];
              const hiddenSessions = sessions.filter(s => !visibleIds.includes(s.id));
              return (
                <div className={`absolute inset-0 flex flex-col overflow-hidden ${!viewIsSession ? 'opacity-0 pointer-events-none' : ''}`}>
                  {isTiled && (
                    <div className="h-8 shrink-0 bg-[#0e0e12] border-b border-white/5 flex items-center justify-between px-3 text-[11px] z-30">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-zinc-300 flex items-center gap-1.5">
                          <Layers size={13} className="text-primary" />
                          Split Workspace ({visibleSessions.length} sessions)
                        </span>
                        <button
                          onClick={() => setSessionSplitOrientation(o => o === "h" ? "v" : "h")}
                          title={`Switch to ${sessionSplitOrientation === "h" ? "vertical (stacked)" : "horizontal (side-by-side)"} layout`}
                          className="px-2 py-0.5 rounded bg-white/5 hover:bg-white/10 text-zinc-300 flex items-center gap-1.5 border border-white/10 transition-colors"
                        >
                          {sessionSplitOrientation === "h" ? <Columns size={12} className="text-primary" /> : <Rows size={12} className="text-primary" />}
                          <span className="text-[10px] uppercase font-bold tracking-wider">{sessionSplitOrientation === "h" ? "Columns" : "Rows"}</span>
                        </button>
                      </div>
                      <button
                        onClick={() => setMergedSessionIds([])}
                        title="Unsplit: restore focused session to full view"
                        className="px-2 py-0.5 rounded bg-white/5 hover:bg-white/10 text-zinc-400 hover:text-white text-[10.5px] transition-colors"
                      >
                        Unsplit
                      </button>
                    </div>
                  )}

                  {isTiled ? (
                    <div className={`flex-1 relative bg-black/40 flex ${sessionSplitOrientation === 'h' ? 'flex-row' : 'flex-col'} overflow-hidden`}>
                      {visibleSessions.map((sess, idx) => {
                        const isFocused = activeView === sess.id;
                        const grow = sessionSplitRatios[idx] ?? 1;
                        const notLast = idx < visibleSessions.length - 1;
                        return (
                          <div key={sess.id} className="contents">
                            <div
                              style={{ flexGrow: grow, flexBasis: 0 }}
                              onMouseDownCapture={() => {
                                if (!isFocused) setActiveView(sess.id);
                              }}
                              className={`relative min-w-0 min-h-0 flex flex-col overflow-hidden border ${
                                isFocused
                                  ? 'border-primary/40 shadow-[inset_0_0_0_1px_rgba(var(--primary),0.15)]'
                                  : 'border-white/[0.05]'
                              }`}
                            >
                              {!isFocused && (
                                <div className="h-7 shrink-0 flex items-center gap-2 px-2 border-b border-white/5 bg-[#111114] text-[10.5px]">
                                  <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                                    (sessionStatuses[sess.id] ?? 'connecting') === 'connected' ? 'bg-emerald-400' :
                                    (sessionStatuses[sess.id] ?? 'connecting') === 'connecting' ? 'bg-amber-400' :
                                    'bg-rose-500'
                                  }`} />
                                  <span className="font-bold text-zinc-200 uppercase tracking-wider truncate flex-1">
                                    {sess.serverName}
                                  </span>
                                  <button
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      const next = mergedSessionIds.filter(id => id !== sess.id);
                                      setMergedSessionIds(next.length < 2 ? [] : next);
                                    }}
                                    title="Remove this pane from the split view"
                                    className="h-5 w-5 rounded flex items-center justify-center text-zinc-500 hover:text-red-400 hover:bg-white/[0.05] transition-all"
                                  >
                                    <X size={11} />
                                  </button>
                                </div>
                              )}
                              <ErrorBoundary
                                label={sess.serverName}
                                onReset={() => {
                                  setSessions(prev => prev.filter(s => s.id !== sess.id));
                                  if (activeView === sess.id) setActiveView("nodes");
                                }}
                              >
                                <SessionView
                                  session={sess}
                                  onClose={getCloseHandler(sess.id)}
                                  addLog={addLog}
                                  onStatusChange={handleSessionStatus}
                                  onTerminalsChange={handleTerminalsChange}
                                  chromeless={!isFocused}
                                  isSessionActive={isFocused && viewIsSession}
                                  onOpenSettings={() => setActiveView("settings")}
                                />
                              </ErrorBoundary>
                            </div>
                            {notLast && (
                              <div
                                onMouseDown={(e) => {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  const container = e.currentTarget.parentElement;
                                  if (!container) return;
                                  const rect = container.getBoundingClientRect();
                                  const total = sessionSplitOrientation === "h" ? rect.width : rect.height;
                                  const startClient = sessionSplitOrientation === "h" ? e.clientX : e.clientY;
                                  const sumGrow = sessionSplitRatios.reduce((a, b) => a + (b || 0), 0) || visibleSessions.length;
                                  const pxPerUnit = total / sumGrow;
                                  const startA = sessionSplitRatios[idx] ?? 1;
                                  const startB = sessionSplitRatios[idx + 1] ?? 1;
                                  const move = (ev: MouseEvent) => {
                                    const client = sessionSplitOrientation === "h" ? ev.clientX : ev.clientY;
                                    const deltaUnits = (client - startClient) / pxPerUnit;
                                    const minPair = 0.3;
                                    const combined = startA + startB;
                                    const nextA = Math.max(minPair, Math.min(combined - minPair, startA + deltaUnits));
                                    const nextB = combined - nextA;
                                    setSessionSplitRatios(prev => {
                                      const copy = prev.slice();
                                      copy[idx] = nextA;
                                      copy[idx + 1] = nextB;
                                      return copy;
                                    });
                                  };
                                  const up = () => {
                                    window.removeEventListener("mousemove", move);
                                    window.removeEventListener("mouseup", up);
                                  };
                                  window.addEventListener("mousemove", move);
                                  window.addEventListener("mouseup", up);
                                }}
                                className={`z-20 shrink-0 ${
                                  sessionSplitOrientation === "h"
                                    ? "w-1.5 cursor-col-resize hover:bg-primary/50"
                                    : "h-1.5 cursor-row-resize hover:bg-primary/50"
                                } bg-white/[0.08] transition-colors`}
                              />
                            )}
                          </div>
                        );
                      })}
                      {hiddenSessions.map(sess => (
                        <div
                          key={sess.id}
                          style={{ position: 'absolute', inset: 0, opacity: 0, pointerEvents: 'none' }}
                        >
                          <ErrorBoundary
                            label={sess.serverName}
                            onReset={() => {
                              setSessions(prev => prev.filter(s => s.id !== sess.id));
                              if (activeView === sess.id) setActiveView("nodes");
                            }}
                          >
                            <SessionView
                              session={sess}
                              onClose={getCloseHandler(sess.id)}
                              addLog={addLog}
                              onStatusChange={handleSessionStatus}
                              onTerminalsChange={handleTerminalsChange}
                              chromeless={true}
                              isSessionActive={false}
                              onOpenSettings={() => setActiveView("settings")}
                            />
                          </ErrorBoundary>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="flex-1 relative bg-black/40">
                      {sessions.map(sess => {
                        const isFocused = activeView === sess.id;
                        return (
                          <div
                            key={sess.id}
                            style={isFocused ? { position: 'absolute', inset: 0 } : { position: 'absolute', inset: 0, opacity: 0, pointerEvents: 'none' }}
                            className="flex flex-col overflow-hidden"
                          >
                            <ErrorBoundary
                              label={sess.serverName}
                              onReset={() => {
                                setSessions(prev => prev.filter(s => s.id !== sess.id));
                                if (activeView === sess.id) setActiveView("nodes");
                              }}
                            >
                              <SessionView
                                session={sess}
                                onClose={getCloseHandler(sess.id)}
                                addLog={addLog}
                                onStatusChange={handleSessionStatus}
                                onTerminalsChange={handleTerminalsChange}
                                chromeless={false}
                                isSessionActive={isFocused && viewIsSession}
                                onOpenSettings={() => setActiveView("settings")}
                              />
                            </ErrorBoundary>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })()}

            {/* Wall canvas — a grid of individual terminal tiles pinned
                from any session. Independent of the session-split
                canvas above; the two live side-by-side in `main` with
                only one visible at a time. Wall tiles mount their own
                TerminalView in attach-only mode so xterm scrollback +
                PTY ownership stay with the primary xterm in the
                session tab. */}
            {activeView === "wall" && (
              <div className="absolute inset-0 flex flex-col overflow-hidden bg-[#0a0a0d]">
                {/* Toolbar: cols selector + Add + Clear. Rows are
                    derived automatically from tile count so users only
                    have to pick the horizontal density they want. */}
                <div className="h-10 shrink-0 border-b border-white/5 bg-[#111114] flex items-center gap-2 px-3">
                  <LayoutGrid size={12} className="text-primary/70 shrink-0" />
                  <span className="text-[10px] font-bold uppercase tracking-widest text-zinc-400 shrink-0">
                    Wall {wallItems.length > 0 ? `· ${wallItems.length}` : ''}
                  </span>
                  <div className="flex items-center gap-1 ml-2 shrink-0">
                    <span className="text-[9px] font-bold uppercase tracking-wider text-zinc-500">Cols</span>
                    {[1, 2, 3, 4, 5, 6].map(n => (
                      <button
                        key={n}
                        onClick={() => setWallCols(n)}
                        title={`${n} column${n === 1 ? '' : 's'} per row`}
                        className={`h-6 w-6 rounded flex items-center justify-center text-[10px] font-bold transition-all ${
                          wallCols === n
                            ? 'bg-primary/20 text-primary border border-primary/40'
                            : 'text-zinc-400 hover:bg-white/[0.06] border border-transparent'
                        }`}
                      >
                        {n}
                      </button>
                    ))}
                  </div>
                  <div className="flex-1" />
                  <button
                    onClick={() => setWallPickerOpen(v => !v)}
                    title="Pick terminals to pin"
                    className="px-3 py-1 bg-primary/15 hover:bg-primary/25 text-primary border border-primary/30 rounded-md text-[10px] font-bold uppercase tracking-wider flex items-center gap-1.5"
                  >
                    <Plus size={11} /> Add
                  </button>
                  {wallItems.length > 0 && (
                    <button
                      onClick={() => setWallItems([])}
                      title="Unpin everything (terminals stay open in their sessions)"
                      className="px-3 py-1 bg-white/[0.04] hover:bg-rose-500/15 hover:text-rose-300 border border-white/10 rounded-md text-[10px] font-bold uppercase tracking-wider text-zinc-400 flex items-center gap-1.5"
                    >
                      <X size={11} /> Clear
                    </button>
                  )}
                </div>

                {/* Grid canvas. Empty state overlaid when nothing is
                    pinned so we don't just show a black rectangle to a
                    first-time visitor. */}
                <div className="flex-1 relative bg-black/40 overflow-auto custom-scrollbar">
                  {wallItems.length === 0 ? (
                    <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 text-center px-6 pointer-events-none">
                      <LayoutGrid size={40} className="text-zinc-600" />
                      <div className="text-zinc-400 text-[13px] max-w-md leading-relaxed">
                        The Wall is a pinboard for watching multiple <em>terminals</em> at once.<br/>
                        Right-click a session tab or use the <span className="text-primary font-semibold">Add</span> button above to pin any terminal from any server.
                      </div>
                    </div>
                  ) : (
                    <div
                      className="min-h-full grid gap-1.5 p-1.5"
                      style={{
                        gridTemplateColumns: `repeat(${wallCols}, minmax(0, 1fr))`,
                        gridAutoRows: `minmax(220px, 1fr)`,
                      }}
                    >
                      {wallItems.map(item => {
                        const sess = sessions.find(s => s.id === item.sessionId);
                        if (!sess) return null;
                        const terms = sessionTerminals[item.sessionId] ?? [];
                        const term = terms.find(t => t.id === item.terminalId);
                        const st = sessionStatuses[item.sessionId] ?? 'connecting';
                        const dotTone =
                          st === 'connected'    ? 'bg-emerald-400' :
                          st === 'connecting'   ? 'bg-amber-400 animate-pulse' :
                                                  'bg-rose-500';
                        return (
                          <div
                            key={item.id}
                            className="flex flex-col overflow-hidden border border-white/10 rounded-md bg-[#09090b] shadow-[0_2px_10px_rgba(0,0,0,0.4)] hover:border-primary/30 transition-colors"
                          >
                            {/* Slim tile header — server + terminal
                                title, quick-jump into the session,
                                unpin. Terminal body below owns focus
                                so keystrokes go to xterm directly. */}
                            <div className="h-7 shrink-0 flex items-center gap-2 px-2 border-b border-white/5 bg-[#141418] text-[10.5px] select-none">
                              <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${dotTone}`} />
                              <span className="font-bold text-zinc-200 uppercase tracking-wider truncate">
                                {sess.serverName}
                              </span>
                              <span className="text-zinc-600">·</span>
                              <span className="text-zinc-400 truncate flex-1">
                                {term?.title ?? item.terminalId}
                              </span>
                              <button
                                onClick={() => setActiveView(sess.id)}
                                title="Open this session in its own tab"
                                className="h-5 w-5 rounded flex items-center justify-center text-zinc-500 hover:text-primary hover:bg-white/[0.05] transition-all"
                              >
                                <TerminalSquare size={11} />
                              </button>
                              <button
                                onClick={() => unpinTerminalFromWall(item.terminalId)}
                                title="Unpin from Wall"
                                className="h-5 w-5 rounded flex items-center justify-center text-zinc-500 hover:text-red-400 hover:bg-white/[0.05] transition-all"
                              >
                                <PinOff size={11} />
                              </button>
                            </div>
                            {/* Attach-only TerminalView: hitches onto
                                the same PTY as the session's primary
                                xterm without owning the lifecycle, so
                                closing the Wall or unpinning doesn't
                                drop the session. */}
                            {sessionStatuses[item.sessionId] === 'connected' ? (
                              <div className="flex-1 min-h-0 relative">
                                <TerminalView
                                  sessionId={item.sessionId}
                                  terminalId={item.terminalId}
                                  attachOnly
                                  disabled={false}
                                  isActive={true}
                                  serverId={sess.serverId}
                                  serverName={sess.serverName}
                                />
                              </div>
                            ) : (
                              <div className="flex-1 flex items-center justify-center text-zinc-500 text-[10.5px] font-medium uppercase tracking-wider">
                                Session {st}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                {/* Wall picker popover — 2-level session → terminal
                    tree so users can precisely pick which shells to
                    pin. Ticking a terminal pins; unticking unpins.
                    Session rows aren't selectable themselves; they
                    only group their terminals visually. */}
                {wallPickerOpen && (
                  <>
                    <div className="fixed inset-0 z-[65]" onClick={() => setWallPickerOpen(false)} />
                    <div className="absolute top-12 right-3 z-[66] w-80 max-h-[70vh] bg-[#15151a] border border-white/10 rounded-xl shadow-2xl p-2 flex flex-col">
                      <div className="px-2 pb-2 flex items-center justify-between shrink-0">
                        <span className="text-[10px] font-bold uppercase tracking-widest text-zinc-500">
                          Pin terminals
                        </span>
                        <button
                          onClick={() => setWallPickerOpen(false)}
                          className="h-5 w-5 rounded flex items-center justify-center text-zinc-500 hover:text-white hover:bg-white/[0.05]"
                        >
                          <X size={11} />
                        </button>
                      </div>
                      {sessions.length === 0 ? (
                        <div className="px-2 py-6 text-center text-zinc-500 text-[11px]">
                          No open sessions yet.
                        </div>
                      ) : (
                        <div className="overflow-y-auto custom-scrollbar space-y-1 pr-1">
                          {sessions.map(s => {
                            const terms = sessionTerminals[s.id] ?? [];
                            const st = sessionStatuses[s.id] ?? 'connecting';
                            return (
                              <div key={s.id} className="rounded bg-white/[0.02] border border-white/5">
                                <div className="flex items-center gap-2 px-2 py-1.5 border-b border-white/5">
                                  <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                                    st === 'connected' ? 'bg-emerald-400' :
                                    st === 'connecting' ? 'bg-amber-400' :
                                    'bg-rose-500'
                                  }`} />
                                  <span className="text-[11px] font-bold text-zinc-200 truncate flex-1">
                                    {s.serverName}
                                  </span>
                                  <span className="text-[9px] uppercase tracking-wider text-zinc-500">
                                    {terms.length} term{terms.length === 1 ? '' : 's'}
                                  </span>
                                </div>
                                {terms.length === 0 ? (
                                  <div className="px-3 py-2 text-[10px] text-zinc-500 italic">
                                    Session not yet ready.
                                  </div>
                                ) : (
                                  <div className="p-1 space-y-0.5">
                                    {terms.map(t => {
                                      const checked = wallHasTerminal(t.id);
                                      return (
                                        <label
                                          key={t.id}
                                          className={`flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer ${
                                            checked ? 'bg-primary/10' : 'hover:bg-white/[0.04]'
                                          }`}
                                        >
                                          <input
                                            type="checkbox"
                                            className="accent-primary shrink-0"
                                            checked={checked}
                                            onChange={() => {
                                              if (checked) unpinTerminalFromWall(t.id);
                                              else pinTerminalToWall(s.id, t.id);
                                            }}
                                          />
                                          <TerminalSquare size={11} className="text-zinc-500 shrink-0" />
                                          <span className="text-[11px] text-zinc-200 truncate flex-1">
                                            {t.title}
                                          </span>
                                        </label>
                                      );
                                    })}
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  </>
                )}
              </div>
            )}

            {/* Library = Commands + Notes merged.
                Commands and Notes used to be two distinct rails; both are
                per-profile lists of small text blobs stored inside the
                encrypted vault, and the only real difference is
                "runnable snippet vs freeform text". A single tab with an
                internal segmented control gives us the sidebar slot back
                on narrow viewports and puts both lists under one search
                box. The sub-tab state (`libraryTab`) is kept at the parent
                so it survives navigation elsewhere and back. */}
            {activeView === "library" && (() => {
              const q = libraryQuery.trim().toLowerCase();
              const filteredCommands = q
                ? commands.filter(c =>
                    (c.title || "").toLowerCase().includes(q) ||
                    (c.content || "").toLowerCase().includes(q))
                : commands;
              const filteredNotes = q
                ? notes.filter(n =>
                    (n.title || "").toLowerCase().includes(q) ||
                    (n.body || "").toLowerCase().includes(q))
                : notes;
              const onCommandsTab = libraryTab === "commands";
              const addLabel = onCommandsTab ? "Add Command" : "Add Note";
              const openAdd = () => {
                if (onCommandsTab) {
                  setEditCommandData({ id: null, title: "", content: "" });
                  setIsCommandPanelOpen(true);
                } else {
                  setEditNoteData({ id: null, title: "", body: "" });
                  setIsNotePanelOpen(true);
                }
              };
              return (
                <div className="flex-1 flex flex-col p-4 sm:p-8 space-y-5 sm:space-y-6 animate-in overflow-y-auto custom-scrollbar">
                  <header className="flex flex-col gap-3 border-b border-zinc-700 pb-5 sm:pb-6 shrink-0">
                    <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-3">
                      <div className="min-w-0">
                        <h2 className="text-[18px] sm:text-[22px] font-bold text-white tracking-tight flex items-center gap-2">
                          Library
                          <span
                            title="All entries are AES-256-GCM encrypted inside the current profile vault."
                            className="inline-flex items-center gap-1 h-5 px-1.5 rounded-full bg-emerald-500/10 border border-emerald-500/30 text-[9px] font-bold uppercase tracking-wider text-emerald-300"
                          >
                            <Shield size={9} /> Vault-locked
                          </span>
                        </h2>
                        <p className="hidden sm:block text-[13px] text-zinc-400">
                          Reusable snippets and freeform notes — encrypted with your profile key.
                        </p>
                      </div>
                      <div className="flex gap-2 items-center">
                        <div className="relative">
                          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-500 pointer-events-none" />
                          <input
                            type="text"
                            value={libraryQuery}
                            onChange={(e) => setLibraryQuery(e.target.value)}
                            placeholder="Search title or content…"
                            className="h-9 pl-7 pr-3 w-44 sm:w-56 bg-black/40 border border-white/10 rounded-xl text-[12px] text-zinc-200 placeholder:text-zinc-600 outline-none focus:border-primary/40"
                          />
                        </div>
                        <button
                          onClick={openAdd}
                          title={addLabel}
                          className="h-9 px-3 sm:px-4 bg-primary text-black text-[12px] sm:text-[13px] font-bold rounded-xl shadow-lg shadow-primary/20 flex items-center gap-1.5 transition-all hover:brightness-110 self-start sm:self-auto"
                        >
                          <Plus size={14} /> {addLabel}
                        </button>
                      </div>
                    </div>
                    {/* Segmented control — Commands vs Notes. Counts sit
                        inside each pill so switching contexts is a single
                        glance. */}
                    <div className="flex items-center gap-1 self-start bg-black/30 border border-white/5 rounded-xl p-0.5">
                      <button
                        onClick={() => setLibraryTab("commands")}
                        className={`h-8 px-3 rounded-lg text-[11px] font-bold uppercase tracking-wider transition-all flex items-center gap-1.5 ${
                          onCommandsTab
                            ? "bg-primary/15 text-primary shadow-inner"
                            : "text-zinc-400 hover:text-zinc-100"
                        }`}
                      >
                        <TerminalSquare size={12} /> Commands
                        <span className={`text-[9px] font-bold ${onCommandsTab ? "text-primary/70" : "text-zinc-600"}`}>
                          {filteredCommands.length}
                        </span>
                      </button>
                      <button
                        onClick={() => setLibraryTab("notes")}
                        className={`h-8 px-3 rounded-lg text-[11px] font-bold uppercase tracking-wider transition-all flex items-center gap-1.5 ${
                          !onCommandsTab
                            ? "bg-primary/15 text-primary shadow-inner"
                            : "text-zinc-400 hover:text-zinc-100"
                        }`}
                      >
                        <StickyNote size={12} /> Notes
                        <span className={`text-[9px] font-bold ${!onCommandsTab ? "text-primary/70" : "text-zinc-600"}`}>
                          {filteredNotes.length}
                        </span>
                      </button>
                    </div>
                  </header>

                  {onCommandsTab ? (
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 pb-10">
                      {filteredCommands.length === 0 ? (
                        <div className="col-span-full py-12 text-center text-zinc-500 text-[14px] italic border border-dashed border-white/10 rounded-2xl">
                          {q ? `No commands match "${libraryQuery}".` : "No commands yet."}
                        </div>
                      ) : (
                        filteredCommands.map(cmd => (
                          <div key={cmd.id} className="bg-[#16161a] border border-white/5 rounded-2xl p-4 flex flex-col group relative overflow-hidden shadow-inner h-[150px]">
                            <div className="flex justify-between items-start mb-2">
                              <h3 className="text-[16px] font-bold text-primary tracking-tight truncate flex-1">{cmd.title}</h3>
                              <div className="flex items-center gap-2 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity">
                                {sessions.length > 0 && (
                                  <button
                                    onClick={() => handleExecuteSnippet(cmd.content, cmd.title)}
                                    title="Run command in terminal"
                                    className="px-2 py-0.5 rounded-lg bg-primary/10 hover:bg-primary/20 text-primary transition-colors flex items-center gap-1 text-[11px] font-bold"
                                  >
                                    <Play size={10} className="fill-primary" />
                                    <span>Run</span>
                                  </button>
                                )}
                                <button onClick={() => { setEditCommandData(cmd); setIsCommandPanelOpen(true); }} className="text-zinc-500 hover:text-white transition-colors"><Edit2 size={14} /></button>
                                <button onClick={async () => {
                                  const ok = await confirm({ title: "Delete command?", message: `“${cmd.title}” will be removed.`, destructive: true });
                                  if (!ok) return;
                                  invoke("delete_command", { id: cmd.id }).then(() => { refreshCommands(); bumpSync(); });
                                }} className="text-zinc-500 hover:text-red-500 transition-colors"><Trash2 size={14} /></button>
                              </div>
                            </div>
                            <div className="bg-black/30 rounded-xl p-3 border border-white/5 flex-1 relative group-hover:border-primary/20 transition-colors overflow-hidden">
                              <pre className="text-[12px] text-zinc-400 font-mono whitespace-pre-wrap leading-relaxed line-clamp-3">{cmd.content}</pre>
                            </div>
                          </div>
                        ))
                      )}
                    </div>
                  ) : (
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 pb-10">
                      {filteredNotes.length === 0 ? (
                        <div className="col-span-full py-12 text-center text-zinc-500 text-[14px] italic border border-dashed border-white/10 rounded-2xl">
                          {q ? `No notes match "${libraryQuery}".` : "No notes yet."}
                        </div>
                      ) : (
                        filteredNotes.map(n => (
                          <div key={n.id} className="bg-[#16161a] border border-white/5 rounded-2xl p-4 flex flex-col group relative overflow-hidden shadow-inner h-[170px]">
                            <div className="flex justify-between items-start mb-2 gap-2">
                              <h3 className="text-[15px] font-bold text-primary tracking-tight truncate flex-1">{n.title || "Untitled"}</h3>
                              <div className="flex items-center gap-2 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity shrink-0">
                                <button onClick={() => { setEditNoteData({ id: n.id, title: n.title || "", body: n.body || "" }); setIsNotePanelOpen(true); }} className="text-zinc-500 hover:text-white transition-colors"><Edit2 size={14} /></button>
                                <button onClick={async () => {
                                  const ok = await confirm({ title: "Delete note?", message: `“${n.title || "Untitled"}” will be removed.`, destructive: true });
                                  if (!ok) return;
                                  invoke("delete_note", { id: n.id }).then(() => { refreshNotes(); bumpSync(); });
                                }} className="text-zinc-500 hover:text-red-500 transition-colors"><Trash2 size={14} /></button>
                              </div>
                            </div>
                            <div className="bg-black/30 rounded-xl p-3 border border-white/5 flex-1 relative group-hover:border-primary/20 transition-colors overflow-hidden cursor-pointer"
                                 onClick={() => { setEditNoteData({ id: n.id, title: n.title || "", body: n.body || "" }); setIsNotePanelOpen(true); }}>
                              <pre className="text-[12px] text-zinc-400 whitespace-pre-wrap leading-relaxed line-clamp-4 font-sans">{n.body}</pre>
                            </div>
                          </div>
                        ))
                      )}
                    </div>
                  )}
                </div>
              );
            })()}

            {/* Monitor is mounted permanently and just CSS-hidden when not
                active. Unmounting would tear down the sample/history ring
                buffers, the per-node event listeners, and the 1s tick — so
                switching tabs felt like monitoring "stopped". Keeping it
                mounted preserves the live data; the backend pollers were
                always running, only the UI side was losing state. */}
            {appSettings.enableMonitoring && (
              <div className={`flex-1 flex flex-col overflow-hidden ${activeView === "monitor" ? "" : "hidden"}`}>
                <MonitoringPanel servers={servers} refreshServers={refreshServers} addLog={addLog} />
              </div>
            )}

            {/* Compare workspace — pick any subset of open sessions and
                tile their currently-visible terminals in one canvas.
                Uses BroadcastContext.sessionTerminalMap to look up which
                of each session's tabs is the "current" one; a tile just
                re-mounts a TerminalView pointing at that (sessionId,
                terminalId) pair. Since the source SessionView also stays
                mounted, both instances stay in sync via the shared
                `terminal-output-<id>` events — closing a tile doesn't
                tear the terminal down, it just detaches this view.

                Layout: `grid-cols-N` for up to 4 tiles (1/2/2/2), then
                `grid-cols-3` for 5-9, then `grid-cols-4` for 10+. Rows
                fill down; each tile stretches equally so the user
                doesn't have to fiddle with dividers to compare row
                lengths — the whole point of compare mode is uniform
                side-by-side. */}
            {activeView === "logs" && (
              <div className="flex-1 flex flex-col p-3 sm:p-8 space-y-3 sm:space-y-6 animate-in overflow-hidden">
                <header className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-2 sm:gap-3 border-b border-zinc-700 pb-3 sm:pb-6 shrink-0">
                  <div className="flex items-center gap-2 min-w-0">
                    <button
                      onClick={() => setActiveView("settings")}
                      className="h-8 w-8 sm:hidden flex items-center justify-center rounded-lg text-zinc-400 hover:text-white hover:bg-white/5 transition-all shrink-0"
                      title="Back to Settings"
                    >
                      <ChevronLeft size={18} />
                    </button>
                    <div className="min-w-0">
                      <h2 className="text-[16px] sm:text-[22px] font-bold text-white tracking-tight">Activity</h2>
                      <p className="hidden sm:block text-[13px] text-zinc-400">What the app has been doing.</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 self-end sm:self-auto">
                    <button
                      onClick={() => setActiveView("settings")}
                      className="hidden sm:flex h-9 px-3 bg-white/[0.04] text-zinc-300 text-[12px] font-bold rounded-xl border border-white/5 hover:bg-white/10 hover:text-white transition-all items-center gap-1.5"
                    >
                      <ChevronLeft size={14} /> Settings
                    </button>
                    <button onClick={async () => {
                      const ok = await confirm({ title: "Clear activity log?", message: "All entries will be discarded.", destructive: true });
                      if (!ok) return;
                      setLogs([]);
                    }} className="h-8 sm:h-9 px-2.5 sm:px-4 bg-zinc-900 text-zinc-200 text-[11px] sm:text-[13px] font-bold rounded-xl border border-white/5 hover:bg-red-500/20 hover:text-red-400 hover:border-primary/50 transition-all flex items-center gap-1.5">
                      <Trash2 size={13} /> Clear
                    </button>
                  </div>
                </header>

                <div className="flex-1 overflow-y-auto custom-scrollbar bg-black/50 rounded-xl sm:rounded-2xl border border-white/5 p-2 sm:p-4 space-y-0.5 sm:space-y-1 shadow-inner select-text cursor-text">
                  {logs.length === 0 ? (
                    <div className="h-full flex items-center justify-center text-zinc-600 text-[12px] sm:text-[14px] font-mono italic">
                      Nothing yet.
                    </div>
                  ) : (
                    [...logs].reverse().map((log) => (
                      <div
                        key={(log as any).id ?? `${log.time}-${log.msg}`}
                        className="flex flex-col sm:flex-row sm:items-start sm:gap-3 text-[10px] sm:text-[12px] font-mono group hover:bg-white/5 p-1 rounded-md transition-colors"
                      >
                        <div className="flex items-baseline gap-2 sm:gap-3 sm:shrink-0">
                          <span className="text-zinc-600 sm:w-20 shrink-0">{log.time}</span>
                          <span className={`sm:w-24 shrink-0 font-bold uppercase ${log.type === 'error' ? 'text-red-500' : log.type === 'success' ? 'text-primary' : log.type === 'warn' ? 'text-amber-500' : 'text-sky-300'}`}>
                            [{log.type}]
                          </span>
                        </div>
                        <span className="text-zinc-300 break-all sm:flex-1">{log.msg}</span>
                      </div>
                    ))
                  )}
                </div>
              </div>
            )}

            </>
          )}
          </main>
        </div>

      <AddNodePanel
        isOpen={isPanelOpen}
        initialImportOpen={isImportModalRequested}
        onClose={() => {
          setIsPanelOpen(false);
          setIsImportModalRequested(false);
          setFormError("");
        }}
        newNode={newNode} setNewNode={setNewNode}
        isEditMode={!!newNode.id}
        onSave={async () => {
          if (!newNode.name || !newNode.host) {
            setFormError("Name and Host are required.");
            addLog("Name and Host are required.", "error");
            return;
          }
          if (newNode.authType === "vault" && !newNode.credentialId) {
            setFormError("Please pick a saved login.");
            addLog("Please pick a saved login.", "error");
            return;
          }
          if (newNode.authType === "custom_key" && !newNode.keyId) {
            setFormError("Please pick an SSH key.");
            addLog("Please pick an SSH key.", "error");
            return;
          }
          try {
            // Identity fields are only meaningful for inline (custom_*) modes;
            // in vault mode the credential owns username/password/key and we
            // send nulls so the DB row matches reality. The backend's
            // `normalize_server_identity` enforces this again on the server
            // side as a belt-and-suspenders guarantee.
            const isInline = newNode.authType === "custom_pass" || newNode.authType === "custom_key";
            const payload = {
              name: newNode.name,
              host: newNode.host,
              port: newNode.port,
              username: isInline
                ? (newNode.username?.trim() ? newNode.username.trim() : "root")
                : null,
              password: newNode.authType === "custom_pass" ? (newNode.password || null) : null,
              credentialId: (newNode.authType === "vault" && newNode.credentialId) ? parseInt(newNode.credentialId) : null,
              folderId: newNode.folderId ? parseInt(newNode.folderId) : null,
              proxyType: newNode.proxyType || "none",
              proxyHost: newNode.proxyHost || "",
              proxyPort: newNode.proxyPort || 1080,
              tunnels: newNode.tunnels || [],
              authType: newNode.authType,
              keyId: newNode.authType === "custom_key" && newNode.keyId ? parseInt(newNode.keyId) : null,
              autostart: !!newNode.autostart,
              mirrors: newNode.mirrors || [],
              color: newNode.color ?? null,
              forwardAgent: !!newNode.forward_agent,
              // Edit-mode + untouched password field = ask the backend to
              // keep the existing column. Otherwise the bind below sends
              // whatever's in the field (including empty / null) which
              // would overwrite the DB value.
              preservePassword: !!newNode.id && !newNode.password_dirty,
            };
            const action = newNode.id
              ? invoke<void>("edit_server", { id: newNode.id, ...payload }).then(() => newNode.id!)
              : invoke<number>("add_server", payload);

            const savedId = await action;
            // Notes live on the server row but go through their own command
            // (set_server_notes) so we don't have to thread a long-text field
            // through every add/edit_server signature. Empty string is valid
            // — clears any previous note.
            try {
              await invoke("set_server_notes", { id: savedId, notes: newNode.notes || "" });
            } catch (e) {
              addLog(`SAVE_NOTES_FAILED: ${e}`, "error");
            }
            // Same separate-write pattern for the on-connect commands.
            try {
              await invoke("set_server_run_on_connect", { id: savedId, value: newNode.runOnConnect || "" });
            } catch (e) {
              addLog(`SAVE_RUN_ON_CONNECT_FAILED: ${e}`, "error");
            }
            // ProxyJump target — same separate-write pattern. Empty string
            // means "no jump host" → store NULL.
            try {
              await invoke("set_server_jump_host", { id: savedId, value: newNode.jumpHostId ? parseInt(newNode.jumpHostId) : null });
            } catch (e) {
              addLog(`SAVE_JUMP_HOST_FAILED: ${e}`, "error");
            }
            try {
              await invoke("set_server_is_production", { id: savedId, value: !!newNode.is_production });
            } catch (e) {
              addLog(`SAVE_IS_PRODUCTION_FAILED: ${e}`, "error");
            }
            try {
              await invoke("set_server_icon", { id: savedId, icon: newNode.icon || "server" });
            } catch (e) {
              addLog(`SAVE_ICON_FAILED: ${e}`, "error");
            }
            setIsPanelOpen(false);
            setFormError("");
            refreshServers();
            bumpSync();
            // If we just edited a node whose session is live, re-apply its saved
            // forwarding rules now so a changed/added tunnel comes up without a
            // manual reconnect. The backend cleared the stale tunnel cache when
            // the rules changed, so this re-seeds from the freshly-saved DB rules
            // (idempotent + a no-op when nothing forwarding-related changed).
            if (newNode.id && sessionStatuses[`session-${savedId}`] === "connected") {
              invoke("restart_session_tunnels", { sessionId: `session-${savedId}`, serverId: savedId }).catch(() => {});
            }
            addLog(`Node ${newNode.id ? 'updated' : 'added'} successfully.`, "success");
          } catch (e) {
            setFormError(`Failed to save: ${e}`);
            addLog(`SAVE_ERROR: ${e}`, "error");
          }
        }}
        formError={formError}
        credentials={credentials} sshKeys={sshKeys} refreshSshKeys={refreshSshKeys} folders={folders} refreshFolders={refreshFolders}
        refreshServers={refreshServers}
        servers={servers}
        isMobile={isMobile}
      />

      <QuickConnectModal
        isOpen={isQuickConnectOpen}
        onClose={() => setIsQuickConnectOpen(false)}
        onConnect={openQuickConnect}
      />

      <NetworkToolsModal
        isOpen={isNetworkToolsOpen}
        onClose={() => setIsNetworkToolsOpen(false)}
        servers={servers}
      />

      <WorkspaceSwitcherModal
        isOpen={isWorkspaceSwitcherOpen}
        onClose={() => setIsWorkspaceSwitcherOpen(false)}
        activeProfile={activeProfile}
        onSwitchWorkspace={switchWorkspace}
        onOpenSettings={() => {
          setIsWorkspaceSwitcherOpen(false);
          setActiveView("settings");
        }}
      />

      {isUnlockModalOpen && (
        <MasterUnlockPage
          isModal={true}
          onClose={() => setIsUnlockModalOpen(false)}
          onUnlocked={(p) => {
            setIsUnlockModalOpen(false);
            handleProfileUnlocked(p);
          }}
          autoSync={appSettings.autoSync}
          onOpenSettings={() => {
            setIsUnlockModalOpen(false);
            setActiveView("settings");
          }}
          initialSelectedProfile={activeProfile}
        />
      )}

      {isUnlocked && (
        <CommandPalette
        isOpen={isCommandPaletteOpen}
        onClose={() => setIsCommandPaletteOpen(false)}
        servers={servers}
        sessions={sessions}
        activeView={activeView}
        enableMonitoring={appSettings.enableMonitoring}
        onSelectView={(viewId) => {
          setActiveView(viewId);
          setIsCommandPaletteOpen(false);
        }}
        onConnectServer={(server) => {
          openServer(server);
          setIsCommandPaletteOpen(false);
        }}
        onOpenQuickConnect={() => {
          setIsCommandPaletteOpen(false);
          setIsQuickConnectOpen(true);
        }}
        onOpenLocalTerminal={() => {
          setIsCommandPaletteOpen(false);
          openLocalTerminal();
        }}
        onOpenAddNode={() => {
          setIsCommandPaletteOpen(false);
          setNewNode(defaultNode);
          setIsPanelOpen(true);
        }}
        onOpenSettings={() => {
          setIsCommandPaletteOpen(false);
          setActiveView("settings");
        }}
        onCloseSession={(sessId) => {
          getCloseHandler(sessId)();
        }}
        commands={commands}
        onExecuteCommand={(cmd) => {
          handleExecuteSnippet(cmd);
        }}
      />
      )}


      <div className={`fixed inset-0 z-50 transition-all duration-500 flex justify-end ${isCommandPanelOpen ? 'bg-black/80 backdrop-blur-sm' : 'opacity-0 pointer-events-none'}`} onClick={() => setIsCommandPanelOpen(false)}>
        <div className={`w-full max-w-[400px] bg-[#09090b] border-l border-white/5 shadow-2xl transition-all duration-500 h-full flex flex-col ${isCommandPanelOpen ? 'translate-x-0' : 'translate-x-full'}`} onClick={(e) => e.stopPropagation()}>
          <div className="flex justify-between items-center p-6 border-b border-white/5 shrink-0">
            <h2 className="text-[15px] font-bold text-white tracking-tight flex items-center gap-2">
              <TerminalSquare size={18} className="text-primary" />
              {editCommandData.id ? "Edit command" : "New command"}
            </h2>
            <button onClick={() => { setIsCommandPanelOpen(false); setFormError(""); }} className="w-7 h-7 flex items-center justify-center text-zinc-500 hover:text-white bg-black border border-white/5 hover:bg-white/10 rounded-full transition-all">
              <X size={16} />
            </button>
          </div>
          <div className="p-6 flex-1 overflow-y-auto space-y-6">
            {formError && <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-xl text-red-500 text-[12px] font-bold">{formError}</div>}
            <div className="space-y-1.5">
              <label className="text-[12px] font-bold text-zinc-400 ml-1">Title</label>
              <input type="text" className="w-full h-10 bg-black rounded-lg px-3 text-[13px] text-white border border-white/10 outline-none focus:border-primary/50 focus:bg-zinc-900/50 transition-all shadow-inner" placeholder="e.g. Update packages" value={editCommandData.title} onChange={e => setEditCommandData({ ...editCommandData, title: e.target.value })} />
            </div>
            <div className="space-y-1.5 flex-1 flex flex-col h-64">
              <label className="text-[12px] font-bold text-zinc-400 ml-1">Command</label>
              <textarea className="w-full flex-1 bg-black rounded-lg p-3 text-[13px] text-zinc-300 font-mono border border-white/10 outline-none focus:border-primary/50 focus:bg-zinc-900/50 transition-all shadow-inner custom-scrollbar resize-none" placeholder="sudo apt update && sudo apt upgrade -y" value={editCommandData.content} onChange={e => setEditCommandData({ ...editCommandData, content: e.target.value })} />
            </div>
          </div>
          <div className="p-6 border-t border-white/5 shrink-0">
            <button 
              onClick={async () => {
                if (!editCommandData.title || !editCommandData.content) {
                  addLog("Title and Content are required.", "error");
                  return;
                }
                try {
                  const action = editCommandData.id 
                    ? invoke("edit_command", { id: editCommandData.id, title: editCommandData.title, content: editCommandData.content })
                    : invoke("add_command", { title: editCommandData.title, content: editCommandData.content });
                  await action;
                  setIsCommandPanelOpen(false);
                  refreshCommands();
                  bumpSync();
                  addLog("Command saved.", "success");
                } catch (e) {
                  setFormError(`Failed to save command: ${e}`);
                  addLog(`COMMAND_SAVE_ERROR: ${e}`, "error");
                }
              }} 
              className="w-full h-10 bg-primary text-black font-bold rounded-lg text-[13px] tracking-tight hover:brightness-110 transition-all active:scale-[0.98] shadow-[0_0_15px_rgba(var(--primary),0.2)] flex items-center justify-center gap-2"
            >
              Save
            </button>
          </div>
        </div>
      </div>

      <div className={`fixed inset-0 z-50 transition-all duration-500 flex justify-end ${isNotePanelOpen ? 'bg-black/80 backdrop-blur-sm' : 'opacity-0 pointer-events-none'}`} onClick={() => setIsNotePanelOpen(false)}>
        <div className={`w-full max-w-[480px] bg-[#09090b] border-l border-white/5 shadow-2xl transition-all duration-500 h-full flex flex-col ${isNotePanelOpen ? 'translate-x-0' : 'translate-x-full'}`} onClick={(e) => e.stopPropagation()}>
          <div className="flex justify-between items-center p-6 border-b border-white/5 shrink-0">
            <h2 className="text-[15px] font-bold text-white tracking-tight flex items-center gap-2">
              <StickyNote size={18} className="text-primary" />
              {editNoteData.id ? "Edit note" : "New note"}
            </h2>
            <button onClick={() => { setIsNotePanelOpen(false); setFormError(""); }} className="w-7 h-7 flex items-center justify-center text-zinc-500 hover:text-white bg-black border border-white/5 hover:bg-white/10 rounded-full transition-all">
              <X size={16} />
            </button>
          </div>
          <div className="p-6 flex-1 overflow-y-auto space-y-6 flex flex-col">
            {formError && <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-xl text-red-500 text-[12px] font-bold">{formError}</div>}
            <div className="space-y-1.5">
              <label className="text-[12px] font-bold text-zinc-400 ml-1">Title</label>
              <input type="text" className="w-full h-10 bg-black rounded-lg px-3 text-[13px] text-white border border-white/10 outline-none focus:border-primary/50 focus:bg-zinc-900/50 transition-all shadow-inner" placeholder="e.g. Production credentials reminder" value={editNoteData.title} onChange={e => setEditNoteData({ ...editNoteData, title: e.target.value })} />
            </div>
            <div className="space-y-1.5 flex-1 flex flex-col min-h-[240px]">
              <label className="text-[12px] font-bold text-zinc-400 ml-1">Content</label>
              <textarea className="w-full flex-1 bg-black rounded-lg p-3 text-[13px] text-zinc-300 border border-white/10 outline-none focus:border-primary/50 focus:bg-zinc-900/50 transition-all shadow-inner custom-scrollbar resize-none leading-relaxed" placeholder="Write anything — markdown, paths, secrets you'd otherwise forget…" value={editNoteData.body} onChange={e => setEditNoteData({ ...editNoteData, body: e.target.value })} />
            </div>
          </div>
          <div className="p-6 border-t border-white/5 shrink-0">
            <button
              onClick={async () => {
                if (!editNoteData.title.trim() && !editNoteData.body.trim()) {
                  setFormError("Add a title or some content first.");
                  return;
                }
                try {
                  const action = editNoteData.id
                    ? invoke("edit_note", { id: editNoteData.id, title: editNoteData.title, body: editNoteData.body })
                    : invoke("add_note", { title: editNoteData.title, body: editNoteData.body });
                  await action;
                  setIsNotePanelOpen(false);
                  refreshNotes();
                  bumpSync();
                  addLog("Note saved.", "success");
                } catch (e) {
                  setFormError(`Failed to save note: ${e}`);
                  addLog(`NOTE_SAVE_ERROR: ${e}`, "error");
                }
              }}
              className="w-full h-10 bg-primary text-black font-bold rounded-lg text-[13px] tracking-tight hover:brightness-110 transition-all active:scale-[0.98] shadow-[0_0_15px_rgba(var(--primary),0.2)] flex items-center justify-center gap-2"
            >
              Save
            </button>
          </div>
        </div>
      </div>

      <div className={`fixed inset-0 z-50 transition-all duration-500 flex justify-end ${isCredPanelOpen ? 'bg-black/80 backdrop-blur-sm' : 'opacity-0 pointer-events-none'}`} onClick={() => setIsCredPanelOpen(false)}>
        <div className={`w-full max-w-[400px] bg-[#09090b] border-l border-white/5 shadow-2xl transition-all duration-500 h-full flex flex-col ${isCredPanelOpen ? 'translate-x-0' : 'translate-x-full'}`} onClick={(e) => e.stopPropagation()}>
          <div className="flex justify-between items-center p-6 border-b border-white/5 shrink-0">
            <h2 className="text-[15px] font-bold text-white tracking-tight flex items-center gap-2">
              <Shield size={18} className="text-primary" />
              {editCredData.id ? "Edit login" : "New login"}
            </h2>
            <button onClick={() => { setIsCredPanelOpen(false); setFormError(""); }} className="w-7 h-7 flex items-center justify-center text-zinc-500 hover:text-white bg-black border border-white/5 hover:bg-white/10 rounded-full transition-all">
              <X size={16} />
            </button>
          </div>
          <div className="p-6 flex-1 overflow-y-auto space-y-6">
            {formError && <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-xl text-red-500 text-[12px] font-bold">{formError}</div>}
            <div className="space-y-1.5">
              <label className="text-[12px] font-bold text-zinc-400 ml-1">Name</label>
              <input type="text" className="w-full h-10 bg-black rounded-lg px-3 text-[13px] text-white border border-white/10 outline-none focus:border-primary/50 focus:bg-zinc-900/50 transition-all shadow-inner" placeholder="e.g. Work server" value={editCredData.name} onChange={e => setEditCredData({ ...editCredData, name: e.target.value })} />
            </div>
            <div className="space-y-1.5">
              <label className="text-[12px] font-bold text-zinc-400 ml-1">Username</label>
              <input type="text" className="w-full h-10 bg-black rounded-lg px-3 text-[13px] text-white border border-white/10 outline-none focus:border-primary/50 focus:bg-zinc-900/50 transition-all shadow-inner" placeholder="root" value={editCredData.username} onChange={e => setEditCredData({ ...editCredData, username: e.target.value })} />
            </div>
            <div className="space-y-4 pt-2">
              <div className="flex justify-between items-center">
                <label className="text-[12px] font-bold text-zinc-400 ml-1">Sign in with</label>
                <select
                  className="bg-transparent text-[12px] font-bold text-primary outline-none cursor-pointer"
                  value={editCredData.auth_type || "password"}
                  onChange={e => setEditCredData({ ...editCredData, auth_type: e.target.value })}
                >
                  <option value="password" className="bg-[#121215] text-primary">Password</option>
                  <option value="key" className="bg-[#121215] text-primary">SSH key</option>
                </select>
              </div>
            </div>
            {editCredData.auth_type === "key" ? (
              <div className="space-y-1.5 animate-in fade-in">
                <label className="text-[12px] font-bold text-zinc-400 ml-1">Pick a key</label>
                <select
                  className="w-full h-10 bg-black rounded-lg px-3 text-[13px] text-zinc-300 border border-white/10 outline-none focus:border-primary/50 transition-all shadow-inner"
                  value={editCredData.key_id?.toString() || ""}
                  onChange={e => setEditCredData({ ...editCredData, key_id: e.target.value ? parseInt(e.target.value) : null })}
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
                  value={editCredData.password || ""}
                  onChange={(v) => setEditCredData({ ...editCredData, password: v })}
                  className="w-full h-10 bg-black rounded-lg px-3 text-[13px] text-white border border-white/10 outline-none focus:border-primary/50 focus:bg-zinc-900/50 transition-all shadow-inner"
                />
              </div>
            )}
          </div>
          <div className="p-6 border-t border-white/5 shrink-0">
            <button 
              onClick={async () => {
                if (!editCredData.name) {
                  setFormError("Name is required.");
                  addLog("Name is required.", "error");
                  return;
                }
                if (editCredData.auth_type === "key" && !editCredData.key_id) {
                  setFormError("Please select a linked SSH Private Key.");
                  addLog("Please select a linked SSH Private Key.", "error");
                  return;
                }
                try {
                  const payload = {
                    name: editCredData.name,
                    authType: editCredData.auth_type || "password",
                    username: editCredData.username?.trim() ? editCredData.username.trim() : "root",
                    password: editCredData.auth_type === "key" ? null : (editCredData.password || null),
                    keyId: editCredData.auth_type === "key" ? (editCredData.key_id ? parseInt(editCredData.key_id.toString()) : null) : null
                  };
                  const action = editCredData.id 
                    ? invoke("edit_credential", { id: editCredData.id, ...payload })
                    : invoke("add_credential", payload);
                  await action;
                  setIsCredPanelOpen(false);
                  refreshCredentials();
                  bumpSync();
                  addLog("Credential saved.", "success");
                } catch (e) {
                  setFormError(`Failed to save credential: ${e}`);
                  addLog(`CRED_SAVE_ERROR: ${e}`, "error");
                }
              }} 
              className="w-full h-10 bg-primary text-black font-bold rounded-lg text-[13px] tracking-tight hover:brightness-110 transition-all active:scale-[0.98] flex items-center justify-center gap-2"
            >
              Save
            </button>
          </div>
        </div>
      </div>

      <div className={`fixed inset-0 z-50 transition-all duration-500 flex justify-end ${isKeyPanelOpen ? 'bg-black/80 backdrop-blur-sm' : 'opacity-0 pointer-events-none'}`} onClick={() => setIsKeyPanelOpen(false)}>
        <div className={`w-full max-w-[450px] bg-[#09090b] border-l border-white/5 shadow-2xl transition-all duration-500 h-full flex flex-col ${isKeyPanelOpen ? 'translate-x-0' : 'translate-x-full'}`} onClick={(e) => e.stopPropagation()}>
          <div className="flex justify-between items-center p-6 border-b border-white/5 shrink-0">
            <h2 className="text-[15px] font-bold text-white tracking-tight flex items-center gap-2">
              <Key size={18} className="text-primary" />
              {editKeyData.id ? "Edit SSH key" : "New SSH key"}
            </h2>
            <button onClick={() => { setIsKeyPanelOpen(false); setFormError(""); }} className="w-7 h-7 flex items-center justify-center text-zinc-500 hover:text-white bg-black border border-white/5 hover:bg-white/10 rounded-full transition-all">
              <X size={16} />
            </button>
          </div>
          <div className="p-6 flex-1 overflow-y-auto space-y-6">
            {formError && <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-xl text-red-500 text-[12px] font-bold">{formError}</div>}
            <div className="space-y-1.5">
              <label className="text-[12px] font-bold text-zinc-400 ml-1">Name</label>
              <input type="text" className="w-full h-10 bg-black rounded-lg px-3 text-[13px] text-white border border-white/10 outline-none focus:border-primary/50 focus:bg-zinc-900/50 transition-all shadow-inner" placeholder="e.g. My laptop key" value={editKeyData.name} onChange={e => setEditKeyData({ ...editKeyData, name: e.target.value })} />
            </div>
            <div className="space-y-1.5">
              <label className="text-[12px] font-bold text-zinc-400 ml-1">Public key</label>
              <textarea className="w-full h-24 bg-black rounded-lg p-3 text-[13px] text-zinc-400 font-mono border border-white/10 outline-none focus:border-primary/50 focus:bg-zinc-900/50 transition-all shadow-inner custom-scrollbar resize-none" placeholder="ssh-ed25519 ..." value={editKeyData.public_key} onChange={e => setEditKeyData({ ...editKeyData, public_key: e.target.value })} />
            </div>
            <div className="space-y-1.5">
              <label className="text-[12px] font-bold text-zinc-400 ml-1">Private key</label>
              <textarea className="w-full h-32 bg-black rounded-lg p-3 text-[13px] text-zinc-400 font-mono border border-white/10 outline-none focus:border-primary/50 focus:bg-zinc-900/50 transition-all shadow-inner custom-scrollbar resize-none" placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" value={editKeyData.private_key} onChange={e => setEditKeyData({ ...editKeyData, private_key: e.target.value })} />
            </div>
            <div className="space-y-1.5">
              <label className="text-[12px] font-bold text-zinc-400 ml-1">Passphrase (if any)</label>
              <PasswordField
                value={editKeyData.passphrase || ""}
                onChange={(v) => setEditKeyData({ ...editKeyData, passphrase: v })}
                className="w-full h-10 bg-black rounded-lg px-3 text-[13px] text-white border border-white/10 outline-none focus:border-primary/50 focus:bg-zinc-900/50 transition-all shadow-inner"
              />
            </div>
          </div>
          <div className="p-6 border-t border-white/5 shrink-0">
            <button 
              onClick={async () => {
                if (!editKeyData.name || !editKeyData.private_key) {
                  addLog("Name and Private Key are required.", "error");
                  return;
                }
                try {
                  const payload = {
                    name: editKeyData.name,
                    publicKey: editKeyData.public_key,
                    privateKey: editKeyData.private_key,
                    passphrase: editKeyData.passphrase || null
                  };
                  const action = editKeyData.id 
                    ? invoke("edit_ssh_key", { id: editKeyData.id, ...payload })
                    : invoke("add_ssh_key", payload);
                  await action;
                  setIsKeyPanelOpen(false);
                  refreshSshKeys();
                  bumpSync();
                  addLog("SSH Key saved.", "success");
                } catch (e) {
                  setFormError(`Failed to save SSH Key: ${e}`);
                  addLog(`KEY_SAVE_ERROR: ${e}`, "error");
                }
              }} 
              className="w-full h-10 bg-primary text-black font-bold rounded-lg text-[13px] tracking-tight hover:brightness-110 transition-all active:scale-[0.98] flex items-center justify-center gap-2"
            >
              Save
            </button>
          </div>
        </div>
      </div>
      {activeSnippetParam && (
        <SnippetParamModal
          isOpen={!!activeSnippetParam}
          onClose={() => setActiveSnippetParam(null)}
          rawCommand={activeSnippetParam.raw}
          title={activeSnippetParam.title}
          broadcastSessionCount={broadcast.enabled ? broadcast.targetSessionIds.size : 0}
          onRun={(resolved, execute) => {
            const target = activeSnippetParam.targetSessionId || (activeView.startsWith("session-") ? activeView : sessions[0]?.id);
            if (target) {
              const text = execute
                ? (resolved.endsWith("\n") || resolved.endsWith("\r") ? resolved : resolved + "\n")
                : resolved;
              window.dispatchEvent(new CustomEvent(`submarine-terminal-exec-${target}`, { detail: { text } }));
            }
          }}
        />
      )}
    </div>
  );
}

export default DesktopApp;