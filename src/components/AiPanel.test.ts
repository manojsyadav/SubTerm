// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import type { ChatMsg } from "../ai/providers";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
Element.prototype.scrollTo = () => {};

let replies: ChatMsg[] = [];
// When set, ai_chat streams this text and then hangs until ai_cancel.
let hangWith: string | null = null;
let cancelHung: (() => void) | null = null;
let baseUrl = "http://localhost:11434/v1";
const invokeMock = vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
  if (cmd === "ai_list_providers") return [{ id: 1, name: "Ollama", kind: "openai", baseUrl, model: "qwen", hasKey: false }];
  if (cmd === "ai_cancel") { cancelHung?.(); return; }
  if (cmd === "ai_chat" && hangWith !== null) {
    (args!.onText as { onmessage?: (t: string) => void }).onmessage?.(hangWith);
    return new Promise((_, reject) => { cancelHung = () => reject("[AI] STOPPED"); });
  }
  if (cmd === "ai_chat") {
    const r = replies.shift() ?? { role: "assistant", content: "All done." };
    (args!.onText as { onmessage?: (t: string) => void }).onmessage?.(r.content);
    return r;
  }
  if (cmd === "ai_exec") return { stdout: "/dev/sda1 91%", stderr: "", exitCode: 0, truncated: false, timedOut: false };
  throw new Error(`unexpected ${cmd}`);
});
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) => invokeMock(cmd, args),
  Channel: class { onmessage?: (t: string) => void; },
}));
const confirmMock = vi.fn(async () => true);
vi.mock("../ui/confirm", () => ({ useConfirm: () => confirmMock }));

const { AiPanel } = await import("./AiPanel");

const toolCall = (command: string): ChatMsg => ({
  role: "assistant",
  content: "",
  toolCalls: [{ id: "c1", name: "run_command", arguments: JSON.stringify({ command }) }],
});

let host: HTMLDivElement;
let root: Root;
const flush = () => act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); });

async function mount(props: Partial<Parameters<typeof AiPanel>[0]> = {}) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root.render(createElement(AiPanel, {
      sessionId: "s1", target: "web-01", isLocal: false, canRun: true, isProd: false,
      readTerminal: () => "$ ls", onInsertCommand: vi.fn(), onClose: vi.fn(), open: true, ...props,
    }));
  });
  await flush();
}

const button = (label: string) =>
  [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === label || b.getAttribute("aria-label") === label)!;

async function ask(text: string) {
  const ta = host.querySelector("textarea")!;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    setter.call(ta, text);
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => { button("Send").click(); });
  await flush();
}

const execCalls = () => invokeMock.mock.calls.filter(([c]) => c === "ai_exec");

beforeEach(() => {
  localStorage.clear();
  invokeMock.mockClear();
  confirmMock.mockClear();
  replies = [];
  hangWith = null;
  baseUrl = "http://localhost:11434/v1";
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

describe("AiPanel", () => {
  it("Ask mode waits for approval, runs the command and continues", async () => {
    replies = [toolCall("df -h"), { role: "assistant", content: "Disk is 91% full." }];
    await mount();
    await ask("why is disk full");
    expect(host.textContent).toContain("Run this command on web-01?");
    expect(execCalls()).toHaveLength(0);
    await act(async () => { button("Run").click(); });
    await flush();
    expect(execCalls()[0][1]).toMatchObject({ sessionId: "s1", command: "df -h" });
    expect(host.textContent).toContain("Disk is 91% full.");
  });

  it("Skip stops without running anything", async () => {
    replies = [toolCall("rm -rf /tmp/cache")];
    await mount();
    await ask("clean up");
    await act(async () => { button("Skip").click(); });
    await flush();
    expect(execCalls()).toHaveLength(0);
    expect(host.textContent).toContain("Stopped because you skipped a command");
  });

  it("Auto runs read-only commands unasked, but still asks on a production server", async () => {
    localStorage.setItem("subterm-ai-mode", "auto");
    replies = [toolCall("df -h")];
    await mount();
    await ask("disk?");
    expect(execCalls()).toHaveLength(1);
    act(() => root.unmount());
    host.remove();

    replies = [toolCall("df -h")];
    await mount({ isProd: true });
    await ask("disk?");
    expect(host.textContent).toContain("Run this command on web-01?");
    expect(execCalls()).toHaveLength(1);
  });

  it("warns once before the first send to an online provider", async () => {
    baseUrl = "https://api.anthropic.com/v1";
    await mount();
    await ask("hi");
    await ask("again");
    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(invokeMock.mock.calls.filter(([c]) => c === "ai_chat")).toHaveLength(2);
  });

  it("does not warn for a local provider", async () => {
    await mount();
    await ask("hi");
    expect(confirmMock).not.toHaveBeenCalled();
  });

  it("sends an Explain request on its own", async () => {
    await mount({ seed: { text: "This command failed with exit code 1", nonce: 1 } });
    const chat = invokeMock.mock.calls.find(([c]) => c === "ai_chat")!;
    expect((chat[1]!.messages as ChatMsg[])[0].content).toContain("exit code 1");
  });

  it("Run & send in Suggest mode runs the block and sends the result back", async () => {
    localStorage.setItem("subterm-ai-mode", "suggest");
    replies = [{ role: "assistant", content: "Check with:\n```sh\nuptime\n```" }];
    await mount();
    await ask("load?");
    await act(async () => { button("Run & send").click(); });
    await flush();
    expect(execCalls()[0][1]).toMatchObject({ command: "uptime" });
    const lastChat = invokeMock.mock.calls.filter(([c]) => c === "ai_chat").at(-1)!;
    expect((lastChat[1]!.messages as ChatMsg[]).at(-1)!.content).toContain("/dev/sda1 91%");
    expect(lastChat[1]!.tools).toEqual([]);
  });

  it("Stop keeps the streamed text and frees the panel", async () => {
    hangWith = "Partial answer";
    await mount();
    await ask("long question");
    expect(button("Stop")).toBeTruthy();
    await act(async () => { button("Stop").click(); });
    await flush();
    expect(invokeMock.mock.calls.some(([c]) => c === "ai_cancel")).toBe(true);
    expect(host.textContent).toContain("Partial answer …(stopped)");
    expect(button("Send")).toBeTruthy();
  });

  it("offers only Suggest in a container shell", async () => {
    await mount({ canRun: false });
    expect(button("Ask").disabled).toBe(true);
    expect(button("Suggest").getAttribute("aria-checked")).toBe("true");
  });
});
