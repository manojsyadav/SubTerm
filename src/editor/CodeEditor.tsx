import React, { useEffect, useRef } from "react";
import { Compartment, EditorState } from "@codemirror/state";
import {
  EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { HighlightStyle, syntaxHighlighting, bracketMatching, indentOnInput } from "@codemirror/language";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { tags as t } from "@lezer/highlight";
import { detectLanguage, loadLanguage } from "./language";
import { hideCommentsExtension, setHideComments } from "./hideComments";
import { readEditorPrefs } from "./editorPrefs";

const theme = EditorView.theme(
  {
    "&": { height: "100%", color: "#e4e4e7", backgroundColor: "transparent", fontSize: "12px" },
    ".cm-scroller": { fontFamily: "inherit", lineHeight: "20px", overflow: "auto" },
    ".cm-content": { caretColor: "#a5b4fc", padding: "12px 0" },
    ".cm-gutters": { backgroundColor: "#09090c", color: "#52525b", border: "none", borderRight: "1px solid rgba(255,255,255,0.05)" },
    ".cm-activeLine": { backgroundColor: "rgba(255,255,255,0.03)" },
    ".cm-activeLineGutter": { backgroundColor: "rgba(255,255,255,0.05)", color: "#a1a1aa" },
    "&.cm-focused": { outline: "none" },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": { backgroundColor: "rgba(99,102,241,0.35)" },
    ".cm-selectionMatch": { backgroundColor: "rgba(99,102,241,0.2)" },
    ".cm-cursor": { borderLeftColor: "#a5b4fc" },
    ".cm-panels": { backgroundColor: "#121217", color: "#d4d4d8" },
  },
  { dark: true },
);

const highlight = HighlightStyle.define([
  { tag: [t.comment, t.lineComment, t.blockComment], color: "#6b7280", fontStyle: "italic" },
  { tag: [t.keyword, t.controlKeyword, t.operatorKeyword, t.modifier], color: "#c084fc" },
  { tag: [t.string, t.special(t.string), t.regexp], color: "#86efac" },
  { tag: [t.number, t.bool, t.null, t.atom], color: "#fdba74" },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.labelName], color: "#7dd3fc" },
  { tag: [t.propertyName, t.attributeName], color: "#93c5fd" },
  { tag: [t.typeName, t.className, t.namespace], color: "#fcd34d" },
  { tag: [t.variableName, t.definition(t.variableName)], color: "#e4e4e7" },
  { tag: [t.tagName, t.heading], color: "#f9a8d4", fontWeight: "bold" },
  { tag: [t.operator, t.punctuation, t.separator], color: "#a1a1aa" },
  { tag: [t.meta, t.processingInstruction, t.url, t.link], color: "#67e8f9" },
  { tag: t.invalid, color: "#f87171" },
]);

interface CodeEditorProps {
  value: string;
  onChange: (value: string) => void;
  fileName: string;
  filePath?: string;
  /** View-only: collapse comment lines into a marker. The document is never changed. */
  hideComments?: boolean;
  /** Viewer mode: cursor, selection and search still work; typing does not. */
  readOnly?: boolean;
}

/** Thin CodeMirror 6 wrapper. The doc is owned by CM; `value` only seeds it (and re-syncs on external changes such as a reload). */
export const CodeEditor: React.FC<CodeEditorProps> = ({ value, onChange, fileName, filePath, hideComments = false, readOnly = false }) => {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const langRef = useRef(new Compartment());
  const roRef = useRef(new Compartment());
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    if (!hostRef.current) return;
    const prefs = readEditorPrefs();
    const view = new EditorView({
      parent: hostRef.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(), highlightActiveLineGutter(), highlightActiveLine(), drawSelection(),
          history(), indentOnInput(), bracketMatching(), highlightSelectionMatches(),
          syntaxHighlighting(highlight), theme, langRef.current.of([]), roRef.current.of(EditorState.readOnly.of(readOnly)), hideCommentsExtension,
          EditorState.tabSize.of(prefs.tabSize),
          EditorView.theme({ "&": { fontSize: `${prefs.fontSize}px` }, ".cm-scroller": { lineHeight: `${Math.round(prefs.fontSize * 1.65)}px` } }),
          ...(prefs.wordWrap ? [EditorView.lineWrapping] : []),
          keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
          EditorView.updateListener.of((u) => { if (u.docChanged) onChangeRef.current(u.state.doc.toString()); }),
        ],
      }),
    });
    viewRef.current = view;
    view.focus();
    return () => { view.destroy(); viewRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // External value changes (file reload / revert) — skip when it already matches to avoid clobbering the cursor.
  useEffect(() => {
    const view = viewRef.current;
    if (view && value !== view.state.doc.toString()) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
    }
  }, [value]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: setHideComments.of({ hide: hideComments, lang: detectLanguage(fileName, filePath) }) });
  }, [hideComments, fileName, filePath]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: roRef.current.reconfigure(EditorState.readOnly.of(readOnly)) });
  }, [readOnly]);

  useEffect(() => {
    let cancelled = false;
    loadLanguage(detectLanguage(fileName, filePath)).then((ext) => {
      if (!cancelled && viewRef.current) viewRef.current.dispatch({ effects: langRef.current.reconfigure(ext ?? []) });
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [fileName, filePath]);

  return <div ref={hostRef} className="flex-1 min-w-0 h-full overflow-hidden" />;
};
