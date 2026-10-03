import { useState } from "react";
import {
  Settings, Palette, RefreshCw, List, Cloud, User,
  ArrowLeft, Activity, Server, ArrowUp, ArrowDown, Trash2,
  Plus, Terminal, Keyboard, ChevronRight, Lock,
} from "lucide-react";
import CloudPanel from "./CloudPanel";
import { SettingsProfileManagement } from "./SettingsProfileManagement";
import { SettingsKeyboardShortcuts } from "./SettingsKeyboardShortcuts";
import { SettingsQuickCommands } from "./SettingsQuickCommands";
import { SettingsCloudSync } from "./SettingsCloudSync";

type CategoryId = "appearance" | "terminal" | "servers" | "monitoring" | "cloud" | "profile" | "quickcommands" | "shortcuts" | "maintenance" | "logs";

interface Category {
  id: CategoryId;
  label: string;
  icon: React.ReactNode;
  description: string;
}

// Categories that require the vault to be unlocked before use.
const LOCKED_CATEGORIES: CategoryId[] = ["cloud", "profile", "quickcommands", "servers", "maintenance", "logs"];

const CATEGORIES: Category[] = [
  { id: "appearance",    label: "Appearance",        icon: <Palette size={16} />,   description: "Colors, fonts, and theme" },
  { id: "terminal",      label: "Terminal",           icon: <Terminal size={16} />,  description: "Behaviour, clipboard, session-end" },
  { id: "servers",       label: "Quick Access",       icon: <Server size={16} />,    description: "Pinned servers in the top bar" },
  { id: "monitoring",    label: "Monitoring",         icon: <Activity size={16} />,  description: "Resource polling and alerts" },
  { id: "cloud",         label: "Cloud and Sync",     icon: <Cloud size={16} />,     description: "Cloud account and sync settings" },
  { id: "profile",       label: "Profile",            icon: <User size={16} />,      description: "Manage and switch profiles" },
  { id: "quickcommands", label: "Quick Commands",     icon: <List size={16} />,      description: "OS / environment quick commands" },
  { id: "shortcuts",     label: "Keyboard Shortcuts", icon: <Keyboard size={16} />,  description: "Rebind keyboard shortcuts" },
  { id: "maintenance",   label: "Maintenance",        icon: <RefreshCw size={16} />, description: "Reset defaults and diagnostics" },
  { id: "logs",          label: "Activity Log",       icon: <List size={16} />,      description: "Session diagnostics timeline" },
];

// â”€â”€â”€ Reusable primitives â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const SectionCard = ({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) => (
  <div className="bg-[#121215] border border-white/5 rounded-2xl p-6 shadow-xl">
    <div className="mb-4">
      <h3 className="text-sm font-bold text-white">{title}</h3>
      {subtitle && <p className="text-xs text-zinc-500 mt-1 leading-relaxed">{subtitle}</p>}
    </div>
    {children}
  </div>
);

const Toggle = ({ checked, onChange }: { checked: boolean; onChange: () => void }) => (
  <button
    type="button"
    role="switch"
    aria-checked={checked}
    onClick={onChange}
    className={`relative shrink-0 w-11 h-6 rounded-full transition-colors ${checked ? "bg-primary" : "bg-white/10"}`}
  >
    <span className={`block w-5 h-5 rounded-full bg-white transition-transform shadow-md ${checked ? "translate-x-5" : "translate-x-0.5"}`} />
  </button>
);

const Row = ({ label, desc, children }: { label: string; desc?: string; children: React.ReactNode }) => (
  <div className="flex items-center justify-between gap-4 py-3 border-b border-white/5 last:border-0">
    <div className="min-w-0">
      <div className="text-sm font-semibold text-zinc-200">{label}</div>
      {desc && <div className="text-xs text-zinc-500 mt-0.5">{desc}</div>}
    </div>
    <div className="shrink-0">{children}</div>
  </div>
);

// â”€â”€â”€ Lock gate â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const LockedPage = ({ label, onRequestUnlock }: { label: string; onRequestUnlock?: () => void }) => (
  <div className="flex flex-col items-center justify-center py-20 text-center px-6">
    <div className="w-14 h-14 rounded-2xl bg-amber-500/10 border border-amber-500/20 flex items-center justify-center text-amber-400 mb-5 shadow-xl shadow-amber-500/5">
      <Lock size={24} />
    </div>
    <h3 className="text-base font-bold text-white mb-1.5">Vault is locked</h3>
    <p className="text-xs text-zinc-400 max-w-xs leading-relaxed mb-6">
      <span className="font-semibold text-zinc-300">{label}</span> settings are protected by your master password.
      Unlock SubTerm to view and change these settings.
    </p>
    {onRequestUnlock && (
      <button
        type="button"
        onClick={onRequestUnlock}
        className="h-9 px-6 rounded-xl bg-amber-400 text-zinc-950 font-bold text-xs hover:bg-amber-300 transition-all flex items-center gap-2 shadow-lg shadow-amber-500/20"
      >
        <Lock size={13} /> Unlock Vault
      </button>
    )}
  </div>
);

// â”€â”€â”€ Page components â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const accentColors = [
  { name: "Light Blue", value: "#60a5fa" },
  { name: "Sky",        value: "#38bdf8" },
  { name: "Cyan",       value: "#22d3ee" },
  { name: "Indigo",     value: "#818cf8" },
  { name: "Emerald",    value: "#10b981" },
  { name: "Rose",       value: "#f43f5e" },
];
const bgColors = [
  { name: "Onyx",       value: "#050505" },
  { name: "Charcoal",   value: "#0a0a0c" },
  { name: "Slate",      value: "#0f172a" },
  { name: "Nord",       value: "#2e3440" },
  { name: "Dark Gray",  value: "#1a1a1a" },
  { name: "Deep Space", value: "#0d0d10" },
];

const PageAppearance = ({ settings, setSettings }: any) => (
  <div className="space-y-6">
    <SectionCard title="Primary Accent Color">
      <div className="flex items-center justify-between mb-4">
        <span className="text-xs text-zinc-500">Pick a preset or enter a custom hex value</span>
        <div className="flex items-center gap-2">
          <input type="color" value={settings.primaryColor} onChange={(e) => setSettings({ ...settings, primaryColor: e.target.value })} className="w-6 h-6 rounded-md bg-transparent cursor-pointer border-none p-0" />
          <input type="text" value={settings.primaryColor} onChange={(e) => setSettings({ ...settings, primaryColor: e.target.value })} className="w-20 h-6 bg-black border border-white/10 rounded px-1.5 text-[10px] font-mono text-zinc-400 focus:border-primary/50 outline-none" />
        </div>
      </div>
      <div className="grid grid-cols-6 gap-3">
        {accentColors.map((c) => (
          <button key={c.value} onClick={() => setSettings({ ...settings, primaryColor: c.value })} className={`w-full aspect-square rounded-xl border-2 transition-all ${settings.primaryColor === c.value ? "border-white scale-110 shadow-lg" : "border-transparent hover:scale-105"}`} style={{ backgroundColor: c.value }} title={c.name} />
        ))}
      </div>
    </SectionCard>
    <SectionCard title="Background Theme">
      <div className="flex items-center justify-between mb-4">
        <span className="text-xs text-zinc-500">App background colour preset</span>
        <div className="flex items-center gap-2">
          <input type="color" value={settings.backgroundColor} onChange={(e) => setSettings({ ...settings, backgroundColor: e.target.value })} className="w-6 h-6 rounded-md bg-transparent cursor-pointer border-none p-0" />
          <input type="text" value={settings.backgroundColor} onChange={(e) => setSettings({ ...settings, backgroundColor: e.target.value })} className="w-20 h-6 bg-black border border-white/10 rounded px-1.5 text-[10px] font-mono text-zinc-400 focus:border-primary/50 outline-none" />
        </div>
      </div>
      <div className="grid grid-cols-6 gap-3">
        {bgColors.map((c) => (
          <button key={c.value} onClick={() => setSettings({ ...settings, backgroundColor: c.value })} className={`w-full aspect-square rounded-xl border-2 transition-all ${settings.backgroundColor === c.value ? "border-white scale-110 shadow-lg" : "border-transparent hover:scale-105"}`} style={{ backgroundColor: c.value }} title={c.name} />
        ))}
      </div>
    </SectionCard>
  </div>
);

const PageTerminal = ({ settings, setSettings }: any) => (
  <div className="space-y-6">
    <SectionCard title="Display">
      <Row label="Font Size (px)" desc="Terminal character size in pixels">
        <div className="flex items-center gap-3">
          <input type="range" min="8" max="24" value={settings.terminalFontSize || 14} onChange={(e) => setSettings({ ...settings, terminalFontSize: parseInt(e.target.value) || 14 })} className="w-32 accent-primary" />
          <input type="number" value={settings.terminalFontSize || 14} onChange={(e) => setSettings({ ...settings, terminalFontSize: parseInt(e.target.value) || 14 })} className="w-14 h-8 bg-black border border-white/10 rounded-lg px-2 text-[12px] font-bold text-white focus:border-primary/50 outline-none text-center" />
        </div>
      </Row>
      <Row label="WebGL Hardware Acceleration" desc="Enable GPU-accelerated rendering for 60fps throughput and lower CPU usage">
        <Toggle
          checked={settings.terminalWebgl !== false}
          onChange={() => {
            const next = settings.terminalWebgl === false;
            setSettings({ ...settings, terminalWebgl: next });
            localStorage.setItem('subterm-terminal-webgl', next ? 'true' : 'false');
          }}
        />
      </Row>
    </SectionCard>
    <SectionCard title="Session Behaviour">
      <Row label="Auto-close tab on exit" desc="Close the session tab when the shell process exits">
        <Toggle checked={!!settings.autoCloseOnExit} onChange={() => setSettings({ ...settings, autoCloseOnExit: !settings.autoCloseOnExit })} />
      </Row>
      <Row label="Download audit on exit" desc="Save a session transcript to file when the session ends">
        <Toggle checked={!!settings.downloadAuditOnExit} onChange={() => setSettings({ ...settings, downloadAuditOnExit: !settings.downloadAuditOnExit })} />
      </Row>
      <Row label="Auto-copy output to clipboard" desc="Copies command output automatically after completion">
        <Toggle checked={!!settings.autoCopyOutput} onChange={() => setSettings({ ...settings, autoCopyOutput: !settings.autoCopyOutput })} />
      </Row>
    </SectionCard>
    <SectionCard title="Command Widget">
      <Row label="Auto-dismiss timer (seconds)" desc="Time before floating output pill fades (0 = stay open)">
        <div className="flex items-center gap-3">
          <input type="range" min="0" max="20" value={settings.commandDismissSec !== undefined ? settings.commandDismissSec : 4} onChange={(e) => setSettings({ ...settings, commandDismissSec: Math.max(0, parseInt(e.target.value) || 0) })} className="w-32 accent-primary" />
          <input type="number" min="0" max="30" value={settings.commandDismissSec !== undefined ? settings.commandDismissSec : 4} onChange={(e) => setSettings({ ...settings, commandDismissSec: Math.max(0, parseInt(e.target.value) || 0) })} className="w-14 h-8 bg-black border border-white/10 rounded-lg px-2 text-[12px] font-bold text-white focus:border-primary/50 outline-none text-center" />
        </div>
      </Row>
    </SectionCard>
    <SectionCard title="Session-End Banner Buttons">
      {settings.autoCloseOnExit ? (
        <p className="text-xs text-zinc-500 italic py-2">Disabled because the tab closes automatically on exit.</p>
      ) : (
        <>
          <Row label="Show Copy Output button" desc="Displays the Copy Output action on the session-end screen">
            <Toggle checked={settings.showAuditCopy !== false} onChange={() => setSettings({ ...settings, showAuditCopy: settings.showAuditCopy === false ? true : false })} />
          </Row>
          <Row label="Show Download Audit button" desc="Displays the Download Audit action on the session-end screen">
            <Toggle checked={settings.showAuditDownload !== false} onChange={() => setSettings({ ...settings, showAuditDownload: settings.showAuditDownload === false ? true : false })} />
          </Row>
        </>
      )}
    </SectionCard>
  </div>
);

const PageServers = ({ settings, setSettings, servers }: any) => {
  const [selectedToAdd, setSelectedToAdd] = useState("");
  const quickAccessIds: number[] = settings.quickAccessServerIds || [];
  const currentQuickServers = quickAccessIds.map((id: number) => servers.find((s: any) => s.id === id)).filter(Boolean);
  const availableToAdd = servers.filter((s: any) => !quickAccessIds.includes(s.id));
  const handleAdd = () => {
    const numId = parseInt(selectedToAdd, 10);
    if (!numId || quickAccessIds.length >= 5) return;
    setSettings({ ...settings, quickAccessServerIds: [...quickAccessIds, numId] });
    setSelectedToAdd("");
  };
  const remove = (id: number) => setSettings({ ...settings, quickAccessServerIds: quickAccessIds.filter((i) => i !== id) });
  const move = (from: number, to: number) => {
    if (to < 0 || to >= quickAccessIds.length) return;
    const next = [...quickAccessIds];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    setSettings({ ...settings, quickAccessServerIds: next });
  };
  return (
    <div className="space-y-6">
      <SectionCard title={`Pinned Servers (${currentQuickServers.length}/5)`} subtitle="These servers appear as quick-connect buttons in the top title bar.">
        <div className="space-y-2 mt-2">
          {currentQuickServers.length === 0 && (
            <div className="p-4 text-center rounded-xl border border-dashed border-white/10 text-xs text-zinc-500">No servers pinned yet. Add up to 5 below.</div>
          )}
          {currentQuickServers.map((srv: any, idx: number) => (
            <div key={srv.id} className="flex items-center justify-between p-2.5 rounded-xl bg-white/[0.03] border border-white/5 hover:border-white/10 transition-colors">
              <div className="flex items-center gap-2.5 min-w-0">
                <span className="w-5 h-5 rounded-full bg-white/5 flex items-center justify-center text-[10px] font-bold text-zinc-400 shrink-0">{idx + 1}</span>
                <span className="w-2 h-2 rounded-full bg-emerald-400 shrink-0 shadow-[0_0_6px_rgba(52,211,153,0.8)]" />
                <span className="text-xs font-semibold text-white truncate">{srv.name}</span>
                <span className="text-[11px] text-zinc-500 font-mono truncate hidden sm:inline">{srv.host || srv.ip || "SSH"}</span>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <button disabled={idx === 0} onClick={() => move(idx, idx - 1)} className="p-1 rounded text-zinc-400 hover:text-white hover:bg-white/10 disabled:opacity-30" title="Move up"><ArrowUp size={13} /></button>
                <button disabled={idx === currentQuickServers.length - 1} onClick={() => move(idx, idx + 1)} className="p-1 rounded text-zinc-400 hover:text-white hover:bg-white/10 disabled:opacity-30" title="Move down"><ArrowDown size={13} /></button>
                <button onClick={() => remove(srv.id)} className="p-1 rounded text-rose-400 hover:text-rose-300 hover:bg-rose-500/10 ml-1" title="Remove"><Trash2 size={13} /></button>
              </div>
            </div>
          ))}
        </div>
        {currentQuickServers.length < 5 && availableToAdd.length > 0 && (
          <div className="pt-3 border-t border-white/5 flex items-center gap-2 mt-3">
            <select value={selectedToAdd} onChange={(e) => setSelectedToAdd(e.target.value)} className="flex-1 bg-[#18181f] border border-white/10 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-primary/50">
              <option value="">Select a server to pin...</option>
              {availableToAdd.map((s: any) => (<option key={s.id} value={s.id}>{s.name} ({s.host || s.ip || "SSH"})</option>))}
            </select>
            <button disabled={!selectedToAdd} onClick={handleAdd} className="px-3 py-2 bg-primary/10 border border-primary/30 hover:bg-primary/20 text-primary text-xs font-semibold rounded-xl flex items-center gap-1.5 transition-colors disabled:opacity-40"><Plus size={13} /> Pin</button>
          </div>
        )}
      </SectionCard>
    </div>
  );
};

const PageMonitoring = ({ settings, setSettings }: any) => (
  <div className="space-y-6">
    <SectionCard title="Resource Monitoring">
      <Row label="Enable monitoring" desc="Show the Monitor tab and start background polling for CPU, RAM, disk, and outage detection.">
        <Toggle checked={settings.enableMonitoring !== false} onChange={() => setSettings({ ...settings, enableMonitoring: !(settings.enableMonitoring !== false) })} />
      </Row>
      {settings.enableMonitoring !== false
        ? <p className="text-[11px] text-zinc-400 mt-3">Real-time polling, sparklines, and outage detection are active in the Monitor tab.</p>
        : <p className="text-[11px] text-zinc-500 italic mt-3">Monitoring is disabled. The Monitor tab is hidden and background polling is halted.</p>
      }
    </SectionCard>
  </div>
);

const PageCloud = ({ settings, setSettings, onSync, syncing, lastSyncLabel }: any) => {
  const [cloudOpen, setCloudOpen] = useState(false);
  return (
    <div className="space-y-6">
      <SettingsCloudSync settings={settings} setSettings={setSettings} onOpenCloudAccount={() => setCloudOpen(true)} onSync={onSync} syncing={syncing} lastSyncLabel={lastSyncLabel} />
      <CloudPanel isOpen={cloudOpen} onClose={() => setCloudOpen(false)} onLocalProfilesChanged={() => {}} />
    </div>
  );
};

const PageProfile = ({ onUnlocked, activeProfile, onSwitchProfile, isUnlocked, onRequestUnlock }: any) => (
  <div className="space-y-6">
    <SettingsProfileManagement
      onUnlocked={onUnlocked}
      activeProfile={activeProfile}
      onSwitchProfile={onSwitchProfile}
      isUnlocked={isUnlocked}
      onRequestUnlock={onRequestUnlock}
    />
  </div>
);

const PageQuickCommands = () => <div className="space-y-6"><SettingsQuickCommands /></div>;

const PageShortcuts = () => <div className="space-y-6"><SettingsKeyboardShortcuts /></div>;

const PageMaintenance = ({ settings, setSettings }: any) => (
  <div className="space-y-6">
    <SectionCard title="Reset Preferences" subtitle="Resets UI aesthetics to factory defaults. Your servers and profiles are unaffected.">
      <button
        onClick={() => { if (window.confirm("Reset all UI customisations to defaults?")) { setSettings((s: any) => ({ ...s, primaryColor: "#60a5fa", backgroundColor: "#0a0a0c", terminalFontSize: 14, enableMonitoring: true })); } }}
        className="mt-4 px-4 h-9 bg-zinc-900 border border-white/5 text-zinc-300 rounded-xl text-xs font-bold uppercase hover:bg-white/5 transition-all w-full"
      >
        Reset to Defaults
      </button>
    </SectionCard>
  </div>
);

const PageLogs = ({ onOpenLogs }: { onOpenLogs?: () => void }) => (
  <div className="space-y-6">
    <SectionCard title="Activity Log" subtitle="Diagnostic timeline of app activity this session. Useful for confirming connection failures or watching transfers in retrospect.">
      {onOpenLogs
        ? <button onClick={onOpenLogs} className="mt-4 px-4 h-9 bg-primary/10 border border-primary/30 text-primary rounded-xl text-xs font-bold uppercase hover:bg-primary hover:text-zinc-950 transition-all w-full flex items-center justify-center gap-2"><List size={14} /> View Activity Log</button>
        : <p className="text-xs text-zinc-500 italic py-2">Activity log is not available.</p>
      }
    </SectionCard>
  </div>
);

// â”€â”€â”€ Main component â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const SettingsPanel = ({ settings, setSettings, onOpenLogs, onClose, onUnlocked, servers = [], onSync, syncing, lastSyncLabel, activeProfile, onSwitchProfile, isUnlocked = false, onRequestUnlock }: any) => {
  const [activeCategory, setActiveCategory] = useState<CategoryId>("appearance");

  const needsUnlock = (id: CategoryId) => !isUnlocked && LOCKED_CATEGORIES.includes(id);

  const renderPage = () => {
    if (needsUnlock(activeCategory)) {
      const current = CATEGORIES.find((c) => c.id === activeCategory)!;
      return <LockedPage label={current.label} onRequestUnlock={onRequestUnlock} />;
    }
    switch (activeCategory) {
      case "appearance":    return <PageAppearance settings={settings} setSettings={setSettings} />;
      case "terminal":      return <PageTerminal settings={settings} setSettings={setSettings} />;
      case "servers":       return <PageServers settings={settings} setSettings={setSettings} servers={servers} />;
      case "monitoring":    return <PageMonitoring settings={settings} setSettings={setSettings} />;
      case "cloud":         return <PageCloud settings={settings} setSettings={setSettings} onSync={onSync} syncing={syncing} lastSyncLabel={lastSyncLabel} />;
      case "profile":       return <PageProfile onUnlocked={onUnlocked} activeProfile={activeProfile} onSwitchProfile={onSwitchProfile} isUnlocked={isUnlocked} onRequestUnlock={onRequestUnlock} />;
      case "quickcommands": return <PageQuickCommands />;
      case "shortcuts":     return <PageShortcuts />;
      case "maintenance":   return <PageMaintenance settings={settings} setSettings={setSettings} />;
      case "logs":          return <PageLogs onOpenLogs={onOpenLogs} />;
      default:              return null;
    }
  };

  const current = CATEGORIES.find((c) => c.id === activeCategory)!;

  return (
    <div className="flex h-full overflow-hidden animate-in">
      <aside className="w-52 shrink-0 flex flex-col border-r border-white/5 bg-black/20 overflow-y-auto custom-scrollbar">
        <div className="p-4 border-b border-white/5 flex items-center gap-3">
          {onClose && (
            <button onClick={onClose} className="h-7 w-7 rounded-full bg-white/[0.05] hover:bg-white/[0.1] text-zinc-400 flex items-center justify-center transition-colors shrink-0">
              <ArrowLeft size={13} />
            </button>
          )}
          <div className="flex items-center gap-2 min-w-0">
            <Settings size={15} className="text-primary shrink-0" />
            <span className="text-sm font-bold text-white tracking-tight truncate">Settings</span>
          </div>
        </div>
        {!isUnlocked && (
          <div className="mx-2 mt-2 px-3 py-2 rounded-xl bg-amber-500/10 border border-amber-500/20 flex items-center gap-2">
            <Lock size={11} className="text-amber-400 shrink-0" />
            <p className="text-[10px] text-amber-300/80 leading-tight">Unlock to access protected settings</p>
          </div>
        )}
        <nav className="flex-1 p-2 space-y-0.5 mt-1">
          {CATEGORIES.map((cat) => {
            const active = cat.id === activeCategory;
            const locked = needsUnlock(cat.id);
            return (
              <button
                key={cat.id}
                onClick={() => setActiveCategory(cat.id)}
                className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-left transition-all group ${active ? "bg-primary/10 text-primary border border-primary/20" : "text-zinc-400 hover:text-zinc-200 hover:bg-white/[0.04] border border-transparent"}`}
              >
                <span className={`shrink-0 transition-colors ${active ? "text-primary" : "text-zinc-500 group-hover:text-zinc-300"}`}>{cat.icon}</span>
                <span className="text-xs font-semibold truncate flex-1">{cat.label}</span>
                {locked ? (
                  <Lock size={10} className="shrink-0 text-amber-500/60" />
                ) : active ? (
                  <ChevronRight size={12} className="shrink-0 opacity-60" />
                ) : null}
              </button>
            );
          })}
        </nav>
        <div className="p-3 border-t border-white/5">
          <p className="text-[10px] text-zinc-600 leading-relaxed">Preferences are local and do not sync with your cloud profile.</p>
        </div>
      </aside>
      <main className="flex-1 overflow-y-auto custom-scrollbar">
        <div className="p-6 sm:p-8 max-w-2xl">
          <div className="mb-6">
            <h2 className="text-lg font-bold text-white flex items-center gap-2">
              <span className="text-primary">{current.icon}</span>
              {current.label}
              {needsUnlock(current.id) && <Lock size={14} className="text-amber-400 ml-1" />}
            </h2>
            <p className="text-xs text-zinc-500 mt-1">{current.description}</p>
          </div>
          {renderPage()}
        </div>
      </main>
    </div>
  );
};

export default SettingsPanel;
