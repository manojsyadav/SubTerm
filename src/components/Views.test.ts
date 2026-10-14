// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { LogsView, type LogEntry } from "./LogsView";
import { LibraryView } from "./LibraryView";
import { LoginsView } from "./LoginsView";
import type { SavedCommand, Note, Credential, SshKey } from "../types";

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

describe("LogsView", () => {
  it("renders log entries and allows clearing", async () => {
    const logs: LogEntry[] = [
      { id: "1", time: "12:00:01", msg: "Connected to server", type: "success" },
      { id: "2", time: "12:00:05", msg: "Connection dropped", type: "error" },
    ];
    const setLogs = vi.fn();
    const confirm = vi.fn().mockResolvedValue(true);

    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() =>
      root.render(
        createElement(LogsView, {
          logs,
          setActiveView: vi.fn(),
          setLogs,
          confirm,
        })
      )
    );

    expect(host.textContent).toContain("Connected to server");
    expect(host.textContent).toContain("Connection dropped");

    const clearBtn = [...host.querySelectorAll("button")].find((b) => b.textContent?.includes("Clear"));
    expect(clearBtn).toBeDefined();

    await act(async () => {
      clearBtn?.click();
    });

    expect(confirm).toHaveBeenCalled();
    expect(setLogs).toHaveBeenCalledWith([]);
  });

  it("shows empty state when no logs exist", () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() =>
      root.render(
        createElement(LogsView, {
          logs: [],
          setActiveView: vi.fn(),
          setLogs: vi.fn(),
          confirm: vi.fn(),
        })
      )
    );

    expect(host.textContent).toContain("Nothing yet.");
  });
});

describe("LibraryView", () => {
  const commands: SavedCommand[] = [
    { id: 1, title: "Restart Nginx", content: "systemctl restart nginx", tags: "prod", serverId: null },
    { id: 2, title: "Docker Status", content: "docker ps", tags: "docker", serverId: null },
  ];
  const notes: Note[] = [
    { id: 1, title: "Deploy Docs", body: "Run ansible playbook" },
  ];

  it("filters commands and handles switching tabs", () => {
    const setLibraryQuery = vi.fn();
    const setLibraryTab = vi.fn();
    const setIsCommandPanelOpen = vi.fn();

    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() =>
      root.render(
        createElement(LibraryView, {
          libraryQuery: "nginx",
          setLibraryQuery,
          libraryTab: "commands",
          setLibraryTab,
          commands,
          notes,
          servers: [],
          sessions: [],
          confirm: vi.fn(),
          refreshCommands: vi.fn(),
          refreshNotes: vi.fn(),
          bumpSync: vi.fn(),
          handleExecuteSnippet: vi.fn(),
          setEditCommandData: vi.fn(),
          setIsCommandPanelOpen,
          setEditNoteData: vi.fn(),
          setIsNotePanelOpen: vi.fn(),
        })
      )
    );

    expect(host.textContent).toContain("Restart Nginx");
    expect(host.textContent).not.toContain("Docker Status");

    const addBtn = [...host.querySelectorAll("button")].find((b) => b.textContent?.includes("Add Command"));
    expect(addBtn).toBeDefined();
    act(() => addBtn?.click());
    expect(setIsCommandPanelOpen).toHaveBeenCalledWith(true);
  });
});

describe("LoginsView", () => {
  const credentials: Credential[] = [
    { id: 1, name: "Database", username: "postgres", auth_type: "password", has_password: true, key_id: null },
  ];
  const sshKeys: SshKey[] = [
    { id: 1, name: "Deploy Key", public_key: "ssh-ed25519 AAAA...", has_private_key: true, has_passphrase: false },
  ];

  it("renders credentials and keys and opens edit panels", () => {
    const setIsCredPanelOpen = vi.fn();
    const setIsKeyPanelOpen = vi.fn();

    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() =>
      root.render(
        createElement(LoginsView, {
          credentials,
          sshKeys,
          addLog: vi.fn(),
          confirm: vi.fn(),
          refreshCredentials: vi.fn(),
          refreshSshKeys: vi.fn(),
          bumpSync: vi.fn(),
          setEditCredData: vi.fn(),
          setIsCredPanelOpen,
          setEditKeyData: vi.fn(),
          setIsKeyPanelOpen,
          textPrompt: vi.fn(),
        })
      )
    );

    expect(host.textContent).toContain("Database");
    expect(host.textContent).toContain("Deploy Key");

    const addPwdBtn = [...host.querySelectorAll("button")].find((b) => b.title === "Add Password");
    act(() => addPwdBtn?.click());
    expect(setIsCredPanelOpen).toHaveBeenCalledWith(true);

    const addKeyBtn = [...host.querySelectorAll("button")].find((b) => b.title === "Add Key");
    act(() => addKeyBtn?.click());
    expect(setIsKeyPanelOpen).toHaveBeenCalledWith(true);
  });
});
