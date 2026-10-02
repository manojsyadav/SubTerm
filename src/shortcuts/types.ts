export type ShortcutCategory =
  | "General"
  | "Session & Navigation"
  | "Terminal"
  | "Tools & Panels";

export interface ShortcutAction {
  id: string;
  name: string;
  category: ShortcutCategory;
  description: string;
  defaultKey: string; // e.g. "Ctrl+Shift+P", "Alt+E", "Ctrl+\\"
  scope: "global" | "session" | "terminal";
}

export type CustomShortcutMap = Record<string, string>;
