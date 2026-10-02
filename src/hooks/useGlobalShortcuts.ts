import { useEffect } from "react";
import { matchesKeyCombo, getActiveShortcut } from "../shortcuts";

interface GlobalShortcutsProps {
  enabled: boolean;
  sessions: { id: string; serverName: string }[];
  activeView: string;
  setActiveView: (id: string) => void;
  onCloseSession: (id: string) => void;
  onOpenCommandPalette?: () => void;
  onOpenLocalTerminal?: () => void;
}

export function useGlobalShortcuts({
  enabled,
  sessions,
  activeView,
  setActiveView,
  onCloseSession,
  onOpenCommandPalette,
  onOpenLocalTerminal,
}: GlobalShortcutsProps) {
  useEffect(() => {
    if (!enabled) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      // 0. Global Command Palette: e.g. Ctrl+Shift+P / custom (or F1)
      const cmdPaletteCombo = getActiveShortcut("commandPalette");
      const isCmdPaletteKey = matchesKeyCombo(e, cmdPaletteCombo) || e.key === "F1";

      if (isCmdPaletteKey) {
        // If it's plain Ctrl+K (without Shift) and focus is currently in a terminal (xterm),
        // do NOT intercept! Pass it through so nano can cut lines and bash/readline can kill lines.
        const isTerminalFocused = !!(
          document.activeElement?.classList?.contains("xterm-helper-textarea") ||
          document.activeElement?.closest?.(".xterm")
        );
        if ((e.key === "k" || e.key === "K") && !e.shiftKey && isTerminalFocused) {
          return;
        }

        e.preventDefault();
        e.stopPropagation();
        onOpenCommandPalette?.();
        return;
      }

      // Open Local Terminal shortcut: Ctrl+Alt+T / custom
      const openLocalCombo = getActiveShortcut("openLocalTerminal");
      if (matchesKeyCombo(e, openLocalCombo)) {
        e.preventDefault();
        e.stopPropagation();
        onOpenLocalTerminal?.();
        return;
      }

      // 1. Session cycling: Next/Previous session
      const nextSessionCombo = getActiveShortcut("nextSession");
      const prevSessionCombo = getActiveShortcut("prevSession");
      if (matchesKeyCombo(e, nextSessionCombo) || (e.ctrlKey && !e.shiftKey && e.key === "Tab")) {
        e.preventDefault();
        e.stopPropagation();
        if (sessions.length === 0) return;
        const views = ["nodes", ...sessions.map((s) => s.id)];
        const currentIndex = views.indexOf(activeView);
        const nextIndex = (currentIndex + 1) % views.length;
        setActiveView(views[nextIndex]);
        return;
      }
      if (matchesKeyCombo(e, prevSessionCombo) || (e.ctrlKey && e.shiftKey && e.key === "Tab")) {
        e.preventDefault();
        e.stopPropagation();
        if (sessions.length === 0) return;
        const views = ["nodes", ...sessions.map((s) => s.id)];
        const currentIndex = views.indexOf(activeView);
        const nextIndex = (currentIndex - 1 + views.length) % views.length;
        setActiveView(views[nextIndex]);
        return;
      }

      // 2. Direct session jump: Alt+1 .. Alt+9
      if (e.altKey && !e.ctrlKey && !e.metaKey && e.key >= "1" && e.key <= "9") {
        const index = parseInt(e.key, 10) - 1;
        if (index < sessions.length) {
          e.preventDefault();
          e.stopPropagation();
          setActiveView(sessions[index].id);
          return;
        }
      }

      // Alt+0 or custom: Jump to Servers grid
      const serversCombo = getActiveShortcut("serversView");
      if (matchesKeyCombo(e, serversCombo) || (e.altKey && e.key === "`")) {
        e.preventDefault();
        e.stopPropagation();
        setActiveView("nodes");
        return;
      }

      // Session-scoped shortcuts (only when viewing an active server session)
      if (activeView.startsWith("session-")) {
        // Close active session
        if (matchesKeyCombo(e, getActiveShortcut("closeSession"))) {
          e.preventDefault();
          e.stopPropagation();
          onCloseSession(activeView);
          return;
        }

        // Split terminal horizontally
        if (matchesKeyCombo(e, getActiveShortcut("splitHorizontal"))) {
          e.preventDefault();
          e.stopPropagation();
          window.dispatchEvent(
            new CustomEvent(`submarine-split-terminal-${activeView}`, { detail: { orientation: "h" } })
          );
          return;
        }

        // Split terminal vertically
        if (matchesKeyCombo(e, getActiveShortcut("splitVertical"))) {
          e.preventDefault();
          e.stopPropagation();
          window.dispatchEvent(
            new CustomEvent(`submarine-split-terminal-${activeView}`, { detail: { orientation: "v" } })
          );
          return;
        }

        // New terminal tab
        if (matchesKeyCombo(e, getActiveShortcut("newTerminal"))) {
          e.preventDefault();
          e.stopPropagation();
          window.dispatchEvent(
            new CustomEvent(`submarine-new-terminal-${activeView}`)
          );
          return;
        }

        // Toggle SFTP workspace
        if (matchesKeyCombo(e, getActiveShortcut("toggleSftp"))) {
          e.preventDefault();
          e.stopPropagation();
          window.dispatchEvent(
            new CustomEvent(`submarine-toggle-sftp-${activeView}`)
          );
          return;
        }

        // Toggle Docker
        if (matchesKeyCombo(e, getActiveShortcut("toggleDocker"))) {
          e.preventDefault();
          e.stopPropagation();
          window.dispatchEvent(
            new CustomEvent(`subterm-toggle-tool-${activeView}`, { detail: { tool: "docker" } })
          );
          return;
        }

        // Toggle Processes
        if (matchesKeyCombo(e, getActiveShortcut("toggleProcesses"))) {
          e.preventDefault();
          e.stopPropagation();
          window.dispatchEvent(
            new CustomEvent(`subterm-toggle-tool-${activeView}`, { detail: { tool: "processes" } })
          );
          return;
        }

        // Toggle Services
        if (matchesKeyCombo(e, getActiveShortcut("toggleServices"))) {
          e.preventDefault();
          e.stopPropagation();
          window.dispatchEvent(
            new CustomEvent(`subterm-toggle-tool-${activeView}`, { detail: { tool: "services" } })
          );
          return;
        }

        // Toggle System Info
        if (matchesKeyCombo(e, getActiveShortcut("toggleInfo"))) {
          e.preventDefault();
          e.stopPropagation();
          window.dispatchEvent(
            new CustomEvent(`subterm-toggle-tool-${activeView}`, { detail: { tool: "info" } })
          );
          return;
        }

        // Quick Open / Edit Remote File
        if (matchesKeyCombo(e, getActiveShortcut("quickOpenFile"))) {
          e.preventDefault();
          e.stopPropagation();
          window.dispatchEvent(
            new CustomEvent(`submarine-quick-open-file-${activeView}`)
          );
          return;
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown, { capture: true });
    return () => {
      window.removeEventListener("keydown", handleKeyDown, { capture: true });
    };
  }, [enabled, sessions, activeView, setActiveView, onCloseSession, onOpenCommandPalette, onOpenLocalTerminal]);
}
