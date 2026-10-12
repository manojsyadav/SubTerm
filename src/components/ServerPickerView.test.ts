// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { ServerPickerView } from "./ServerPickerView";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const servers = [
  { id: 1, name: "web", host: "10.0.0.11", port: 22, username: "root", protocol: "ssh" },
  { id: 2, name: "db", host: "10.0.0.12", port: 22, username: "", protocol: "ssh" },
  { id: 3, name: "win", host: "10.0.0.13", port: 3389, username: "admin", protocol: "rdp" },
] as never;

let host: HTMLDivElement;
let root: Root;
const onOpen = vi.fn();

const mount = (props: Record<string, unknown> = {}) =>
  act(() => {
    root.render(createElement(ServerPickerView as never, {
      title: "SFTP", subtitle: "s", icon: null, servers,
      include: (s: { protocol: string }) => s.protocol !== "rdp",
      actionLabel: "Open", onOpen, emptyText: "nothing here", ...props,
    }));
  });

beforeEach(() => {
  onOpen.mockReset();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

describe("ServerPickerView", () => {
  it("lists only the servers the page includes and opens the clicked one", () => {
    mount();
    const cards = [...host.querySelectorAll("button")].filter((b) => b.textContent?.includes("Open"));
    expect(cards.map((c) => c.textContent)).toEqual([expect.stringContaining("db"), expect.stringContaining("web")]);
    act(() => { cards[1].dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }));
  });

  it("filters by search text", () => {
    mount();
    const input = host.querySelector("input")!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    act(() => { setter.call(input, "0.12"); input.dispatchEvent(new Event("input", { bubbles: true })); });
    expect(host.textContent).toContain("db");
    expect(host.textContent).not.toContain("web");
  });

  it("shows the empty text and the add button for an empty page", () => {
    const onAdd = vi.fn();
    mount({ include: (s: { protocol: string }) => s.protocol === "none", onAdd, addLabel: "New one" });
    expect(host.textContent).toContain("nothing here");
    const add = [...host.querySelectorAll("button")].find((b) => b.textContent?.includes("New one"))!;
    act(() => { add.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(onAdd).toHaveBeenCalled();
  });
});
