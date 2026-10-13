import { useState, useEffect, Fragment } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Server, KeyRound, Braces, Activity, Settings, Lock, ArrowLeftRight, Terminal, FolderOpen, Monitor, Network, Plus, X } from "lucide-react";

interface MonitorListRow {
  node_id: number;
  name: string;
  paused?: boolean;
  connected?: boolean;
  last_error?: string | null;
}

interface MonitorSamplePayload {
  values?: { cpu_perc?: number; mem_perc?: number };
}

interface MonitorOutagePayload {
  node_name?: string;
}

interface SidebarProps {
  activeTab: string;
  setActiveTab: (tab: string) => void;
  isMobile?: boolean;
  isUnlocked?: boolean;
  onUnlock?: () => void;
  onLogout?: () => void;
  onLock?: () => void;
  onSwitchProfile?: () => void;
  enableMonitoring?: boolean;
  /** RDP page is hidden when the RDP feature toggle is off. */
  showRdp?: boolean;
  /** Network Tools opens a dialog rather than a page, and is hidden when its feature is off. */
  showNetworkTools?: boolean;
  /** Installed local shells, offered on right-click of Local (desktop rail). */
  localShells?: { id: string; name: string }[];
  onOpenLocalShell?: (shellId: string) => void;
  /** Active workspace, shown on the Switch workspace button (the title bar no longer has one). */
  workspaceName?: string;
  workspaceIcon?: string;
  /** Shells open in the Local tab, listed under the Local item (desktop rail). */
  localTabs?: { id: string; label: string; title: string }[];
  activeLocalTab?: string | null;
  onSelectLocalTab?: (id: string) => void;
  onCloseLocalTab?: (id: string) => void;
  onNewLocalTab?: () => void;
}

// Vertical rail on desktop, horizontal bottom dock on mobile. Layout swap is
// driven by `isMobile` so the terminal/session views can use the full screen
// width on phones — vertical sidebars eat ~50px of width that's expensive on
// a 360px-wide viewport. The parent in DesktopApp uses `flex-col-reverse` on
// mobile so this component visually lands at the bottom while staying first
// in DOM order (keyboard tab-order stays intuitive).
export const Sidebar = ({
  activeTab,
  setActiveTab,
  isMobile,
  isUnlocked = true,
  onUnlock,
  onLogout,
  onLock,
  onSwitchProfile,
  enableMonitoring = true,
  showRdp = true,
  showNetworkTools = true,
  localShells = [],
  onOpenLocalShell,
  workspaceName,
  workspaceIcon,
  localTabs = [],
  activeLocalTab = null,
  onSelectLocalTab,
  onCloseLocalTab,
  onNewLocalTab,
}: SidebarProps) => {
  const [shellMenu, setShellMenu] = useState<{ x: number; y: number } | null>(null);
  const switchTitle = workspaceName ? `Workspace: ${workspaceName} (click to switch)` : "Switch workspace";
  // The workspace's own icon (an emoji) when it has one, so the active workspace is visible at a glance.
  const workspaceBadge = workspaceIcon
    ? <span className="text-[18px] leading-none select-none">{workspaceIcon}</span>
    : <ArrowLeftRight size={18} />;
  // Live health pulse state across monitored servers
  const [healthState, setHealthState] = useState<"ok" | "warning" | "critical" | "idle">("idle");
  const [alertSummary, setAlertSummary] = useState<string | null>(null);

  useEffect(() => {
    if (!enableMonitoring) {
      setHealthState("idle");
      setAlertSummary(null);
      return;
    }

    let isMounted = true;
    const cleanups: (() => void)[] = [];

    const checkHealth = async () => {
      try {
        const rows: MonitorListRow[] = await invoke("monitor_list");
        if (!isMounted) return;
        if (!rows || rows.length === 0) {
          setHealthState("idle");
          setAlertSummary(null);
          return;
        }

        let hasCritical = false;
        const hasWarning = false;
        const criticalReasons: string[] = [];
        const warningReasons: string[] = [];

        for (const r of rows) {
          if (r.paused) continue;
          if (r.connected === false || r.last_error) {
            hasCritical = true;
            criticalReasons.push(`${r.name}: offline / error`);
          }
        }

        if (hasCritical) {
          setHealthState("critical");
          setAlertSummary(criticalReasons.slice(0, 2).join(", "));
        } else if (hasWarning) {
          setHealthState("warning");
          setAlertSummary(warningReasons.slice(0, 2).join(", "));
        } else {
          setHealthState("ok");
          setAlertSummary("All monitored servers healthy");
        }

        for (const r of rows) {
          listen<MonitorSamplePayload>(`monitor-sample-${r.node_id}`, (ev) => {
            if (!isMounted) return;
            const values = ev.payload?.values || {};
            const cpu = values.cpu_perc ?? 0;
            const mem = values.mem_perc ?? 0;
            if (cpu > 95 || mem > 95) {
              setHealthState("warning");
              setAlertSummary(`${r.name}: high load (${Math.round(Math.max(cpu, mem))}%)`);
            }
          }).then((unlisten) => cleanups.push(unlisten));

          listen<MonitorOutagePayload>(`monitor-outage-${r.node_id}`, (ev) => {
            if (!isMounted) return;
            setHealthState("critical");
            setAlertSummary(`${ev.payload?.node_name || r.name}: outage detected`);
          }).then((unlisten) => cleanups.push(unlisten));

          listen<unknown>(`monitor-recovered-${r.node_id}`, () => {
            if (!isMounted) return;
            checkHealth();
          }).then((unlisten) => cleanups.push(unlisten));
        }
      } catch {
        // Monitor service may not have any nodes configured
      }
    };

    checkHealth();
    const interval = setInterval(checkHealth, 20000);

    return () => {
      isMounted = false;
      clearInterval(interval);
      cleanups.forEach((c) => c());
    };
  }, [enableMonitoring]);



  // Commands + Notes used to be separate rails. Both are per-profile lists
  // of small text blobs stored under the vault; the only real distinction
  // was "runnable snippet vs freeform prose". A single Library rail with
  // an internal segmented control uses one sidebar slot instead of two —
  // room the user asked us to give back on narrow viewports.
  // "Tile two sessions together" moved out of a dedicated Compare rail
  // and into a per-session-tab "Merge into current view" action — the
  // sidebar stays focused on the persistent-content activities (Servers,
  // Logins, Library, Monitor) so it isn't padded with a workflow that
  // only makes sense while sessions are open.
  const items = [
    { id: 'local', icon: Terminal, label: 'Local' },
    { id: 'nodes', icon: Server, label: 'Servers' },
    { id: 'sftp', icon: FolderOpen, label: 'SFTP' },
    ...(showRdp ? [{ id: 'rdp', icon: Monitor, label: 'RDP' }] : []),
    { id: 'vault', icon: KeyRound, label: 'Credentials' },
    { id: 'library', icon: Braces, label: 'Snippets' },
    ...(showNetworkTools ? [{ id: 'network', icon: Network, label: 'Network Tools' }] : []),
    ...(enableMonitoring ? [{ id: 'monitor', icon: Activity, label: 'Monitor' }] : []),
  ];

  if (isMobile) {
    return (
      // `pb-[env(safe-area-inset-bottom)]` clears the Android gesture-nav pill
      // and iPhone home-indicator so the tab icons don't sit under system UI.
      // Height stays 56px minimum (h-14) via `min-h-14` — the extra padding
      // expands the aside downward into safe-area space, not upward into the
      // content area, so the terminal above doesn't lose vertical room.
      <aside
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
        className="w-full min-h-14 shrink-0 bg-background border-t border-white/5 flex items-center px-2 relative z-10 shadow-2xl brightness-95"
      >
        <nav className="flex-1 flex flex-row items-center justify-around gap-1">
          {items.map((item) => (
            <button
              key={item.id}
              onClick={() => setActiveTab(item.id)}
              className={`p-2.5 rounded-xl transition-all duration-300 relative group flex items-center justify-center ${
                activeTab === item.id
                  ? 'text-primary bg-primary/10 shadow-[0_0_20px_rgba(var(--primary),0.15)]'
                  : 'text-zinc-500 hover:text-zinc-200 hover:bg-white/5'
              }`}
              title={(item.id === 'nodes' || item.id === 'monitor') && enableMonitoring && alertSummary ? `${item.label} · ${alertSummary}` : item.label}
            >
              <item.icon size={20} className={activeTab === item.id ? "drop-shadow-[0_0_8px_rgba(var(--primary),0.5)]" : ""} />
              {/* Live Health Pulse Badge */}
              {(item.id === 'nodes' || item.id === 'monitor') && enableMonitoring && healthState !== 'idle' && (
                <>
                  {healthState === 'critical' && (
                    <span className="absolute top-1.5 right-1.5 flex h-2 w-2">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-rose-400 opacity-75" />
                      <span className="relative inline-flex rounded-full h-2 w-2 bg-rose-500 shadow-[0_0_8px_rgba(244,63,94,0.8)]" />
                    </span>
                  )}
                  {healthState === 'warning' && (
                    <span className="absolute top-1.5 right-1.5 flex h-2 w-2">
                      <span className="animate-pulse relative inline-flex rounded-full h-2 w-2 bg-amber-400 shadow-[0_0_8px_rgba(251,191,36,0.8)]" />
                    </span>
                  )}
                  {healthState === 'ok' && (
                    <span className="absolute top-1.5 right-1.5 inline-flex rounded-full h-1.5 w-1.5 bg-emerald-500/80 shadow-[0_0_4px_rgba(16,185,129,0.5)]" />
                  )}
                </>
              )}
              {/* Bottom indicator stripe instead of left rail in mobile mode. */}
              {activeTab === item.id && <div className="absolute bottom-0 left-1/2 -translate-x-1/2 h-0.5 w-1/2 bg-primary rounded-t-full shadow-[0_0_10px_rgba(var(--primary),1)]" />}
            </button>
          ))}
        </nav>

        {/* Trailing cluster (lock + switch profile + settings) */}
        <div className="flex items-center gap-1 pl-2 ml-1 border-l border-white/5">
          {(!isUnlocked ? onUnlock : (onLock || onLogout)) && (
            <button
              onClick={!isUnlocked ? onUnlock : (onLock || onLogout)}
              className={`p-2.5 rounded-xl transition-all flex items-center justify-center ${
                !isUnlocked
                  ? "text-amber-400 bg-amber-500/10 hover:bg-amber-500/20"
                  : "text-zinc-400 hover:text-amber-400 hover:bg-amber-500/10"
              }`}
              title={!isUnlocked ? "Sign In / Unlock Vault" : "Lock SubTerm"}
            >
              <Lock size={18} />
            </button>
          )}
          {isUnlocked && (onSwitchProfile || onLogout) && (
            <button
              onClick={onSwitchProfile || onLogout}
              className="p-2.5 rounded-xl transition-all flex items-center justify-center text-zinc-400 hover:text-primary hover:bg-primary/10"
              title={switchTitle}
              aria-label={switchTitle}
            >
              {workspaceBadge}
            </button>
          )}
          <button
            onClick={() => setActiveTab('settings')}
            className={`p-2.5 rounded-xl transition-all flex items-center justify-center ${
              activeTab === 'settings'
                ? 'text-primary bg-primary/10 shadow-[0_0_20px_rgba(var(--primary),0.15)]'
                : 'text-zinc-500 hover:text-zinc-200 hover:bg-white/5'
            }`}
            title="Settings"
          >
            <Settings size={20} className={activeTab === 'settings' ? "drop-shadow-[0_0_8px_rgba(var(--primary),0.5)]" : ""} />
          </button>
        </div>
      </aside>
    );
  }

  return (
    <aside className="w-14 h-full bg-background border-r border-white/5 flex flex-col items-center py-6 shrink-0 relative z-10 shadow-2xl brightness-95 transition-all">
      <nav className="flex flex-col gap-3 w-full px-2">
        {items.map((item) => (
          <Fragment key={item.id}>
          <button
            onClick={() => setActiveTab(item.id)}
            onContextMenu={item.id === 'local' && onOpenLocalShell && localShells.length > 0 ? (e) => {
              e.preventDefault();
              const r = e.currentTarget.getBoundingClientRect();
              setShellMenu({ x: r.right + 6, y: r.top });
            } : undefined}
            className={`p-2.5 rounded-xl transition-all duration-300 relative group flex items-center justify-center ${
              activeTab === item.id
                ? 'text-primary bg-primary/10 shadow-[0_0_20px_rgba(var(--primary),0.15)]'
                : 'text-zinc-500 hover:text-zinc-200 hover:bg-white/5'
            }`}
            title={(item.id === 'nodes' || item.id === 'monitor') && enableMonitoring && alertSummary ? `${item.label} · ${alertSummary}`
              : item.id === 'local' && onOpenLocalShell && localShells.length > 0 ? 'Local (right-click to pick a shell)' : item.label}
          >
            <item.icon size={20} className={activeTab === item.id ? "drop-shadow-[0_0_8px_rgba(var(--primary),0.5)]" : ""} />
            {/* Live Health Pulse Badge */}
            {(item.id === 'nodes' || item.id === 'monitor') && enableMonitoring && healthState !== 'idle' && (
              <>
                {healthState === 'critical' && (
                  <span className="absolute top-1.5 right-1.5 flex h-2 w-2">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-rose-400 opacity-75" />
                    <span className="relative inline-flex rounded-full h-2 w-2 bg-rose-500 shadow-[0_0_8px_rgba(244,63,94,0.8)]" />
                  </span>
                )}
                {healthState === 'warning' && (
                  <span className="absolute top-1.5 right-1.5 flex h-2 w-2">
                    <span className="animate-pulse relative inline-flex rounded-full h-2 w-2 bg-amber-400 shadow-[0_0_8px_rgba(251,191,36,0.8)]" />
                  </span>
                )}
                {healthState === 'ok' && (
                  <span className="absolute top-1.5 right-1.5 inline-flex rounded-full h-1.5 w-1.5 bg-emerald-500/80 shadow-[0_0_4px_rgba(16,185,129,0.5)]" />
                )}
              </>
            )}
            {activeTab === item.id && <div className="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-1/2 bg-primary rounded-r-full shadow-[0_0_10px_rgba(var(--primary),1)]" />}
          </button>
          {item.id === 'local' && localTabs.length > 0 && (
            <div role="tablist" aria-label="Local shells" aria-orientation="vertical" className="-mt-1.5 flex flex-col gap-1">
              {localTabs.map((t) => (
                <div key={t.id} className="relative group/tab">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={t.id === activeLocalTab}
                    onClick={() => onSelectLocalTab?.(t.id)}
                    title={t.title}
                    className={`w-full h-7 px-0.5 rounded-lg text-[9px] font-bold uppercase tracking-tight truncate border transition-colors ${
                      t.id === activeLocalTab
                        ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
                        : 'text-zinc-500 hover:text-zinc-200 hover:bg-white/5 border-transparent'
                    }`}
                  >
                    {t.label}
                  </button>
                  {localTabs.length > 1 && (
                    <button
                      type="button"
                      onClick={() => onCloseLocalTab?.(t.id)}
                      aria-label={`Close ${t.title}`}
                      title="Close"
                      className="absolute -top-1 -right-1 hidden group-hover/tab:flex focus:flex w-3.5 h-3.5 rounded-full bg-zinc-800 border border-white/10 items-center justify-center text-zinc-400 hover:text-red-400"
                    >
                      <X size={8} />
                    </button>
                  )}
                </div>
              ))}
              <button
                type="button"
                onClick={onNewLocalTab}
                aria-label="New local shell"
                title="Open another shell (right-click Local to pick which)"
                className="h-6 rounded-lg border border-dashed border-white/10 text-zinc-500 hover:text-white hover:bg-white/5 flex items-center justify-center"
              >
                <Plus size={11} />
              </button>
            </div>
          )}
          </Fragment>
        ))}
      </nav>

      {shellMenu && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setShellMenu(null)} onContextMenu={(e) => { e.preventDefault(); setShellMenu(null); }} />
          <div
            role="menu"
            aria-label="Open a local shell"
            onKeyDown={(e) => { if (e.key === 'Escape') setShellMenu(null); }}
            style={{ left: shellMenu.x, top: shellMenu.y }}
            className="fixed z-50 w-56 py-1.5 bg-[#141418] border border-white/10 rounded-lg shadow-2xl text-[11px]"
          >
            <div className="px-3 py-1 text-[10px] font-bold uppercase tracking-wider text-zinc-400 border-b border-white/5 mb-1">Open local shell</div>
            {localShells.map((sh, i) => (
              <button
                key={sh.id}
                type="button"
                role="menuitem"
                autoFocus={i === 0}
                onClick={() => { setShellMenu(null); onOpenLocalShell?.(sh.id); }}
                className="w-full text-left px-3 py-1.5 hover:bg-emerald-500/10 focus:bg-emerald-500/10 outline-none text-zinc-300 hover:text-emerald-300 flex items-center justify-between"
              >
                <span className="font-medium truncate">{sh.name}</span>
                <span className="text-[10px] text-zinc-500 font-mono shrink-0 ml-2">{sh.id}</span>
              </button>
            ))}
          </div>
        </>
      )}

      {/* Bottom cluster: lock, switch workspace, and settings */}
      <div className="mt-auto w-full px-2 flex flex-col gap-2">
        {(!isUnlocked ? onUnlock : (onLock || onLogout)) && (
          <button
            onClick={!isUnlocked ? onUnlock : (onLock || onLogout)}
            className={`p-2.5 rounded-xl transition-all flex items-center justify-center ${
              !isUnlocked
                ? "text-amber-400 bg-amber-500/10 hover:bg-amber-500/20"
                : "text-zinc-400 hover:text-amber-400 hover:bg-amber-500/10"
            }`}
            title={!isUnlocked ? "Sign In / Unlock Vault" : "Lock SubTerm"}
          >
            <Lock size={18} />
          </button>
        )}
        {isUnlocked && (onSwitchProfile || onLogout) && (
          <button
            onClick={onSwitchProfile || onLogout}
            className="p-2.5 rounded-xl transition-all flex items-center justify-center text-zinc-400 hover:text-primary hover:bg-primary/10"
            title={switchTitle}
            aria-label={switchTitle}
          >
            {workspaceBadge}
          </button>
        )}
        <button
          onClick={() => setActiveTab('settings')}
          className={`p-2.5 rounded-xl transition-all flex items-center justify-center ${
            activeTab === 'settings'
              ? 'text-primary bg-primary/10 shadow-[0_0_20px_rgba(var(--primary),0.15)]'
              : 'text-zinc-500 hover:text-zinc-200 hover:bg-white/5'
          }`}
          title="Settings"
        >
          <Settings size={20} className={activeTab === 'settings' ? "drop-shadow-[0_0_8px_rgba(var(--primary),0.5)]" : ""} />
        </button>
      </div>
    </aside>
  );
};
