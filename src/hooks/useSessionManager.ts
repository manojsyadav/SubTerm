import { useState, useCallback, useRef, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { QuickAuth } from "../components/QuickConnectModal";
import type { Server } from "../types";
import { isFeatureEnabled } from "../featureFlags";
import { getRdpOpenMode } from "../rdp/openMode";

export type Session = {
  id: string;
  serverId: number;
  serverName: string;
  mirrors?: string;
  runOnConnect?: string;
  quickAuth?: QuickAuth | null;
  initialTool?: "sftp" | "tunnels" | "mirrors" | "cmds" | "info" | null;
  /** Open the initial tool across the whole window instead of beside the terminal. */
  toolFull?: boolean;
  isLocal?: boolean;
  /** Embedded remote desktop tab (RdpSessionView) instead of an SSH session. */
  protocol?: "rdp";
  localShell?: string;
  isProduction?: boolean;
  icon?: string;
  color?: string | null;
  osInfo?: {
    os_type: string;
    distro: string;
    distro_id: string;
    version: string;
    kernel: string;
  };
};

interface UseSessionManagerOptions {
  onSessionClosed?: (sessionId: string) => void;
  onAddLog?: (msg: string, type?: string) => void;
  onQuickNodeSaved?: () => void;
  /** Show an RDP server inside SubTerm instead of launching the system client. */
  onOpenRdpEmbedded?: (server: Server) => void;
}

export function useSessionManager(options?: UseSessionManagerOptions) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeView, setActiveView] = useState<string>("nodes");
  const [sessionStatuses, setSessionStatuses] = useState<Record<string, string>>({});
  const [tabMenu, setTabMenu] = useState<{ x: number; y: number; sessionId: string } | null>(null);
  const [mergedSessionIds, setMergedSessionIds] = useState<string[]>([]);
  const [sessionSplitOrientation, setSessionSplitOrientation] = useState<"h" | "v">("h");
  const [sessionSplitRatios, setSessionSplitRatios] = useState<number[]>([]);
  const [mobileSessionPickerOpen, setMobileSessionPickerOpen] = useState(false);

  useEffect(() => {
    setSessionSplitRatios(prev => {
      if (prev.length === mergedSessionIds.length) return prev;
      return mergedSessionIds.map(() => 1);
    });
  }, [mergedSessionIds]);

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

  // RDP servers have no in-app session: they open the system's Remote Desktop client.
  const launchRdp = useCallback((server: Server) => {
    if (!isFeatureEnabled("rdpServers")) {
      options?.onAddLog?.("RDP servers are turned off in Settings > Feature Toggles.", "error");
      return;
    }
    if (getRdpOpenMode() === "embedded" && options?.onOpenRdpEmbedded) {
      options.onOpenRdpEmbedded(server);
      return;
    }
    invoke("launch_rdp", { id: server.id })
      .then(() => options?.onAddLog?.(`Opened Remote Desktop for ${server.name}`, "info"))
      .catch((e) => options?.onAddLog?.(`RDP_LAUNCH_FAILED (${server.name}): ${e}`, "error"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openServer = useCallback(
    (server: Server, initialTool?: Session["initialTool"], opts?: { fullWidth?: boolean }) => {
      if (server.protocol === "rdp") {
        launchRdp(server);
        return;
      }
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
              toolFull: !!(initialTool && opts?.fullWidth),
              isProduction: Boolean(server.is_production || /prod|production|live/i.test(server.name || "")),
              icon: server.icon || "server",
              color: server.color ?? null,
            },
          ];
        } else if (initialTool) {
          if (opts?.fullWidth) window.dispatchEvent(new CustomEvent(`subterm-tool-full-${sessionId}`));
          window.dispatchEvent(new CustomEvent(`submarine-set-tool-${sessionId}`, { detail: initialTool }));
        }
        return prev;
      });
      setActiveView(sessionId);
    },
    [launchRdp]
  );

  const openMultipleServers = useCallback(
    (allServers: Server[], onFleetBroadcast?: (ids: string[]) => void) => {
      if (!allServers || !allServers.length) return;
      allServers.filter((s) => s.protocol === "rdp").forEach(launchRdp);
      const serversToOpen = allServers.filter((s) => s.protocol !== "rdp");
      if (!serversToOpen.length) return;
      const newSessions: Session[] = [];
      const newIds: string[] = [];
      serversToOpen.forEach((srv) => {
        const sId = `session-${srv.id}`;
        newIds.push(sId);
        newSessions.push({
          id: sId,
          serverId: srv.id,
          serverName: srv.name,
          mirrors: srv.mirrors,
          runOnConnect: srv.run_on_connect || "",
          initialTool: null,
          isProduction: Boolean(srv.is_production || /prod|production|live/i.test(srv.name || "")),
          icon: srv.icon || "server",
          color: srv.color ?? null,
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
    (auth: QuickAuth, opts?: { save?: boolean; initialTool?: Session["initialTool"] }) => {
      const sessionId = `session-quick-${Date.now()}`;
      const displayName = `${auth.username}@${auth.host}:${auth.port}`;
      setSessions((prev) => [
        ...prev,
        {
          id: sessionId,
          serverId: 0,
          serverName: displayName,
          quickAuth: auth,
          initialTool: opts?.initialTool ?? null,
        },
      ]);
      setActiveView(sessionId);
      options?.onAddLog?.(`Quick connect → ${displayName}`, "info");

      if (opts?.save === false) return sessionId;
      invoke("save_quick_connect_node", { auth })
        .then(() => {
          options?.onQuickNodeSaved?.();
          options?.onAddLog?.(`Saved node → ${displayName}`, "success");
        })
        .catch((e) => options?.onAddLog?.(`QUICK_NODE_SAVE_FAILED: ${e}`, "error"));
      return sessionId;
    },
    [options]
  );

  const openLocalTerminal = useCallback((preferredShell?: string, forceNew = false) => {
    setSessions((prev) => {
      if (!forceNew) {
        // If an existing local session is open (matching preferred shell if specified), switch to it!
        const existing = prev.find((s) => s.isLocal && (!preferredShell || s.localShell === preferredShell));
        if (existing) {
          setActiveView(existing.id);
          return prev;
        }
      }
      const sessionId = `session-local-${Date.now()}`;
      setActiveView(sessionId);
      const shellLabel = preferredShell ? `Local (${preferredShell})` : "Local Shell";
      options?.onAddLog?.(`Opened local terminal${preferredShell ? ` (${preferredShell})` : ""}`, "info");
      return [
        ...prev,
        {
          id: sessionId,
          serverId: -1,
          serverName: shellLabel,
          isLocal: true,
          localShell: preferredShell,
          icon: "shell",
        },
      ];
    });
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
    sessionSplitOrientation,
    setSessionSplitOrientation,
    sessionSplitRatios,
    setSessionSplitRatios,
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
