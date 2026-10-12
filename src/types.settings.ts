/**
 * The app-wide `settings` object held in DesktopApp state (initialised from
 * localStorage) and read/written by SettingsPanel and SettingsCloudSync.
 */
export interface AppSettings {
  primaryColor: string;
  backgroundColor: string;
  terminalFontSize: number;
  autoSync: boolean;
  syncIntervalMin: number;
  cloudApiBase: string;
  autoCloseOnExit: boolean;
  downloadAuditOnExit: boolean;
  commandDismissSec: number;
  autoCopyOutput: boolean;
  showAuditDownload: boolean;
  showAuditCopy: boolean;
  enableMonitoring: boolean;
  terminalWebgl: boolean;
  rightClickAction: string;
  linkOpenMode: string;
  startupView: string;
  /** Shell the Local item and Ctrl+Alt+T open. Empty = automatic. */
  localShell: string;
  sshDetectMode: string;
  copyOnSelect: boolean;
  terminalTheme: string;
  terminalCursorStyle: string;
  terminalCursorBlink: boolean;
  terminalBell: string;
  terminalFontFamily: string;
  terminalLineHeight: number;
  /** Whole-UI zoom in percent (webview zoom). */
  uiZoom: number;
  /** Most command-history entries kept (older ones are dropped). */
  historyMaxEntries: number;
  /** Drop history older than this many days; 0 = keep by age. */
  historyRetentionDays: number;
  /** Ask before closing the window while sessions are open. */
  confirmOnClose: boolean;
  /** What a transfer does when the target exists: "ask" (dialog), "skip" or "overwrite". */
  overwritePolicy: string;
  /** Quick Editor: spaces per tab (1-8). */
  editorTabSize: number;
  editorWordWrap: boolean;
  /** Quick Editor font size in px (9-24). */
  editorFontSize: number;
  /** Minutes without input before the vault locks; 0 = never. */
  autoLockMin: number;
  /** Lock as soon as the window is minimised or hidden. */
  lockOnMinimize: boolean;
  /** Empty the clipboard whenever the vault locks. */
  clearClipboardOnLock: boolean;
  /** Pasted text with at least this many non-empty lines asks for review first; 0 = never ask. */
  pasteReviewLines: number;
  /** Characters that end a word for double-click selection. */
  wordSeparators: string;
  /** Jump to the bottom when you type while scrolled up. */
  scrollOnInput: boolean;
  /** Cursor colour override (hex); empty = the theme's own cursor. */
  terminalCursorColor: string;
  /** Space around the terminal text, in px. */
  terminalPadding: number;
  terminalScrollback: number;
  sshKeepaliveSec: number;
  /** Seconds the first TCP connect (direct or to a proxy) may take. */
  sshConnectTimeoutSec: number;
  /** "ask" (default) prompts for unknown host keys; "strict" refuses any key not already trusted. */
  hostKeyPolicy: string;
  /** Auto-reconnect attempts before giving up; 0 = retry forever. */
  reconnectMaxAttempts: number;
  /** Ceiling of the auto-reconnect backoff, in seconds. */
  reconnectMaxDelaySec: number;
  /** Prefilled in the add-server form. */
  defaultSshPort: number;
  defaultSshUser: string;
  defaultAgentForward: boolean;
  quickAccessServerIds: number[];
}

export type SetAppSettings = (
  updater: AppSettings | ((prev: AppSettings) => AppSettings),
) => void;
