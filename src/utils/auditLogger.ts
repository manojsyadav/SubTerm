export interface AuditLogEntry {
  id: string;
  sessionId: string;
  serverName: string;
  startTime: number;
  endTime: number;
  cleanExit: boolean;
  transcript: string;
}

const STORAGE_KEY = "subterm_session_audit_logs";
const MAX_LOGS = 50;

export const saveSessionAudit = (entry: Omit<AuditLogEntry, "id" | "endTime"> & { id?: string; endTime?: number }): AuditLogEntry => {
  const fullEntry: AuditLogEntry = {
    id: entry.id || `audit-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
    endTime: entry.endTime || Date.now(),
    ...entry,
  };

  try {
    const existingRaw = localStorage.getItem(STORAGE_KEY);
    const logs: AuditLogEntry[] = existingRaw ? JSON.parse(existingRaw) : [];
    // Prepend new entry
    logs.unshift(fullEntry);
    if (logs.length > MAX_LOGS) {
      logs.length = MAX_LOGS;
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(logs));
  } catch (e) {
    console.error("Failed to save session audit log:", e);
  }

  return fullEntry;
};

export const getSessionAudits = (): AuditLogEntry[] => {
  try {
    const existingRaw = localStorage.getItem(STORAGE_KEY);
    return existingRaw ? JSON.parse(existingRaw) : [];
  } catch {
    return [];
  }
};

export const clearSessionAudits = (): void => {
  localStorage.removeItem(STORAGE_KEY);
};

export const formatAuditLogText = (entry: AuditLogEntry): string => {
  const startStr = new Date(entry.startTime).toLocaleString();
  const endStr = new Date(entry.endTime).toLocaleString();
  const durationSec = Math.max(1, Math.round((entry.endTime - entry.startTime) / 1000));

  return [
    `================================================================================`,
    `  SubTerm Session Audit Log`,
    `================================================================================`,
    `Server     : ${entry.serverName}`,
    `Session ID : ${entry.sessionId}`,
    `Started    : ${startStr}`,
    `Ended      : ${endStr} (${durationSec}s)`,
    `Status     : ${entry.cleanExit ? "Clean Exit (Normal Logout)" : "Terminated / Connection Dropped"}`,
    `================================================================================`,
    ``,
    `--- TERMINAL OUTPUT TRANSCRIPT ---`,
    entry.transcript.trim(),
    ``,
    `--- END OF AUDIT LOG ---`,
  ].join("\n");
};

import { invoke } from "@tauri-apps/api/core";

export const downloadAuditLog = async (entry: AuditLogEntry): Promise<string | null> => {
  const text = formatAuditLogText(entry);
  const dateSlug = new Date(entry.endTime).toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const filename = `session-${entry.serverName.replace(/[^a-zA-Z0-9_-]/g, "_")}-${dateSlug}.log`;

  try {
    const saved = await invoke<string | null>("save_audit_log", {
      content: text,
      filename,
    });
    return saved;
  } catch (e) {
    console.error("Native save failed, fallback to clipboard:", e);
    await navigator.clipboard.writeText(text);
    return null;
  }
};
