import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Session } from "../hooks/useSessionManager";
import { MCP_CHANGED, getMcpSettings, mcpSessions } from "../ai/mcp";
import { useConfirm } from "../ui/confirm";

interface Approval {
  requestId: string;
  session: string;
  production: boolean;
  command: string;
  client: string;
}

/** Runs the MCP server while it is switched on and answers its approval requests. Renders nothing. */
export function McpBridge({ sessions, onError }: { sessions: Session[]; onError?: (msg: string) => void }) {
  const confirm = useConfirm();
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  useEffect(() => {
    const apply = () => {
      const s = getMcpSettings();
      if (s.enabled && s.token) {
        invoke("mcp_start", { port: s.port, token: s.token }).catch((e) => onErrorRef.current?.(`MCP server: ${e}`));
      } else {
        invoke("mcp_stop").catch(() => {});
      }
    };
    apply();
    window.addEventListener(MCP_CHANGED, apply);
    return () => {
      window.removeEventListener(MCP_CHANGED, apply);
      invoke("mcp_stop").catch(() => {});
    };
  }, []);

  useEffect(() => {
    invoke("mcp_set_sessions", { sessions: mcpSessions(sessions) }).catch(() => {});
  }, [sessions]);

  // One dialog at a time; requests that arrive meanwhile wait their turn.
  const queue = useRef<Promise<void>>(Promise.resolve());
  useEffect(() => {
    const off = listen<Approval>("mcp-approval", ({ payload: a }) => {
      queue.current = queue.current.then(async () => {
        const ok = await confirm({
          title: a.production ? "Agent command on a production server" : "Agent command",
          message: `${a.client} wants to run this on ${a.session}:\n\n${a.command}`,
          okLabel: "Run",
          cancelLabel: "Decline",
          destructive: a.production,
        });
        await invoke("mcp_answer", { requestId: a.requestId, approved: ok }).catch(() => {});
      });
    });
    return () => { off.then((f) => f()); };
  }, [confirm]);

  return null;
}
