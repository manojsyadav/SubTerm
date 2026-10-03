// ─────────────────────────────────────────────────────────────────────────────
// Parameterized Snippets Engine
// Supports {{varName}} and {{varName:defaultValue}}
// Example: docker run -d -p {{port:8080}}:80 --name {{name:my-nginx}} {{image:nginx:alpine}}
// ─────────────────────────────────────────────────────────────────────────────

export interface SnippetVariable {
  raw: string;
  name: string;
  defaultValue: string;
}

const STORAGE_KEY = "subterm-cmd-params";
const LEGACY_STORAGE_KEY = "submarine-cmd-params";

export function parseSnippetVariables(template: string): SnippetVariable[] {
  const matches = Array.from(template.matchAll(/\{\{([^}]+)\}\}/g));
  const seen = new Set<string>();
  const vars: SnippetVariable[] = [];

  for (const m of matches) {
    const raw = m[0];
    const inner = m[1].trim();
    const colonIdx = inner.indexOf(":");
    let name: string;
    let defaultValue = "";

    if (colonIdx !== -1) {
      name = inner.slice(0, colonIdx).trim();
      defaultValue = inner.slice(colonIdx + 1).trim();
    } else {
      name = inner;
    }

    if (!name || seen.has(name)) continue;
    seen.add(name);
    vars.push({ raw, name, defaultValue });
  }

  return vars;
}

export function getSavedSnippetParams(): Record<string, string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY) || localStorage.getItem(LEGACY_STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

export function saveSnippetParams(params: Record<string, string>): void {
  try {
    const existing = getSavedSnippetParams();
    const merged = { ...existing, ...params };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
  } catch (e) {
    console.error("Failed to save snippet parameters:", e);
  }
}

export function interpolateSnippet(
  template: string,
  values: Record<string, string>
): string {
  return template.replace(/\{\{([^}]+)\}\}/g, (_match, inner) => {
    const trimmed = inner.trim();
    const colonIdx = trimmed.indexOf(":");
    const name = colonIdx !== -1 ? trimmed.slice(0, colonIdx).trim() : trimmed;
    const fallback = colonIdx !== -1 ? trimmed.slice(colonIdx + 1).trim() : "";

    const userVal = values[name];
    if (userVal !== undefined && userVal !== "") {
      return userVal;
    }
    return fallback;
  });
}
