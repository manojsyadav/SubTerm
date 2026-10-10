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
  copyOnSelect: boolean;
  terminalTheme: string;
  terminalCursorStyle: string;
  terminalCursorBlink: boolean;
  terminalBell: string;
  terminalFontFamily: string;
  terminalLineHeight: number;
  terminalScrollback: number;
  sshKeepaliveSec: number;
  quickAccessServerIds: number[];
}

export type SetAppSettings = (
  updater: AppSettings | ((prev: AppSettings) => AppSettings),
) => void;
