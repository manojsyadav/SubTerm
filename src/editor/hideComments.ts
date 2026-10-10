import { EditorState, StateEffect, StateField, type Extension } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";
import type { LanguageId } from "./language";
import { commentRuns, supportsCommentHiding } from "./comments";

/**
 * View-only "hide comments": comment runs are replaced by a one-line marker.
 * The document itself is never modified, so saving always writes the full file.
 */
export const setHideComments = StateEffect.define<{ hide: boolean; lang: LanguageId }>();
const expandRun = StateEffect.define<number>(); // doc position of the run's first line

interface HideState {
  hide: boolean;
  lang: LanguageId;
  /** Start positions of runs the user expanded by clicking their marker. */
  expanded: number[];
  deco: DecorationSet;
}

class HiddenCommentsWidget extends WidgetType {
  constructor(readonly lines: number, readonly from: number) { super(); }
  eq(other: HiddenCommentsWidget) { return other.lines === this.lines && other.from === this.from; }
  toDOM(view: EditorView) {
    const el = document.createElement("div");
    el.className = "cm-hidden-comments";
    el.textContent = `⋯ ${this.lines} comment line${this.lines === 1 ? "" : "s"} hidden — click to show`;
    el.onmousedown = (e) => {
      e.preventDefault();
      view.dispatch({ effects: expandRun.of(this.from) });
    };
    return el;
  }
  ignoreEvent() { return false; }
}

function build(state: EditorState, hide: boolean, lang: LanguageId, expanded: number[]): DecorationSet {
  if (!hide || !supportsCommentHiding(lang)) return Decoration.none;
  const doc = state.doc;
  const ranges = [];
  for (const run of commentRuns(doc.toString(), lang)) {
    const first = doc.line(run.startLine + 1);
    if (expanded.includes(first.from)) continue;
    const last = doc.line(run.endLine + 1);
    ranges.push(
      Decoration.replace({
        widget: new HiddenCommentsWidget(run.endLine - run.startLine + 1, first.from),
        block: true,
      }).range(first.from, last.to),
    );
  }
  return Decoration.set(ranges);
}

const field = StateField.define<HideState>({
  create: () => ({ hide: false, lang: "plain", expanded: [], deco: Decoration.none }),
  update(value, tr) {
    let { hide, lang, expanded } = value;
    let dirty = tr.docChanged;
    if (tr.docChanged) expanded = expanded.map((p) => tr.changes.mapPos(p, -1));
    for (const e of tr.effects) {
      if (e.is(setHideComments)) {
        hide = e.value.hide; lang = e.value.lang;
        if (!hide) expanded = [];
        dirty = true;
      } else if (e.is(expandRun)) {
        expanded = [...expanded, e.value];
        dirty = true;
      }
    }
    if (!dirty) return value;
    return { hide, lang, expanded, deco: build(tr.state, hide, lang, expanded) };
  },
  provide: (f) => [
    EditorView.decorations.from(f, (v) => v.deco),
    // Cursor movement skips over a hidden block instead of landing inside it.
    EditorView.atomicRanges.of((view) => view.state.field(f).deco),
  ],
});

const styles = EditorView.baseTheme({
  ".cm-hidden-comments": {
    color: "#71717a",
    fontStyle: "italic",
    cursor: "pointer",
    padding: "0 12px",
    backgroundColor: "rgba(255,255,255,0.03)",
    borderTop: "1px dashed rgba(255,255,255,0.08)",
    borderBottom: "1px dashed rgba(255,255,255,0.08)",
    userSelect: "none",
  },
  ".cm-hidden-comments:hover": { color: "#a5b4fc", backgroundColor: "rgba(99,102,241,0.08)" },
});

export const hideCommentsExtension: Extension = [field, styles];
