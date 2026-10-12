import type { Server as ServerRecord, Folder } from "../types";
import type { AppSettings, SetAppSettings } from "../types.settings";
import { SettingsFileLinkTypes } from "./SettingsFileLinkTypes";
import { SettingsRdpMode } from "./SettingsRdpMode";
import { FEATURES, FEATURE_FLAGS_CHANGED_EVENT, isFeatureEnabled, setFeatureEnabled, type FeatureKey } from "../featureFlags";
import { buildBackup, parseBackup, applyBackup } from "../settingsBackup";
import { saveTextFile } from "../terminal/saveFile";
import { isSettingChanged, resetSetting, pageHasChanges, resetPage, resetAllSettings, type ResettablePage } from "../settingsDefaults";
import { useState, useEffect, createContext, useContext, type ComponentProps } from "react";
import { invoke } from "@tauri-apps/api/core";
import { IS_MOBILE_OS } from "../util/platform";
import { toExportableServers, serversToJson, serversToCsv } from "../export/serverExport";
import {
  Settings, Palette, RefreshCw, List, Cloud, User,
  ArrowLeft, Activity, Server, ArrowUp, ArrowDown, Trash2,
  Plus, Terminal, ChevronRight, Lock, ShieldCheck,
  Download, X, SlidersHorizontal, ToggleRight, Search,
} from "lucide-react";
import { lazy, Suspense } from "react";
const CloudPanel = lazy(() => import("./CloudPanel"));
import { SettingsProfileManagement } from "./SettingsProfileManagement";
import { SettingsKeyboardShortcuts } from "./SettingsKeyboardShortcuts";
import { SettingsQuickCommands } from "./SettingsQuickCommands";
import { SettingsCloudSync } from "./SettingsCloudSync";
import { SettingsKnownHosts } from "./SettingsKnownHosts";
import { TERMINAL_THEMES, FONT_FAMILY_PRESETS, SCROLLBACK_PRESETS, getAllTerminalThemes, saveCustomThemes, getCustomThemes, TerminalThemeConfig } from "../terminal/themes";
import { TerminalTrigger, TriggerAction, getTerminalTriggers, saveTerminalTriggers, newTrigger } from "../terminal/triggers";

type CategoryId = "general" | "appearance" | "terminal" | "features" | "quick" | "accounts" | "system";

interface Category {
  id: CategoryId;
  label: string;
  icon: React.ReactNode;
  description: string;
}

// Categories that require the vault to be unlocked before use.
// "quick" is not listed: its keyboard-shortcuts tab works while locked, and the page gates its other tabs itself.
const LOCKED_CATEGORIES: CategoryId[] = ["accounts", "system"];

const CATEGORIES: Category[] = [
  { id: "general",       label: "General",            icon: <SlidersHorizontal size={16} />, description: "Startup and remote desktop" },
  { id: "appearance",    label: "Appearance",        icon: <Palette size={16} />,     description: "Colors, fonts, and terminal theme" },
  { id: "terminal",      label: "Terminal",           icon: <Terminal size={16} />,    description: "Mouse, clipboard, sessions, triggers" },
  { id: "features",      label: "Features",           icon: <ToggleRight size={16} />, description: "Turn optional features on or off" },
  { id: "quick",         label: "Quick Access",       icon: <Server size={16} />,      description: "Pinned servers, quick commands, keyboard shortcuts" },
  { id: "accounts",      label: "Accounts & Sync",    icon: <User size={16} />,        description: "Profiles, cloud account and sync" },
  { id: "system",        label: "System",             icon: <ShieldCheck size={16} />, description: "Known hosts, maintenance and the activity log" },
];

// â”€â”€â”€ Reusable primitives â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Lets any Row/SectionCard show a "changed from default" dot that resets it on click.
const SettingsMetaContext = createContext<{ changed: (id: string) => boolean; reset: (id: string) => void }>({
  changed: () => false,
  reset: () => {},
});

const ChangedDot = ({ id }: { id?: string }) => {
  const meta = useContext(SettingsMetaContext);
  if (!id || !meta.changed(id)) return null;
  return (
    <button
      type="button"
      title="Changed from default. Click to reset."
      aria-label="Reset to default"
      onClick={() => meta.reset(id)}
      className="inline-flex items-center justify-center w-3 h-3 ml-2 align-middle"
    >
      <span className="w-1.5 h-1.5 rounded-full bg-primary" />
    </button>
  );
};

const SectionCard = ({ id, title, subtitle, children }: { id?: string; title: string; subtitle?: string; children: React.ReactNode }) => (
  <div data-setting={id} className="bg-[#121215] border border-white/5 rounded-2xl p-6 shadow-xl break-inside-avoid">
    <div className="mb-4">
      <h3 className="text-sm font-bold text-white">{title}<ChangedDot id={id} /></h3>
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

const Row = ({ id, label, desc, children }: { id?: string; label: string; desc?: string; children: React.ReactNode }) => (
  <div data-setting={id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-3 border-b border-white/5 last:border-0">
    <div className="min-w-0">
      <div className="text-sm font-semibold text-zinc-200">{label}<ChangedDot id={id} /></div>
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

type PinnableServer = ServerRecord & { ip?: string };

interface SettingsPageProps {
  settings: AppSettings;
  setSettings: SetAppSettings;
}

interface CloudSyncExtras {
  onSync?: () => Promise<void> | void;
  syncing?: boolean;
  lastSyncLabel?: string | null;
}

interface SettingsPanelProps extends SettingsPageProps, CloudSyncExtras, ComponentProps<typeof SettingsProfileManagement> {
  servers?: ServerRecord[];
  folders?: Folder[];
  isMobile?: boolean;
  onOpenLogs?: () => void;
  onOpenMonitor?: () => void;
  onClose?: () => void;
}

const PageAppearance = ({ settings, setSettings }: SettingsPageProps) => (
  <>
    <SectionCard id="accent" title="Primary Accent Color">
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
    {!IS_MOBILE_OS && (
      <SectionCard id="ui-zoom" title="Interface Zoom" subtitle="Scales the whole window, menus and terminal included. Useful on high-resolution or small screens.">
        <Row id="ui-zoom-row" label="Zoom level">
          <select
            value={settings.uiZoom ?? 100}
            onChange={(e) => setSettings({ ...settings, uiZoom: parseInt(e.target.value, 10) || 100 })}
            className="bg-black/60 border border-white/10 text-white rounded-lg px-2.5 py-1 text-xs outline-none focus:border-primary/50"
          >
            {[80, 90, 100, 110, 125, 150, 175].map((z) => <option key={z} value={z}>{z}%{z === 100 ? " (default)" : ""}</option>)}
          </select>
        </Row>
      </SectionCard>
    )}
    <SectionCard id="accessibility" title="Accessibility">
      <Row id="reduce-motion" label="Reduce motion" desc="Turns off slide and fade animations and transitions. Loading spinners and the cursor blink stay. System follows your operating system setting.">
        <select
          value={settings.reduceMotion || "system"}
          onChange={(e) => setSettings({ ...settings, reduceMotion: e.target.value })}
          className="bg-black/60 border border-white/10 text-white rounded-lg px-2.5 py-1 text-xs outline-none focus:border-primary/50"
        >
          <option value="system">Follow system (default)</option>
          <option value="on">Always reduce</option>
          <option value="off">Never reduce</option>
        </select>
      </Row>
    </SectionCard>
    <SectionCard id="quick-editor" title="Quick Editor" subtitle="For files opened in the built-in editor. Changes apply the next time you open a file.">
      <Row id="editor-font-size" label="Font size">
        <select
          value={settings.editorFontSize ?? 12}
          onChange={(e) => setSettings({ ...settings, editorFontSize: parseInt(e.target.value, 10) || 12 })}
          className="bg-black/60 border border-white/10 text-white rounded-lg px-2.5 py-1 text-xs outline-none focus:border-primary/50"
        >
          {[10, 11, 12, 13, 14, 16, 18, 20].map((n) => <option key={n} value={n}>{n} px{n === 12 ? " (default)" : ""}</option>)}
        </select>
      </Row>
      <Row id="editor-tab-size" label="Tab width">
        <select
          value={settings.editorTabSize ?? 4}
          onChange={(e) => setSettings({ ...settings, editorTabSize: parseInt(e.target.value, 10) || 4 })}
          className="bg-black/60 border border-white/10 text-white rounded-lg px-2.5 py-1 text-xs outline-none focus:border-primary/50"
        >
          {[2, 3, 4, 8].map((n) => <option key={n} value={n}>{n} spaces{n === 4 ? " (default)" : ""}</option>)}
        </select>
      </Row>
      <Row id="editor-word-wrap" label="Wrap long lines" desc="Off keeps one line per row and scrolls sideways">
        <Toggle checked={!!settings.editorWordWrap} onChange={() => setSettings({ ...settings, editorWordWrap: !settings.editorWordWrap })} />
      </Row>
    </SectionCard>
    <SectionCard id="background" title="Background Theme">
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
  </>
);

type TerminalPart = "appearance" | "general" | "terminal" | "features";

const PageTerminal = ({ settings, setSettings, part, onOpenMonitor }: SettingsPageProps & { part: TerminalPart; onOpenMonitor?: () => void }) => {
  const [themesList, setThemesList] = useState<TerminalThemeConfig[]>(getAllTerminalThemes());
  const [flags, setFlags] = useState<Record<FeatureKey, boolean>>(() =>
    Object.fromEntries(FEATURES.map((f) => [f.key, isFeatureEnabled(f.key)])) as Record<FeatureKey, boolean>,
  );
  useEffect(() => {
    const sync = () => setFlags(Object.fromEntries(FEATURES.map((f) => [f.key, isFeatureEnabled(f.key)])) as Record<FeatureKey, boolean>);
    window.addEventListener(FEATURE_FLAGS_CHANGED_EVENT, sync);
    return () => window.removeEventListener(FEATURE_FLAGS_CHANGED_EVENT, sync);
  }, []);
  // Start on login: the OS holds this state, so it is read from the backend rather than stored as a setting.
  const [autostart, setAutostart] = useState<boolean | null>(null);
  const [autostartErr, setAutostartErr] = useState<string | null>(null);
  useEffect(() => {
    if (part !== 'general' || IS_MOBILE_OS) return;
    invoke<boolean>('get_autostart').then((v) => setAutostart(v === true)).catch(() => setAutostart(null));
  }, [part]);
  const toggleAutostart = async () => {
    const next = !(autostart === true);
    setAutostartErr(null);
    try {
      await invoke('set_autostart', { enabled: next });
      setAutostart(next);
    } catch (e) {
      setAutostartErr(String(e));
    }
  };
  const [localShells, setLocalShells] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    if (part !== 'general' || IS_MOBILE_OS) return;
    invoke<{ id: string; name: string }[]>('get_available_local_shells').then(setLocalShells).catch(() => setLocalShells([]));
  }, [part]);
  const [historyMsg, setHistoryMsg] = useState<string | null>(null);
  const clearHistory = async () => {
    if (!window.confirm("Delete all saved command history? This cannot be undone.")) return;
    try {
      await invoke("cmd_history_clear");
      setHistoryMsg("Command history cleared.");
    } catch (e) {
      setHistoryMsg(`Could not clear history: ${e}`);
    }
  };
  const [backupMsg, setBackupMsg] = useState<{ text: string; tone: "ok" | "err" } | null>(null);
  const exportPrefs = async () => {
    try {
      const day = new Date().toISOString().slice(0, 10);
      const path = await saveTextFile(JSON.stringify(buildBackup(), null, 2), `subterm-preferences-${day}`, "json");
      if (path) setBackupMsg({ text: "Preferences exported.", tone: "ok" });
    } catch (e) {
      setBackupMsg({ text: `Export failed: ${e}`, tone: "err" });
    }
  };
  const importPrefs = async (file: File | undefined) => {
    if (!file) return;
    const parsed = parseBackup(await file.text());
    if (!parsed.ok) { setBackupMsg({ text: parsed.error, tone: "err" }); return; }
    const n = Object.keys(parsed.backup.prefs).length;
    if (!window.confirm(`Replace your current preferences with the ${n} saved in this file? SubTerm will reload.`)) return;
    const { applied, skipped } = applyBackup(parsed.backup);
    setBackupMsg({ text: `Imported ${applied} preference${applied === 1 ? "" : "s"}${skipped ? `, skipped ${skipped}` : ""}. Reloading...`, tone: "ok" });
    window.setTimeout(() => window.location.reload(), 600);
  };
  const [importThemeModal, setImportThemeModal] = useState(false);
  const [importThemeText, setImportThemeText] = useState("");
  const [importThemeError, setImportThemeError] = useState("");
  const [triggers, setTriggers] = useState<TerminalTrigger[]>(getTerminalTriggers());

  const updateTriggers = (next: TerminalTrigger[]) => {
    setTriggers(next);
    saveTerminalTriggers(next);
  };
  const updateTrigger = (id: string, patch: Partial<TerminalTrigger>) => {
    updateTriggers(triggers.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  };
  const [copiedThemeToast, setCopiedThemeToast] = useState(false);

  const currentThemeId = settings.terminalTheme || 'subterm-dark';
  const currentTheme = themesList.find((t) => t.id === currentThemeId) || themesList[0] || TERMINAL_THEMES[0];
  const currentFont = settings.terminalFontFamily || 'JetBrains Mono, Menlo, Monaco, Consolas, "Courier New", monospace';
  const matchingPreset = FONT_FAMILY_PRESETS.find((p) => p.value && p.value === currentFont);
  const selectedPresetId = matchingPreset ? matchingPreset.id : "custom";

  const handleImportTheme = () => {
    try {
      const parsed = JSON.parse(importThemeText.trim());
      const themeObj = parsed.theme || parsed;
      const themeName = parsed.name || `Custom Theme ${themesList.length + 1}`;
      const bg = themeObj.background || "#09090b";
      const fg = themeObj.foreground || "#e4e4e7";
      const accent1 = themeObj.cursor || themeObj.blue || "#60a5fa";
      const accent2 = themeObj.green || "#34d399";
      const newId = `custom-${Date.now()}`;
      const newConfig: TerminalThemeConfig = {
        id: newId,
        name: `${themeName} (Custom)`,
        previewColors: [bg, fg, accent1, accent2],
        theme: themeObj,
      };
      const existing = getCustomThemes();
      const updated = [...existing, newConfig];
      saveCustomThemes(updated);
      const all = getAllTerminalThemes();
      setThemesList(all);
      setSettings({ ...settings, terminalTheme: newId });
      setImportThemeModal(false);
      setImportThemeText("");
      setImportThemeError("");
    } catch (e) {
      setImportThemeError(`Invalid JSON: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const featureExtras: Partial<Record<FeatureKey, React.ReactNode>> = {
    terminalFileLinks: (
      <div data-setting="file-types" className="py-2">
        <div className="text-xs text-zinc-500 mb-2">Which file names in terminal output can be clicked to open in the editor.</div>
        <SettingsFileLinkTypes />
      </div>
    ),
    sshDetect: (
      <Row id="ssh-mode" label="When you type ssh / sftp" desc="Ask first, or open a matching saved server straight away. Either way the shell's own ssh is stopped.">
        <select
          value={settings.sshDetectMode || 'prompt'}
          onChange={(e) => setSettings({ ...settings, sshDetectMode: e.target.value })}
          className="bg-black/60 border border-white/10 text-white rounded-lg px-2.5 py-1 text-xs outline-none focus:border-primary/50"
        >
          <option value="prompt">Ask First</option>
          <option value="auto">Open Saved Servers Automatically</option>
        </select>
      </Row>
    ),
  };

  return (
    <>
      {part === 'appearance' && (
        <>
      <SectionCard id="display" title="Display & Theme">
        <Row id="theme" label="Color Scheme / Theme" desc="Curated palette, custom themes, and full ANSI 16-color theme for terminal sessions">
          <div className="flex items-center gap-2 flex-wrap">
            <div className="flex items-center gap-1 p-1 bg-black/40 rounded-md border border-white/10" title="Palette preview">
              {currentTheme.previewColors.map((color, i) => (
                <span key={i} className="w-3.5 h-3.5 rounded-sm" style={{ backgroundColor: color }} />
              ))}
            </div>
            <select
              value={currentThemeId}
              onChange={(e) => setSettings({ ...settings, terminalTheme: e.target.value })}
              className="bg-black/60 border border-white/10 text-white rounded-lg px-2.5 py-1 text-xs outline-none focus:border-primary/50"
            >
              {themesList.map((theme) => (
                <option key={theme.id} value={theme.id}>
                  {theme.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => {
                navigator.clipboard.writeText(JSON.stringify(currentTheme.theme, null, 2));
                setCopiedThemeToast(true);
                setTimeout(() => setCopiedThemeToast(false), 2000);
              }}
              className="p-1.5 rounded-md bg-white/5 border border-white/10 hover:bg-white/10 text-zinc-300 hover:text-white transition-colors"
              title="Copy current theme JSON to clipboard"
            >
              <Download size={13} />
            </button>
            <button
              type="button"
              onClick={() => {
                setImportThemeText("");
                setImportThemeError("");
                setImportThemeModal(true);
              }}
              className="p-1.5 rounded-md bg-white/5 border border-white/10 hover:bg-white/10 text-sky-400 hover:text-sky-300 transition-colors"
              title="Import theme from JSON"
            >
              <Plus size={13} />
            </button>
            {currentThemeId.startsWith("custom-") && (
              <button
                type="button"
                onClick={() => {
                  const updated = getCustomThemes().filter((t) => t.id !== currentThemeId);
                  saveCustomThemes(updated);
                  const all = getAllTerminalThemes();
                  setThemesList(all);
                  setSettings({ ...settings, terminalTheme: "subterm-dark" });
                }}
                className="p-1.5 rounded-md bg-rose-500/10 border border-rose-500/20 hover:bg-rose-500/20 text-rose-400 transition-colors"
                title="Delete this custom theme"
              >
                <Trash2 size={13} />
              </button>
            )}
            {copiedThemeToast && (
              <span className="text-[10px] text-emerald-400 font-mono">Copied JSON!</span>
            )}
          </div>
        </Row>
        <Row id="font" label="Font Family" desc="Typography typeface preset or custom font stack">
          <div className="flex flex-col sm:flex-row items-end sm:items-center gap-2">
            <select
              value={selectedPresetId}
              onChange={(e) => {
                const val = e.target.value;
                if (val !== "custom") {
                  const preset = FONT_FAMILY_PRESETS.find((p) => p.id === val);
                  if (preset) {
                    setSettings({ ...settings, terminalFontFamily: preset.value });
                  }
                }
              }}
              className="bg-black/60 border border-white/10 text-white rounded-lg px-2.5 py-1 text-xs outline-none focus:border-primary/50"
            >
              {FONT_FAMILY_PRESETS.map((preset) => (
                <option key={preset.id} value={preset.id}>
                  {preset.name}
                </option>
              ))}
            </select>
            {selectedPresetId === "custom" && (
              <input
                type="text"
                placeholder='e.g. "Operator Mono", monospace'
                value={currentFont}
                onChange={(e) => setSettings({ ...settings, terminalFontFamily: e.target.value })}
                className="w-48 bg-black/60 border border-white/10 text-white rounded-lg px-2 py-1 text-xs outline-none focus:border-primary/50 font-mono"
              />
            )}
          </div>
        </Row>
        <Row id="font-size" label="Font Size (px)" desc="Terminal character size in pixels">
          <div className="flex items-center gap-3">
            <input type="range" min="8" max="24" value={settings.terminalFontSize || 14} onChange={(e) => setSettings({ ...settings, terminalFontSize: parseInt(e.target.value) || 14 })} className="w-32 accent-primary" />
            <input type="number" value={settings.terminalFontSize || 14} onChange={(e) => setSettings({ ...settings, terminalFontSize: parseInt(e.target.value) || 14 })} className="w-14 h-8 bg-black border border-white/10 rounded-lg px-2 text-[12px] font-bold text-white focus:border-primary/50 outline-none text-center" />
          </div>
        </Row>
        <Row id="line-height" label="Line Height" desc="Vertical line spacing ratio for terminal characters">
          <div className="flex items-center gap-3">
            <input
              type="range"
              min="1.0"
              max="1.6"
              step="0.05"
              value={settings.terminalLineHeight || 1.15}
              onChange={(e) => setSettings({ ...settings, terminalLineHeight: parseFloat(e.target.value) || 1.15 })}
              className="w-32 accent-primary"
            />
            <span className="w-12 text-center text-xs font-mono font-semibold text-zinc-300 bg-black/40 border border-white/10 rounded px-1.5 py-1">
              {(settings.terminalLineHeight || 1.15).toFixed(2)}x
            </span>
          </div>
        </Row>
        <Row id="scrollback" label="Scrollback Buffer" desc="Historical terminal lines retained in memory per session">
          <select
            value={settings.terminalScrollback || 5000}
            onChange={(e) => setSettings({ ...settings, terminalScrollback: parseInt(e.target.value, 10) || 5000 })}
            className="bg-black/60 border border-white/10 text-white rounded-lg px-2.5 py-1 text-xs outline-none focus:border-primary/50"
          >
            {SCROLLBACK_PRESETS.map((preset) => (
              <option key={preset.value} value={preset.value}>
                {preset.label}
              </option>
            ))}
          </select>
        </Row>
        <Row id="cursor-style" label="Cursor Style" desc="Visual shape of the terminal cursor">
          <select
            value={settings.terminalCursorStyle || 'block'}
            onChange={(e) => setSettings({ ...settings, terminalCursorStyle: e.target.value })}
            className="bg-black/60 border border-white/10 text-white rounded-lg px-2.5 py-1 text-xs outline-none focus:border-primary/50"
          >
            <option value="block">Block</option>
            <option value="underline">Underline</option>
            <option value="bar">Bar (Vertical Line)</option>
          </select>
        </Row>
        <Row id="cursor-color" label="Cursor Colour" desc="Override the theme's cursor colour">
          <div className="flex items-center gap-2">
            <input
              type="color"
              value={/^#[0-9a-f]{6}$/i.test(settings.terminalCursorColor || "") ? settings.terminalCursorColor : "#ffffff"}
              onChange={(e) => setSettings({ ...settings, terminalCursorColor: e.target.value })}
              className="w-6 h-6 rounded-md bg-transparent cursor-pointer border-none p-0"
            />
            <button
              type="button"
              disabled={!settings.terminalCursorColor}
              onClick={() => setSettings({ ...settings, terminalCursorColor: "" })}
              className="px-2 h-6 rounded text-[10px] font-bold text-zinc-400 hover:text-white disabled:opacity-40"
            >
              {settings.terminalCursorColor ? "Use theme colour" : "Theme colour"}
            </button>
          </div>
        </Row>
        <Row id="terminal-padding" label="Terminal Padding" desc="Space between the window edge and the text">
          <select
            value={settings.terminalPadding ?? 0}
            onChange={(e) => setSettings({ ...settings, terminalPadding: parseInt(e.target.value, 10) || 0 })}
            className="bg-black/60 border border-white/10 text-white rounded-lg px-2.5 py-1 text-xs outline-none focus:border-primary/50"
          >
            {[0, 4, 8, 12, 16, 24].map((px) => <option key={px} value={px}>{px === 0 ? "None" : `${px} px`}</option>)}
          </select>
        </Row>
        <Row id="cursor-blink" label="Cursor Blinking" desc="Animate cursor blinking when the terminal is focused">
          <Toggle
            checked={settings.terminalCursorBlink !== false}
            onChange={() => setSettings({ ...settings, terminalCursorBlink: settings.terminalCursorBlink === false ? true : false })}
          />
        </Row>
        <Row id="webgl" label="WebGL Hardware Acceleration" desc="Enable GPU-accelerated rendering for 60fps throughput and lower CPU usage">
          <Toggle
            checked={settings.terminalWebgl !== false}
            onChange={() => {
              const next = settings.terminalWebgl === false;
              setSettings({ ...settings, terminalWebgl: next });
              localStorage.setItem('subterm-terminal-webgl', next ? 'true' : 'false');
            }}
          />
        </Row>
        <Row id="bell" label="Terminal Bell" desc="Notification style when an ASCII bell (\a or BEL) is emitted by the shell">
          <select
            value={settings.terminalBell || 'visual'}
            onChange={(e) => setSettings({ ...settings, terminalBell: e.target.value })}
            className="bg-black/60 border border-white/10 text-white rounded-lg px-2.5 py-1 text-xs outline-none focus:border-primary/50"
          >
            <option value="visual">Visual Flash (Screen Glow)</option>
            <option value="audio">Audible Chime (Web Audio)</option>
            <option value="both">Both (Visual & Audible)</option>
            <option value="none">Disabled (Mute)</option>
          </select>
        </Row>
      </SectionCard>

      {/* Import Theme Modal */}
      {importThemeModal && (
        <div
          className="fixed inset-0 z-[9999] bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 animate-in fade-in"
          onClick={() => setImportThemeModal(false)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-md bg-[#121215] border border-white/10 rounded-2xl shadow-2xl p-5 space-y-3 font-sans text-xs"
          >
            <div className="flex items-center justify-between border-b border-white/5 pb-2.5">
              <span className="font-bold text-white text-sm">Import Terminal Theme</span>
              <button onClick={() => setImportThemeModal(false)} className="text-zinc-400 hover:text-white">
                <X size={14} />
              </button>
            </div>
            <p className="text-[11px] text-zinc-400">
              Paste xterm.js theme JSON or Windows Terminal / Alacritty theme colors:
            </p>
            <textarea
              autoFocus
              rows={8}
              value={importThemeText}
              onChange={(e) => setImportThemeText(e.target.value)}
              placeholder={`{\n  "name": "My Custom Theme",\n  "background": "#1e1e2e",\n  "foreground": "#cdd6f4",\n  "cursor": "#f5e0dc",\n  "black": "#45475a",\n  "red": "#f38ba8"\n}`}
              className="w-full p-2.5 bg-black/50 border border-white/10 rounded-lg text-white font-mono text-[11px] outline-none focus:border-sky-400/50"
            />
            {importThemeError && (
              <p className="text-[11px] text-rose-400 font-mono">{importThemeError}</p>
            )}
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setImportThemeModal(false)}
                className="px-3 py-1.5 rounded-lg border border-white/10 text-zinc-400 hover:text-white"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleImportTheme}
                disabled={!importThemeText.trim()}
                className="px-4 py-1.5 rounded-lg bg-sky-500 hover:bg-sky-400 disabled:opacity-50 text-zinc-950 font-bold"
              >
                Import Theme
              </button>
            </div>
          </div>
        </div>
      )}

        </>
      )}

      {part === 'general' && (
        <>
          <SectionCard id="startup" title="Startup">
            <Row id="startup-view" label="On Startup" desc="What opens after you unlock a profile. Servers marked Autostart always open first.">
              <select
                value={settings.startupView || 'servers'}
                onChange={(e) => setSettings({ ...settings, startupView: e.target.value })}
                className="bg-black/60 border border-white/10 text-white rounded-lg px-2.5 py-1 text-xs outline-none focus:border-primary/50"
              >
                <option value="servers">Server List</option>
                <option value="last">Reopen Last Session</option>
                {!IS_MOBILE_OS && <option value="local">New Local Terminal</option>}
              </select>
            </Row>
            {!IS_MOBILE_OS && autostart !== null && (
              <Row id="autostart" label="Start when I sign in" desc="Launch SubTerm automatically when you sign in to this computer. It opens to the unlock screen.">
                <Toggle checked={autostart === true} onChange={() => { void toggleAutostart(); }} />
              </Row>
            )}
            {autostartErr && <p role="alert" className="text-[11px] text-rose-400 pb-2">{autostartErr}</p>}
            {!IS_MOBILE_OS && (
              <Row id="local-shell" label="Default local shell" desc="Opened by the Local item and Ctrl+Alt+T. Automatic picks PowerShell 7, else Windows PowerShell (or $SHELL on macOS/Linux).">
                <select
                  value={settings.localShell || ''}
                  onChange={(e) => setSettings({ ...settings, localShell: e.target.value })}
                  className="bg-black/60 border border-white/10 text-white rounded-lg px-2.5 py-1 text-xs outline-none focus:border-primary/50"
                >
                  <option value="">Automatic</option>
                  {localShells.map((sh) => <option key={sh.id} value={sh.id}>{sh.name}</option>)}
                </select>
              </Row>
            )}
          </SectionCard>
          <SectionCard id="backup" title="Backup & Restore" subtitle="Preferences live only on this computer. Export them to move to another install or keep a copy. Servers, credentials and keys are not included; use Maintenance and Profiles for those.">
            <Row id="backup-actions" label="Preferences file" desc="A small JSON file. Machine-bound items such as biometric unlock and pinned server ids are left out.">
              <div className="flex items-center gap-2">
                <button type="button" onClick={() => { void exportPrefs(); }} className="px-3 h-8 rounded-lg bg-primary/10 border border-primary/30 text-primary text-xs font-bold hover:bg-primary/20">Export</button>
                <label className="px-3 h-8 rounded-lg border border-white/15 text-zinc-200 text-xs font-bold hover:bg-white/10 inline-flex items-center cursor-pointer">
                  Import
                  <input type="file" accept="application/json,.json" className="hidden" onChange={(e) => { void importPrefs(e.target.files?.[0]); e.target.value = ""; }} />
                </label>
              </div>
            </Row>
            {backupMsg && <p role="status" className={`text-[11px] mt-2 ${backupMsg.tone === "err" ? "text-rose-400" : "text-emerald-400"}`}>{backupMsg.text}</p>}
          </SectionCard>

          <SectionCard id="security" title="Security" subtitle="Locking closes the vault and disconnects open SSH sessions; local terminals stay open.">
            <Row id="auto-lock" label="Auto-lock when idle" desc="Lock after this long without mouse or keyboard input. Output arriving in a terminal does not count as activity.">
              <select
                value={settings.autoLockMin ?? 0}
                onChange={(e) => setSettings({ ...settings, autoLockMin: parseInt(e.target.value, 10) || 0 })}
                className="bg-black/60 border border-white/10 text-white rounded-lg px-2.5 py-1 text-xs outline-none focus:border-primary/50"
              >
                <option value={0}>Never</option>
                {[1, 5, 10, 15, 30, 60].map((m) => <option key={m} value={m}>{m} minute{m === 1 ? "" : "s"}</option>)}
              </select>
            </Row>
            <Row id="lock-on-minimize" label="Lock when the window is hidden" desc="Lock as soon as SubTerm is minimised or covered by the system.">
              <Toggle checked={!!settings.lockOnMinimize} onChange={() => setSettings({ ...settings, lockOnMinimize: !settings.lockOnMinimize })} />
            </Row>
            <Row id="confirm-on-close" label="Confirm before closing" desc="Ask before the window closes while sessions are open, since closing disconnects them and stops transfers.">
              <Toggle checked={settings.confirmOnClose !== false} onChange={() => setSettings({ ...settings, confirmOnClose: settings.confirmOnClose === false })} />
            </Row>
            <Row id="clear-clipboard" label="Clear clipboard on lock" desc="Empty the clipboard when the vault locks. Best effort: the system only allows it while SubTerm has focus.">
              <Toggle checked={!!settings.clearClipboardOnLock} onChange={() => setSettings({ ...settings, clearClipboardOnLock: !settings.clearClipboardOnLock })} />
            </Row>
          </SectionCard>
          <SectionCard id="monitoring" title="Resource Monitoring">
            <Row id="enable-monitoring" label="Enable monitoring" desc="Show the Monitor page and poll CPU, RAM, disk and outages in the background.">
              <Toggle checked={settings.enableMonitoring !== false} onChange={() => setSettings({ ...settings, enableMonitoring: !(settings.enableMonitoring !== false) })} />
            </Row>
            {settings.enableMonitoring !== false && onOpenMonitor && (
              <Row label="Polling and alerts" desc="Interval, timeouts, outage threshold, notifications and beep are set on the Monitor page.">
                <button type="button" onClick={onOpenMonitor} className="px-3 h-8 rounded-lg bg-primary/10 border border-primary/30 text-primary text-xs font-bold hover:bg-primary/20">
                  Open Monitor
                </button>
              </Row>
            )}
          </SectionCard>
      <SectionCard id="rdp" title="Remote Desktop (RDP)" subtitle="Where RDP servers open when you click them.">
        <SettingsRdpMode />
      </SectionCard>

        </>
      )}

      {part === 'terminal' && (
        <>
          <SectionCard id="mouse" title="Mouse & Clipboard">
            <Row id="right-click" label="Right-Click" desc="Smart copies a selection, otherwise pastes. Shift+Right-Click always opens the menu.">
              <select
                value={settings.rightClickAction || 'smart'}
                onChange={(e) => setSettings({ ...settings, rightClickAction: e.target.value })}
                className="bg-black/60 border border-white/10 text-white rounded-lg px-2.5 py-1 text-xs outline-none focus:border-primary/50"
              >
                <option value="smart">Smart: Copy Selection, Else Paste</option>
                <option value="menu">Open Context Menu</option>
                <option value="paste">Paste Immediately (PuTTY style)</option>
              </select>
            </Row>
            <Row id="copy-on-select" label="Copy on select" desc="Copy highlighted text to the clipboard automatically">
              <Toggle
                checked={settings.copyOnSelect !== false}
                onChange={() => setSettings({ ...settings, copyOnSelect: settings.copyOnSelect === false ? true : false })}
              />
            </Row>
            <Row id="open-links" label="Open Links" desc="How URLs and file paths in output are opened (touch devices always tap)">
              <select
                value={settings.linkOpenMode || 'ctrl-click'}
                onChange={(e) => setSettings({ ...settings, linkOpenMode: e.target.value })}
                className="bg-black/60 border border-white/10 text-white rounded-lg px-2.5 py-1 text-xs outline-none focus:border-primary/50"
              >
                <option value="ctrl-click">Ctrl/Cmd + Click</option>
                <option value="click">Plain Click</option>
              </select>
            </Row>
            <Row id="paste-review" label="Review multi-line paste" desc="Ask before pasting this many lines or more (guards against pasting a script by accident)">
              <select
                value={settings.pasteReviewLines ?? 3}
                onChange={(e) => setSettings({ ...settings, pasteReviewLines: parseInt(e.target.value, 10) || 0 })}
                className="bg-black/60 border border-white/10 text-white rounded-lg px-2.5 py-1 text-xs outline-none focus:border-primary/50"
              >
                <option value={0}>Never ask</option>
                {[2, 3, 5, 10, 20].map((n) => <option key={n} value={n}>{n} lines{n === 3 ? " (default)" : ""}</option>)}
              </select>
            </Row>
            <Row id="word-separators" label="Word separators" desc="Characters that end a word when you double-click to select">
              <input
                type="text"
                value={settings.wordSeparators ?? ""}
                onChange={(e) => setSettings({ ...settings, wordSeparators: e.target.value })}
                spellCheck={false}
                aria-label="Word separators"
                className="w-40 h-8 bg-black/60 border border-white/10 rounded-lg px-2 text-xs font-mono text-white outline-none focus:border-primary/50"
              />
            </Row>
            <Row id="scroll-on-input" label="Scroll to bottom on typing" desc="Jump back to the newest output when you type while scrolled up">
              <Toggle checked={settings.scrollOnInput !== false} onChange={() => setSettings({ ...settings, scrollOnInput: settings.scrollOnInput === false })} />
            </Row>
            <Row id="auto-copy-output" label="Auto-copy command output" desc="Copy a command's output to the clipboard when it finishes">
              <Toggle checked={!!settings.autoCopyOutput} onChange={() => setSettings({ ...settings, autoCopyOutput: !settings.autoCopyOutput })} />
            </Row>
          </SectionCard>

          <SectionCard id="sessions" title="Sessions">
            <Row id="auto-close" label="Auto-close tab on exit" desc="Close the tab when the shell exits">
              <Toggle checked={!!settings.autoCloseOnExit} onChange={() => setSettings({ ...settings, autoCloseOnExit: !settings.autoCloseOnExit })} />
            </Row>
            <Row id="audit-download" label="Download audit on exit" desc="Save a transcript when the session ends">
              <Toggle checked={!!settings.downloadAuditOnExit} onChange={() => setSettings({ ...settings, downloadAuditOnExit: !settings.downloadAuditOnExit })} />
            </Row>
          </SectionCard>

          <SectionCard id="ssh-connection" title="SSH Connection">
            <Row id="keepalive" label="SSH Keep-Alive" desc="Ping interval that stops NAT and firewalls from dropping idle connections">
              <select
                value={settings.sshKeepaliveSec || 20}
                onChange={(e) => setSettings({ ...settings, sshKeepaliveSec: parseInt(e.target.value, 10) || 20 })}
                className="bg-black/60 border border-white/10 text-white rounded-lg px-2.5 py-1 text-xs outline-none focus:border-primary/50"
              >
                <option value={10}>10 seconds (aggressive NATs)</option>
                <option value={20}>20 seconds (recommended)</option>
                <option value={30}>30 seconds</option>
                <option value={60}>60 seconds (relaxed)</option>
                <option value={0}>Disabled</option>
              </select>
            </Row>
            <Row id="host-key-policy" label="Unknown host keys" desc="Ask lets you trust a new key once. Strict refuses any server whose key is not already trusted, so nothing new is trusted by accident; connect once in Ask mode to add a server.">
              <select
                value={settings.hostKeyPolicy === "strict" ? "strict" : "ask"}
                onChange={(e) => setSettings({ ...settings, hostKeyPolicy: e.target.value })}
                className="bg-black/60 border border-white/10 text-white rounded-lg px-2.5 py-1 text-xs outline-none focus:border-primary/50"
              >
                <option value="ask">Ask me (default)</option>
                <option value="strict">Refuse (strict)</option>
              </select>
            </Row>
            <Row id="connect-timeout" label="Connection timeout" desc="How long to wait for a server (or its proxy) to accept the TCP connection before giving up">
              <select
                value={settings.sshConnectTimeoutSec ?? 10}
                onChange={(e) => setSettings({ ...settings, sshConnectTimeoutSec: parseInt(e.target.value, 10) || 10 })}
                className="bg-black/60 border border-white/10 text-white rounded-lg px-2.5 py-1 text-xs outline-none focus:border-primary/50"
              >
                {[5, 10, 20, 30, 60].map((n) => <option key={n} value={n}>{n} seconds{n === 10 ? " (default)" : ""}</option>)}
              </select>
            </Row>
            <Row id="reconnect-attempts" label="Auto-reconnect attempts" desc="How many times to retry a dropped session. Applies when auto-reconnect is on (Features).">
              <select
                value={settings.reconnectMaxAttempts ?? 0}
                onChange={(e) => setSettings({ ...settings, reconnectMaxAttempts: parseInt(e.target.value, 10) || 0 })}
                className="bg-black/60 border border-white/10 text-white rounded-lg px-2.5 py-1 text-xs outline-none focus:border-primary/50"
              >
                <option value={0}>Keep trying (default)</option>
                {[3, 5, 10, 30, 100].map((n) => <option key={n} value={n}>{n} attempts</option>)}
              </select>
            </Row>
            <Row id="reconnect-delay" label="Longest wait between retries" desc="Retries start at 2 s and double up to this limit">
              <select
                value={settings.reconnectMaxDelaySec ?? 30}
                onChange={(e) => setSettings({ ...settings, reconnectMaxDelaySec: parseInt(e.target.value, 10) || 30 })}
                className="bg-black/60 border border-white/10 text-white rounded-lg px-2.5 py-1 text-xs outline-none focus:border-primary/50"
              >
                {[5, 10, 30, 60, 120].map((n) => <option key={n} value={n}>{n} seconds{n === 30 ? " (default)" : ""}</option>)}
              </select>
            </Row>
            <Row id="default-port" label="Default port" desc="Prefilled when you add a server">
              <input
                type="number"
                min={1}
                max={65535}
                value={settings.defaultSshPort ?? 22}
                onChange={(e) => setSettings({ ...settings, defaultSshPort: Math.min(65535, Math.max(1, parseInt(e.target.value, 10) || 22)) })}
                className="w-24 h-8 bg-black/60 border border-white/10 rounded-lg px-2 text-xs text-white text-center outline-none focus:border-primary/50"
              />
            </Row>
            <Row id="default-user" label="Default username" desc="Prefilled when you add a server (leave empty to use none)">
              <input
                type="text"
                value={settings.defaultSshUser ?? ""}
                onChange={(e) => setSettings({ ...settings, defaultSshUser: e.target.value })}
                spellCheck={false}
                aria-label="Default username"
                className="w-40 h-8 bg-black/60 border border-white/10 rounded-lg px-2 text-xs text-white outline-none focus:border-primary/50"
              />
            </Row>
            <Row id="default-agent" label="Forward SSH agent on new servers" desc="Turns agent forwarding on in the add-server form. Only enable it for hosts you fully trust: a forwarded agent lets that host use your keys while you are connected.">
              <Toggle checked={!!settings.defaultAgentForward} onChange={() => setSettings({ ...settings, defaultAgentForward: !settings.defaultAgentForward })} />
            </Row>
          </SectionCard>

          <SectionCard id="notifications" title="Notifications" subtitle="System notifications while SubTerm is in the background. They depend on the system allowing them for this app; the Activity Log records session drops either way.">
            <Row id="notify-long" label="Long command finished" desc="Needs shell integration (the shell must send OSC 133 markers), otherwise SubTerm cannot tell when a command ends.">
              <select
                value={settings.notifyLongCommandSec ?? 0}
                onChange={(e) => setSettings({ ...settings, notifyLongCommandSec: parseInt(e.target.value, 10) || 0 })}
                className="bg-black/60 border border-white/10 text-white rounded-lg px-2.5 py-1 text-xs outline-none focus:border-primary/50"
              >
                <option value={0}>Off (default)</option>
                {[15, 30, 60, 120, 300].map((n) => <option key={n} value={n}>After {n} seconds</option>)}
              </select>
            </Row>
            <Row id="notify-disconnect" label="SSH session lost" desc="Notify when a session drops unexpectedly (not when you disconnect it yourself)">
              <Toggle checked={!!settings.notifyOnDisconnect} onChange={() => setSettings({ ...settings, notifyOnDisconnect: !settings.notifyOnDisconnect })} />
            </Row>
          </SectionCard>

          <SectionCard id="privacy" title="Privacy" subtitle="Command history is the list behind Ctrl+R search. Turn it off entirely under Features. It is stored inside the encrypted vault.">
            <Row id="history-max" label="Keep up to" desc="Older entries are dropped as new ones arrive">
              <select
                value={settings.historyMaxEntries ?? 1000}
                onChange={(e) => setSettings({ ...settings, historyMaxEntries: parseInt(e.target.value, 10) || 1000 })}
                className="bg-black/60 border border-white/10 text-white rounded-lg px-2.5 py-1 text-xs outline-none focus:border-primary/50"
              >
                {[100, 500, 1000, 5000, 10000].map((n) => <option key={n} value={n}>{n.toLocaleString()} commands{n === 1000 ? " (default)" : ""}</option>)}
              </select>
            </Row>
            <Row id="history-days" label="Delete after" desc="Also drop entries older than this">
              <select
                value={settings.historyRetentionDays ?? 0}
                onChange={(e) => setSettings({ ...settings, historyRetentionDays: parseInt(e.target.value, 10) || 0 })}
                className="bg-black/60 border border-white/10 text-white rounded-lg px-2.5 py-1 text-xs outline-none focus:border-primary/50"
              >
                <option value={0}>Never (default)</option>
                {[7, 30, 90, 365].map((n) => <option key={n} value={n}>{n} days</option>)}
              </select>
            </Row>
            <Row id="history-clear" label="Clear history now" desc="Needs the vault to be unlocked">
              <button type="button" onClick={() => { void clearHistory(); }} className="px-3 h-8 rounded-lg border border-rose-500/40 text-rose-300 text-xs font-bold hover:bg-rose-500/10">Clear</button>
            </Row>
            {historyMsg && <p role="status" className="text-[11px] mt-2 text-zinc-400">{historyMsg}</p>}
          </SectionCard>

          <SectionCard id="transfers" title="File Transfers" subtitle="Uploads and downloads run one at a time per session so two transfers never write the same file together.">
            <Row id="overwrite-policy" label="When a file already exists" desc="Ask shows the compare dialog. Skip keeps the existing file. Overwrite replaces it without asking, so use it with care.">
              <select
                value={settings.overwritePolicy || "ask"}
                onChange={(e) => setSettings({ ...settings, overwritePolicy: e.target.value })}
                className="bg-black/60 border border-white/10 text-white rounded-lg px-2.5 py-1 text-xs outline-none focus:border-primary/50"
              >
                <option value="ask">Ask me (default)</option>
                <option value="skip">Skip existing files</option>
                <option value="overwrite">Overwrite existing files</option>
              </select>
            </Row>
          </SectionCard>

          <SectionCard id="command-widget" title="Command Widget">
            <Row label="Auto-dismiss timer (seconds)" desc="How long the floating output pill stays (0 = until closed)">
              <div className="flex items-center gap-3">
                <input type="range" min="0" max="20" value={settings.commandDismissSec !== undefined ? settings.commandDismissSec : 4} onChange={(e) => setSettings({ ...settings, commandDismissSec: Math.max(0, parseInt(e.target.value) || 0) })} className="w-32 accent-primary" />
                <input type="number" min="0" max="30" value={settings.commandDismissSec !== undefined ? settings.commandDismissSec : 4} onChange={(e) => setSettings({ ...settings, commandDismissSec: Math.max(0, parseInt(e.target.value) || 0) })} className="w-14 h-8 bg-black border border-white/10 rounded-lg px-2 text-[12px] font-bold text-white focus:border-primary/50 outline-none text-center" />
              </div>
            </Row>
          </SectionCard>

          <SectionCard id="banner-buttons" title="Session-End Banner Buttons">
            {settings.autoCloseOnExit ? (
              <p className="text-xs text-zinc-500 italic py-2">Disabled because the tab closes automatically on exit.</p>
            ) : (
              <>
                <Row label="Show Copy Output button" desc="Copy Output action on the session-end screen">
                  <Toggle checked={settings.showAuditCopy !== false} onChange={() => setSettings({ ...settings, showAuditCopy: settings.showAuditCopy === false ? true : false })} />
                </Row>
                <Row label="Show Download Audit button" desc="Download Audit action on the session-end screen">
                  <Toggle checked={settings.showAuditDownload !== false} onChange={() => setSettings({ ...settings, showAuditDownload: settings.showAuditDownload === false ? true : false })} />
                </Row>
              </>
            )}
          </SectionCard>
      <SectionCard id="triggers" title="Terminal Triggers & Alert Keywords" subtitle="Match keywords or regex patterns against live terminal output and fire an alert — useful for spotting ERROR/FATAL lines in a session you're not actively watching.">
        {triggers.length === 0 && (
          <p className="text-xs text-zinc-500 italic py-1">No triggers configured yet.</p>
        )}
        <div className="space-y-2">
          {triggers.map((t) => (
            <div key={t.id} className="flex flex-wrap items-center gap-2 bg-black/30 border border-white/10 rounded-lg px-2.5 py-2">
              <Toggle checked={t.enabled} onChange={() => updateTrigger(t.id, { enabled: !t.enabled })} />
              <input
                type="text"
                value={t.pattern}
                onChange={(e) => updateTrigger(t.id, { pattern: e.target.value })}
                placeholder={t.isRegex ? "regex, e.g. (ERROR|FATAL)" : "keyword, e.g. ERROR"}
                className="flex-1 min-w-[140px] bg-black/60 border border-white/10 text-white rounded-lg px-2.5 py-1 text-xs outline-none focus:border-primary/50 font-mono"
              />
              <label className="flex items-center gap-1 text-[10.5px] text-zinc-400 cursor-pointer select-none">
                <input type="checkbox" checked={t.isRegex} onChange={(e) => updateTrigger(t.id, { isRegex: e.target.checked })} className="accent-primary" />
                Regex
              </label>
              <label className="flex items-center gap-1 text-[10.5px] text-zinc-400 cursor-pointer select-none">
                <input type="checkbox" checked={t.caseSensitive} onChange={(e) => updateTrigger(t.id, { caseSensitive: e.target.checked })} className="accent-primary" />
                Case-sensitive
              </label>
              <select
                value={t.action}
                onChange={(e) => updateTrigger(t.id, { action: e.target.value as TriggerAction })}
                className="bg-black/60 border border-white/10 text-white rounded-lg px-2 py-1 text-[10.5px] outline-none focus:border-primary/50"
              >
                <option value="notify">Toast Notification</option>
                <option value="chime">Audible Chime</option>
                <option value="highlight">Visual Flash</option>
                <option value="log">Activity Log Entry</option>
              </select>
              <button
                type="button"
                onClick={() => updateTriggers(triggers.filter((x) => x.id !== t.id))}
                className="p-1.5 rounded-md bg-rose-500/10 text-rose-400 hover:bg-rose-500/20 transition-colors"
                title="Remove trigger"
              >
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </div>
        <button
          type="button"
          onClick={() => updateTriggers([...triggers, newTrigger()])}
          className="mt-3 px-3 py-1.5 rounded-lg bg-primary/10 border border-primary/30 text-primary text-xs font-bold uppercase hover:bg-primary hover:text-zinc-950 transition-all flex items-center gap-1.5"
        >
          <Plus size={13} /> Add Trigger
        </button>
      </SectionCard>

        </>
      )}

      {part === 'features' && (["Editor", "Terminal", "Panels", "AI"] as const).map((group) => {
        const items = FEATURES.filter((f) => f.group === group);
        if (items.length === 0) return null;
        return (
          <SectionCard
            key={group}
            id={`features-${group.toLowerCase()}`}
            title={`${group} features`}
            subtitle={group === "Editor" ? "Turn optional features off to skip loading and running their code. A feature's options sit under it and grey out while it is off. Changes apply immediately." : undefined}
          >
            {items.map((f) => (
              <div key={f.key}>
                <Row id={f.key} label={f.label} desc={f.desc}>
                  <Toggle
                    checked={flags[f.key]}
                    onChange={() => {
                      const next = !flags[f.key];
                      setFeatureEnabled(f.key, next);
                      setFlags((prev) => ({ ...prev, [f.key]: next }));
                    }}
                  />
                </Row>
                {featureExtras[f.key] && (
                  <div className={`ml-4 pl-4 border-l border-white/10 ${flags[f.key] ? "" : "opacity-40 pointer-events-none"}`}>
                    {featureExtras[f.key]}
                  </div>
                )}
              </div>
            ))}
          </SectionCard>
        );
      })}
    </>
  );
};

const PageServers = ({ settings, setSettings, servers }: SettingsPageProps & { servers: PinnableServer[] }) => {
  const [selectedToAdd, setSelectedToAdd] = useState("");
  const quickAccessIds: number[] = settings.quickAccessServerIds || [];
  const currentQuickServers = quickAccessIds.map((id) => servers.find((s) => s.id === id)).filter((s): s is PinnableServer => !!s);
  const availableToAdd = servers.filter((s) => !quickAccessIds.includes(s.id));
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
    <>
      <SectionCard title={`Pinned Servers (${currentQuickServers.length}/5)`} subtitle="These servers appear as quick-connect buttons in the top title bar.">
        <div className="space-y-2 mt-2">
          {currentQuickServers.length === 0 && (
            <div className="p-4 text-center rounded-xl border border-dashed border-white/10 text-xs text-zinc-500">No servers pinned yet. Add up to 5 below.</div>
          )}
          {currentQuickServers.map((srv, idx) => (
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
              {availableToAdd.map((s) => (<option key={s.id} value={s.id}>{s.name} ({s.host || s.ip || "SSH"})</option>))}
            </select>
            <button disabled={!selectedToAdd} onClick={handleAdd} className="px-3 py-2 bg-primary/10 border border-primary/30 hover:bg-primary/20 text-primary text-xs font-semibold rounded-xl flex items-center gap-1.5 transition-colors disabled:opacity-40"><Plus size={13} /> Pin</button>
          </div>
        )}
      </SectionCard>
    </>
  );
};

const PageCloud = ({ settings, setSettings, onSync, syncing, lastSyncLabel }: SettingsPageProps & CloudSyncExtras) => {
  const [cloudOpen, setCloudOpen] = useState(false);
  return (
    <>
      <SettingsCloudSync settings={settings} setSettings={setSettings} onOpenCloudAccount={() => setCloudOpen(true)} onSync={onSync} syncing={syncing} lastSyncLabel={lastSyncLabel} />
      {cloudOpen && (
        <Suspense fallback={null}>
          <CloudPanel isOpen={cloudOpen} onClose={() => setCloudOpen(false)} onLocalProfilesChanged={() => {}} />
        </Suspense>
      )}
    </>
  );
};

const PageProfile = ({ onUnlocked, activeProfile, onSwitchProfile, isUnlocked, onRequestUnlock }: ComponentProps<typeof SettingsProfileManagement>) => (
  <>
    <SettingsProfileManagement
      onUnlocked={onUnlocked}
      activeProfile={activeProfile}
      onSwitchProfile={onSwitchProfile}
      isUnlocked={isUnlocked}
      onRequestUnlock={onRequestUnlock}
    />
  </>
);


// Pinned servers, quick commands and keyboard shortcuts as three cards in the same column layout
// as the other settings pages. Shortcuts need no vault; the other two are replaced by an unlock
// card while the vault is locked.
const PageQuick = ({ settings, setSettings, servers, isUnlocked, onRequestUnlock }: SettingsPageProps & {
  servers: PinnableServer[]; isUnlocked: boolean; onRequestUnlock?: () => void;
}) => (
  <>
    {isUnlocked ? (
      <>
        <PageServers settings={settings} setSettings={setSettings} servers={servers} />
        <SettingsQuickCommands />
      </>
    ) : (
      <SectionCard id="quick-locked" title="Pinned Servers and Quick Commands" subtitle="These hold server names, addresses and saved scripts, so they need the vault unlocked.">
        <button
          type="button"
          onClick={onRequestUnlock}
          className="px-4 h-9 rounded-xl bg-amber-400 text-zinc-950 font-bold text-xs hover:bg-amber-300 inline-flex items-center gap-2"
        >
          <Lock size={13} /> Unlock Vault
        </button>
      </SectionCard>
    )}
    <SettingsKeyboardShortcuts />
  </>
);

const PageMaintenance = ({ settings, setSettings, servers = [], folders = [] }: SettingsPageProps & { servers?: ServerRecord[]; folders?: Folder[] }) => {
  const [exporting, setExporting] = useState<"json" | "csv" | null>(null);
  const [exportMsg, setExportMsg] = useState<string | null>(null);

  const doExport = async (format: "json" | "csv") => {
    setExporting(format);
    setExportMsg(null);
    try {
      const list = toExportableServers(servers, folders);
      const content = format === "json" ? serversToJson(list) : serversToCsv(list);
      const fileName = `subterm-servers-export-${new Date().toISOString().slice(0, 10)}.${format}`;
      const dir = IS_MOBILE_OS
        ? await invoke<string>("android_default_local_dir")
        : await invoke<string | null>("select_local_folder");
      if (!dir) { setExporting(null); return; }
      const sep = dir.includes("\\") ? "\\" : "/";
      const localPath = `${dir.replace(/[\\/]+$/, "")}${sep}${fileName}`;
      await invoke("local_write_file_text", { localPath, content });
      setExportMsg(`Exported ${list.length} server${list.length === 1 ? "" : "s"} to ${fileName}`);
    } catch (e) {
      setExportMsg(`Export failed: ${e}`);
    } finally {
      setExporting(null);
    }
  };

  return (
    <>
      <SectionCard title="Reset Preferences" subtitle="Restores every setting on the General, Appearance, Terminal and Features pages to its default and switches all features back on. Your servers, credentials, profiles, pinned servers and shortcuts are unaffected.">
        <button
          onClick={() => { if (window.confirm("Reset all settings to their defaults?")) { setSettings(resetAllSettings(settings)); } }}
          className="mt-4 px-4 h-9 bg-zinc-900 border border-white/5 text-zinc-300 rounded-xl text-xs font-bold uppercase hover:bg-white/5 transition-all w-full"
        >
          Reset All Settings
        </button>
      </SectionCard>

      <SectionCard title="Export Server List" subtitle="1-click export of saved server profiles (name, host, port, username, folder, proxy, notes) to a portable JSON or CSV file for backup or migration. Passwords, private keys, and passphrases are never included.">
        <div className="flex items-center gap-2">
          <button
            onClick={() => doExport("json")}
            disabled={exporting !== null || servers.length === 0}
            className="px-4 h-9 bg-zinc-900 border border-white/5 text-zinc-200 rounded-xl text-xs font-bold uppercase hover:bg-white/5 disabled:opacity-40 transition-all flex items-center gap-1.5"
          >
            <Download size={13} /> {exporting === "json" ? "Exporting…" : "Export JSON"}
          </button>
          <button
            onClick={() => doExport("csv")}
            disabled={exporting !== null || servers.length === 0}
            className="px-4 h-9 bg-zinc-900 border border-white/5 text-zinc-200 rounded-xl text-xs font-bold uppercase hover:bg-white/5 disabled:opacity-40 transition-all flex items-center gap-1.5"
          >
            <Download size={13} /> {exporting === "csv" ? "Exporting…" : "Export CSV"}
          </button>
        </div>
        {servers.length === 0 && <p className="text-xs text-zinc-500 italic mt-2">No saved servers to export.</p>}
        {exportMsg && <p className="text-xs text-zinc-400 mt-2">{exportMsg}</p>}
      </SectionCard>
    </>
  );
};

// Known hosts, maintenance and the activity log are occasional housekeeping, so they share one page
// (as cards in the usual column layout). The whole category sits behind the vault lock.
const PageSystemTabs = ({ settings, setSettings, servers, folders, onOpenLogs }: SettingsPageProps & {
  servers: ServerRecord[]; folders: Folder[]; onOpenLogs?: () => void;
}) => (
  <>
    <SettingsKnownHosts />
    <PageMaintenance settings={settings} setSettings={setSettings} servers={servers} folders={folders} />
    <PageLogs onOpenLogs={onOpenLogs} />
  </>
);

const PageLogs = ({ onOpenLogs }: { onOpenLogs?: () => void }) => (
  <>
    <SectionCard title="Activity Log" subtitle="Diagnostic timeline of app activity this session. Useful for confirming connection failures or watching transfers in retrospect.">
      {onOpenLogs
        ? <button onClick={onOpenLogs} className="mt-4 px-4 h-9 bg-primary/10 border border-primary/30 text-primary rounded-xl text-xs font-bold uppercase hover:bg-primary hover:text-zinc-950 transition-all w-full flex items-center justify-center gap-2"><List size={14} /> View Activity Log</button>
        : <p className="text-xs text-zinc-500 italic py-2">Activity log is not available.</p>
      }
    </SectionCard>
  </>
);

// â”€â”€â”€ Main component â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Search index: one entry per settings row/section that carries a data-setting id.
export const SETTINGS_INDEX: { id: string; page: CategoryId; label: string; keywords: string }[] = [
  { id: "startup", page: "general", label: "Startup", keywords: "launch open start" },
  { id: "autostart", page: "general", label: "Start when I sign in", keywords: "startup login boot autostart launch sign in windows" },
  { id: "local-shell", page: "general", label: "Default local shell", keywords: "powershell pwsh cmd bash wsl git shell terminal local" },
  { id: "backup", page: "general", label: "Backup & Restore", keywords: "export import preferences settings backup restore migrate move" },
  { id: "backup-actions", page: "general", label: "Preferences file", keywords: "export import preferences backup" },
  { id: "security", page: "general", label: "Security", keywords: "lock idle auto lock clipboard minimise" },
  { id: "auto-lock", page: "general", label: "Auto-lock when idle", keywords: "lock idle timeout inactivity security" },
  { id: "lock-on-minimize", page: "general", label: "Lock when the window is hidden", keywords: "lock minimise minimize hidden security" },
  { id: "confirm-on-close", page: "general", label: "Confirm before closing", keywords: "close quit exit sessions confirm" },
  { id: "clear-clipboard", page: "general", label: "Clear clipboard on lock", keywords: "clipboard clear lock security password" },
  { id: "monitoring", page: "general", label: "Resource Monitoring", keywords: "monitor cpu ram disk outage polling" },
  { id: "enable-monitoring", page: "general", label: "Enable monitoring", keywords: "monitor cpu ram disk outage polling" },
  { id: "startup-view", page: "general", label: "On Startup", keywords: "launch open start server list last session local terminal" },
  { id: "rdp", page: "general", label: "Remote Desktop (RDP)", keywords: "rdp remote desktop windows mstsc" },
  { id: "accent", page: "appearance", label: "Primary Accent Color", keywords: "accent colour color highlight" },
  { id: "ui-zoom", page: "appearance", label: "Interface Zoom", keywords: "zoom scale size dpi large small interface ui" },
  { id: "ui-zoom-row", page: "appearance", label: "Zoom level", keywords: "zoom scale size dpi" },
  { id: "accessibility", page: "appearance", label: "Accessibility", keywords: "accessibility motion animation reduce" },
  { id: "reduce-motion", page: "appearance", label: "Reduce motion", keywords: "reduce motion animation transition accessibility vestibular" },
  { id: "quick-editor", page: "appearance", label: "Quick Editor", keywords: "editor font tab wrap file edit" },
  { id: "editor-font-size", page: "appearance", label: "Editor font size", keywords: "editor font size text" },
  { id: "editor-tab-size", page: "appearance", label: "Editor tab width", keywords: "editor tab indent spaces" },
  { id: "editor-word-wrap", page: "appearance", label: "Editor wrap long lines", keywords: "editor wrap word lines" },
  { id: "background", page: "appearance", label: "Background Theme", keywords: "background colour color dark" },
  { id: "display", page: "appearance", label: "Display & Theme", keywords: "terminal display theme font cursor" },
  { id: "theme", page: "appearance", label: "Terminal Color Scheme", keywords: "theme palette ansi colors import" },
  { id: "font", page: "appearance", label: "Font Family", keywords: "font typeface monospace" },
  { id: "font-size", page: "appearance", label: "Font Size", keywords: "text size zoom" },
  { id: "line-height", page: "appearance", label: "Line Height", keywords: "spacing" },
  { id: "scrollback", page: "appearance", label: "Scrollback Buffer", keywords: "history lines memory" },
  { id: "cursor-color", page: "appearance", label: "Cursor Colour", keywords: "cursor colour color caret" },
  { id: "terminal-padding", page: "appearance", label: "Terminal Padding", keywords: "padding margin spacing" },
  { id: "cursor-style", page: "appearance", label: "Cursor Style", keywords: "block underline bar" },
  { id: "cursor-blink", page: "appearance", label: "Cursor Blinking", keywords: "blink" },
  { id: "webgl", page: "appearance", label: "WebGL Acceleration", keywords: "gpu rendering performance" },
  { id: "bell", page: "appearance", label: "Terminal Bell", keywords: "beep sound notification" },
  { id: "mouse", page: "terminal", label: "Mouse & Clipboard", keywords: "mouse clipboard copy paste links" },
  { id: "sessions", page: "terminal", label: "Sessions", keywords: "session exit close keep alive audit" },
  { id: "paste-review", page: "terminal", label: "Review multi-line paste", keywords: "paste lines confirm script safety" },
  { id: "word-separators", page: "terminal", label: "Word separators", keywords: "double click select word" },
  { id: "scroll-on-input", page: "terminal", label: "Scroll to bottom on typing", keywords: "scroll keypress output" },
  { id: "notifications", page: "terminal", label: "Notifications", keywords: "notify notification alert background long command disconnect" },
  { id: "notify-long", page: "terminal", label: "Long command finished", keywords: "notify notification long command finished build" },
  { id: "notify-disconnect", page: "terminal", label: "SSH session lost", keywords: "notify notification disconnect dropped session" },
  { id: "privacy", page: "terminal", label: "Privacy", keywords: "history command privacy retention clear" },
  { id: "history-max", page: "terminal", label: "History size", keywords: "command history keep entries limit" },
  { id: "history-days", page: "terminal", label: "History age", keywords: "command history delete days retention" },
  { id: "history-clear", page: "terminal", label: "Clear history now", keywords: "command history clear delete privacy" },
  { id: "transfers", page: "terminal", label: "File Transfers", keywords: "sftp upload download transfer" },
  { id: "overwrite-policy", page: "terminal", label: "When a file already exists", keywords: "overwrite skip existing conflict replace sftp transfer" },
  { id: "right-click", page: "terminal", label: "Right-Click", keywords: "paste copy context menu mouse smart" },
  { id: "copy-on-select", page: "terminal", label: "Copy on select", keywords: "clipboard selection" },
  { id: "open-links", page: "terminal", label: "Open Links", keywords: "ctrl click url file path hyperlink" },
  { id: "auto-copy-output", page: "terminal", label: "Auto-copy command output", keywords: "clipboard output" },
  { id: "auto-close", page: "terminal", label: "Auto-close tab on exit", keywords: "exit close shell tab" },
  { id: "audit-download", page: "terminal", label: "Download audit on exit", keywords: "transcript log save" },
  { id: "ssh-connection", page: "terminal", label: "SSH Connection", keywords: "ssh connection keep alive timeout reconnect" },
  { id: "host-key-policy", page: "terminal", label: "Unknown host keys", keywords: "host key fingerprint strict trust known hosts security mitm" },
  { id: "connect-timeout", page: "terminal", label: "Connection timeout", keywords: "ssh connect timeout seconds slow" },
  { id: "reconnect-attempts", page: "terminal", label: "Auto-reconnect attempts", keywords: "reconnect retry attempts give up drop" },
  { id: "reconnect-delay", page: "terminal", label: "Longest wait between retries", keywords: "reconnect retry backoff delay" },
  { id: "default-port", page: "terminal", label: "Default port", keywords: "ssh port new server default" },
  { id: "default-user", page: "terminal", label: "Default username", keywords: "ssh user username new server default" },
  { id: "default-agent", page: "terminal", label: "Forward SSH agent on new servers", keywords: "agent forwarding ssh-agent new server default security" },
  { id: "keepalive", page: "terminal", label: "SSH Keep-Alive", keywords: "ping nat timeout idle disconnect" },
  { id: "command-widget", page: "terminal", label: "Command Widget", keywords: "output pill dismiss timer" },
  { id: "banner-buttons", page: "terminal", label: "Session-End Banner Buttons", keywords: "copy output download audit" },
  { id: "triggers", page: "terminal", label: "Terminal Triggers & Alert Keywords", keywords: "alert regex keyword error highlight notify" },
  { id: "features-editor", page: "features", label: "Editor features", keywords: "features optional enable disable switch editor" },
  { id: "features-terminal", page: "features", label: "Terminal features", keywords: "features optional enable disable switch terminal" },
  { id: "features-panels", page: "features", label: "Panels features", keywords: "features optional enable disable switch panels sftp docker" },
  { id: "features-ai", page: "features", label: "AI features", keywords: "features optional enable disable switch ai copilot" },
  { id: "ssh-mode", page: "features", label: "When you type ssh / sftp", keywords: "local terminal saved server auto ask quick connect" },
  { id: "file-types", page: "features", label: "Clickable file types", keywords: "extensions editor open file click" },
];

// Two columns on wide windows; cards never split. Narrow windows stay single-column.
// Two columns from 1280 px, three from 1700 px (a 1920 px monitor); cards never split.
const COLUMNS = "space-y-6 xl:space-y-0 xl:columns-2 min-[1700px]:columns-3 xl:gap-6 xl:[&>*]:mb-6";
const WIDE_PAGES: CategoryId[] = ["general", "appearance", "terminal", "features", "quick", "accounts", "system"];

const SettingsPanel = ({ settings, setSettings, onOpenLogs, onOpenMonitor, onClose, onUnlocked, servers = [], folders = [], onSync, syncing, lastSyncLabel, activeProfile, onSwitchProfile, isUnlocked = false, onRequestUnlock }: SettingsPanelProps) => {
  const [activeCategory, setActiveCategory] = useState<CategoryId>("general");
  const [query, setQuery] = useState("");
  const resettable = ["general", "appearance", "terminal", "features"].includes(activeCategory) ? (activeCategory as ResettablePage) : null;
  const [, bump] = useState(0);
  const meta = {
    changed: (id: string) => isSettingChanged(id, settings),
    reset: (id: string) => { setSettings(resetSetting(id, settings)); bump((n) => n + 1); },
  };

  const searchResults = (() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const words = q.split(/\s+/);
    const featureEntries = FEATURES.map((f) => ({ id: f.key, page: "features" as CategoryId, label: f.label, keywords: f.desc }));
    return [...SETTINGS_INDEX, ...featureEntries]
      .filter((e) => {
        const hay = `${e.label} ${e.keywords}`.toLowerCase();
        return words.every((w) => hay.includes(w));
      })
      .slice(0, 12);
  })();

  const jumpToSetting = (page: CategoryId, id: string) => {
    setActiveCategory(page);
    setQuery("");
    window.setTimeout(() => {
      const el = document.querySelector<HTMLElement>(`[data-setting="${id}"]`);
      if (!el) return;
      el.scrollIntoView({ block: "center", behavior: "smooth" });
      el.classList.add("ring-2", "ring-primary/60", "rounded-lg");
      window.setTimeout(() => el.classList.remove("ring-2", "ring-primary/60"), 1600);
    }, 80);
  };

  const needsUnlock = (id: CategoryId) => !isUnlocked && LOCKED_CATEGORIES.includes(id);

  const renderPage = () => {
    if (needsUnlock(activeCategory)) {
      const current = CATEGORIES.find((c) => c.id === activeCategory)!;
      return <LockedPage label={current.label} onRequestUnlock={onRequestUnlock} />;
    }
    switch (activeCategory) {
      case "general":       return <div className={COLUMNS}><PageTerminal part="general" settings={settings} setSettings={setSettings} onOpenMonitor={onOpenMonitor} /></div>;
      case "appearance":    return <div className={COLUMNS}><PageAppearance settings={settings} setSettings={setSettings} /><PageTerminal part="appearance" settings={settings} setSettings={setSettings} /></div>;
      case "terminal":      return <div className={COLUMNS}><PageTerminal part="terminal" settings={settings} setSettings={setSettings} /></div>;
      case "features":      return <div className={COLUMNS}><PageTerminal part="features" settings={settings} setSettings={setSettings} /></div>;
      case "quick":         return <div className={COLUMNS}><PageQuick settings={settings} setSettings={setSettings} servers={servers} isUnlocked={isUnlocked} onRequestUnlock={onRequestUnlock} /></div>;
      case "accounts":      return (
        <div className={COLUMNS}>
          <PageProfile onUnlocked={onUnlocked} activeProfile={activeProfile} onSwitchProfile={onSwitchProfile} isUnlocked={isUnlocked} onRequestUnlock={onRequestUnlock} />
          <PageCloud settings={settings} setSettings={setSettings} onSync={onSync} syncing={syncing} lastSyncLabel={lastSyncLabel} />
        </div>
      );
      case "system":        return <div className={COLUMNS}><PageSystemTabs settings={settings} setSettings={setSettings} servers={servers} folders={folders} onOpenLogs={onOpenLogs} /></div>;
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
        <div className="px-2 pt-2">
          <div className="relative">
            <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-500" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") setQuery("");
                if (e.key === "Enter" && searchResults[0]) jumpToSetting(searchResults[0].page, searchResults[0].id);
              }}
              placeholder="Search settings"
              className="w-full h-8 pl-7 pr-2 rounded-lg bg-black/40 border border-white/10 text-xs text-white placeholder:text-zinc-600 outline-none focus:border-primary/50"
            />
          </div>
        </div>
        {query.trim() ? (
          <div className="flex-1 p-2 space-y-0.5 mt-1">
            {searchResults.length === 0 ? (
              <p className="px-3 py-2 text-[11px] text-zinc-500">No settings match "{query}".</p>
            ) : searchResults.map((r) => (
              <button
                key={`${r.page}-${r.id}`}
                onClick={() => jumpToSetting(r.page, r.id)}
                className="w-full px-3 py-2 rounded-xl text-left text-zinc-300 hover:bg-white/[0.06] border border-transparent"
              >
                <div className="text-xs font-semibold truncate">{r.label}</div>
                <div className="text-[10px] text-zinc-500">{CATEGORIES.find((c) => c.id === r.page)?.label}</div>
              </button>
            ))}
          </div>
        ) : (
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
        )}
        <div className="p-3 border-t border-white/5">
          <p className="text-[10px] text-zinc-600 leading-relaxed">Preferences are local and do not sync with your cloud profile.</p>
        </div>
      </aside>
      <main className="flex-1 overflow-y-auto custom-scrollbar">
        <div className={`p-6 sm:p-8 ${WIDE_PAGES.includes(activeCategory) ? "max-w-[2000px]" : "max-w-2xl"}`}>
          <div className="mb-6">
            <h2 className="text-lg font-bold text-white flex items-center gap-2">
              <span className="text-primary">{current.icon}</span>
              {current.label}
              {needsUnlock(current.id) && <Lock size={14} className="text-amber-400 ml-1" />}
            </h2>
            <p className="text-xs text-zinc-500 mt-1">{current.description}</p>
            {resettable && pageHasChanges(resettable, settings) && (
              <button
                type="button"
                onClick={() => {
                  if (window.confirm(`Reset every setting on the ${current.label} page to its default?`)) {
                    setSettings(resetPage(resettable, settings));
                    bump((n) => n + 1);
                  }
                }}
                className="mt-2 text-[11px] font-semibold text-primary hover:underline"
              >
                Reset this page to defaults
              </button>
            )}
          </div>
          <SettingsMetaContext.Provider value={meta}>{renderPage()}</SettingsMetaContext.Provider>
        </div>
      </main>
    </div>
  );
};

export default SettingsPanel;
