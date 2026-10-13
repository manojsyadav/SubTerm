import { useState, useCallback } from "react";

export type WallItem = { id: string; sessionId: string; terminalId: string };
export type SessionTerm = { id: string; title: string; container?: { name: string; useSudo: boolean }; shell?: string };

export function useWallManager() {
  // "Wall" pinboard — a permanent tab at the end of the session strip
  // that hosts a user-controlled grid of individual terminals. Each
  // pin is a (sessionId, terminalId) pair; the tile mounts its OWN
  // TerminalView with `attachOnly=true`, hitching onto the same PTY
  // as the primary xterm in the session tab.
  const [wallItems, setWallItems] = useState<WallItem[]>([]);
  // User-controlled grid density: 1..6.
  const [wallCols, setWallCols] = useState<number>(2);
  const [wallPickerOpen, setWallPickerOpen] = useState(false);
  // Per-session terminals + active terminal id, bubbled up from each
  // SessionView via onTerminalsChange. Sourced here so the Wall picker
  // and pin/unpin helpers can enumerate terminals.
  const [sessionTerminals, setSessionTerminals] = useState<Record<string, SessionTerm[]>>({});
  const [sessionActiveTerm, setSessionActiveTerm] = useState<Record<string, string>>({});

  const handleTerminalsChange = useCallback((sid: string, terms: SessionTerm[], activeTermId: string) => {
    setSessionTerminals((prev) => {
      const cur = prev[sid];
      if (cur && cur.length === terms.length && cur.every((t, i) => t.id === terms[i].id && t.title === terms[i].title)) {
        return prev;
      }
      return { ...prev, [sid]: terms };
    });
    setSessionActiveTerm((prev) => (prev[sid] === activeTermId ? prev : { ...prev, [sid]: activeTermId }));
  }, []);

  const wallHasTerminal = useCallback(
    (terminalId: string) => wallItems.some((i) => i.terminalId === terminalId),
    [wallItems]
  );

  const pinTerminalToWall = useCallback((sid: string, terminalId: string) => {
    setWallItems((prev) => {
      if (prev.some((i) => i.terminalId === terminalId)) return prev;
      return [...prev, { id: `wall-${terminalId}`, sessionId: sid, terminalId }];
    });
  }, []);

  const unpinTerminalFromWall = useCallback((terminalId: string) => {
    setWallItems((prev) => prev.filter((i) => i.terminalId !== terminalId));
  }, []);

  const unpinSessionFromWall = useCallback((sid: string) => {
    setWallItems((prev) => prev.filter((i) => i.sessionId !== sid));
  }, []);

  return {
    wallItems,
    setWallItems,
    wallCols,
    setWallCols,
    wallPickerOpen,
    setWallPickerOpen,
    sessionTerminals,
    sessionActiveTerm,
    handleTerminalsChange,
    wallHasTerminal,
    pinTerminalToWall,
    unpinTerminalFromWall,
    unpinSessionFromWall,
  };
}
