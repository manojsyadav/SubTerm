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
  quickAccessServerIds: number[];
}

export type SetAppSettings = (
  updater: AppSettings | ((prev: AppSettings) => AppSettings),
) => void;
