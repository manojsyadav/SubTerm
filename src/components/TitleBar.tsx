// The window's title bar: profile pill, local-shell and quick-access bookmarks, the
// session tab strip (with its context menu and the mobile session picker), the Wall
// and broadcast controls, and the window buttons. Moved out of DesktopApp, which
// owns all of the state it shows; this component only renders it.
import { invoke } from "@tauri-apps/api/core";
import { Plus, X, Terminal, Key, ArrowLeftRight, Square, Copy, MoreVertical, Radio, ChevronDown, Columns, LayoutGrid, Pin, PinOff, Command, Lock, Settings } from "lucide-react";
import logoUrl from "../assets/logo.png";
import { useConfirm } from "../ui/confirm";
import { RenameInput } from "../ui/renameInput";
import type { Server } from "../types";
import { renderServerIcon } from "./ServerIcon";
import { getActiveShortcut } from "../shortcuts";
import { Session } from "../hooks/useSessionManager";
import { WallItem } from "../hooks/useWallManager";
import type { Window as AppWindow } from "@tauri-apps/api/window";
import type { SshKey } from "../types";
import type { BroadcastContextValue } from "../ui/broadcast";

export interface TitleBarProps {
  activeProfile: string | null;
  activeView: string;
  appWindow: AppWindow;
  /** The app's confirm dialog (useConfirm), not window.confirm. */
  confirm: ReturnType<typeof useConfirm>;
  availableShells: { id: string; name: string; command: string }[];
  broadcast: BroadcastContextValue;
  broadcastMenuOpen: boolean;
  closeSession: (sessId: string) => void;
  handleLockProfile: () => Promise<void>;
  isMaximized: boolean;
  isMobile: boolean;
  isUnlocked: boolean;
  mergedSessionIds: string[];
  mobileSessionPickerOpen: boolean;
  openDefaultLocal: () => void;
  openLocalTerminal: (preferredShell?: string, forceNew?: boolean) => void;
  openServer: (server: Server, initialTool?: Session["initialTool"], opts?: { fullWidth?: boolean }) => void;
  pinTerminalToWall: (sid: string, terminalId: string) => void;
  profileDropdownOpen: boolean;
  profileIcon: string;
  quickAccessServersList: Server[];
  sessionActiveTerm: Record<string, string>;
  sessionStatuses: Record<string, string>;
  sessions: Session[];
  setActiveView: React.Dispatch<React.SetStateAction<string>>;
  setBroadcastMenuOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setIsCommandPaletteOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setIsUnlockModalOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setIsWorkspaceSwitcherOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setMergedSessionIds: React.Dispatch<React.SetStateAction<string[]>>;
  setMobileSessionPickerOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setProfileDropdownOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setSessionStatuses: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  setSessions: React.Dispatch<React.SetStateAction<Session[]>>;
  setShellMenuOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setTabMenu: React.Dispatch<React.SetStateAction<{ x: number; y: number; sessionId: string } | null>>;
  setTabNames: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  shellMenuOpen: boolean;
  sshKeys: SshKey[];
  tabMenu: { x: number; y: number; sessionId: string } | null;
  tabNames: Record<string, string>;
  toggleMaximize: () => void;
  unpinSessionFromWall: (sid: string) => void;
  unpinTerminalFromWall: (terminalId: string) => void;
  wallEnabled: boolean;
  wallHasTerminal: (terminalId: string) => boolean;
  wallItems: WallItem[];
}

export function TitleBar(props: TitleBarProps) {
  const {
    confirm,
    activeProfile,
    activeView,
    appWindow,
    availableShells,
    broadcast,
    broadcastMenuOpen,
    closeSession,
    handleLockProfile,
    isMaximized,
    isMobile,
    isUnlocked,
    mergedSessionIds,
    mobileSessionPickerOpen,
    openDefaultLocal,
    openLocalTerminal,
    openServer,
    pinTerminalToWall,
    profileDropdownOpen,
    profileIcon,
    quickAccessServersList,
    sessionActiveTerm,
    sessionStatuses,
    sessions,
    setActiveView,
    setBroadcastMenuOpen,
    setIsCommandPaletteOpen,
    setIsUnlockModalOpen,
    setIsWorkspaceSwitcherOpen,
    setMergedSessionIds,
    setMobileSessionPickerOpen,
    setProfileDropdownOpen,
    setSessionStatuses,
    setSessions,
    setShellMenuOpen,
    setTabMenu,
    setTabNames,
    shellMenuOpen,
    sshKeys,
    tabMenu,
    tabNames,
    toggleMaximize,
    unpinSessionFromWall,
    unpinTerminalFromWall,
    wallEnabled,
    wallHasTerminal,
    wallItems,
  } = props;
  return (
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
            onClick={() => openDefaultLocal()}
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
        {quickAccessServersList.map((server) => {
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
                  {wallEnabled && (<>
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
                  </>)}
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
          .filter((s) => !quickAccessServersList.some((qs) => qs.id === s.serverId || qs.name === s.serverName))
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
      {wallEnabled && sessions.length >= 1 && (
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
                    onClick={() => broadcast.selectAll(sessions.filter(s => s.protocol !== 'rdp').map(s => s.id))}
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
                  {sshKeys.map((k) => (
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
}
