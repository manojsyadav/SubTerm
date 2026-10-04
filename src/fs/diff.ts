// Simple line-by-line diff, shared between QuickEditorModal (diffing a file's
// unsaved edits against what's on disk) and FileDiffModal (diffing two
// distinct files). Not a real LCS/Myers diff — a lookahead-5 heuristic is
// good enough for the config-file-sized text this app diffs, and keeps the
// algorithm trivial to read.
export interface DiffLine {
  type: "same" | "add" | "del";
  text: string;
  oldNum?: number;
  newNum?: number;
}

export function computeDiff(original: string, modified: string): DiffLine[] {
  const origLines = original.split("\n");
  const modLines = modified.split("\n");
  const diff: DiffLine[] = [];

  let i = 0;
  let j = 0;
  let oldLineNum = 1;
  let newLineNum = 1;

  while (i < origLines.length || j < modLines.length) {
    if (i < origLines.length && j < modLines.length && origLines[i] === modLines[j]) {
      diff.push({ type: "same", text: origLines[i], oldNum: oldLineNum++, newNum: newLineNum++ });
      i++;
      j++;
    } else if (j < modLines.length && (i >= origLines.length || !origLines.slice(i, i + 5).includes(modLines[j]))) {
      diff.push({ type: "add", text: modLines[j], newNum: newLineNum++ });
      j++;
    } else if (i < origLines.length) {
      diff.push({ type: "del", text: origLines[i], oldNum: oldLineNum++ });
      i++;
    }
  }

  return diff;
}
