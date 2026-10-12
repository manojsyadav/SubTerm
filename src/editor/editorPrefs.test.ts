import { describe, it, expect } from "vitest";
import { readEditorPrefs } from "./editorPrefs";

const store = (o: Record<string, string>) => ({ getItem: (k: string) => o[k] ?? null });

describe("readEditorPrefs", () => {
  it("defaults to tab 4, no wrap, 12 px", () => {
    expect(readEditorPrefs(store({}))).toEqual({ tabSize: 4, wordWrap: false, fontSize: 12 });
  });

  it("reads stored values and clamps junk", () => {
    expect(readEditorPrefs(store({ "subterm-editor-tab-size": "2", "subterm-editor-word-wrap": "true", "subterm-editor-font-size": "16" })))
      .toEqual({ tabSize: 2, wordWrap: true, fontSize: 16 });
    expect(readEditorPrefs(store({ "subterm-editor-tab-size": "99", "subterm-editor-font-size": "2" }))).toMatchObject({ tabSize: 8, fontSize: 9 });
    expect(readEditorPrefs(store({ "subterm-editor-tab-size": "abc" })).tabSize).toBe(4);
  });
});
