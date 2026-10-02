import { useState, useCallback, useRef, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { QuickAuth } from "../components/QuickConnectModal";

export type Session = {
  id: string;
  serverId: number;
  serverName: string;
  mirrors?: string;
  runOnConnect?: string;
  quickAuth?: QuickAuth | null;
  initialTool?: "sftp" | "tunnels" | "mirrors" | "cmds" | "info" | null;
  isLocal?: boolean;
};

interface UseSessionManagerOptions {
  onSessionClosed?: (sessionId: string) => void;
  onAddLog?: (msg: string, type?: string) => void;
  onQuickNodeSaved?: () => void;
}

export function useSessionManager(options?: UseSessionManagerOptions) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeView, setActiveView] = useState<string>("nodes");
  const [sessionStatuses, setSessionStatuses] = useState<Record<string, string>>({});
  const [tabMenu, setTabMenu] = useState<{ x: number; y: number; sessionId: string } | null>(null);
  const [mergedSessionIds, setMergedSessionIds] = useState<string[]>([]);
  const [mobileSessionPickerOpen, setMobileSessionPickerOpen] = useState(false);

  useEffect(() => {
    const onRelativeTab = (e: Event) => {
      const custom = e as CustomEvent<{ delta: number }>;
      const delta = custom.detail?.delta || 0;
      if (!delta || sessions.length <= 1) return;
      const idx = sessions.findIndex((s) => s.id === activeView);
      if (idx === -1) {
        if (sessions.length > 0) setActiveView(sessions[0].id);
        return;
      }
      const nextIdx = (idx + delta + sessions.length) % sessions.length;
      setActiveView(sessions[nextIdx].id);
    };
    window.addEventListener("submarine-switch-tab-relative", onRelativeTab);
    return () => window.removeEventListener("submarine-switch-tab-relative", onRelativeTab);
  }, [sessions, activeView]);

  const closeHandlersRef = useRef<Map<string, () => void>>(new Map());

  const handleSessionStatus = useCallback((sessionId: string, status: string) => {
    setSessionStatuses((prev) => (prev[sessionId] === status ? prev : { ...prev, [sessionId]: status }));
  }, []);

  const closeSession = useCallback(
    (sessId: string) => {
      invoke("disconnect_session", { sessionId: sessId }).catch(() => {});
      setSessions((prev) => prev.filter((s) => s.id !== sessId));
      setSessionStatuses((prev) => {
        const { [sessId]: _, ...rest } = prev;
        return rest;
      });
      setActiveView((prev) => (prev === sessId ? "nodes" : prev));
      setMergedSessionIds((prev) => {
        const next = prev.filter((id) => id !== sessId);
        return next.length < 2 ? [] : next;
      });
      options?.onSessionClosed?.(sessId);
      closeHandlersRef.current.delete(sessId);
    },
    [options]
  );

  const getCloseHandler = useCallback(
    (sessId: string) => {
      let h = closeHandlersRef.current.get(sessId);
      if (!h) {
        h = () => closeSession(sessId);
        closeHandlersRef.current.set(sessId, h);
      }
      return h;
    },
    [closeSession]
  );

  const openServer = useCallback(
    (server: any, initialTool?: Session["initialTool"]) => {
      const sessionId = `session-${server.id}`;
      setSessions((prev) => {
        const existing = prev.find((s) => s.id === sessionId);
        if (!existing) {
          return [
            ...prev,
            {
              id: sessionId,
              serverId: server.id,
              serverName: server.name,
              mirrors: server.mirrors,
              runOnConnect: server.run_on_connect || "",
              initialTool: initialTool || null,
            },
          ];
        } else if (initialTool) {
          window.dispatchEvent(new CustomEvent(`submarine-set-tool-${sessionId}`, { detail: initialTool }));
        }
        return prev;
      });
      setActiveView(sessionId);
    },
    []
  );

  const openMultipleServers = useCallback(
    (serversToOpen: any[], onFleetBroadcast?: (ids: string[]) => void) => {
      if (!serversToOpen || !serversToOpen.length) return;
      const newSessions: Session[] = [];
      const newIds: string[] = [];
      serversToOpen.forEach((srv: any) => {
        const sId = `session-${srv.id}`;
        newIds.push(sId);
        newSessions.push({
          id: sId,
          serverId: srv.id,
          serverName: srv.name,
          mirrors: srv.mirrors,
          runOnConnect: srv.run_on_connect || "",
          initialTool: null,
        });
      });
      setSessions((prev) => {
        const seen = new Set(prev.map((p) => p.id));
        const fresh = newSessions.filter((n) => !seen.has(n.id));
        return [...prev, ...fresh];
      });
      setActiveView(newIds[0]);
      if (newIds.length >= 2) {
        onFleetBroadcast?.(newIds);
      }
    },
    []
  );

  const openQuickConnect = useCallback(
    (auth: QuickAuth) => {
      const sessionId = `session-quick-${Date.now()}`;
      const displayName = `${auth.username}@${auth.host}:${auth.port}`;
      setSessions((prev) => [
        ...prev,
        {
          id: sessionId,
          serverId: 0,
          serverName: displayName,
          quickAuth: auth,
        },
      ]);
      setActiveView(sessionId);
      options?.onAddLog?.(`Quick connect → ${displayName}`, "info");

      invoke("save_quick_connect_node", { auth })
        .then(() => {
          options?.onQuickNodeSaved?.();
          options?.onAddLog?.(`Saved node → ${displayName}`, "success");
        })
        .catch((e) => options?.onAddLog?.(`QUICK_NODE_SAVE_FAILED: ${e}`, "error"));
    },
    [options]
  );

  const openLocalTerminal = useCallback(() => {
    const sessionId = `session-local-${Date.now()}`;
    setSessions((prev) => [
      ...prev,
      {
        id: sessionId,
        serverId: -1,
        serverName: "Local Terminal",
        isLocal: true,
      },
    ]);
    setActiveView(sessionId);
    options?.onAddLog?.("Opened local terminal", "info");
  }, [options]);

  return {
    sessions,
    setSessions,
    activeView,
    setActiveView,
    sessionStatuses,
    setSessionStatuses,
    tabMenu,
    setTabMenu,
    mergedSessionIds,
    setMergedSessionIds,
    mobileSessionPickerOpen,
    setMobileSessionPickerOpen,
    handleSessionStatus,
    getCloseHandler,
    closeSession,
    openServer,
    openMultipleServers,
    openQuickConnect,
    openLocalTerminal,
  };
}
