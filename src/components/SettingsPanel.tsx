import type { Server as ServerRecord, Folder } from "../types";
import type { AppSettings, SetAppSettings } from "../types.settings";
import { SettingsFileLinkTypes } from "./SettingsFileLinkTypes";
import { FEATURES, isFeatureEnabled, setFeatureEnabled, type FeatureKey } from "../featureFlags";
import { useState, type ComponentProps } from "react";
import { invoke } from "@tauri-apps/api/core";
import { IS_ANDROID } from "../util/platform";
import { toExportableServers, serversToJson, serversToCsv } from "../export/serverExport";
import {
  Settings, Palette, RefreshCw, List, Cloud, User,
  ArrowLeft, Activity, Server, ArrowUp, ArrowDown, Trash2,
  Plus, Terminal, Keyboard, ChevronRight, Lock, ShieldCheck,
  Download, X,
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

type CategoryId = "appearance" | "terminal" | "servers" | "monitoring" | "cloud" | "profile" | "quickcommands" | "shortcuts" | "security" | "maintenance" | "logs";

interface Category {
  id: CategoryId;
  label: string;
  icon: React.ReactNode;
  description: string;
}

// Categories that require the vault to be unlocked before use.
const LOCKED_CATEGORIES: CategoryId[] = ["cloud", "profile", "quickcommands", "servers", "security", "maintenance", "logs"];

const CATEGORIES: Category[] = [
  { id: "appearance",    label: "Appearance",        icon: <Palette size={16} />,     description: "Colors, fonts, and theme" },
  { id: "terminal",      label: "Terminal",           icon: <Terminal size={16} />,    description: "Behaviour, clipboard, session-end" },
  { id: "servers",       label: "Quick Access",       icon: <Server size={16} />,      description: "Pinned servers in the top bar" },
  { id: "monitoring",    label: "Monitoring",         icon: <Activity size={16} />,    description: "Resource polling and alerts" },
  { id: "cloud",         label: "Cloud and Sync",     icon: <Cloud size={16} />,       description: "Cloud account and sync settings" },
  { id: "profile",       label: "Profile",            icon: <User size={16} />,        description: "Manage and switch profiles" },
  { id: "quickcommands", label: "Quick Commands",     icon: <List size={16} />,        description: "OS / environment quick commands" },
  { id: "shortcuts",     label: "Keyboard Shortcuts", icon: <Keyboard size={16} />,    description: "Rebind keyboard shortcuts" },
  { id: "security",      label: "Known Hosts",        icon: <ShieldCheck size={16} />, description: "Trusted host keys and fingerprints" },
  { id: "maintenance",   label: "Maintenance",        icon: <RefreshCw size={16} />,   description: "Reset defaults and diagnostics" },
  { id: "logs",          label: "Activity Log",       icon: <List size={16} />,        description: "Session diagnostics timeline" },
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
  onClose?: () => void;
}

const PageAppearance = ({ settings, setSettings }: SettingsPageProps) => (
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

const PageTerminal = ({ settings, setSettings }: SettingsPageProps) => {
  const [themesList, setThemesList] = useState<TerminalThemeConfig[]>(getAllTerminalThemes());
  const [flags, setFlags] = useState<Record<FeatureKey, boolean>>(() =>
    Object.fromEntries(FEATURES.map((f) => [f.key, isFeatureEnabled(f.key)])) as Record<FeatureKey, boolean>,
  );
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

  return (
    <div className="space-y-6">
      <SectionCard title="Display & Theme">
        <Row label="Color Scheme / Theme" desc="Curated palette, custom themes, and full ANSI 16-color theme for terminal sessions">
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
        <Row label="Font Family" desc="Typography typeface preset or custom font stack">
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
        <Row label="Font Size (px)" desc="Terminal character size in pixels">
          <div className="flex items-center gap-3">
            <input type="range" min="8" max="24" value={settings.terminalFontSize || 14} onChange={(e) => setSettings({ ...settings, terminalFontSize: parseInt(e.target.value) || 14 })} className="w-32 accent-primary" />
            <input type="number" value={settings.terminalFontSize || 14} onChange={(e) => setSettings({ ...settings, terminalFontSize: parseInt(e.target.value) || 14 })} className="w-14 h-8 bg-black border border-white/10 rounded-lg px-2 text-[12px] font-bold text-white focus:border-primary/50 outline-none text-center" />
          </div>
        </Row>
        <Row label="Line Height" desc="Vertical line spacing ratio for terminal characters">
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
        <Row label="Scrollback Buffer" desc="Historical terminal lines retained in memory per session">
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
        <Row label="Cursor Style" desc="Visual shape of the terminal cursor">
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
        <Row label="Cursor Blinking" desc="Animate cursor blinking when the terminal is focused">
          <Toggle
            checked={settings.terminalCursorBlink !== false}
            onChange={() => setSettings({ ...settings, terminalCursorBlink: settings.terminalCursorBlink === false ? true : false })}
          />
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
        <Row label="Terminal Bell" desc="Notification style when an ASCII bell (\a or BEL) is emitted by the shell">
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

      <SectionCard title="Feature Toggles" subtitle="Turn optional features off to skip loading and running their code. Changes apply immediately.">
        {(["Editor", "Terminal", "Panels", "AI"] as const).map((group) => {
          const items = FEATURES.filter((f) => f.group === group);
          if (items.length === 0) return null;
          return (
            <div key={group}>
              <div className="text-[10px] font-bold uppercase tracking-wider text-zinc-500 pt-2 pb-1">{group}</div>
              {items.map((f) => (
                <Row key={f.key} label={f.label} desc={f.desc}>
                  <Toggle
                    checked={flags[f.key]}
                    onChange={() => {
                      const next = !flags[f.key];
                      setFeatureEnabled(f.key, next);
                      setFlags((prev) => ({ ...prev, [f.key]: next }));
                    }}
                  />
                </Row>
              ))}
            </div>
          );
        })}
      </SectionCard>

      <SectionCard title="Clickable file types" subtitle="Choose which file names in terminal output can be clicked to open in the editor. Add or remove extensions and exact file names; changes apply immediately.">
        <SettingsFileLinkTypes />
      </SectionCard>

      <SectionCard title="Terminal Triggers & Alert Keywords" subtitle="Match keywords or regex patterns against live terminal output and fire an alert — useful for spotting ERROR/FATAL lines in a session you're not actively watching.">
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
      <Row label="SSH Keep-Alive Interval" desc="Sends periodic ping packets through the SSH transport to prevent NAT dropouts and keep idle connections alive">
        <select
          value={settings.sshKeepaliveSec || 20}
          onChange={(e) => setSettings({ ...settings, sshKeepaliveSec: parseInt(e.target.value, 10) || 20 })}
          className="bg-black/60 border border-white/10 text-white rounded-lg px-2.5 py-1 text-xs outline-none focus:border-primary/50"
        >
          <option value={10}>10 seconds (High frequency / aggressive NATs)</option>
          <option value={20}>20 seconds (Standard / Recommended)</option>
          <option value={30}>30 seconds (Default)</option>
          <option value={60}>60 seconds (Relaxed)</option>
          <option value={0}>Disabled (Mute)</option>
        </select>
      </Row>
      <Row label="Right-Click Action" desc="Behavior when right-clicking inside the terminal viewport">
        <select
          value={settings.rightClickAction || 'menu'}
          onChange={(e) => setSettings({ ...settings, rightClickAction: e.target.value })}
          className="bg-black/60 border border-white/10 text-white rounded-lg px-2.5 py-1 text-xs outline-none focus:border-primary/50"
        >
          <option value="menu">Open Context Menu</option>
          <option value="paste">Paste Immediately (PuTTY style)</option>
        </select>
      </Row>
      <Row label="Copy on select" desc="Automatically copy highlighted terminal text to system clipboard">
        <Toggle
          checked={settings.copyOnSelect !== false}
          onChange={() => setSettings({ ...settings, copyOnSelect: settings.copyOnSelect === false ? true : false })}
        />
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
    <div className="space-y-6">
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
    </div>
  );
};

const PageMonitoring = ({ settings, setSettings }: SettingsPageProps) => (
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

const PageCloud = ({ settings, setSettings, onSync, syncing, lastSyncLabel }: SettingsPageProps & CloudSyncExtras) => {
  const [cloudOpen, setCloudOpen] = useState(false);
  return (
    <div className="space-y-6">
      <SettingsCloudSync settings={settings} setSettings={setSettings} onOpenCloudAccount={() => setCloudOpen(true)} onSync={onSync} syncing={syncing} lastSyncLabel={lastSyncLabel} />
      {cloudOpen && (
        <Suspense fallback={null}>
          <CloudPanel isOpen={cloudOpen} onClose={() => setCloudOpen(false)} onLocalProfilesChanged={() => {}} />
        </Suspense>
      )}
    </div>
  );
};

const PageProfile = ({ onUnlocked, activeProfile, onSwitchProfile, isUnlocked, onRequestUnlock }: ComponentProps<typeof SettingsProfileManagement>) => (
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
      const dir = IS_ANDROID
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
    <div className="space-y-6">
      <SectionCard title="Reset Preferences" subtitle="Resets UI aesthetics to factory defaults. Your servers and profiles are unaffected.">
        <button
          onClick={() => { if (window.confirm("Reset all UI customisations to defaults?")) { setSettings((s) => ({ ...s, primaryColor: "#60a5fa", backgroundColor: "#0a0a0c", terminalFontSize: 14, enableMonitoring: true })); } }}
          className="mt-4 px-4 h-9 bg-zinc-900 border border-white/5 text-zinc-300 rounded-xl text-xs font-bold uppercase hover:bg-white/5 transition-all w-full"
        >
          Reset to Defaults
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
    </div>
  );
};

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
const SettingsPanel = ({ settings, setSettings, onOpenLogs, onClose, onUnlocked, servers = [], folders = [], onSync, syncing, lastSyncLabel, activeProfile, onSwitchProfile, isUnlocked = false, onRequestUnlock }: SettingsPanelProps) => {
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
      case "security":      return <SettingsKnownHosts />;
      case "maintenance":   return <PageMaintenance settings={settings} setSettings={setSettings} servers={servers} folders={folders} />;
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
