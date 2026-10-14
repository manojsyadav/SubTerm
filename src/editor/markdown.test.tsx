// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const invoke = vi.fn(() => Promise.resolve());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const { parseMarkdown, MarkdownView } = await import("./markdown");

describe("parseMarkdown", () => {
  it("reads headings, paragraphs, fences, rules and quotes", () => {
    const md = "# Title\n\nSome *text*\nmore\n\n```bash\nls -la\n```\n\n---\n> quoted\n> line\n\nSetext\n===";
    expect(parseMarkdown(md)).toEqual([
      { t: "h", level: 1, text: "Title" },
      { t: "p", text: "Some *text*\nmore" },
      { t: "code", lang: "bash", text: "ls -la" },
      { t: "hr" },
      { t: "quote", blocks: [{ t: "p", text: "quoted\nline" }] },
      { t: "h", level: 1, text: "Setext" },
    ]);
  });

  it("nests lists and reads task items", () => {
    const [list] = parseMarkdown("- a\n  - b\n- [x] done\n- [ ] todo");
    expect(list).toMatchObject({ t: "list", ordered: false });
    if (list.t !== "list") throw new Error();
    expect(list.items).toHaveLength(3);
    expect(list.items[0].blocks).toEqual([{ t: "p", text: "a" }, { t: "list", ordered: false, start: 1, items: [{ task: false, done: undefined, blocks: [{ t: "p", text: "b" }] }] }]);
    expect(list.items[1]).toMatchObject({ task: true, done: true });
    expect(list.items[2]).toMatchObject({ task: true, done: false });
  });

  it("reads ordered lists with their start and GFM tables with alignment", () => {
    expect(parseMarkdown("3. x\n4. y")[0]).toMatchObject({ t: "list", ordered: true, start: 3 });
    expect(parseMarkdown("| A | B |\n| :--- | ---: |\n| 1 | a \\| b |")[0]).toEqual({ t: "table", align: ["left", "right"], head: ["A", "B"], rows: [["1", "a | b"]] });
  });
});

describe("MarkdownView", () => {
  let root: Root;
  afterEach(() => { act(() => root.unmount()); document.body.innerHTML = ""; });
  const render = (src: string) => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root.render(createElement(MarkdownView, { source: src })));
    return host;
  };

  it("never turns HTML in the source into elements, and does not load images", () => {
    const host = render('<img src=x onerror="alert(1)"> <script>alert(2)</script>\n\n![logo](http://evil/x.png)');
    expect(host.querySelector("img, script")).toBeNull();
    expect(host.textContent).toContain("<script>");
    expect(host.textContent).toContain("[image: logo]");
  });

  it("renders inline styles and opens external links through the backend", () => {
    const host = render("**bold** _em_ snake_case_name `code` [site](https://example.com) [rel](./docs/a.md)");
    expect(host.querySelector("strong")?.textContent).toBe("bold");
    expect(host.querySelectorAll("em")).toHaveLength(1);
    expect(host.textContent).toContain("snake_case_name");
    expect(host.querySelector("code")?.textContent).toBe("code");
    const links = host.querySelectorAll("a");
    expect(links).toHaveLength(1);
    act(() => links[0].click());
    expect(invoke).toHaveBeenCalledWith("open_external_url", { url: "https://example.com" });
  });

  it("leaves underscore runs touching a word as text", () => {
    const host = render("window.__xss=1 and window.__xss=2, a__b and c__d");
    expect(host.querySelectorAll("em, strong")).toHaveLength(0);
    expect(host.textContent).toBe("window.__xss=1 and window.__xss=2, a__b and c__d");
    expect(render("__strong__ and _em_ and _a_b_").querySelectorAll("strong, em")).toHaveLength(3);
  });

  it("does not make javascript: links clickable", () => {
    const host = render("[x](javascript:alert(1))");
    expect(host.querySelector("a")).toBeNull();
  });
});
