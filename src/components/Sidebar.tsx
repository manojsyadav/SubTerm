import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Server, KeyRound, Braces, Activity, Settings, Lock, ArrowLeftRight, Terminal, FolderOpen, Monitor } from "lucide-react";

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
}: SidebarProps) => {
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
    { id: 'nodes', icon: Server, label: 'Servers' },
    { id: 'local', icon: Terminal, label: 'Local' },
    { id: 'sftp', icon: FolderOpen, label: 'SFTP' },
    ...(showRdp ? [{ id: 'rdp', icon: Monitor, label: 'RDP' }] : []),
    { id: 'vault', icon: KeyRound, label: 'Credentials' },
    { id: 'library', icon: Braces, label: 'Snippets' },
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
              title="Switch workspace"
            >
              <ArrowLeftRight size={18} />
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
            {activeTab === item.id && <div className="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-1/2 bg-primary rounded-r-full shadow-[0_0_10px_rgba(var(--primary),1)]" />}
          </button>
        ))}
      </nav>

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
            title="Switch workspace"
          >
            <ArrowLeftRight size={18} />
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
