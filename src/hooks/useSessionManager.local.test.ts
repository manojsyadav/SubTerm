// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { act } from "react-dom/test-utils";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));

const { useSessionManager, localShellEvent } = await import("./useSessionManager");

describe("local shells", () => {
  it("keep one Local tab and open further shells as sub-tabs in it", () => {
    let api!: ReturnType<typeof useSessionManager>;
    const Probe = () => { api = useSessionManager(); return null; };
    const root = createRoot(document.createElement("div"));
    act(() => root.render(createElement(Probe)));

    act(() => api.openLocalTerminal("pwsh"));
    expect(api.sessions).toHaveLength(1);
    const local = api.sessions[0];
    expect(local).toMatchObject({ isLocal: true, serverName: "Local", localShell: "pwsh" });
    expect(api.activeView).toBe(local.id);

    const asked: (string | undefined)[] = [];
    window.addEventListener(localShellEvent(local.id), (e) => asked.push((e as CustomEvent<{ shell?: string }>).detail.shell));
    act(() => { api.setActiveView("nodes"); });
    act(() => api.openLocalTerminal("wsl", true)); // picked from a shell menu
    act(() => api.openLocalTerminal(undefined, true)); // "New tab (default shell)"
    act(() => api.openLocalTerminal("pwsh")); // plain Local click: focus only

    expect(api.sessions).toHaveLength(1);
    expect(asked).toEqual(["wsl", undefined]);
    expect(api.activeView).toBe(local.id);
    act(() => root.unmount());
  });
});
