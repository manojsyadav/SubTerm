import { useState } from "react";
import { Settings, Palette, RefreshCw, Pipette, List, Cloud, User, ArrowLeft, Activity, Server, ArrowUp, ArrowDown, Trash2, Plus } from "lucide-react";
import CloudPanel from "./CloudPanel";
import { SettingsProfileManagement } from "./SettingsProfileManagement";

const SettingsPanel = ({ settings, setSettings, onOpenLogs, onClose, onUnlocked, servers = [] }: any) => {
  const accentColors = [
    { name: 'Light Blue', value: '#60a5fa' },
    { name: 'Sky', value: '#38bdf8' },
    { name: 'Cyan', value: '#22d3ee' },
    { name: 'Indigo', value: '#818cf8' },
    { name: 'Emerald', value: '#10b981' },
    { name: 'Rose', value: '#f43f5e' },
  ];

  const bgColors = [
    { name: 'Onyx', value: '#050505' },
    { name: 'Charcoal', value: '#0a0a0c' },
    { name: 'Slate', value: '#0f172a' },
    { name: 'Nord', value: '#2e3440' },
    { name: 'Dark Gray', value: '#1a1a1a' },
    { name: 'Deep Space', value: '#0d0d10' },
  ];

  const [cloudOpen, setCloudOpen] = useState(false);

  // Quick access server IDs (up to 5)
  const quickAccessIds: number[] = settings.quickAccessServerIds || [];
  const currentQuickServers = quickAccessIds
    .map((id: number) => servers.find((s: any) => s.id === id))
    .filter(Boolean);

  const availableToAdd = servers.filter((s: any) => !quickAccessIds.includes(s.id));
  const [selectedToAdd, setSelectedToAdd] = useState("");

  const handleAddServer = () => {
    const numId = parseInt(selectedToAdd, 10);
    if (!numId || quickAccessIds.length >= 5) return;
    const next = [...quickAccessIds, numId];
    setSettings({ ...settings, quickAccessServerIds: next });
    setSelectedToAdd("");
  };

  const removeQuickServer = (id: number) => {
    const next = quickAccessIds.filter((i: number) => i !== id);
    setSettings({ ...settings, quickAccessServerIds: next });
  };

  const moveQuickServer = (fromIndex: number, toIndex: number) => {
    if (toIndex < 0 || toIndex >= quickAccessIds.length) return;
    const next = [...quickAccessIds];
    const [moved] = next.splice(fromIndex, 1);
    next.splice(toIndex, 0, moved);
    setSettings({ ...settings, quickAccessServerIds: next });
  };

  return (
    <div className="flex-1 p-4 sm:p-10 overflow-y-auto custom-scrollbar animate-in">
      <header className="mb-6 sm:mb-10 flex items-center gap-4">
        {onClose && (
          <button onClick={onClose} className="h-9 w-9 rounded-full bg-white/[0.05] hover:bg-white/[0.1] text-zinc-300 flex items-center justify-center transition-colors">
            <ArrowLeft size={16} />
          </button>
        )}
        <div>
          <h2 className="text-xl sm:text-2xl font-bold text-white tracking-tight flex items-center gap-3">
            <Settings size={24} className="text-primary" /> Settings
          </h2>
        <p className="text-[13px] text-zinc-400 mt-2">
          Tweak how SubTerm looks and feels.
          {' '}
          <span className="text-zinc-500 italic">Per-device — preferences live in this machine's local storage and don't sync with your cloud profile.</span>
        </p>
        </div>
      </header>

      {/* Columns rather than a grid: the sections are very different heights, and
          a 2-col grid rows them up so a short card leaves a tall empty gap beside
          it. Column flow packs them, and break-inside-avoid keeps a card whole. */}
      <div className="columns-1 md:columns-2 gap-4 sm:gap-8">
        <SettingsProfileManagement onUnlocked={onUnlocked} />

        {/* Quick Access Servers (Top Bar) Section */}
        <section className="break-inside-avoid space-y-3 mb-4 sm:mb-8">
          <div className="flex items-center gap-2 text-zinc-400 font-bold uppercase tracking-widest text-xs">
            <Server size={14} className="text-primary" /> Top Bar Quick Access Servers
          </div>

          <div className="bg-[#121215] border border-white/5 rounded-2xl p-6 space-y-6 shadow-xl">
            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <span className="text-sm font-semibold text-white">Pinned Servers ({currentQuickServers.length}/5)</span>
                <span className="text-[11px] text-zinc-500">Maximum 5 servers</span>
              </div>
              <p className="text-xs text-zinc-400">
                Display up to 5 quick access servers directly in the top titlebar. Active servers display a bright green indicator.
              </p>
            </div>

            {/* List of current quick access servers */}
            <div className="space-y-2">
              {currentQuickServers.map((srv: any, idx: number) => (
                <div
                  key={srv.id}
                  className="flex items-center justify-between p-2.5 rounded-xl bg-white/[0.03] border border-white/5 hover:border-white/10 transition-colors"
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    <span className="w-5 h-5 rounded-full bg-white/5 flex items-center justify-center text-[10px] font-bold text-zinc-400 shrink-0">
                      {idx + 1}
                    </span>
                    <span className="w-2 h-2 rounded-full bg-emerald-400 shrink-0 shadow-[0_0_6px_rgba(52,211,153,0.8)]" />
                    <span className="text-xs font-semibold text-white truncate">{srv.name}</span>
                    <span className="text-[11px] text-zinc-500 font-mono truncate hidden sm:inline">
                      {srv.host || srv.ip || "SSH"}
                    </span>
                  </div>

                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      type="button"
                      disabled={idx === 0}
                      onClick={() => moveQuickServer(idx, idx - 1)}
                      className="p-1 rounded text-zinc-400 hover:text-white hover:bg-white/10 disabled:opacity-30 disabled:hover:bg-transparent"
                      title="Move up"
                    >
                      <ArrowUp size={13} />
                    </button>
                    <button
                      type="button"
                      disabled={idx === currentQuickServers.length - 1}
                      onClick={() => moveQuickServer(idx, idx + 1)}
                      className="p-1 rounded text-zinc-400 hover:text-white hover:bg-white/10 disabled:opacity-30 disabled:hover:bg-transparent"
                      title="Move down"
                    >
                      <ArrowDown size={13} />
                    </button>
                    <button
                      type="button"
                      onClick={() => removeQuickServer(srv.id)}
                      className="p-1 rounded text-rose-400 hover:text-rose-300 hover:bg-rose-500/10 ml-1"
                      title="Remove from top bar"
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                </div>
              ))}

              {currentQuickServers.length === 0 && (
                <div className="p-4 text-center rounded-xl border border-dashed border-white/10 text-xs text-zinc-500">
                  No quick access servers configured. Select and add servers below to show them in the top bar.
                </div>
              )}
            </div>

            {/* Add Server Dropdown */}
            {currentQuickServers.length < 5 && availableToAdd.length > 0 && (
              <div className="pt-2 border-t border-white/5 flex items-center gap-2">
                <select
                  value={selectedToAdd}
                  onChange={(e) => setSelectedToAdd(e.target.value)}
                  className="flex-1 bg-[#18181f] border border-white/10 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-primary/50"
                >
                  <option value="">Select a server to add...</option>
                  {availableToAdd.map((s: any) => (
                    <option key={s.id} value={s.id}>
                      {s.name} ({s.host || s.ip || "SSH"})
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  disabled={!selectedToAdd}
                  onClick={handleAddServer}
                  className="px-3 py-2 bg-primary/10 border border-primary/30 hover:bg-primary/20 text-primary text-xs font-semibold rounded-xl flex items-center gap-1.5 transition-colors disabled:opacity-40 disabled:hover:bg-primary/10"
                >
                  <Plus size={13} /> Add
                </button>
              </div>
            )}
          </div>
        </section>

        {/* Appearance Section */}
        <section className="break-inside-avoid space-y-3 mb-4 sm:mb-8">
          <div className="flex items-center gap-2 text-zinc-400 font-bold uppercase tracking-widest text-xs">
            <Palette size={14} /> UI Customization
          </div>

          <div className="bg-[#121215] border border-white/5 rounded-2xl p-6 space-y-8 shadow-xl">
            {/* Accent Color */}
            <div className="space-y-4">
              <div className="flex justify-between items-center">
                <label className="text-[11px] font-black text-zinc-500 uppercase tracking-wider">Primary Accent Color</label>
                <div className="flex items-center gap-2">
                  <input 
                    type="color" 
                    value={settings.primaryColor} 
                    onChange={(e) => setSettings({ ...settings, primaryColor: e.target.value })}
                    className="w-6 h-6 rounded-md bg-transparent cursor-pointer border-none p-0"
                  />
                  <input 
                    type="text" 
                    value={settings.primaryColor} 
                    onChange={(e) => setSettings({ ...settings, primaryColor: e.target.value })}
                    className="w-20 h-6 bg-black border border-white/10 rounded px-1.5 text-[10px] font-mono text-zinc-400 focus:border-primary/50 outline-none"
                  />
                </div>
              </div>
              <div className="grid grid-cols-6 gap-3">
                {accentColors.map(c => (
                  <button
                    key={c.value}
                    onClick={() => setSettings({ ...settings, primaryColor: c.value })}
                    className={`w-full aspect-square rounded-xl border-2 transition-all ${settings.primaryColor === c.value ? 'border-white scale-110 shadow-lg' : 'border-transparent hover:scale-105'}`}
                    style={{ backgroundColor: c.value }}
                    title={c.name}
                  />
                ))}
              </div>
            </div>

            {/* Background Theme */}
            <div className="space-y-4 pt-6 border-t border-white/5">
              <div className="flex justify-between items-center">
                <label className="text-[11px] font-black text-zinc-500 uppercase tracking-wider">Background Theme</label>
                <div className="flex items-center gap-2">
                  <input 
                    type="color" 
                    value={settings.backgroundColor} 
                    onChange={(e) => setSettings({ ...settings, backgroundColor: e.target.value })}
                    className="w-6 h-6 rounded-md bg-transparent cursor-pointer border-none p-0"
                  />
                  <input 
                    type="text" 
                    value={settings.backgroundColor} 
                    onChange={(e) => setSettings({ ...settings, backgroundColor: e.target.value })}
                    className="w-20 h-6 bg-black border border-white/10 rounded px-1.5 text-[10px] font-mono text-zinc-400 focus:border-primary/50 outline-none"
                  />
                </div>
              </div>
              <div className="grid grid-cols-6 gap-3">
                {bgColors.map(c => (
                  <button
                    key={c.value}
                    onClick={() => setSettings({ ...settings, backgroundColor: c.value })}
                    className={`w-full aspect-square rounded-xl border-2 transition-all ${settings.backgroundColor === c.value ? 'border-white scale-110 shadow-lg' : 'border-transparent hover:scale-105'}`}
                    style={{ backgroundColor: c.value }}
                    title={c.name}
                  />
                ))}
              </div>
            </div>
          </div>
        </section>

        {/* Terminal Section */}
        <section className="break-inside-avoid space-y-3 mb-4 sm:mb-8">
          <div className="flex items-center gap-2 text-zinc-400 font-bold uppercase tracking-widest text-xs">
            <Settings size={14} /> Terminal Configuration
          </div>
          
          <div className="bg-[#121215] border border-white/5 rounded-2xl p-6 space-y-4 shadow-xl">
            <div className="space-y-4">
              <div className="flex justify-between items-center">
                <label className="text-[11px] font-black text-zinc-500 uppercase tracking-wider">Font Size (px)</label>
                <input 
                  type="number" 
                  value={settings.terminalFontSize || 14} 
                  onChange={(e) => setSettings({ ...settings, terminalFontSize: parseInt(e.target.value) || 14 })}
                  className="w-16 h-8 bg-black border border-white/10 rounded-lg px-2 text-[12px] font-bold text-white focus:border-primary/50 outline-none text-center"
                />
              </div>
              <input
                type="range"
                min="1"
                max="24"
                value={settings.terminalFontSize || 14}
                onChange={(e) => setSettings({ ...settings, terminalFontSize: parseInt(e.target.value) || 14 })}
                className="w-full accent-primary"
              />
            </div>

            {/* Auto-Close on Shell Exit */}
            <div className="pt-4 border-t border-white/5 space-y-2">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-sm font-semibold text-zinc-200">Auto-close tab on exit</div>
                  <div className="text-xs text-zinc-500">Automatically close the session tab when the shell exits</div>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={settings.autoCloseOnExit}
                  onClick={() => setSettings({ ...settings, autoCloseOnExit: !settings.autoCloseOnExit })}
                  className={`w-11 h-6 rounded-full transition-colors relative ${settings.autoCloseOnExit ? 'bg-primary' : 'bg-white/10'}`}
                >
                  <span className={`block w-5 h-5 rounded-full bg-white transition-transform ${settings.autoCloseOnExit ? 'translate-x-5' : 'translate-x-0.5'} shadow-md`} />
                </button>
              </div>
            </div>

            {/* Download Audit on Exit */}
            <div className="pt-4 border-t border-white/5 space-y-2">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-sm font-semibold text-zinc-200">Download audit on exit</div>
                  <div className="text-xs text-zinc-500">Automatically save session audit log to file when session terminates</div>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={settings.downloadAuditOnExit}
                  onClick={() => setSettings({ ...settings, downloadAuditOnExit: !settings.downloadAuditOnExit })}
                  className={`w-11 h-6 rounded-full transition-colors relative ${settings.downloadAuditOnExit ? 'bg-primary' : 'bg-white/10'}`}
                >
                  <span className={`block w-5 h-5 rounded-full bg-white transition-transform ${settings.downloadAuditOnExit ? 'translate-x-5' : 'translate-x-0.5'} shadow-md`} />
                </button>
              </div>
            </div>

            {/* Auto-Copy Command Output to Clipboard */}
            <div className="pt-4 border-t border-white/5 space-y-2">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-sm font-semibold text-zinc-200">Auto-copy output to clipboard</div>
                  <div className="text-xs text-zinc-500">Automatically copy command output to clipboard upon completion</div>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={settings.autoCopyOutput}
                  onClick={() => setSettings({ ...settings, autoCopyOutput: !settings.autoCopyOutput })}
                  className={`w-11 h-6 rounded-full transition-colors relative ${settings.autoCopyOutput ? 'bg-primary' : 'bg-white/10'}`}
                >
                  <span className={`block w-5 h-5 rounded-full bg-white transition-transform ${settings.autoCopyOutput ? 'translate-x-5' : 'translate-x-0.5'} shadow-md`} />
                </button>
              </div>
            </div>

            {/* Command Widget Auto-Dismiss Timer */}
            <div className="pt-4 border-t border-white/5 space-y-2">
              <div className="flex justify-between items-center">
                <div>
                  <div className="text-sm font-semibold text-zinc-200">Command widget dismiss timer</div>
                  <div className="text-xs text-zinc-500">Seconds before floating output pill fades out (0 = keep open)</div>
                </div>
                <input 
                  type="number" 
                  min="0"
                  max="30"
                  value={settings.commandDismissSec !== undefined ? settings.commandDismissSec : 4} 
                  onChange={(e) => setSettings({ ...settings, commandDismissSec: Math.max(0, parseInt(e.target.value) || 0) })}
                  className="w-16 h-8 bg-black border border-white/10 rounded-lg px-2 text-[12px] font-bold text-white focus:border-primary/50 outline-none text-center"
                />
              </div>
              <input
                type="range"
                min="0"
                max="20"
                value={settings.commandDismissSec !== undefined ? settings.commandDismissSec : 4}
                onChange={(e) => setSettings({ ...settings, commandDismissSec: Math.max(0, parseInt(e.target.value) || 0) })}
                className="w-full accent-primary"
              />
            </div>

            {/* Session Ended Actions Configuration (Only relevant if tab does not auto-close) */}
            <div className={`pt-4 border-t border-white/5 space-y-3 transition-opacity ${settings.autoCloseOnExit ? 'opacity-40' : ''}`}>
              <div className="flex items-center justify-between">
                <div>
                  <label className="text-[11px] font-black text-zinc-500 uppercase tracking-wider block">Session End Screen Buttons</label>
                  <div className="text-[11px] text-zinc-500">
                    {settings.autoCloseOnExit 
                      ? "Disabled because 'Auto-close tab on exit' is enabled" 
                      : "Configure action buttons shown on the session ended banner"}
                  </div>
                </div>
              </div>
              
              {!settings.autoCloseOnExit ? (
                <>
                  <div className="flex items-center justify-between pl-2 border-l border-white/10">
                    <div className="text-xs text-zinc-300">Show "Copy Output" button on session end</div>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={settings.showAuditCopy !== false}
                      onClick={() => setSettings({ ...settings, showAuditCopy: settings.showAuditCopy === false ? true : false })}
                      className={`w-9 h-5 rounded-full transition-colors relative ${settings.showAuditCopy !== false ? 'bg-primary' : 'bg-white/10'}`}
                    >
                      <span className={`block w-4 h-4 rounded-full bg-white transition-transform ${settings.showAuditCopy !== false ? 'translate-x-4' : 'translate-x-0.5'} shadow-md`} />
                    </button>
                  </div>

                  <div className="flex items-center justify-between pl-2 border-l border-white/10">
                    <div className="text-xs text-zinc-300">Show "Download Audit" button on session end</div>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={settings.showAuditDownload !== false}
                      onClick={() => setSettings({ ...settings, showAuditDownload: settings.showAuditDownload === false ? true : false })}
                      className={`w-9 h-5 rounded-full transition-colors relative ${settings.showAuditDownload !== false ? 'bg-primary' : 'bg-white/10'}`}
                    >
                      <span className={`block w-4 h-4 rounded-full bg-white transition-transform ${settings.showAuditDownload !== false ? 'translate-x-4' : 'translate-x-0.5'} shadow-md`} />
                    </button>
                  </div>
                </>
              ) : (
                <div className="text-xs text-zinc-500 italic pl-2 border-l border-white/10">
                  When auto-close tab is enabled, tabs close immediately upon shell exit without displaying the session end banner.
                </div>
              )}
            </div>
          </div>
        </section>

        {/* Server Monitoring Section */}
        <section className="break-inside-avoid space-y-3 mb-4 sm:mb-8">
          <div className="flex items-center gap-2 text-zinc-400 font-bold uppercase tracking-widest text-xs">
            <Activity size={14} className={settings.enableMonitoring !== false ? "text-primary" : "text-zinc-500"} /> Server Monitoring
          </div>

          <div className="bg-[#121215] border border-white/5 rounded-2xl p-6 space-y-4 shadow-xl">
            <div className="flex items-center justify-between gap-4">
              <div className="min-w-0">
                <div className="text-sm font-semibold text-zinc-100 flex items-center gap-2">
                  Enable Resource Monitoring
                  {settings.enableMonitoring !== false && (
                    <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                      Active
                    </span>
                  )}
                </div>
                <p className="text-[12px] text-zinc-400 leading-relaxed mt-1">
                  Show the Monitor tab in the navigation bar and enable background polling for CPU, RAM, disk metrics, and outage notifications for your saved servers.
                </p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={settings.enableMonitoring !== false}
                onClick={() => setSettings({ ...settings, enableMonitoring: !(settings.enableMonitoring !== false) })}
                className={`relative shrink-0 w-11 h-6 rounded-full transition-colors ${settings.enableMonitoring !== false ? 'bg-primary' : 'bg-white/10'}`}
              >
                <span className={`block w-5 h-5 rounded-full bg-white transition-transform ${settings.enableMonitoring !== false ? 'translate-x-5' : 'translate-x-0.5'} shadow-md`} />
              </button>
            </div>

            {settings.enableMonitoring === false ? (
              <div className="border-t border-white/5 pt-3">
                <p className="text-[11px] text-zinc-500 italic">
                  Monitoring is currently disabled. The Monitor tab is hidden and background polling is halted to save CPU, network, and battery.
                </p>
              </div>
            ) : (
              <div className="border-t border-white/5 pt-3 text-[11px] text-zinc-400 flex items-center justify-between">
                <span>Real-time polling, sparklines, and outage detection are active in the Monitor tab.</span>
              </div>
            )}
          </div>
        </section>

        {/* Activity Section — moved out of the sidebar so the top-level
            navigation stays focused on primary workflows. Logs are diagnostic
            only; keeping them one click deep here cleans up the sidebar on
            mobile (six icons → five) without burying the data. */}
        {onOpenLogs && (
          <section className="break-inside-avoid space-y-3 mb-4 sm:mb-8">
            <div className="flex items-center gap-2 text-zinc-400 font-bold uppercase tracking-widest text-xs">
              <List size={14} /> Activity Log
            </div>

            <div className="bg-[#121215] border border-white/5 rounded-2xl p-6 space-y-4 shadow-xl">
              <p className="text-sm text-zinc-400 leading-relaxed">
                Diagnostic timeline of what the app has been doing this session. Useful for confirming a connection actually failed or watching a transfer's progress in retrospect.
              </p>
              <button
                onClick={onOpenLogs}
                className="px-4 h-9 bg-primary/10 border border-primary/30 text-primary rounded-xl text-xs font-bold uppercase hover:bg-primary hover:text-zinc-950 transition-all w-full flex items-center justify-center gap-2"
              >
                <List size={14} /> View Activity Log
              </button>
            </div>
          </section>
        )}

        {/* Cloud Section */}
        <section className="break-inside-avoid space-y-3 mb-4 sm:mb-8">
          <div className="flex items-center gap-2 text-zinc-400 font-bold uppercase tracking-widest text-xs">
            <Cloud size={14} /> Cloud Sync
          </div>

          <div className="bg-[#121215] border border-white/5 rounded-2xl p-6 space-y-4 shadow-xl">
            <div className="flex items-center justify-between gap-4">
              <div className="min-w-0">
                <div className="text-sm font-semibold text-zinc-100">Auto-sync</div>
                <p className="text-[12px] text-zinc-400 leading-relaxed mt-1">
                  Keep open profiles synced in the background — shortly after you make a change, when
                  you return to the window, and every few minutes to pull in others' edits on shared
                  profiles. Turn off to sync only with the manual button.
                </p>
              </div>
              <button
                role="switch"
                aria-checked={settings.autoSync !== false}
                onClick={() => setSettings((s: any) => ({ ...s, autoSync: !(s.autoSync !== false) }))}
                className={`relative shrink-0 w-11 h-6 rounded-full transition-colors ${settings.autoSync !== false ? 'bg-primary' : 'bg-zinc-700'}`}
              >
                <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all ${settings.autoSync !== false ? 'left-[22px]' : 'left-0.5'}`} />
              </button>
            </div>

            {settings.autoSync !== false && (
              <div className="border-t border-white/5 pt-4 text-[12px] text-zinc-400 space-y-4">
                <div>
                  Currently checking every{' '}
                  <span className="text-zinc-100 font-semibold">{settings.syncIntervalMin ?? 5} min</span>. Change it
                  on the Profile tab, next to Sync now.
                </div>
                <div>
                  <div className="text-zinc-100 font-semibold mb-1">Custom API Endpoint</div>
                  <input
                    type="text"
                    value={settings.cloudApiBase || ""}
                    onChange={(e) => setSettings((s: any) => ({ ...s, cloudApiBase: e.target.value }))}
                    placeholder="https://api.subterm.com"
                    className="w-full bg-black/40 border border-white/10 rounded-lg px-3 h-9 text-zinc-200 outline-none focus:border-primary/50 placeholder:text-zinc-600 transition-colors"
                  />
                  <p className="mt-1 text-[11px] text-zinc-500">Leave blank to use the default backend.</p>
                </div>
                <div className="pt-2 border-t border-white/5">
                  <button
                    onClick={() => setCloudOpen(true)}
                    className="h-9 px-4 rounded-xl text-xs font-bold text-zinc-900 bg-primary hover:bg-primary/90 transition-colors flex items-center gap-2"
                  >
                    <User size={14} /> Manage Cloud Account
                  </button>
                </div>
              </div>
            )}
          </div>
        </section>

        {/* Maintenance Section */}
        <section className="break-inside-avoid space-y-3 mb-4 sm:mb-8">
          <div className="flex items-center gap-2 text-zinc-400 font-bold uppercase tracking-widest text-xs">
            <RefreshCw size={14} /> Maintenance
          </div>

          <div className="bg-[#121215] border border-white/5 rounded-2xl p-6 space-y-4 shadow-xl">
            <p className="text-sm text-zinc-400 leading-relaxed">
              These preferences are persisted in your local environment. Resetting will revert all UI aesthetics to factory defaults.
            </p>
            <button
              onClick={() => {
                if(window.confirm('Reset all UI customizations?')) {
                  setSettings((s: any) => ({ ...s, primaryColor: '#60a5fa', backgroundColor: '#0a0a0c', terminalFontSize: 14, enableMonitoring: true }));
                }
              }}
              className="px-4 h-9 bg-zinc-900 border border-white/5 text-zinc-300 rounded-xl text-xs font-bold uppercase hover:bg-white/5 transition-all w-full"
            >
              Reset to Defaults
            </button>
          </div>
        </section>
      </div>
      <CloudPanel isOpen={cloudOpen} onClose={() => setCloudOpen(false)} onLocalProfilesChanged={() => {}} />
    </div>
  );
};

export default SettingsPanel;
