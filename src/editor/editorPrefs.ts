/** Quick Editor preferences (Settings > Appearance > Quick Editor). Read when an editor opens. */
export interface EditorPrefs {
  tabSize: number;
  wordWrap: boolean;
  fontSize: number;
}

const clampInt = (raw: string | null, min: number, max: number, fallback: number) => {
  const n = parseInt(raw ?? "", 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

export function readEditorPrefs(storage: Pick<Storage, "getItem"> = localStorage): EditorPrefs {
  return {
    tabSize: clampInt(storage.getItem("subterm-editor-tab-size"), 1, 8, 4),
    wordWrap: storage.getItem("subterm-editor-word-wrap") === "true",
    fontSize: clampInt(storage.getItem("subterm-editor-font-size"), 9, 24, 12),
  };
}
