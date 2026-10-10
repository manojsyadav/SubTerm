// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createElement, forwardRef, useImperativeHandle } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));

const confirmMock = vi.fn();
vi.mock("../ui/confirm", () => ({ useConfirm: () => confirmMock }));

vi.mock("../fs/remoteProvider", () => ({ createRemoteProvider: (id: string) => ({ id: "remote", sessionId: id }) }));

// Stand-in FilePanel: records its props per session and exposes a handle.
type PanelProps = {
  sessionId: string; paneId: string;
  getOppositeDir: () => string | undefined;
  peerTransfer: { label: string; send: (items: unknown[], dir: string) => Promise<void> };
};
const panels: Record<string, PanelProps> = {};
const notes: string[] = [];
const refreshed: string[] = [];
const currentDirs: Record<string, string> = {};
vi.mock("./FilePanel", () => ({
  default: forwardRef((p: PanelProps, ref) => {
    panels[p.paneId] = p;
    useImperativeHandle(ref, () => ({
      refresh: async () => { refreshed.push(p.paneId); },
      currentDir: () => currentDirs[p.paneId] ?? "/",
      notify: (m: string) => { notes.push(m); },
      sendItems: async () => {},
    }));
    return createElement("div", { "data-pane": p.paneId });
  }),
}));

const { publishOpenSessions } = await import("../fs/sessionRegistry");
const { default: RemoteDualView } = await import("./RemoteDualView");

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  invokeMock.mockReset();
  confirmMock.mockReset();
  notes.length = 0;
  refreshed.length = 0;
  for (const k of Object.keys(panels)) delete panels[k];
  localStorage.clear();
  publishOpenSessions([
    { id: "s1", name: "web-1", connected: true, isLocal: false },
    { id: "s2", name: "db-1", connected: true, isLocal: false },
    { id: "s3", name: "offline", connected: false, isLocal: false },
    { id: "l1", name: "powershell", connected: true, isLocal: true },
  ]);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root.render(createElement(RemoteDualView, {
    hostSessionId: "s1", onDragMove: vi.fn(), registerPane: vi.fn(),
  })));
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

const file = (name: string, isDir = false) => ({ name, path: `/src/${name}`, isDir, size: 1 });

describe("RemoteDualView", () => {
  it("defaults to this server on the left and the first other connected server on the right", () => {
    expect(panels.remoteA.sessionId).toBe("s1");
    expect(panels.remoteB.sessionId).toBe("s2");
    expect(panels.remoteA.peerTransfer.label).toBe("db-1");
    // offline and local sessions are never offered
    const opts = [...host.querySelectorAll("select")[0].querySelectorAll("option")].map((o) => o.textContent);
    expect(opts).toEqual(["Choose a server…", "web-1", "db-1"]);
  });

  it("copies straight between the two sessions into the destination folder", async () => {
    invokeMock.mockResolvedValue(undefined);
    await act(async () => { await panels.remoteA.peerTransfer.send([file("a.txt"), file("dir", true)], "/dest/"); });
    expect(invokeMock).toHaveBeenCalledTimes(2);
    expect(invokeMock).toHaveBeenNthCalledWith(1, "sftp_copy_between_sessions", {
      srcSessionId: "s1", srcPath: "/src/a.txt", dstSessionId: "s2", dstPath: "/dest/a.txt",
      isDir: false, overwrite: false, eventSessionId: "s1",
    });
    expect(invokeMock.mock.calls[1][1]).toMatchObject({ srcPath: "/src/dir", dstPath: "/dest/dir", isDir: true });
    expect(refreshed).toContain("remoteB");
    expect(notes.some((n) => n.includes("Copied 2 of 2 items to db-1"))).toBe(true);
  });

  it("the right pane copies the other way", async () => {
    invokeMock.mockResolvedValue(undefined);
    await act(async () => { await panels.remoteB.peerTransfer.send([file("x")], "/in-web"); });
    expect(invokeMock.mock.calls[0][1]).toMatchObject({ srcSessionId: "s2", dstSessionId: "s1", dstPath: "/in-web/x" });
  });

  it("asks before replacing and retries with overwrite only when confirmed", async () => {
    invokeMock.mockRejectedValueOnce("EXISTS:/dest/a.txt").mockResolvedValueOnce(undefined);
    confirmMock.mockResolvedValueOnce(true);
    await act(async () => { await panels.remoteA.peerTransfer.send([file("a.txt")], "/dest"); });
    expect(invokeMock).toHaveBeenCalledTimes(2);
    expect(invokeMock.mock.calls[1][1]).toMatchObject({ overwrite: true });

    invokeMock.mockReset();
    invokeMock.mockRejectedValueOnce("EXISTS:/dest/b.txt");
    confirmMock.mockResolvedValueOnce(false);
    await act(async () => { await panels.remoteA.peerTransfer.send([file("b.txt")], "/dest"); });
    expect(invokeMock).toHaveBeenCalledTimes(1); // declined: no overwrite attempt
  });

  it("stops the batch when the user cancels and reports other failures without stopping", async () => {
    invokeMock.mockRejectedValueOnce("boom").mockRejectedValueOnce("cancelled");
    await act(async () => { await panels.remoteA.peerTransfer.send([file("1"), file("2"), file("3")], "/d"); });
    expect(invokeMock).toHaveBeenCalledTimes(2); // third never attempted
    expect(notes.some((n) => n.includes("Copy failed for 1"))).toBe(true);
    expect(notes).toContain("Copy cancelled");
  });
});
