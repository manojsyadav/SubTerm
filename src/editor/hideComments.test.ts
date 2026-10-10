import { describe, it, expect } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { hideCommentsExtension, setHideComments } from "./hideComments";

const DOC = "#!/bin/sh\n# one\n# two\n\nA=1 # keep\n# three\nB=2";

/** Collect [from, to] of every replace decoration the extension currently provides. */
function replaced(state: EditorState): [number, number][] {
  const out: [number, number][] = [];
  for (const src of state.facet(EditorView.decorations)) {
    if (typeof src === "function") continue;
    const it = src.iter();
    while (it.value) { out.push([it.from, it.to]); it.next(); }
  }
  return out;
}

describe("hideCommentsExtension", () => {
  const base = EditorState.create({ doc: DOC, extensions: [hideCommentsExtension] });

  it("hides nothing until enabled", () => {
    expect(replaced(base)).toEqual([]);
  });

  it("collapses each comment run to one range and never edits the document", () => {
    const next = base.update({ effects: setHideComments.of({ hide: true, lang: "shell" }) }).state;
    // run 1: "# one\n# two" (lines 2-3), run 2: "# three" (line 6); shebang and trailing comment stay visible
    expect(replaced(next)).toEqual([[10, 21], [34, 41]]);
    expect(next.doc.toString()).toBe(DOC);
  });

  it("shows everything again when disabled", () => {
    const on = base.update({ effects: setHideComments.of({ hide: true, lang: "shell" }) }).state;
    const off = on.update({ effects: setHideComments.of({ hide: false, lang: "shell" }) }).state;
    expect(replaced(off)).toEqual([]);
  });

  it("recomputes after edits", () => {
    const on = base.update({ effects: setHideComments.of({ hide: true, lang: "shell" }) }).state;
    const edited = on.update({ changes: { from: 0, insert: "X=0\n" } }).state;
    // the shebang is no longer on line 1, so it now counts as part of the first comment run
    expect(replaced(edited)).toEqual([[4, 25], [38, 45]]);
  });

  it("does nothing for languages without comment syntax", () => {
    const md = base.update({ effects: setHideComments.of({ hide: true, lang: "markdown" }) }).state;
    expect(replaced(md)).toEqual([]);
  });
});
