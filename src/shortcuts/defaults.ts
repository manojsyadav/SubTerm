import { ShortcutAction } from "./types";

export const DEFAULT_SHORTCUTS: ShortcutAction[] = [
  // General
  {
    id: "commandPalette",
    name: "Command Palette",
    category: "General",
    description: "Open the universal search and quick command palette",
    defaultKey: "Ctrl+Shift+P",
    scope: "global",
  },
  {
    id: "openLocalTerminal",
    name: "Open Local Terminal",
    category: "General",
    description: "Launch a native local shell session (PowerShell / Bash)",
    defaultKey: "Ctrl+Alt+T",
    scope: "global",
  },

  // Tools & Panels
  {
    id: "quickOpenFile",
    name: "Quick Open / Edit File",
    category: "Tools & Panels",
    description: "Search and open remote files in the built-in editor",
    defaultKey: "Alt+E",
    scope: "session",
  },
  {
    id: "toggleSftp",
    name: "Toggle SFTP File Manager",
    category: "Tools & Panels",
    description: "Toggle the remote SFTP file explorer panel",
    defaultKey: "Ctrl+Shift+F",
    scope: "session",
  },
  {
    id: "toggleDocker",
    name: "Toggle Docker Panel",
    category: "Tools & Panels",
    description: "Toggle Docker containers and images panel",
    defaultKey: "Ctrl+Shift+K",
    scope: "session",
  },
  {
    id: "toggleProcesses",
    name: "Toggle Processes Panel",
    category: "Tools & Panels",
    description: "Toggle real-time system task monitor",
    defaultKey: "Ctrl+Shift+M",
    scope: "session",
  },
  {
    id: "toggleServices",
    name: "Toggle Services Panel",
    category: "Tools & Panels",
    description: "Toggle systemd services inspection panel",
    defaultKey: "Ctrl+Shift+S",
    scope: "session",
  },
  {
    id: "toggleInfo",
    name: "Toggle System Info",
    category: "Tools & Panels",
    description: "Toggle hardware, network, and port overview",
    defaultKey: "Ctrl+Shift+I",
    scope: "session",
  },

  // Terminal
  {
    id: "newTerminal",
    name: "New Terminal Tab",
    category: "Terminal",
    description: "Spawn a new shell terminal tab in the active session",
    defaultKey: "Ctrl+Shift+T",
    scope: "session",
  },
  {
    id: "splitHorizontal",
    name: "Split Terminal Horizontally",
    category: "Terminal",
    description: "Split terminal into side-by-side columns",
    defaultKey: "Ctrl+\\",
    scope: "session",
  },
  {
    id: "splitVertical",
    name: "Split Terminal Vertically",
    category: "Terminal",
    description: "Split terminal into stacked rows",
    defaultKey: "Ctrl+Shift+D",
    scope: "session",
  },

  {
    id: "focusNextPane",
    name: "Focus Next Pane",
    category: "Terminal",
    description: "Move keyboard focus to the next split pane (or next terminal tab when not split)",
    defaultKey: "Alt+Shift+ArrowRight",
    scope: "session",
  },
  {
    id: "focusPrevPane",
    name: "Focus Previous Pane",
    category: "Terminal",
    description: "Move keyboard focus to the previous split pane (or previous terminal tab when not split)",
    defaultKey: "Alt+Shift+ArrowLeft",
    scope: "session",
  },

  // Session & Navigation
  {
    id: "closeSession",
    name: "Close Active Session",
    category: "Session & Navigation",
    description: "Disconnect and close the current session view",
    defaultKey: "Ctrl+Shift+W",
    scope: "session",
  },
  {
    id: "nextSession",
    name: "Next Session Tab",
    category: "Session & Navigation",
    description: "Switch to the next open session",
    defaultKey: "Ctrl+Tab",
    scope: "global",
  },
  {
    id: "prevSession",
    name: "Previous Session Tab",
    category: "Session & Navigation",
    description: "Switch to the previous open session",
    defaultKey: "Ctrl+Shift+Tab",
    scope: "global",
  },
  {
    id: "serversView",
    name: "Go to Servers Grid",
    category: "Session & Navigation",
    description: "Return to the server fleet list and node grid",
    defaultKey: "Alt+0",
    scope: "global",
  },
];
