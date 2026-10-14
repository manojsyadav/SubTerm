// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import {
  CommandEditPanel,
  NoteEditPanel,
  CredentialEditPanel,
  KeyEditPanel,
} from "./VaultEditPanels";

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

describe("CommandEditPanel", () => {
  it("renders when open and requires title and content", async () => {
    const addLog = vi.fn();
    const setFormError = vi.fn();
    const props = {
      isOpen: true,
      onClose: vi.fn(),
      data: { id: null, title: "", content: "", serverId: null, tags: "" },
      setData: vi.fn(),
      servers: [],
      formError: "",
      setFormError,
      addLog,
      refreshCommands: vi.fn(),
      bumpSync: vi.fn(),
    };
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root.render(createElement(CommandEditPanel, props)));

    expect(host.textContent).toContain("New command");
    const saveBtn = [...host.querySelectorAll("button")].find((b) => b.textContent === "Save");
    expect(saveBtn).toBeDefined();

    await act(async () => {
      saveBtn?.click();
    });

    expect(addLog).toHaveBeenCalledWith("Title and Content are required.", "error");
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("saves a valid new command and closes", async () => {
    invokeMock.mockResolvedValueOnce({ id: 1 });
    const onClose = vi.fn();
    const refreshCommands = vi.fn();
    const bumpSync = vi.fn();
    const addLog = vi.fn();

    const props = {
      isOpen: true,
      onClose,
      data: { id: null, title: "Deploy", content: "docker compose up -d", serverId: null, tags: "prod" },
      setData: vi.fn(),
      servers: [],
      formError: "",
      setFormError: vi.fn(),
      addLog,
      refreshCommands,
      bumpSync,
    };
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root.render(createElement(CommandEditPanel, props)));

    const saveBtn = [...host.querySelectorAll("button")].find((b) => b.textContent === "Save");
    await act(async () => {
      saveBtn?.click();
    });

    expect(invokeMock).toHaveBeenCalledWith("add_command", {
      title: "Deploy",
      content: "docker compose up -d",
      serverId: null,
      tags: "prod",
    });
    expect(onClose).toHaveBeenCalled();
    expect(refreshCommands).toHaveBeenCalled();
    expect(bumpSync).toHaveBeenCalled();
    expect(addLog).toHaveBeenCalledWith("Command saved.", "success");
  });
});

describe("NoteEditPanel", () => {
  it("saves a valid note", async () => {
    invokeMock.mockResolvedValueOnce({ id: 2 });
    const onClose = vi.fn();
    const refreshNotes = vi.fn();
    const bumpSync = vi.fn();

    const props = {
      isOpen: true,
      onClose,
      data: { id: null, title: "Server Arch", body: "Architecture details" },
      setData: vi.fn(),
      formError: "",
      setFormError: vi.fn(),
      addLog: vi.fn(),
      refreshNotes,
      bumpSync,
    };
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root.render(createElement(NoteEditPanel, props)));

    const saveBtn = [...host.querySelectorAll("button")].find((b) => b.textContent === "Save");
    await act(async () => {
      saveBtn?.click();
    });

    expect(invokeMock).toHaveBeenCalledWith("add_note", {
      title: "Server Arch",
      body: "Architecture details",
    });
    expect(onClose).toHaveBeenCalled();
    expect(refreshNotes).toHaveBeenCalled();
    expect(bumpSync).toHaveBeenCalled();
  });
});

describe("CredentialEditPanel", () => {
  it("saves valid credential", async () => {
    invokeMock.mockResolvedValueOnce({ id: 5 });
    const onClose = vi.fn();
    const refreshCredentials = vi.fn();
    const bumpSync = vi.fn();

    const props = {
      isOpen: true,
      onClose,
      data: { id: null, name: "prod-db", auth_type: "password", username: "admin", password: "secretPassword", key_id: null },
      setData: vi.fn(),
      sshKeys: [],
      formError: "",
      setFormError: vi.fn(),
      addLog: vi.fn(),
      refreshCredentials,
      bumpSync,
    };
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root.render(createElement(CredentialEditPanel, props)));

    const saveBtn = [...host.querySelectorAll("button")].find((b) => b.textContent === "Save");
    await act(async () => {
      saveBtn?.click();
    });

    expect(invokeMock).toHaveBeenCalledWith("add_credential", {
      name: "prod-db",
      authType: "password",
      username: "admin",
      password: "secretPassword",
      keyId: null,
    });
    expect(onClose).toHaveBeenCalled();
    expect(refreshCredentials).toHaveBeenCalled();
    expect(bumpSync).toHaveBeenCalled();
  });
});

describe("KeyEditPanel", () => {
  it("saves valid SSH key", async () => {
    invokeMock.mockResolvedValueOnce({ id: 10 });
    const onClose = vi.fn();
    const refreshSshKeys = vi.fn();
    const bumpSync = vi.fn();

    const props = {
      isOpen: true,
      onClose,
      data: { id: null, name: "id_ed25519", public_key: "ssh-ed25519 AAA...", private_key: "-----BEGIN OPENSSH PRIVATE KEY-----...", passphrase: "" },
      setData: vi.fn(),
      formError: "",
      setFormError: vi.fn(),
      addLog: vi.fn(),
      refreshSshKeys,
      bumpSync,
    };
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root.render(createElement(KeyEditPanel, props)));

    const saveBtn = [...host.querySelectorAll("button")].find((b) => b.textContent === "Save");
    await act(async () => {
      saveBtn?.click();
    });

    expect(invokeMock).toHaveBeenCalledWith("add_ssh_key", {
      name: "id_ed25519",
      publicKey: "ssh-ed25519 AAA...",
      privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----...",
      passphrase: null,
    });
    expect(onClose).toHaveBeenCalled();
    expect(refreshSshKeys).toHaveBeenCalled();
    expect(bumpSync).toHaveBeenCalled();
  });
});
