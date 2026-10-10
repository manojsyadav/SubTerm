import type { Extension } from "@codemirror/state";
import { StreamLanguage } from "@codemirror/language";

export type LanguageId =
  | "shell" | "nginx" | "properties" | "toml" | "dockerfile" | "json" | "yaml"
  | "javascript" | "typescript" | "jsx" | "tsx" | "python" | "html" | "css"
  | "xml" | "sql" | "markdown" | "rust" | "go" | "cpp" | "plain";

const BY_EXT: Record<string, LanguageId> = {
  sh: "shell", bash: "shell", zsh: "shell", env: "shell", profile: "shell", bashrc: "shell", zshrc: "shell",
  conf: "properties", cfg: "properties", ini: "properties", properties: "properties", service: "properties",
  timer: "properties", socket: "properties", mount: "properties",
  toml: "toml", json: "json", jsonc: "json", yml: "yaml", yaml: "yaml",
  js: "javascript", mjs: "javascript", cjs: "javascript", ts: "typescript", jsx: "jsx", tsx: "tsx",
  py: "python", html: "html", htm: "html", css: "css", scss: "css",
  xml: "xml", svg: "xml", sql: "sql", md: "markdown", markdown: "markdown",
  rs: "rust", go: "go", c: "cpp", h: "cpp", cpp: "cpp", hpp: "cpp", cc: "cpp",
};

const BY_NAME: Record<string, LanguageId> = {
  dockerfile: "dockerfile",
  makefile: "shell",
  ".bashrc": "shell", ".zshrc": "shell", ".profile": "shell", ".bash_profile": "shell",
  ".env": "shell", ".gitconfig": "properties",
};

/** Pick a language from the file name (and path, to tell nginx configs apart). Pure, so it's unit-testable. */
export function detectLanguage(name: string, path = ""): LanguageId {
  const lower = name.toLowerCase();
  if (BY_NAME[lower]) return BY_NAME[lower];
  if (lower.startsWith("dockerfile")) return "dockerfile";
  if (lower.startsWith(".env")) return "shell";
  const dot = lower.lastIndexOf(".");
  const ext = dot >= 0 ? lower.slice(dot + 1) : "";
  if (ext === "conf" && (/nginx/.test(lower) || /\/nginx\//i.test(path))) return "nginx";
  return BY_EXT[ext] ?? "plain";
}

/** Lazily load only the grammar needed so the bundle isn't paying for every language up front. */
export async function loadLanguage(id: LanguageId): Promise<Extension | null> {
  switch (id) {
    case "shell": return StreamLanguage.define((await import("@codemirror/legacy-modes/mode/shell")).shell);
    case "nginx": return StreamLanguage.define((await import("@codemirror/legacy-modes/mode/nginx")).nginx);
    case "properties": return StreamLanguage.define((await import("@codemirror/legacy-modes/mode/properties")).properties);
    case "toml": return StreamLanguage.define((await import("@codemirror/legacy-modes/mode/toml")).toml);
    case "dockerfile": return StreamLanguage.define((await import("@codemirror/legacy-modes/mode/dockerfile")).dockerFile);
    case "json": return (await import("@codemirror/lang-json")).json();
    case "yaml": return (await import("@codemirror/lang-yaml")).yaml();
    case "javascript": return (await import("@codemirror/lang-javascript")).javascript();
    case "typescript": return (await import("@codemirror/lang-javascript")).javascript({ typescript: true });
    case "jsx": return (await import("@codemirror/lang-javascript")).javascript({ jsx: true });
    case "tsx": return (await import("@codemirror/lang-javascript")).javascript({ jsx: true, typescript: true });
    case "python": return (await import("@codemirror/lang-python")).python();
    case "html": return (await import("@codemirror/lang-html")).html();
    case "css": return (await import("@codemirror/lang-css")).css();
    case "xml": return (await import("@codemirror/lang-xml")).xml();
    case "sql": return (await import("@codemirror/lang-sql")).sql();
    case "markdown": return (await import("@codemirror/lang-markdown")).markdown();
    case "rust": return (await import("@codemirror/lang-rust")).rust();
    case "go": return (await import("@codemirror/lang-go")).go();
    case "cpp": return (await import("@codemirror/lang-cpp")).cpp();
    default: return null;
  }
}
