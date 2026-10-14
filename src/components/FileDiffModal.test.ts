// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { FileDiffModal, type DiffFileRef } from "./FileDiffModal";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: unknown) => invokeMock(cmd, args),
}));

let host: HTMLDivElement;
let root: Root;
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

beforeEach(() => {
  invokeMock.mockReset();
});

function render(extra: Record<string, unknown> = {}) {
  const left: DiffFileRef = { label: "Local Config", path: "C:/app/config.json", provider: "local" };
  const right: DiffFileRef = { label: "Remote Config", path: "/etc/app/config.json", provider: "remote", sessionId: "sess-1" };
  const props = {
    isOpen: true,
    onClose: vi.fn(),
    left,
    right,
    onOverwritten: vi.fn(),
    ...extra,
  };
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root.render(createElement(FileDiffModal, props)));
  return props;
}

describe("FileDiffModal", () => {
  it("reads left and right files and displays diff with stats", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "local_read_file_text") return Promise.resolve("port=8080\nenv=prod");
      if (cmd === "sftp_read_file_text") return Promise.resolve("port=8080\nenv=staging");
      return Promise.resolve();
    });

    render();

    // Wait for file reads to complete
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(host.textContent).toContain("Local Config");
    expect(host.textContent).toContain("Remote Config");
    expect(host.textContent).toContain("1 additions");
    expect(host.textContent).toContain("1 deletions");
    expect(host.textContent).toContain("env=staging");
  });

  it("handles left-to-right overwrite and fires callback", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "local_read_file_text") return Promise.resolve("v2");
      if (cmd === "sftp_read_file_text") return Promise.resolve("v1");
      if (cmd === "sftp_write_file_text") return Promise.resolve();
      return Promise.resolve();
    });

    const p = render();

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const overwriteBtn = [...host.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Use Left →")
    );
    expect(overwriteBtn).toBeDefined();

    await act(async () => {
      overwriteBtn?.click();
      await Promise.resolve();
    });

    expect(invokeMock).toHaveBeenCalledWith("sftp_write_file_text", {
      sessionId: "sess-1",
      remotePath: "/etc/app/config.json",
      content: "v2",
    });
    expect(p.onOverwritten).toHaveBeenCalled();
  });

  it("surfaces file read errors", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "local_read_file_text") return Promise.reject(new Error("Permission denied"));
      return Promise.resolve("some content");
    });

    render();

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(host.textContent).toContain("Permission denied");
  });
});
