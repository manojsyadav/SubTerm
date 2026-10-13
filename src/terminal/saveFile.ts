import { invoke } from "@tauri-apps/api/core";

/**
 * Ask the user where to save `content` (native Save dialog) and write it there.
 * Resolves to the chosen path, or null if the user cancelled.
 */
export function saveTextFile(content: string, filename: string, extension: string): Promise<string | null> {
  return invoke<string | null>("save_text_file", { content, filename, extension });
}

/** Same for binary content (a GIF, say), sent as raw bytes. The name is reduced to plain ASCII. */
export function saveBinaryFile(content: Uint8Array, filename: string, extension: string): Promise<string | null> {
  const asciiName = filename.replace(/[^A-Za-z0-9._-]/g, "_");
  return invoke<string | null>("save_binary_file", content, { headers: { "x-filename": asciiName, "x-extension": extension } });
}
