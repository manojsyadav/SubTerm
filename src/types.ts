/**
 * Shapes of the vault records the Rust backend returns (see `get_servers`,
 * `get_folders`, ... in src-tauri/src/commands/servers.rs). Secrets are never
 * included; `has_password` / `has_private_key` say whether one is stored.
 */

export interface Server {
  id: number;
  name: string;
  host: string;
  port: number;
  username: string;
  has_password: boolean;
  credential_id: number | null;
  folder_id: number | null;
  proxy_type: string;
  proxy_host: string;
  proxy_port: number;
  /** JSON-encoded tunnel specs. */
  tunnels: string;
  auth_type: string;
  key_id: number | null;
  autostart: boolean;
  /** JSON-encoded mirror specs. */
  mirrors: string;
  color: string | null;
  notes: string;
  run_on_connect: string;
  jump_host_id: number | null;
  updated_at: string | null;
  edited_by: string | null;
  position: number;
  is_production: boolean;
  icon: string;
  os_info: string;
  forward_agent: boolean;
}

export interface Folder {
  id: number;
  name: string;
  parent_id: number | null;
  color: string | null;
}

export interface Credential {
  id: number;
  name: string;
  auth_type: string;
  username: string;
  has_password: boolean;
  key_id: number | null;
}

export interface SshKey {
  id: number;
  name: string;
  public_key: string;
  has_private_key: boolean;
  has_passphrase: boolean;
}

export interface SavedCommand {
  id: number;
  title: string;
  content: string;
  serverId: number | null;
  tags: string;
}

export interface Note {
  id: number;
  title: string;
  body: string;
}
