// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import type { Session } from "../hooks/useSessionManager";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const invokeMock = vi.fn(async (_cmd: string, _args?: unknown) => undefined);
vi.mock("@tauri-apps/api/core", () => ({ invoke: (cmd: string, args?: unknown) => invokeMock(cmd, args) }));
let approvalHandler: ((e: { payload: unknown }) => void) | null = null;
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (_name: string, cb: (e: { payload: unknown }) => void) => { approvalHandler = cb; return () => {}; }),
}));
let answer = true;
const confirmMock = vi.fn(async () => answer);
vi.mock("../ui/confirm", () => ({ useConfirm: () => confirmMock }));

const { McpBridge } = await import("./McpBridge");
const { saveMcpSettings, mcpSessions } = await import("../ai/mcp");

const sessions: Session[] = [
  { id: "session-1", serverId: 1, serverName: "web-01" },
  { id: "session-2", serverId: 2, serverName: "db", isProduction: true },
  { id: "session-sftp-1", serverId: 1, serverName: "web-01" },
  { id: "local-1", serverId: 0, serverName: "Local", isLocal: true },
  { id: "session-rdp-3", serverId: 3, serverName: "win", protocol: "rdp" },
];

let host: HTMLDivElement;
let root: Root;
const flush = () => act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); });
const calls = (cmd: string) => invokeMock.mock.calls.filter(([c]) => c === cmd);

beforeEach(async () => {
  localStorage.clear();
  invokeMock.mockClear();
  confirmMock.mockClear();
  answer = true;
  saveMcpSettings({ enabled: true, port: 47821, token: "x".repeat(48) });
  host = document.createElement("div");
  root = createRoot(host);
  await act(async () => { root.render(createElement(McpBridge, { sessions })); });
  await flush();
});
afterEach(() => { act(() => root.unmount()); });

describe("McpBridge", () => {
  it("offers only SSH terminal sessions to agents", () => {
    expect(mcpSessions(sessions)).toEqual([
      { id: "session-1", name: "web-01", production: false },
      { id: "session-2", name: "db", production: true },
    ]);
    expect(calls("mcp_set_sessions").at(-1)![1]).toEqual({ sessions: mcpSessions(sessions) });
  });

  it("starts the server when enabled and stops it when switched off", async () => {
    expect(calls("mcp_start")[0][1]).toEqual({ port: 47821, token: "x".repeat(48) });
    await act(async () => { saveMcpSettings({ enabled: false, port: 47821, token: "x".repeat(48) }); });
    expect(calls("mcp_stop").length).toBeGreaterThan(0);
  });

  it("asks the user and passes the answer back", async () => {
    await act(async () => {
      approvalHandler!({ payload: { requestId: "r1", session: "db", production: true, command: "systemctl restart nginx", client: "claude-code" } });
    });
    await flush();
    expect(confirmMock).toHaveBeenCalledWith(expect.objectContaining({ destructive: true, message: expect.stringContaining("systemctl restart nginx") }));
    expect(calls("mcp_answer")[0][1]).toEqual({ requestId: "r1", approved: true });

    answer = false;
    await act(async () => { approvalHandler!({ payload: { requestId: "r2", session: "web-01", production: false, command: "ls", client: "x" } }); });
    await flush();
    expect(calls("mcp_answer")[1][1]).toEqual({ requestId: "r2", approved: false });
  });
});
