import { invoke } from "@tauri-apps/api/core";

/**
 * Ask the user where to save `content` (native Save dialog) and write it there.
 * Resolves to the chosen path, or null if the user cancelled.
 */
export function saveTextFile(content: string, filename: string, extension: string): Promise<string | null> {
  return invoke<string | null>("save_text_file", { content, filename, extension });
}
