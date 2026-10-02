import { useEffect } from "react";

interface GlobalShortcutsProps {
  enabled: boolean;
  sessions: { id: string; serverName: string }[];
  activeView: string;
  setActiveView: (id: string) => void;
  onCloseSession: (id: string) => void;
  onOpenCommandPalette?: () => void;
}

export function useGlobalShortcuts({
  enabled,
  sessions,
  activeView,
  setActiveView,
  onCloseSession,
  onOpenCommandPalette,
}: GlobalShortcutsProps) {
  useEffect(() => {
    if (!enabled) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      // 0. Global Command Palette: Ctrl+K / Cmd+K / Ctrl+Shift+P / F1
      const isCmdPaletteKey =
        ((e.ctrlKey || e.metaKey) && (e.key === "K" || e.key === "k")) ||
        ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === "P" || e.key === "p")) ||
        e.key === "F1";

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

      // 1. Session cycling: Ctrl+Tab / Ctrl+Shift+Tab
      if (e.ctrlKey && e.key === "Tab") {
        e.preventDefault();
        e.stopPropagation();
        if (sessions.length === 0) return;
        const views = ["nodes", ...sessions.map((s) => s.id)];
        const currentIndex = views.indexOf(activeView);
        const nextIndex = e.shiftKey
          ? (currentIndex - 1 + views.length) % views.length
          : (currentIndex + 1) % views.length;
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

      // Alt+0 or Alt+` jumps to Servers grid
      if (e.altKey && (e.key === "0" || e.key === "`")) {
        e.preventDefault();
        e.stopPropagation();
        setActiveView("nodes");
        return;
      }

      // Session-scoped shortcuts (only when viewing an active server session)
      if (activeView.startsWith("session-")) {
        // 3. Close active session: Ctrl+Shift+W
        if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === "W" || e.key === "w")) {
          e.preventDefault();
          e.stopPropagation();
          onCloseSession(activeView);
          return;
        }

        // 4. Split terminal horizontally: Ctrl+\ or Ctrl+Shift+D
        if (((e.ctrlKey || e.metaKey) && e.key === "\\") ||
            ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === "D" || e.key === "d"))) {
          e.preventDefault();
          e.stopPropagation();
          window.dispatchEvent(
            new CustomEvent(`submarine-split-terminal-${activeView}`, { detail: { orientation: "h" } })
          );
          return;
        }

        // 5. Split terminal vertically: Ctrl+Shift+E
        if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === "E" || e.key === "e")) {
          e.preventDefault();
          e.stopPropagation();
          window.dispatchEvent(
            new CustomEvent(`submarine-split-terminal-${activeView}`, { detail: { orientation: "v" } })
          );
          return;
        }

        // 6. New terminal tab: Ctrl+Shift+T
        if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === "T" || e.key === "t")) {
          e.preventDefault();
          e.stopPropagation();
          window.dispatchEvent(
            new CustomEvent(`submarine-new-terminal-${activeView}`)
          );
          return;
        }

        // 7. Toggle SFTP workspace: Ctrl+Shift+F
        if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === "F" || e.key === "f")) {
          e.preventDefault();
          e.stopPropagation();
          window.dispatchEvent(
            new CustomEvent(`submarine-toggle-sftp-${activeView}`)
          );
          return;
        }

        // 8. Quick Open / Edit Remote File: Alt+E, Ctrl+Shift+O, or Ctrl+Alt+E
        if (
          (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === "e" || e.key === "E")) ||
          ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === "O" || e.key === "o")) ||
          ((e.ctrlKey || e.metaKey) && e.altKey && (e.key === "e" || e.key === "E"))
        ) {
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
  }, [enabled, sessions, activeView, setActiveView, onCloseSession]);
}
