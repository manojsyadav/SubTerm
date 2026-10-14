import type { Session } from "../hooks/useSessionManager";

export interface McpSettings {
  enabled: boolean;
  port: number;
  token: string;
}

const KEY = "subterm-mcp";
export const MCP_CHANGED = "subterm-mcp-changed";
export const DEFAULT_PORT = 47821;

export function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function getMcpSettings(): McpSettings {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || "{}");
    return { enabled: !!s.enabled, port: Number(s.port) || DEFAULT_PORT, token: typeof s.token === "string" ? s.token : "" };
  } catch {
    return { enabled: false, port: DEFAULT_PORT, token: "" };
  }
}

export function saveMcpSettings(s: McpSettings) {
  localStorage.setItem(KEY, JSON.stringify(s));
  window.dispatchEvent(new Event(MCP_CHANGED));
}

export const mcpUrl = (port: number) => `http://127.0.0.1:${port}/mcp`;

export const claudeAddCommand = (s: McpSettings) =>
  `claude mcp add --transport http subterm ${mcpUrl(s.port)} --header "Authorization: Bearer ${s.token}"`;

/** SSH sessions an agent may see: terminals only, not the SFTP page's own connections, local shells or RDP. */
export const mcpSessions = (sessions: Session[]) =>
  sessions
    .filter((s) => !s.isLocal && s.protocol !== "rdp" && !s.id.startsWith("session-sftp-"))
    .map((s) => ({ id: s.id, name: s.serverName, production: !!s.isProduction }));
