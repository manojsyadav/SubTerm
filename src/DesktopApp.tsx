import { useState, useEffect, useCallback, useRef, useMemo, lazy, Suspense } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { FolderOpen, Monitor, X, Terminal, Columns, Rows, Lock, Layers } from "lucide-react";
import { useBroadcast } from "./ui/broadcast";
import { useProfileIcon } from "./utils/profileMetadata";
import MasterUnlockPage from "./components/MasterUnlockPage";
import WorkspaceSwitcherModal from "./components/WorkspaceSwitcherModal";
import QuickConnectModal, { QuickAuth } from "./components/QuickConnectModal";
import { IS_MOBILE_OS } from "./util/platform";
import { useConfirm, useTextPrompt } from "./ui/confirm";
import { useIsNarrow } from "./hooks/useViewport";
import { Sidebar } from "./components/Sidebar";
import { NodeGrid } from "./components/NodeGrid";
import AddNodePanel, { type NodeFormState } from "./components/AddNodePanel";
import type { Server } from "./types";
import SettingsPanel from "./components/SettingsPanel";
import { useFeatureFlag } from "./featureFlags";
const RecordingPlayerModal = lazy(() => import("./components/RecordingPlayerModal").then((m) => ({ default: m.RecordingPlayerModal })));
const NetworkToolsModal = lazy(() => import("./components/NetworkToolsModal").then((m) => ({ default: m.NetworkToolsModal })));
import { SessionView } from "./components/SessionView";
import MonitoringPanel from "./components/MonitoringPanel";
import { ErrorBoundary } from "./ui/ErrorBoundary";
import { useGlobalShortcuts } from "./hooks/useGlobalShortcuts";
import { CommandPalette } from "./components/CommandPalette";
import { useProfileVault } from "./hooks/useProfileVault";
import { useSessionManager, Session } from "./hooks/useSessionManager";
import { useWallManager } from "./hooks/useWallManager";
import { parseSnippetVariables } from "./utils/snippetTemplate";
import { SnippetParamModal } from "./components/SnippetParamModal";
import { CommandEditPanel, NoteEditPanel, CredentialEditPanel, KeyEditPanel } from "./components/VaultEditPanels";
import { LibraryView } from "./components/LibraryView";
import { LoginsView } from "./components/LoginsView";
import { isFeatureEnabled } from "./featureFlags";
import { ServerPickerView } from "./components/ServerPickerView";
import LocalFilesView from "./components/LocalFilesView";
import { TitleBar } from "./components/TitleBar";
import { saveAllAutoRecordings } from "./terminal/autoRecord";
import { normalizeReduceMotion, shouldReduceMotion, normalizeHighContrast, shouldUseHighContrast } from "./ui/reduceMotion";
import { clampOpacity, normalizeBlur, OPACITY_KEY, BLUR_KEY } from "./ui/windowOpacity";
import { Effect } from "@tauri-apps/api/window";
import { useIdleLock, useLockOnHidden } from "./hooks/useIdleLock";
import { LogsView } from "./components/LogsView";
import { WallView } from "./components/WallView";
import { publishOpenSessions } from "./fs/sessionRegistry";
const RdpSessionView = lazy(() => import("./components/RdpSessionView"));

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
  const wallEnabled = useFeatureFlag('fleetWall');
  const networkToolsEnabled = useFeatureFlag('networkTools');
  const recordingEnabled = useFeatureFlag('sessionRecording');
  const autoReconnectEnabled = useFeatureFlag('autoReconnect');
  // Tell the backend so it stops emitting resume / network-change events while the feature is off.
  useEffect(() => { invoke('set_auto_reconnect_events', { enabled: autoReconnectEnabled }).catch(() => {}); }, [autoReconnectEnabled]);
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
    rightClickAction: localStorage.getItem('subterm-right-click-action') || 'smart',
    linkOpenMode: localStorage.getItem('subterm-link-open-mode') || 'ctrl-click',
    startupView: localStorage.getItem('subterm-startup-view') || 'servers',
    localShell: localStorage.getItem('subterm-local-shell') || '',
    sshDetectMode: localStorage.getItem('subterm-ssh-detect-mode') || 'prompt',
    copyOnSelect: localStorage.getItem('subterm-copy-on-select') !== 'false',
    terminalTheme: localStorage.getItem('subterm-terminal-theme') || 'subterm-dark',
    terminalCursorStyle: localStorage.getItem('subterm-terminal-cursor-style') || 'block',
    terminalCursorBlink: localStorage.getItem('subterm-terminal-cursor-blink') !== 'false',
    terminalBell: localStorage.getItem('subterm-terminal-bell') || 'visual',
    terminalFontFamily: localStorage.getItem('subterm-terminal-font-family') || 'JetBrains Mono, Menlo, Monaco, Consolas, "Courier New", monospace',
    terminalLineHeight: parseFloat(localStorage.getItem('subterm-terminal-line-height') || '1.15'),
    editorTabSize: Math.min(8, Math.max(1, parseInt(localStorage.getItem('subterm-editor-tab-size') || '4', 10) || 4)),
    editorWordWrap: localStorage.getItem('subterm-editor-word-wrap') === 'true',
    editorFontSize: Math.min(24, Math.max(9, parseInt(localStorage.getItem('subterm-editor-font-size') || '12', 10) || 12)),
    overwritePolicy: ['skip', 'overwrite'].includes(localStorage.getItem('subterm-overwrite-policy') || '') ? (localStorage.getItem('subterm-overwrite-policy') as string) : 'ask',
    historyMaxEntries: Math.min(50000, Math.max(50, parseInt(localStorage.getItem('subterm-history-max') || '1000', 10) || 1000)),
    historyRetentionDays: Math.max(0, parseInt(localStorage.getItem('subterm-history-days') || '0', 10) || 0),
    confirmOnClose: localStorage.getItem('subterm-confirm-on-close') !== 'false',
    notifyLongCommandSec: Math.max(0, parseInt(localStorage.getItem('subterm-notify-long-sec') || '0', 10) || 0),
    notifyOnDisconnect: localStorage.getItem('subterm-notify-disconnect') === 'true',
    checkUpdates: localStorage.getItem('subterm-update-check') !== 'false',
    reduceMotion: normalizeReduceMotion(localStorage.getItem('subterm-reduce-motion')) as string,
    highContrast: normalizeHighContrast(localStorage.getItem('subterm-high-contrast')) as string,
    windowOpacity: clampOpacity(localStorage.getItem(OPACITY_KEY) ?? 100),
    windowBlur: normalizeBlur(localStorage.getItem(BLUR_KEY)) as string,
    uiZoom: Math.min(200, Math.max(50, parseInt(localStorage.getItem('subterm-ui-zoom') || '100', 10) || 100)),
    autoLockMin: Math.max(0, parseInt(localStorage.getItem('subterm-auto-lock-min') || '0', 10) || 0),
    lockOnMinimize: localStorage.getItem('subterm-lock-on-minimize') === 'true',
    clearClipboardOnLock: localStorage.getItem('subterm-clear-clipboard-on-lock') === 'true',
    pasteReviewLines: Math.max(0, parseInt(localStorage.getItem('subterm-paste-review-lines') || '3', 10) || 0),
    wordSeparators: localStorage.getItem('subterm-word-separators') ?? " ()[]{}',\"`",
    scrollOnInput: localStorage.getItem('subterm-scroll-on-input') !== 'false',
    terminalCursorColor: localStorage.getItem('subterm-cursor-color') || '',
    terminalPadding: Math.max(0, parseInt(localStorage.getItem('subterm-terminal-padding') || '0', 10) || 0),
    terminalScrollback: parseInt(localStorage.getItem('subterm-terminal-scrollback') || '5000', 10),
    sshKeepaliveSec: parseInt(localStorage.getItem('subterm-ssh-keepalive-sec') || '20', 10),
    hostKeyPolicy: localStorage.getItem('subterm-host-key-policy') === 'strict' ? 'strict' : 'ask',
    sshConnectTimeoutSec: Math.min(120, Math.max(3, parseInt(localStorage.getItem('subterm-ssh-connect-timeout-sec') || '10', 10) || 10)),
    reconnectMaxAttempts: Math.max(0, parseInt(localStorage.getItem('subterm-reconnect-max-attempts') || '0', 10) || 0),
    reconnectMaxDelaySec: Math.min(300, Math.max(2, parseInt(localStorage.getItem('subterm-reconnect-max-delay-sec') || '30', 10) || 30)),
    defaultSshPort: Math.min(65535, Math.max(1, parseInt(localStorage.getItem('subterm-default-ssh-port') || '22', 10) || 22)),
    defaultSshUser: localStorage.getItem('subterm-default-ssh-user') || '',
    defaultAgentForward: localStorage.getItem('subterm-default-agent-forward') === 'true',
    quickAccessServerIds: (() => {
      try {
        const raw = localStorage.getItem('subterm-quick-access-servers');
        if (raw) return JSON.parse(raw);
      } catch {}
      return [];
    })() as number[],
  });

  // Webview-level zoom (Settings > Appearance). Skipped on mobile, where the OS owns scaling.
  useEffect(() => {
    if (IS_MOBILE_OS) return;
    invoke('set_ui_zoom', { factor: (appSettings.uiZoom || 100) / 100 }).catch(() => {});
  }, [appSettings.uiZoom]);

  // Reduce motion: an explicit choice, or follow the OS preference live.
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const apply = () => document.documentElement.classList.toggle('reduce-motion', shouldReduceMotion(normalizeReduceMotion(appSettings.reduceMotion), mq.matches));
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [appSettings.reduceMotion]);

  // Window opacity and blur (desktop). Blur effects are a Windows backdrop; elsewhere they are ignored.
  useEffect(() => {
    if (IS_MOBILE_OS) return;
    const pct = clampOpacity(appSettings.windowOpacity);
    const blur = normalizeBlur(appSettings.windowBlur);
    const translucent = pct < 100 || blur !== 'none';
    document.documentElement.classList.toggle('translucent', translucent);
    document.documentElement.style.setProperty('--surface-alpha', String(pct / 100));
    const effects = blur === 'acrylic' ? [Effect.Acrylic] : blur === 'mica' ? [Effect.Mica] : [];
    getCurrentWindow().setEffects({ effects }).catch(() => { /* not supported on this OS */ });
  }, [appSettings.windowOpacity, appSettings.windowBlur]);

  // High contrast: same pattern, following the OS "more contrast" preference by default.
  useEffect(() => {
    const mq = window.matchMedia('(prefers-contrast: more)');
    const apply = () => document.documentElement.classList.toggle('high-contrast', shouldUseHighContrast(normalizeHighContrast(appSettings.highContrast), mq.matches));
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [appSettings.highContrast]);

  const wallManager = useWallManager();
  const {
    wallItems, setWallItems, wallCols, setWallCols,
    wallPickerOpen, setWallPickerOpen,
    sessionTerminals, sessionActiveTerm,
    handleTerminalsChange, wallHasTerminal,
    pinTerminalToWall, unpinTerminalFromWall, unpinSessionFromWall,
  } = wallManager;

  const vaultRef = useRef<ReturnType<typeof useProfileVault> | null>(null);

  const [rdpView, setRdpView] = useState<{ id: number; name: string } | null>(null);

  const sessionManager = useSessionManager({
    onOpenRdpEmbedded: (s) => setRdpView({ id: s.id, name: s.name }),
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

  // Local terminals use the shell chosen in Settings > General (empty = automatic: PowerShell 7,
  // else Windows PowerShell on Windows; $SHELL elsewhere). Read from storage so it is current
  // even when called from a callback created before the setting changed.
  const openDefaultLocal = useCallback(() => {
    openLocalTerminal(localStorage.getItem('subterm-local-shell') || undefined);
  }, [openLocalTerminal]);

  const [tabNames, setTabNames] = useState<Record<string, string>>({});

  // Remember the most recent real session so "On startup: Last session" can reopen it.
  // Quick-connect sessions are skipped: they carry inline credentials we do not persist.
  useEffect(() => {
    const s = sessions.find((x) => x.id === activeView);
    if (!s || s.quickAuth) return;
    try {
      const last = s.isLocal ? { kind: 'local', shell: s.localShell } : s.serverId > 0 ? { kind: 'server', id: s.serverId } : null;
      if (last) localStorage.setItem('subterm-last-session', JSON.stringify(last));
    } catch { /* storage unavailable */ }
  }, [activeView, sessions]);

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
    onStartupView: (list) => {
      // Read at call time: this runs right after unlock, before any settings re-render.
      const mode = localStorage.getItem('subterm-startup-view') || 'servers';
      if (mode === 'local' && !IS_MOBILE_OS) {
        openDefaultLocal();
      } else if (mode === 'last') {
        try {
          const last = JSON.parse(localStorage.getItem('subterm-last-session') || 'null') as
            | { kind: 'server'; id: number } | { kind: 'local'; shell?: string } | null;
          if (last?.kind === 'local' && !IS_MOBILE_OS) {
            openLocalTerminal(last.shell);
          } else if (last?.kind === 'server') {
            const srv = list.find((s) => s.id === last.id);
            if (srv) openServer(srv);
          }
        } catch { /* unreadable value: stay on the server list */ }
      }
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

  // Launch view follows Settings -> On Startup. A local shell is opened immediately
  // (before unlock) only when the user picked "New Local Terminal", or "Last Session"
  // and the last session was a local shell. Otherwise the app lands on the server list;
  // server sessions for "Last Session" open after unlock (see onStartupView).
  useEffect(() => {
    if (sessions.length !== 0 || IS_MOBILE_OS) return;
    const mode = localStorage.getItem('subterm-startup-view') || 'servers';
    if (mode === 'local') {
      openDefaultLocal();
    } else if (mode === 'last') {
      try {
        const last = JSON.parse(localStorage.getItem('subterm-last-session') || 'null') as { kind: string; shell?: string } | null;
        if (last?.kind === 'local') openLocalTerminal(last.shell);
      } catch { /* stay on the server list */ }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  vaultRef.current = vault;

  // Tell the file views which sessions exist (for server-to-server SFTP copy).
  useEffect(() => {
    publishOpenSessions(
      sessions.map((s) => ({
        id: s.id,
        name: s.serverName,
        connected: sessionStatuses[s.id] === "connected",
        isLocal: !!s.isLocal,
      })),
    );
  }, [sessions, sessionStatuses]);

  // Leave the Wall if it gets switched off in Settings while open.
  useEffect(() => { if (!wallEnabled && activeView === 'wall') setActiveView('nodes'); }, [wallEnabled, activeView]);

  const handleLogout = () => vaultLogout(sessions, confirm, () => {
    setSessions([]);
    setActiveView("nodes");
  });

  // `automatic` locks (idle timer, window hidden) never ask: nobody may be there to answer, and
  // the point is to close the vault. They disconnect open SSH sessions just like a manual lock.
  const lockVault = async (automatic: boolean) => {
    const remoteSessions = sessions.filter((s) => !s.isLocal);
    if (remoteSessions.length > 0 && !automatic) {
      const ok = await confirm({
        title: "Lock SubTerm Vault?",
        message: `You have ${remoteSessions.length} open remote SSH session${remoteSessions.length === 1 ? "" : "s"}. Locking will disconnect them.`,
        okLabel: "Lock Vault",
        cancelLabel: "Cancel",
        destructive: true,
      });
      if (!ok) return;
    }
    for (const s of remoteSessions) {
      try { await invoke("disconnect_session", { sessionId: s.id }); } catch {}
    }
    try { await invoke("close_profile"); } catch {}
    setIsUnlocked(false);
    // Best effort: the webview only allows clipboard writes while it has focus.
    if (localStorage.getItem('subterm-clear-clipboard-on-lock') === 'true') navigator.clipboard.writeText('').catch(() => {});
    const remainingLocal = sessions.filter((s) => s.isLocal);
    if (remainingLocal.length === 0) {
      if ((localStorage.getItem('subterm-startup-view') || 'servers') === 'local' && !IS_MOBILE_OS) {
        openDefaultLocal();
      } else {
        setSessions([]);
        setActiveView("nodes");
      }
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
    addLog(automatic ? `Vault locked automatically. Local terminal remains active.` : `Vault locked. Local terminal remains active.`, "info");
  };
  const handleLockProfile = () => lockVault(false);

  useIdleLock({ enabled: isUnlocked, minutes: appSettings.autoLockMin, onIdle: () => { void lockVault(true); } });
  useLockOnHidden(isUnlocked && appSettings.lockOnMinimize, () => { void lockVault(true); });

  // Apply the command-history limits (Settings > Terminal > Privacy) once the vault is open and when they change.
  useEffect(() => {
    if (!isUnlocked) return;
    invoke('cmd_history_prune', { maxEntries: appSettings.historyMaxEntries || 1000, maxAgeDays: appSettings.historyRetentionDays || 0 }).catch(() => {});
  }, [isUnlocked, appSettings.historyMaxEntries, appSettings.historyRetentionDays]);

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
    } catch (err: unknown) {
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

  const handleOpenMultipleServers = (serversToOpen: Server[]) => {
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
  const [localFilesOpen, setLocalFilesOpen] = useState(false);
  // Newer GitHub release found at startup (Settings > General > Updates). Dismissing hides that version only.
  const [updateBanner, setUpdateBanner] = useState<{ latest: string; url: string | null } | null>(null);
  useEffect(() => {
    if (localStorage.getItem('subterm-update-check') === 'false') return;
    invoke<{ has_update: boolean; latest: string | null; release_url: string | null }>('check_for_updates')
      .then((u) => {
        if (u.has_update && u.latest && localStorage.getItem('subterm-update-dismissed') !== u.latest) {
          setUpdateBanner({ latest: u.latest, url: u.release_url });
        }
      })
      .catch(() => { /* offline or rate-limited: try again next start */ });
  }, []);
  const [isRecordingPlayerOpen, setIsRecordingPlayerOpen] = useState(false);
  const [isQuickConnectOpen, setIsQuickConnectOpen] = useState(false);
  const [quickConnectPrefill, setQuickConnectPrefill] = useState<{ host: string; port: number; username: string } | null>(null);
  const pendingSftpRef = useRef(false);
  const pendingSaveRef = useRef(true);

  // Quick Connect that can also open the SFTP panel once the session mounts
  // (used when the target came from an `sftp` command typed in a local shell).
  const connectQuick = useCallback((auth: QuickAuth) => {
    openQuickConnect(auth, {
      save: pendingSaveRef.current,
      initialTool: pendingSftpRef.current ? "sftp" : null,
    });
    pendingSftpRef.current = false;
    pendingSaveRef.current = true;
    setQuickConnectPrefill(null);
  }, [openQuickConnect]);

  // A local terminal detected `ssh`/`sftp <target>` and the user accepted the offer.
  useEffect(() => {
    const onOpen = (e: Event) => {
      const d = (e as CustomEvent<{
        host: string; port: number; username: string; private_key: string | null;
        openSftp: boolean; how: "saved" | "save" | "quick"; serverId?: number;
      }>).detail;
      if (!d) return;
      if (d.how === "saved") {
        const srv = servers.find((x) => x.id === d.serverId);
        if (srv) {
          openServer(srv, d.openSftp ? "sftp" : undefined);
          return;
        }
        // Saved server vanished from the list: fall through to a plain quick connect.
      }
      pendingSftpRef.current = !!d.openSftp;
      pendingSaveRef.current = d.how === "save";
      if (d.private_key) {
        connectQuick({ host: d.host, port: d.port, username: d.username, private_key: d.private_key });
      } else {
        // No usable key: reuse the Quick Connect form so the user types the password.
        setQuickConnectPrefill({ host: d.host, port: d.port, username: d.username });
        setIsQuickConnectOpen(true);
      }
    };
    window.addEventListener("subterm-open-ssh-target", onOpen);
    return () => window.removeEventListener("subterm-open-ssh-target", onOpen);
  }, [connectQuick, servers, openServer]);
  const [isCommandPaletteOpen, setIsCommandPaletteOpen] = useState(false);
  const [isCommandPanelOpen, setIsCommandPanelOpen] = useState(false);
  const [editCommandData, setEditCommandData] = useState<{ id: number | null, title: string, content: string, serverId: number | null, tags: string }>({ id: null, title: "", content: "", serverId: null, tags: "" });

  const [isNotePanelOpen, setIsNotePanelOpen] = useState(false);
  const [editNoteData, setEditNoteData] = useState<{ id: number | null, title: string, body: string }>({ id: null, title: "", body: "" });
  // Shared query across Library sub-tabs. Persisting the string across a
  // Commands↔Notes switch lets the user narrow both lists with the same
  // typing — filter is applied against whichever array is active.
  const [libraryQuery, setLibraryQuery] = useState("");
  const [libraryTab, setLibraryTab] = useState<"commands" | "notes">("commands");

  const [isCredPanelOpen, setIsCredPanelOpen] = useState(false);
  const [editCredData, setEditCredData] = useState<{ id: number | null; name: string; auth_type: string; username: string; password: string; key_id: number | null }>({ id: null, name: "", auth_type: "password", username: "", password: "", key_id: null });
  
  const [isKeyPanelOpen, setIsKeyPanelOpen] = useState(false);
  const [editKeyData, setEditKeyData] = useState<{ id: number | null; name: string; public_key: string; private_key: string; passphrase: string }>({ id: null, name: "", public_key: "", private_key: "", passphrase: "" });
  const [formError, setFormError] = useState("");

  const defaultNode: NodeFormState = {
    id: null as number | null,
    name: "", host: "", port: appSettings.defaultSshPort || 22, username: appSettings.defaultSshUser || "", password: "",
    // "custom_pass" picked as default because most users adding a new
    // server have a password in hand; the vault option is mainly useful
    // *after* they've saved a few credentials and want to reuse one.
    authType: "custom_pass", credentialId: "", folderId: "", keyId: "",
    proxyType: "none", proxyHost: "", proxyPort: 1080,
    tunnels: [],
    autostart: false,
    mirrors: [],
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
    forward_agent: !!appSettings.defaultAgentForward,
    protocol: "ssh",
  };

  // Live width-based "narrow viewport" flag. Replaces a one-shot UA check
  // that couldn't see a desktop window being shrunk by the user — the new
  // hook updates on every resize so layout swaps follow the actual width.
  const isMobile = useIsNarrow();

  const [newNode, setNewNode] = useState<NodeFormState>(defaultNode);

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
    localStorage.setItem('subterm-right-click-action', appSettings.rightClickAction || 'smart');
    localStorage.setItem('subterm-link-open-mode', appSettings.linkOpenMode || 'ctrl-click');
    localStorage.setItem('subterm-startup-view', appSettings.startupView || 'servers');
    localStorage.setItem('subterm-local-shell', appSettings.localShell || '');
    localStorage.setItem('subterm-ssh-detect-mode', appSettings.sshDetectMode || 'prompt');
    localStorage.setItem('subterm-copy-on-select', appSettings.copyOnSelect !== false ? 'true' : 'false');
    localStorage.setItem('subterm-terminal-theme', appSettings.terminalTheme || 'subterm-dark');
    localStorage.setItem('subterm-terminal-cursor-style', appSettings.terminalCursorStyle || 'block');
    localStorage.setItem('subterm-terminal-cursor-blink', appSettings.terminalCursorBlink !== false ? 'true' : 'false');
    localStorage.setItem('subterm-terminal-bell', appSettings.terminalBell || 'visual');
    localStorage.setItem('subterm-terminal-font-family', appSettings.terminalFontFamily || 'JetBrains Mono, Menlo, Monaco, Consolas, "Courier New", monospace');
    localStorage.setItem('subterm-paste-review-lines', String(appSettings.pasteReviewLines ?? 3));
    localStorage.setItem('subterm-word-separators', appSettings.wordSeparators ?? " ()[]{}',\"`");
    localStorage.setItem('subterm-scroll-on-input', appSettings.scrollOnInput === false ? 'false' : 'true');
    localStorage.setItem('subterm-cursor-color', appSettings.terminalCursorColor || '');
    localStorage.setItem('subterm-terminal-padding', String(appSettings.terminalPadding ?? 0));
    localStorage.setItem('subterm-auto-lock-min', String(appSettings.autoLockMin ?? 0));
    localStorage.setItem('subterm-lock-on-minimize', appSettings.lockOnMinimize ? 'true' : 'false');
    localStorage.setItem('subterm-clear-clipboard-on-lock', appSettings.clearClipboardOnLock ? 'true' : 'false');
    localStorage.setItem('subterm-editor-tab-size', String(appSettings.editorTabSize ?? 4));
    localStorage.setItem('subterm-editor-word-wrap', appSettings.editorWordWrap ? 'true' : 'false');
    localStorage.setItem('subterm-editor-font-size', String(appSettings.editorFontSize ?? 12));
    localStorage.setItem('subterm-overwrite-policy', appSettings.overwritePolicy || 'ask');
    localStorage.setItem('subterm-history-max', String(appSettings.historyMaxEntries ?? 1000));
    localStorage.setItem('subterm-history-days', String(appSettings.historyRetentionDays ?? 0));
    localStorage.setItem('subterm-confirm-on-close', appSettings.confirmOnClose === false ? 'false' : 'true');
    localStorage.setItem('subterm-notify-long-sec', String(appSettings.notifyLongCommandSec ?? 0));
    localStorage.setItem('subterm-notify-disconnect', appSettings.notifyOnDisconnect ? 'true' : 'false');
    localStorage.setItem('subterm-update-check', appSettings.checkUpdates === false ? 'false' : 'true');
    localStorage.setItem('subterm-reduce-motion', appSettings.reduceMotion || 'system');
    localStorage.setItem('subterm-high-contrast', appSettings.highContrast || 'system');
    localStorage.setItem(OPACITY_KEY, String(clampOpacity(appSettings.windowOpacity)));
    localStorage.setItem(BLUR_KEY, normalizeBlur(appSettings.windowBlur));
    localStorage.setItem('subterm-ui-zoom', String(appSettings.uiZoom ?? 100));
    localStorage.setItem('subterm-host-key-policy', appSettings.hostKeyPolicy === 'strict' ? 'strict' : 'ask');
    localStorage.setItem('subterm-ssh-connect-timeout-sec', String(appSettings.sshConnectTimeoutSec ?? 10));
    localStorage.setItem('subterm-reconnect-max-attempts', String(appSettings.reconnectMaxAttempts ?? 0));
    localStorage.setItem('subterm-reconnect-max-delay-sec', String(appSettings.reconnectMaxDelaySec ?? 30));
    localStorage.setItem('subterm-default-ssh-port', String(appSettings.defaultSshPort ?? 22));
    localStorage.setItem('subterm-default-ssh-user', appSettings.defaultSshUser || '');
    localStorage.setItem('subterm-default-agent-forward', appSettings.defaultAgentForward ? 'true' : 'false');
    localStorage.setItem('subterm-terminal-line-height', String(appSettings.terminalLineHeight || 1.15));
    localStorage.setItem('subterm-terminal-scrollback', String(appSettings.terminalScrollback || 5000));
    localStorage.setItem('subterm-ssh-keepalive-sec', String(appSettings.sshKeepaliveSec || 20));
    invoke('set_ssh_keepalive_interval', { secs: appSettings.sshKeepaliveSec || 20 }).catch(console.error);
    invoke('set_ssh_connect_timeout', { secs: appSettings.sshConnectTimeoutSec || 10 }).catch(console.error);
    invoke('set_host_key_policy', { strict: appSettings.hostKeyPolicy === 'strict' }).catch(console.error);
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
      // The window is destroyed once this handler resolves, so automatic recordings
      // are written first (after the user confirms, when there is a prompt).
      if (n === 0 || localStorage.getItem('subterm-confirm-on-close') === 'false') { // Settings > General > Security
        await saveAllAutoRecordings();
        return;
      }
      event.preventDefault();
      const ok = await confirm({
        title: "Close SubTerm?",
        message: `${n} SSH session${n === 1 ? "" : "s"} ${n === 1 ? "is" : "are"} still connected. Closing now disconnects ${n === 1 ? "it" : "them all"} and aborts any in-flight transfers.`,
        okLabel: "Close anyway",
        cancelLabel: "Stay",
        destructive: true,
      });
      if (ok) {
        await saveAllAutoRecordings();
        await appWindow.destroy();
      }
    }).then((fn) => { unlisten = fn; });
    return () => { if (unlisten) unlisten(); };
  }, [confirm]);

  const handleEditNode = async (server: Server) => {
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
      protocol: server.protocol === "rdp" ? "rdp" : "ssh",
    });
    setIsPanelOpen(true);
  };

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

  // TitleBar is a module-level component (stable identity), so React keeps the tab
  // strip mounted across renders; it only needs the state it shows.
  const titleBarProps = { confirm, activeProfile, activeView, appWindow, availableShells, broadcast, broadcastMenuOpen, closeSession, handleLockProfile, isMaximized, isMobile, isUnlocked, mergedSessionIds, mobileSessionPickerOpen, openDefaultLocal, openLocalTerminal, openServer, pinTerminalToWall, profileDropdownOpen, profileIcon, quickAccessServersList, sessionActiveTerm, sessionStatuses, sessions, setActiveView, setBroadcastMenuOpen, setIsCommandPaletteOpen, setIsUnlockModalOpen, setIsWorkspaceSwitcherOpen, setMergedSessionIds, setMobileSessionPickerOpen, setProfileDropdownOpen, setSessionStatuses, setSessions, setShellMenuOpen, setTabMenu, setTabNames, shellMenuOpen, sshKeys, tabMenu, tabNames, toggleMaximize, unpinSessionFromWall, unpinTerminalFromWall, wallEnabled, wallHasTerminal, wallItems };

  // h-full (not h-screen) so the layout tracks --vv-h from main.tsx —
  // when the Android soft keyboard opens the visualViewport shrinks and the
  // whole flex chain cascades above the keyboard instead of anchoring to
  // the un-shrunken layout viewport.
  if (loading) return <div className="h-full bg-black flex items-center justify-center font-mono text-xs text-primary animate-pulse">Loading…</div>;

  return (
    <div className="h-full w-full bg-background flex flex-col overflow-hidden text-zinc-200 select-none">
      <TitleBar {...titleBarProps} />
      {updateBanner && (
        <div role="status" className="fixed bottom-4 right-4 z-[80] flex items-center gap-2 px-3 py-2 rounded-lg bg-[#121217]/95 border border-amber-500/30 shadow-xl text-[11px] text-zinc-200">
          <span>SubTerm <b className="text-amber-300">v{updateBanner.latest}</b> is available.</span>
          {updateBanner.url && (
            <button
              type="button"
              onClick={() => { invoke('open_external_url', { url: updateBanner.url }).catch(() => {}); }}
              className="px-2 py-0.5 rounded bg-amber-500/15 border border-amber-500/40 text-amber-200 font-bold hover:bg-amber-500/25"
            >
              View release
            </button>
          )}
          <button
            type="button"
            onClick={() => { localStorage.setItem('subterm-update-dismissed', updateBanner.latest); setUpdateBanner(null); }}
            className="px-2 py-0.5 rounded text-zinc-400 hover:text-white hover:bg-white/10"
          >
            Dismiss
          </button>
        </div>
      )}
      {/* Layout swap: on desktop the sidebar is a left rail (row).
          On mobile we flip to flex-col-reverse so the sidebar component
          renders at the bottom while staying first in DOM order — keyboard
          tab-order stays intuitive and <main> grabs the full screen width
          (terminal gains the ~50px the vertical rail used to eat). */}
      <div className={`flex-1 flex ${isMobile ? 'flex-col-reverse' : ''} overflow-hidden pt-10`}>
        <Sidebar
          activeTab={activeView.startsWith('session-local-') ? 'local' : activeView.startsWith('session-') ? 'nodes' : activeView}
          setActiveTab={(tab) => { if (tab === 'local') openDefaultLocal(); else if (tab === 'network') setIsNetworkToolsOpen(true); else setActiveView(tab); }}
          showNetworkTools={networkToolsEnabled}
          showRdp={isFeatureEnabled('rdpServers')}
          localShells={availableShells}
          onOpenLocalShell={(id) => openLocalTerminal(id, false)}
          isMobile={isMobile}
          isUnlocked={isUnlocked}
          onUnlock={() => setIsUnlockModalOpen(true)}
          onLogout={handleLogout}
          onLock={handleLockProfile}
          onSwitchProfile={() => (isUnlocked ? setIsWorkspaceSwitcherOpen(true) : setIsUnlockModalOpen(true))}
          enableMonitoring={appSettings.enableMonitoring}
        />

        <main className="flex-1 flex flex-col min-w-0 min-h-0 bg-transparent relative">
          {!isUnlocked && (activeView === "nodes" || activeView === "vault" || activeView === "library" || activeView === "monitor" || activeView === "sftp" || activeView === "rdp") ? (
            <LockedVaultNotice
              onUnlock={() => setIsUnlockModalOpen(true)}
              onOpenLocal={() => openDefaultLocal()}
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
                onQuickConnect={() => setIsQuickConnectOpen(true)}
                onQuickConnectTarget={(t) => {
                  pendingSftpRef.current = false;
                  pendingSaveRef.current = true;
                  setQuickConnectPrefill({ host: t.host, port: t.port, username: t.username || appSettings.defaultSshUser || 'root' });
                  setIsQuickConnectOpen(true);
                }}
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
                folders={folders}
                isMobile={isMobile}
                onOpenLogs={() => setActiveView("logs")}
                onOpenMonitor={() => setActiveView("monitor")}
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

            {activeView === "sftp" && localFilesOpen && !IS_MOBILE_OS && <LocalFilesView onBack={() => setLocalFilesOpen(false)} />}
            {activeView === "sftp" && !(localFilesOpen && !IS_MOBILE_OS) && (
              <ServerPickerView
                title="SFTP"
                subtitle="Pick a server to browse its files next to this computer's, full width."
                icon={<FolderOpen size={20} />}
                servers={servers}
                include={(s) => s.protocol !== "rdp"}
                actionLabel="Open file browser"
                onOpen={(s) => openServer(s, "sftp", { fullWidth: true })}
                actions={!IS_MOBILE_OS && (
                  <button
                    type="button"
                    onClick={() => setLocalFilesOpen(true)}
                    title="Browse this computer's files without a server"
                    className="h-9 px-3 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 text-xs font-bold hover:bg-emerald-500/20 flex items-center gap-1.5"
                  >
                    <FolderOpen size={13} /> This computer
                  </button>
                )}
                emptyText="No SSH servers saved yet. Add one on the Servers page."
              />
            )}
            {activeView === "rdp" && (
              <ServerPickerView
                title="Remote Desktop"
                subtitle="Open a saved RDP server. Where it opens (inside SubTerm or the system client) is set in Settings > General."
                icon={<Monitor size={20} />}
                servers={servers}
                include={(s) => s.protocol === "rdp"}
                actionLabel="Connect"
                onOpen={(s) => openServer(s)}
                addLabel="New RDP server"
                onAdd={() => { setNewNode({ ...defaultNode, protocol: "rdp", port: 3389 }); setIsPanelOpen(true); }}
                emptyText="No RDP servers saved yet. Use New RDP server to add one."
              />
            )}
            {activeView === "vault" && (
              <LoginsView
                credentials={credentials}
                sshKeys={sshKeys}
                addLog={addLog}
                confirm={confirm}
                refreshCredentials={refreshCredentials}
                refreshSshKeys={refreshSshKeys}
                bumpSync={bumpSync}
                setEditCredData={setEditCredData}
                setIsCredPanelOpen={setIsCredPanelOpen}
                setEditKeyData={setEditKeyData}
                setIsKeyPanelOpen={setIsKeyPanelOpen}
                textPrompt={textPrompt}
              />
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
            {wallEnabled && activeView === "wall" && (
              <WallView
                wallItems={wallItems}
                setWallItems={setWallItems}
                wallCols={wallCols}
                setWallCols={setWallCols}
                wallPickerOpen={wallPickerOpen}
                setWallPickerOpen={setWallPickerOpen}
                sessions={sessions}
                sessionTerminals={sessionTerminals}
                sessionStatuses={sessionStatuses}
                setActiveView={setActiveView}
                wallHasTerminal={wallHasTerminal}
                pinTerminalToWall={pinTerminalToWall}
                unpinTerminalFromWall={unpinTerminalFromWall}
              />
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
            {activeView === "library" && (
              <LibraryView
                libraryQuery={libraryQuery}
                setLibraryQuery={setLibraryQuery}
                libraryTab={libraryTab}
                setLibraryTab={setLibraryTab}
                commands={commands}
                notes={notes}
                servers={servers}
                sessions={sessions}
                confirm={confirm}
                refreshCommands={refreshCommands}
                refreshNotes={refreshNotes}
                bumpSync={bumpSync}
                handleExecuteSnippet={handleExecuteSnippet}
                setEditCommandData={setEditCommandData}
                setIsCommandPanelOpen={setIsCommandPanelOpen}
                setEditNoteData={setEditNoteData}
                setIsNotePanelOpen={setIsNotePanelOpen}
              />
            )}

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
              <LogsView logs={logs} setActiveView={setActiveView} setLogs={setLogs} confirm={confirm} />
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
              await invoke("set_server_protocol", { id: savedId, value: newNode.protocol === "rdp" ? "rdp" : "ssh" });
            } catch (e) {
              addLog(`SAVE_PROTOCOL_FAILED: ${e}`, "error");
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
        onClose={() => { setIsQuickConnectOpen(false); setQuickConnectPrefill(null); pendingSftpRef.current = false; pendingSaveRef.current = true; }}
        onConnect={connectQuick}
        prefill={quickConnectPrefill}
      />

      {rdpView && (
        <Suspense fallback={null}>
          <RdpSessionView key={rdpView.id} serverId={rdpView.id} serverName={rdpView.name} onClose={() => setRdpView(null)} />
        </Suspense>
      )}

      {recordingEnabled && isRecordingPlayerOpen && (
        <Suspense fallback={null}>
          <RecordingPlayerModal onClose={() => setIsRecordingPlayerOpen(false)} />
        </Suspense>
      )}

      {networkToolsEnabled && isNetworkToolsOpen && (
        <Suspense fallback={null}>
          <NetworkToolsModal
            isOpen={isNetworkToolsOpen}
            onClose={() => setIsNetworkToolsOpen(false)}
            servers={servers}
          />
        </Suspense>
      )}

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
          openDefaultLocal();
        }}
        onOpenRecordingPlayer={recordingEnabled ? () => {
          setIsCommandPaletteOpen(false);
          setIsRecordingPlayerOpen(true);
        } : undefined}
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


      <CommandEditPanel
        isOpen={isCommandPanelOpen}
        onClose={() => setIsCommandPanelOpen(false)}
        data={editCommandData}
        setData={setEditCommandData}
        servers={servers}
        formError={formError}
        setFormError={setFormError}
        addLog={addLog}
        refreshCommands={refreshCommands}
        bumpSync={bumpSync}
      />

      <NoteEditPanel
        isOpen={isNotePanelOpen}
        onClose={() => setIsNotePanelOpen(false)}
        data={editNoteData}
        setData={setEditNoteData}
        formError={formError}
        setFormError={setFormError}
        addLog={addLog}
        refreshNotes={refreshNotes}
        bumpSync={bumpSync}
      />

      <CredentialEditPanel
        isOpen={isCredPanelOpen}
        onClose={() => setIsCredPanelOpen(false)}
        data={editCredData}
        setData={setEditCredData}
        sshKeys={sshKeys}
        formError={formError}
        setFormError={setFormError}
        addLog={addLog}
        refreshCredentials={refreshCredentials}
        bumpSync={bumpSync}
      />

      <KeyEditPanel
        isOpen={isKeyPanelOpen}
        onClose={() => setIsKeyPanelOpen(false)}
        data={editKeyData}
        setData={setEditKeyData}
        formError={formError}
        setFormError={setFormError}
        addLog={addLog}
        refreshSshKeys={refreshSshKeys}
        bumpSync={bumpSync}
      />
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