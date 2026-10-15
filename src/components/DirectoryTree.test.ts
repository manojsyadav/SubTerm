// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { FileProvider, ListResult } from "../fs/types";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { DirectoryTree } = await import("./DirectoryTree");

let host: HTMLDivElement;
let root: Root;
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function createMockProvider(): FileProvider {
  return {
    id: "local",
    label: "Local",
    pathSep: "/",
    homePath: vi.fn(async () => "/home/user"),
    list: vi.fn(async (path: string): Promise<ListResult> => {
      if (path === "/") {
        return {
          currentPath: "/",
          entries: [
            { name: "etc", path: "/etc", isDir: true, size: 4096 },
            { name: "home", path: "/home", isDir: true, size: 4096 },
            { name: "var", path: "/var", isDir: true, size: 4096 },
            { name: "file.txt", path: "/file.txt", isDir: false, size: 10 },
          ],
        };
      }
      if (path === "/etc") {
        return {
          currentPath: "/etc",
          entries: [
            { name: "nginx", path: "/etc/nginx", isDir: true, size: 4096 },
            { name: "hosts", path: "/etc/hosts", isDir: false, size: 200 },
          ],
        };
      }
      return { currentPath: path, entries: [] };
    }),
    joinPath: (dir: string, name: string) => (dir.endsWith("/") ? `${dir}${name}` : `${dir}/${name}`),
    parentPath: (path: string) => {
      const parts = path.split("/").filter(Boolean);
      parts.pop();
      return parts.length === 0 ? "/" : `/${parts.join("/")}`;
    },
    mkdir: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
    rename: vi.fn(async () => {}),
  };
}

describe("DirectoryTree component", () => {
  it("initializes and renders root directory and subfolders", async () => {
    const provider = createMockProvider();
    const onSelectPath = vi.fn();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);

    await act(async () => {
      root.render(
        createElement(DirectoryTree, {
          provider,
          currentPath: "/",
          onSelectPath,
        })
      );
    });

    // Wait for async effect
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });

    expect(provider.list).toHaveBeenCalledWith("/");
    expect(host.textContent).toContain("Root (/)");
    expect(host.textContent).toContain("etc");
    expect(host.textContent).toContain("home");
    expect(host.textContent).toContain("var");
    // Non-directories should not be in folder tree
    expect(host.textContent).not.toContain("file.txt");
  });

  it("selects directory path when clicked", async () => {
    const provider = createMockProvider();
    const onSelectPath = vi.fn();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);

    await act(async () => {
      root.render(
        createElement(DirectoryTree, {
          provider,
          currentPath: "/",
          onSelectPath,
        })
      );
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });

    const etcRow = [...host.querySelectorAll("div")].find(
      (el) => el.getAttribute("data-fs-drop-path") === "/etc"
    );
    expect(etcRow).toBeDefined();

    act(() => {
      etcRow!.click();
    });

    expect(onSelectPath).toHaveBeenCalledWith("/etc");
  });

  it("expands a folder node to fetch its children", async () => {
    const provider = createMockProvider();
    const onSelectPath = vi.fn();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);

    await act(async () => {
      root.render(
        createElement(DirectoryTree, {
          provider,
          currentPath: "/",
          onSelectPath,
        })
      );
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });

    const etcRow = [...host.querySelectorAll("div")].find(
      (el) => el.getAttribute("data-fs-drop-path") === "/etc"
    );
    const chevronBtn = etcRow!.querySelector("button")!;

    await act(async () => {
      chevronBtn.click();
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });

    expect(provider.list).toHaveBeenCalledWith("/etc");
    expect(host.textContent).toContain("nginx");
    expect(host.textContent).not.toContain("hosts");
  });
});
