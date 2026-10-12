import type { AppSettings } from "./types.settings";
import { FEATURES, isFeatureEnabled, setFeatureEnabled, type FeatureKey } from "./featureFlags";

/**
 * Factory values for the settings that live on the General / Appearance /
 * Terminal / Features pages. These mirror the fallbacks used when `appSettings`
 * is first built in DesktopApp.tsx; keep the two in step.
 */
export const SETTING_DEFAULTS = {
  startupView: "servers",
  enableMonitoring: true,
  localShell: "",
  primaryColor: "#60a5fa",
  backgroundColor: "#0a0a0c",
  terminalTheme: "subterm-dark",
  terminalFontFamily: 'JetBrains Mono, Menlo, Monaco, Consolas, "Courier New", monospace',
  terminalFontSize: 14,
  terminalLineHeight: 1.15,
  uiZoom: 100,
  notifyLongCommandSec: 0,
  notifyOnDisconnect: false,
  historyMaxEntries: 1000,
  historyRetentionDays: 0,
  confirmOnClose: true,
  overwritePolicy: "ask",
  editorTabSize: 4,
  editorWordWrap: false,
  editorFontSize: 12,
  autoLockMin: 0,
  lockOnMinimize: false,
  clearClipboardOnLock: false,
  pasteReviewLines: 3,
  wordSeparators: " ()[]{}',\"`",
  scrollOnInput: true,
  terminalCursorColor: "",
  terminalPadding: 0,
  terminalScrollback: 5000,
  terminalCursorStyle: "block",
  terminalCursorBlink: true,
  terminalWebgl: true,
  terminalBell: "visual",
  rightClickAction: "smart",
  copyOnSelect: true,
  linkOpenMode: "ctrl-click",
  autoCopyOutput: false,
  autoCloseOnExit: false,
  downloadAuditOnExit: false,
  sshKeepaliveSec: 20,
  sshConnectTimeoutSec: 10,
  hostKeyPolicy: "ask",
  reconnectMaxAttempts: 0,
  reconnectMaxDelaySec: 30,
  defaultSshPort: 22,
  defaultSshUser: "",
  defaultAgentForward: false,
  commandDismissSec: 4,
  showAuditCopy: true,
  showAuditDownload: true,
  sshDetectMode: "prompt",
} as const satisfies Partial<AppSettings>;

type DefaultKey = keyof typeof SETTING_DEFAULTS;

/** Settings-row id (the `data-setting` attribute) -> the setting it edits. */
export const ROW_SETTING_KEY: Record<string, DefaultKey> = {
  "startup-view": "startupView",
  "enable-monitoring": "enableMonitoring",
  "local-shell": "localShell",
  accent: "primaryColor",
  background: "backgroundColor",
  theme: "terminalTheme",
  font: "terminalFontFamily",
  "font-size": "terminalFontSize",
  "line-height": "terminalLineHeight",
  "ui-zoom": "uiZoom",
  "notify-long": "notifyLongCommandSec",
  "notify-disconnect": "notifyOnDisconnect",
  "history-max": "historyMaxEntries",
  "history-days": "historyRetentionDays",
  "confirm-on-close": "confirmOnClose",
  "overwrite-policy": "overwritePolicy",
  "editor-tab-size": "editorTabSize",
  "editor-word-wrap": "editorWordWrap",
  "editor-font-size": "editorFontSize",
  "auto-lock": "autoLockMin",
  "lock-on-minimize": "lockOnMinimize",
  "clear-clipboard": "clearClipboardOnLock",
  "paste-review": "pasteReviewLines",
  "word-separators": "wordSeparators",
  "scroll-on-input": "scrollOnInput",
  "cursor-color": "terminalCursorColor",
  "terminal-padding": "terminalPadding",
  scrollback: "terminalScrollback",
  "cursor-style": "terminalCursorStyle",
  "cursor-blink": "terminalCursorBlink",
  webgl: "terminalWebgl",
  bell: "terminalBell",
  "right-click": "rightClickAction",
  "copy-on-select": "copyOnSelect",
  "open-links": "linkOpenMode",
  "auto-copy-output": "autoCopyOutput",
  "auto-close": "autoCloseOnExit",
  "audit-download": "downloadAuditOnExit",
  keepalive: "sshKeepaliveSec",
  "connect-timeout": "sshConnectTimeoutSec",
  "host-key-policy": "hostKeyPolicy",
  "reconnect-attempts": "reconnectMaxAttempts",
  "reconnect-delay": "reconnectMaxDelaySec",
  "default-port": "defaultSshPort",
  "default-user": "defaultSshUser",
  "default-agent": "defaultAgentForward",
  "command-widget": "commandDismissSec",
  "ssh-mode": "sshDetectMode",
};

export type ResettablePage = "general" | "appearance" | "terminal" | "features";

const PAGE_ROWS: Record<ResettablePage, string[]> = {
  general: ["startup-view", "local-shell", "enable-monitoring", "auto-lock", "lock-on-minimize", "clear-clipboard", "confirm-on-close"],
  appearance: ["accent", "background", "ui-zoom", "editor-font-size", "editor-tab-size", "editor-word-wrap", "theme", "font", "font-size", "line-height", "scrollback", "cursor-style", "cursor-color", "terminal-padding", "cursor-blink", "webgl", "bell"],
  terminal: ["notify-long", "notify-disconnect", "history-max", "history-days", "overwrite-policy", "right-click", "copy-on-select", "open-links", "paste-review", "word-separators", "scroll-on-input", "auto-copy-output", "auto-close", "audit-download", "keepalive", "connect-timeout", "host-key-policy", "reconnect-attempts", "reconnect-delay", "default-port", "default-user", "default-agent", "command-widget"],
  features: ["ssh-mode", ...FEATURES.map((f) => f.key as string)],
};

const isFeatureId = (id: string): id is FeatureKey => FEATURES.some((f) => f.key === id);

export function isSettingChanged(id: string, settings: AppSettings): boolean {
  if (isFeatureId(id)) return !isFeatureEnabled(id);
  const key = ROW_SETTING_KEY[id];
  if (!key) return false;
  const current = settings[key];
  // Unset (undefined) means the default is in effect.
  return current !== undefined && current !== SETTING_DEFAULTS[key];
}

/** Returns settings with one row restored; feature flags are written straight to storage. */
export function resetSetting(id: string, settings: AppSettings): AppSettings {
  if (isFeatureId(id)) {
    setFeatureEnabled(id, true);
    return settings;
  }
  const key = ROW_SETTING_KEY[id];
  return key ? { ...settings, [key]: SETTING_DEFAULTS[key] } : settings;
}

/** Every setting with a factory value back to default, and every feature switched on. */
export function resetAllSettings(settings: AppSettings): AppSettings {
  FEATURES.forEach((f) => setFeatureEnabled(f.key, true));
  return { ...settings, ...SETTING_DEFAULTS };
}

export function pageHasChanges(page: ResettablePage, settings: AppSettings): boolean {
  return PAGE_ROWS[page].some((id) => isSettingChanged(id, settings));
}

export function resetPage(page: ResettablePage, settings: AppSettings): AppSettings {
  return PAGE_ROWS[page].reduce((acc, id) => resetSetting(id, acc), settings);
}
