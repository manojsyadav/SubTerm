// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const invokeMock = vi.fn();
class FakeChannel { onmessage: ((raw: unknown) => void) | null = null; }
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...a: unknown[]) => invokeMock(...a),
  Channel: FakeChannel,
}));

const putImageData = vi.fn();
class FakeImageData { constructor(public data: Uint8ClampedArray, public width: number, public height: number) {} }
beforeEach(() => {
  (globalThis as unknown as { ImageData: unknown }).ImageData = FakeImageData;
  HTMLCanvasElement.prototype.getContext = (() => ({ putImageData })) as never;
});

const { default: RdpSessionView } = await import("./RdpSessionView");

let host: HTMLDivElement;
let root: Root;
let onClose: ReturnType<typeof vi.fn>;

beforeEach(() => {
  invokeMock.mockReset();
  putImageData.mockReset();
  onClose = vi.fn();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root.render(createElement(RdpSessionView, { serverId: 7, serverName: "win-1", onClose })));
});
afterEach(() => {
  invokeMock.mockResolvedValue(undefined); // the unmount disconnects the session, like the real invoke (always a promise)
  act(() => root.unmount());
  host.remove();
});

const text = () => host.textContent ?? "";
const bytes = (...n: number[]) => Uint8Array.from(n).buffer;

async function connect(): Promise<FakeChannel> {
  invokeMock.mockResolvedValueOnce("rdp-7-1");
  const input = host.querySelector("input[type=password]") as HTMLInputElement;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, "s3cret");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => { host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
  return invokeMock.mock.calls[0][1].onEvent as FakeChannel;
}

describe("RdpSessionView", () => {
  it("asks for the password first and connects with the server id and a screen size", async () => {
    expect(text()).toContain("Sign in to win-1");
    const channel = await connect();
    const [cmd, args] = invokeMock.mock.calls[0];
    expect(cmd).toBe("rdp_connect");
    expect(args).toMatchObject({ id: 7, password: "s3cret" });
    expect(args.width % 2).toBe(0);
    expect(args.width).toBeGreaterThanOrEqual(800);
    expect(channel).toBeInstanceOf(FakeChannel);
    expect(text()).toContain("Connecting");
  });

  it("asks before trusting a new certificate and sends the answer", async () => {
    const ch = await connect();
    invokeMock.mockResolvedValue(undefined);
    const ask = new TextEncoder().encode(JSON.stringify({ sessionId: "rdp-7-1", fingerprint: "SHA256:xyz", mismatch: false }));
    act(() => ch.onmessage!(Uint8Array.from([5, ...ask]).buffer));
    expect(text()).toContain("First connection to win-1");
    expect(text()).toContain("SHA256:xyz");
    const trust = [...host.querySelectorAll("button")].find((b) => b.textContent === "Trust and connect")!;
    act(() => trust.click());
    expect(invokeMock).toHaveBeenCalledWith("rdp_answer_certificate", { sessionId: "rdp-7-1", trust: true });
    expect(text()).not.toContain("SHA256:xyz");
  });

  it("goes live on the connected event and paints screen updates", async () => {
    const ch = await connect();
    act(() => ch.onmessage!(bytes(1, 0x00, 0x05, 0xd0, 0x02))); // 1280x720
    expect(text()).toContain("Connected");
    const canvas = host.querySelector("canvas")!;
    expect([canvas.width, canvas.height]).toEqual([1280, 720]);
    act(() => ch.onmessage!(bytes(2, 3, 0, 4, 0, 1, 0, 1, 0, 9, 8, 7, 255)));
    expect(putImageData).toHaveBeenCalledTimes(1);
    expect(putImageData.mock.calls[0].slice(1)).toEqual([3, 4]);
  });

  it("sends mapped key presses and releases to the session, and Ctrl+Alt+Del on request", async () => {
    const ch = await connect();
    act(() => ch.onmessage!(bytes(1, 0x00, 0x05, 0xd0, 0x02)));
    invokeMock.mockResolvedValue(undefined);
    const surface = host.querySelector("[tabindex='0']") as HTMLElement;
    act(() => { surface.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyA", bubbles: true, cancelable: true })); });
    act(() => { surface.dispatchEvent(new KeyboardEvent("keyup", { code: "KeyA", bubbles: true, cancelable: true })); });
    const sent = invokeMock.mock.calls.filter((c) => c[0] === "rdp_send_input").map((c) => c[1]);
    expect(sent[0]).toEqual({ sessionId: "rdp-7-1", data: [4, 0x1e, 0, 1] });
    expect(sent[1]).toEqual({ sessionId: "rdp-7-1", data: [4, 0x1e, 0, 0] });

    // keys with no mapping are not sent
    act(() => { surface.dispatchEvent(new KeyboardEvent("keydown", { code: "MediaPlayPause", bubbles: true, cancelable: true })); });
    expect(invokeMock.mock.calls.filter((c) => c[0] === "rdp_send_input")).toHaveLength(2);

    const cad = [...host.querySelectorAll("button")].find((b) => b.textContent?.includes("Ctrl+Alt+Del"))!;
    act(() => { cad.click(); });
    const last = invokeMock.mock.calls.filter((c) => c[0] === "rdp_send_input").pop()![1];
    expect(last.data).toHaveLength(24);
  });

  it("shows the server's error and offers to try again", async () => {
    const ch = await connect();
    act(() => ch.onmessage!(Uint8Array.from([3, ...new TextEncoder().encode("check the user name and password")]).buffer));
    act(() => ch.onmessage!(bytes(4)));
    expect(text()).toContain("check the user name and password");
    const retry = [...host.querySelectorAll("button")].find((b) => b.textContent === "Try again")!;
    act(() => { retry.click(); });
    expect(text()).toContain("Sign in to win-1");
  });

  it("reports a failed start without a session", async () => {
    invokeMock.mockRejectedValueOnce("The RDP component (subterm-rdp-helper.exe) was not found");
    await act(async () => { host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
    expect(text()).toContain("was not found");
  });

  it("disconnects the session when closed", async () => {
    await connect();
    invokeMock.mockResolvedValue(undefined);
    const close = [...host.querySelectorAll("button")].find((b) => b.textContent?.includes("Close") || b.textContent?.includes("Disconnect"))!;
    act(() => { close.click(); });
    expect(invokeMock).toHaveBeenCalledWith("rdp_disconnect", { sessionId: "rdp-7-1" });
    expect(onClose).toHaveBeenCalled();
  });
});
