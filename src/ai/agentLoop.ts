export interface Part {
  text: string;
  /** Set for a fenced code block; the language tag is dropped. */
  code?: string;
}

/** Split model output into prose and fenced code blocks. An unclosed fence (mid-stream) stays prose. */
export function splitFences(src: string): Part[] {
  const parts: Part[] = [];
  const re = /```[^\n`]*\n([\s\S]*?)```/g;
  let last = 0;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    const before = src.slice(last, m.index).trim();
    if (before) parts.push({ text: before });
    const code = m[1].replace(/\n$/, "");
    if (code.trim()) parts.push({ text: "", code });
    last = re.lastIndex;
  }
  const rest = src.slice(last).trim();
  if (rest) parts.push({ text: rest });
  return parts;
}
