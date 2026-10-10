// Portable, unencrypted export of saved server profiles for backup/migration
// (TODO.md: "Vault Export to Portable Formats"). Deliberately whitelists
// fields rather than spreading the raw server row — `servers` carries
// internal foreign keys (credential_id, key_id, jump_host_id, folder_id) and
// `has_password` that are meaningless outside this vault, and must NEVER
// include a plaintext secret. get_servers() already never returns plaintext
// passwords (see its own comment), so there is nothing secret to strip here,
// but the explicit whitelist means a future column added to `servers` is
// excluded by default instead of silently leaking into an export.
export interface ExportableServer {
  name: string;
  host: string;
  port: number;
  username: string;
  authType: string;
  folder: string;
  proxyType: string;
  proxyHost: string;
  proxyPort: number;
  notes: string;
  runOnConnect: string;
  isProduction: boolean;
  forwardAgent: boolean;
}

/** Server row as returned by `get_servers`; flags may arrive as booleans or 0/1. */
export interface RawServerRow {
  name?: string;
  host?: string;
  port?: number;
  username?: string;
  auth_type?: string;
  folder_id?: number | null;
  proxy_type?: string;
  proxy_host?: string;
  proxy_port?: number;
  notes?: string;
  run_on_connect?: string;
  is_production?: boolean | number;
  forward_agent?: boolean | number;
}

export function toExportableServers(servers: RawServerRow[], folders: { id: number; name: string }[]): ExportableServer[] {
  const folderName = new Map<number, string>(folders.map((f) => [f.id, f.name]));
  return servers.map((s) => ({
    name: s.name || "",
    host: s.host || "",
    port: s.port || 22,
    username: s.username || "",
    authType: s.auth_type || "vault",
    folder: (s.folder_id != null && folderName.get(s.folder_id)) || "",
    proxyType: s.proxy_type || "none",
    proxyHost: s.proxy_host || "",
    proxyPort: s.proxy_port || 1080,
    notes: s.notes || "",
    runOnConnect: s.run_on_connect || "",
    isProduction: Boolean(s.is_production),
    forwardAgent: Boolean(s.forward_agent),
  }));
}

export function serversToJson(list: ExportableServer[]): string {
  return JSON.stringify(list, null, 2);
}

const CSV_HEADER: (keyof ExportableServer)[] = [
  "name", "host", "port", "username", "authType", "folder",
  "proxyType", "proxyHost", "proxyPort", "notes", "runOnConnect",
  "isProduction", "forwardAgent",
];

function csvField(value: unknown): string {
  const s = String(value ?? "");
  // Quote whenever the field contains the delimiter, a quote, or a newline —
  // doubling embedded quotes, the standard RFC 4180 escape.
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function serversToCsv(list: ExportableServer[]): string {
  const lines = [CSV_HEADER.join(",")];
  for (const row of list) {
    lines.push(CSV_HEADER.map((key) => csvField(row[key])).join(","));
  }
  // CRLF line endings — the common CSV convention most spreadsheet tools expect.
  return lines.join("\r\n");
}
