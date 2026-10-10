// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createElement, useEffect, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { TerminalPanes } from "./TerminalPanes";

// React only flushes inside act() when this flag is set.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Stand-in for TerminalView: records every mount/unmount (a remount == lost xterm scrollback). */
const events: string[] = [];
function FakeTerminal({ id }: { id: string }) {
  useEffect(() => {
    events.push(`mount:${id}`);
    return () => { events.push(`unmount:${id}`); };
  }, [id]);
  return createElement("span", { "data-term": id });
}

const terminals = [{ id: "t1" }, { id: "t2" }, { id: "t3" }];

function layout(props: { split: string[]; orientation?: "h" | "v"; isCompact?: boolean; activeTab?: string }): ReactNode {
  return createElement(TerminalPanes, {
    terminals,
    splitTerminals: props.split,
    orientation: props.orientation ?? "h",
    ratios: props.split.map(() => 1),
    isCompact: props.isCompact ?? false,
    activeTab: props.activeTab ?? "t1",
    onFocusPane: () => {},
    renderPane: (t: { id: string }) => createElement(FakeTerminal, { id: t.id }),
  });
}

describe("TerminalPanes", () => {
  let host: HTMLDivElement;
  let root: Root;

  const render = (node: ReactNode) => act(() => { root.render(node); });

  beforeEach(() => {
    events.length = 0;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("mounts every terminal exactly once", () => {
    render(layout({ split: [] }));
    expect(events.sort()).toEqual(["mount:t1", "mount:t2", "mount:t3"]);
  });

  it("does NOT remount terminals when a split is created (scrollback regression)", () => {
    render(layout({ split: [] }));
    const before = [...host.querySelectorAll("[data-term]")];
    events.length = 0;

    render(layout({ split: ["t1", "t2"] }));

    expect(events).toEqual([]); // no unmount/mount at all
    // and the very same DOM nodes are still there
    expect([...host.querySelectorAll("[data-term]")]).toEqual(before);
  });

  it("keeps terminals mounted through add-pane, flip orientation, and unsplit", () => {
    render(layout({ split: [] }));
    events.length = 0;

    render(layout({ split: ["t1", "t2"] }));
    render(layout({ split: ["t1", "t2", "t3"] }));
    render(layout({ split: ["t1", "t2", "t3"], orientation: "v" }));
    render(layout({ split: ["t2", "t3"] })); // t1 leaves the split but stays mounted
    render(layout({ split: [] }));

    expect(events).toEqual([]);
  });

  it("keeps terminals mounted when the viewport turns compact while split", () => {
    render(layout({ split: ["t1", "t2"] }));
    events.length = 0;
    render(layout({ split: ["t1", "t2"], isCompact: true }));
    expect(events).toEqual([]);
  });

  it("only changes wrapper styling: split tiles are ordered, non-members are hidden", () => {
    render(layout({ split: ["t3", "t1"] }));
    const pane = (id: string) => host.querySelector<HTMLElement>(`[data-terminal-pane="${id}"]`)!;
    expect(pane("t3").style.order).toBe("0");
    expect(pane("t1").style.order).toBe("1");
    expect(pane("t2").className).toContain("hidden");

    render(layout({ split: [] , activeTab: "t2" }));
    expect(pane("t2").className).toContain("opacity-100");
    expect(pane("t1").className).toContain("opacity-0");
  });
});
