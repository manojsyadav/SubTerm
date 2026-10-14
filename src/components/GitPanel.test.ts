// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { GitPanel } from "./GitPanel";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: unknown) => invokeMock(cmd, args),
}));

vi.mock("../terminal/cwd", () => ({
  getTerminalCwd: vi.fn(() => "/home/user/project"),
  onTerminalCwdChange: vi.fn(() => () => {}),
  setTerminalGitBranch: vi.fn(),
  shellQuote: (s: string) => `'${s}'`,
}));

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  invokeMock.mockReset();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const sampleStatusOutput = [
  "## feat/x...origin/feat/x [ahead 1, behind 0]",
  "M  src/a.ts",
  " M src/b.ts",
  "?? newfile.txt",
  "",
].join("\0");

const sampleLogOutput = "abc1234\x1ffeat: initial commit\x1fManoj\x1fHEAD -> feat/x\x1f\n";

describe("GitPanel", () => {
  it("displays non-git repository message when status check fails", async () => {
    invokeMock.mockResolvedValueOnce({ exitCode: 128, stdout: "", stderr: "fatal: not a git repository" })
              .mockResolvedValueOnce({ exitCode: 128, stdout: "", stderr: "" });

    await act(async () => {
      root.render(createElement(GitPanel, {
        sessionId: "sess-1",
        terminalId: "term-1",
        visible: true,
      }));
    });

    expect(host.textContent).toContain("fatal: not a git repository");
  });

  it("renders branch, staged files, changes, and handles commit input", async () => {
    invokeMock.mockImplementation(async (_cmd: string, args: unknown) => {
      const command = (args as { command?: string })?.command || "";
      if (command.includes("status") && command.includes("porcelain")) {
        return { exitCode: 0, stdout: sampleStatusOutput, stderr: "" };
      }
      if (command.includes("log -n 50")) {
        return { exitCode: 0, stdout: sampleLogOutput, stderr: "" };
      }
      if (command.includes("commit")) {
        return { exitCode: 0, stdout: "[feat/x abc] feat: new changes", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    await act(async () => {
      root.render(createElement(GitPanel, {
        sessionId: "sess-1",
        terminalId: "term-1",
        visible: true,
      }));
    });

    // Check branch and files rendered
    expect(host.textContent).toContain("feat/x");
    expect(host.textContent).toContain("a.ts");
    expect(host.textContent).toContain("b.ts");
    expect(host.textContent).toContain("newfile.txt");

    // Commit button should be disabled without message
    const commitBtn = [...host.querySelectorAll("button")].find((b) => b.textContent?.includes("Commit"));
    expect(commitBtn).toBeDefined();
    expect(commitBtn?.hasAttribute("disabled")).toBe(true);

    // Type a commit message using React-compatible setter
    const textarea = host.querySelector("textarea") as HTMLTextAreaElement;
    expect(textarea).toBeDefined();
    await act(async () => {
      const desc = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value");
      desc?.set?.call(textarea, "feat: new changes");
      textarea.dispatchEvent(new Event("change", { bubbles: true }));
    });

    // Re-query commit button, should now be enabled
    const enabledCommitBtn = [...host.querySelectorAll("button")].find((b) => b.textContent?.includes("Commit"));
    expect(enabledCommitBtn?.hasAttribute("disabled")).toBe(false);

    // Click commit
    await act(async () => {
      enabledCommitBtn?.click();
    });

    expect(invokeMock).toHaveBeenCalledWith("ai_exec", expect.objectContaining({
      command: expect.stringContaining("commit"),
    }));
  });

  it("stages and unstages files on click", async () => {
    invokeMock.mockImplementation(async (_cmd: string, args: unknown) => {
      const command = (args as { command?: string })?.command || "";
      if (command.includes("status") && command.includes("porcelain")) {
        return { exitCode: 0, stdout: sampleStatusOutput, stderr: "" };
      }
      if (command.includes("log -n 50")) {
        return { exitCode: 0, stdout: sampleLogOutput, stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    await act(async () => {
      root.render(createElement(GitPanel, {
        sessionId: "sess-1",
        terminalId: "term-1",
        visible: true,
      }));
    });

    // Stage changes button
    const stageBtn = host.querySelector('button[aria-label="Stage src/b.ts"]') as HTMLButtonElement;
    expect(stageBtn).toBeDefined();
    await act(async () => {
      stageBtn.click();
    });

    expect(invokeMock).toHaveBeenCalledWith("ai_exec", expect.objectContaining({
      command: expect.stringContaining("git 'add' '--' ':(top,literal)src/b.ts'"),
    }));

    // Unstage changes button
    const unstageBtn = host.querySelector('button[aria-label="Unstage src/a.ts"]') as HTMLButtonElement;
    expect(unstageBtn).toBeDefined();
    await act(async () => {
      unstageBtn.click();
    });

    expect(invokeMock).toHaveBeenCalledWith("ai_exec", expect.objectContaining({
      command: expect.stringContaining("git 'restore' '--staged' '--' ':(top,literal)src/a.ts'"),
    }));
  });

  it("toggles overflow menu and triggers git actions", async () => {
    invokeMock.mockImplementation(async (_cmd: string, args: unknown) => {
      const command = (args as { command?: string })?.command || "";
      if (command.includes("status") && command.includes("porcelain")) {
        return { exitCode: 0, stdout: sampleStatusOutput, stderr: "" };
      }
      if (command.includes("log -n 50")) {
        return { exitCode: 0, stdout: sampleLogOutput, stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    await act(async () => {
      root.render(createElement(GitPanel, {
        sessionId: "sess-1",
        terminalId: "term-1",
        visible: true,
      }));
    });

    // Open more menu
    const moreBtn = host.querySelector('button[title="More Actions"]') as HTMLButtonElement;
    expect(moreBtn).toBeDefined();
    await act(async () => {
      moreBtn.click();
    });

    expect(host.textContent).toContain("Stage All Changes");
    expect(host.textContent).toContain("Fetch");

    const fetchBtn = [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Fetch");
    expect(fetchBtn).toBeDefined();
    await act(async () => {
      fetchBtn?.click();
    });

    expect(invokeMock).toHaveBeenCalledWith("ai_exec", expect.objectContaining({
      command: expect.stringContaining("git 'fetch' '--all' '--prune'"),
    }));
  });

  it("handles clean repository with Publish Branch or Sync Changes primary button", async () => {
    const cleanNoUpstream = "## main\0";
    invokeMock.mockImplementation(async (_cmd: string, args: unknown) => {
      const command = (args as { command?: string })?.command || "";
      if (command.includes("status") && command.includes("porcelain")) {
        return { exitCode: 0, stdout: cleanNoUpstream, stderr: "" };
      }
      if (command.includes("log -n 50")) {
        return { exitCode: 0, stdout: sampleLogOutput, stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    await act(async () => {
      root.render(createElement(GitPanel, {
        sessionId: "sess-local",
        terminalId: "term-local",
        isLocal: true,
        visible: true,
      }));
    });

    const publishBtn = [...host.querySelectorAll("button")].find((b) => b.textContent?.includes("Publish Branch"));
    expect(publishBtn).toBeDefined();

    await act(async () => {
      publishBtn?.click();
    });

    expect(invokeMock).toHaveBeenCalledWith("ai_exec", expect.objectContaining({
      command: expect.stringContaining("push"),
      sessionId: null,
    }));
  });
});

