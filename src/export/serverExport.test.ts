import { describe, it, expect } from "vitest";
import { toExportableServers, serversToJson, serversToCsv } from "./serverExport";

const rawServer = (overrides: Record<string, any> = {}) => ({
  id: 1,
  name: "prod-db",
  host: "10.0.0.5",
  port: 22,
  username: "admin",
  password: "super-secret", // must never survive into the export
  credential_id: 3,
  key_id: 7,
  folder_id: 2,
  auth_type: "key",
  proxy_type: "none",
  notes: "primary postgres host",
  run_on_connect: "",
  is_production: 1,
  forward_agent: 0,
  ...overrides,
});

const folders = [{ id: 2, name: "Databases" }];

describe("toExportableServers", () => {
  it("resolves folder_id to a folder name", () => {
    const [row] = toExportableServers([rawServer()], folders);
    expect(row.folder).toBe("Databases");
  });

  it("leaves folder blank when folder_id has no match", () => {
    const [row] = toExportableServers([rawServer({ folder_id: 999 })], folders);
    expect(row.folder).toBe("");
  });

  it("never includes the password or internal foreign keys", () => {
    const [row] = toExportableServers([rawServer()], folders);
    const serialized = JSON.stringify(row);
    expect(serialized).not.toContain("super-secret");
    expect(row).not.toHaveProperty("password");
    expect(row).not.toHaveProperty("credential_id");
    expect(row).not.toHaveProperty("key_id");
    expect(row).not.toHaveProperty("id");
  });

  it("coerces production/forwardAgent integer flags to booleans", () => {
    const [row] = toExportableServers([rawServer({ is_production: 1, forward_agent: 0 })], folders);
    expect(row.isProduction).toBe(true);
    expect(row.forwardAgent).toBe(false);
  });
});

describe("serversToJson", () => {
  it("round-trips through JSON.parse", () => {
    const list = toExportableServers([rawServer()], folders);
    const parsed = JSON.parse(serversToJson(list));
    expect(parsed).toEqual(list);
  });
});

describe("serversToCsv", () => {
  it("includes a header row and one data row per server", () => {
    const list = toExportableServers([rawServer(), rawServer({ name: "web-1", folder_id: null })], folders);
    const lines = serversToCsv(list).split("\r\n");
    expect(lines[0]).toBe(
      "name,host,port,username,authType,folder,proxyType,proxyHost,proxyPort,notes,runOnConnect,isProduction,forwardAgent"
    );
    expect(lines).toHaveLength(3); // header + 2 servers
  });

  it("quotes fields containing a comma", () => {
    const list = toExportableServers([rawServer({ notes: "primary, read-replica fallback" })], folders);
    const csv = serversToCsv(list);
    expect(csv).toContain('"primary, read-replica fallback"');
  });

  it("doubles embedded quotes per RFC 4180", () => {
    const list = toExportableServers([rawServer({ notes: 'has "quoted" text' })], folders);
    const csv = serversToCsv(list);
    expect(csv).toContain('"has ""quoted"" text"');
  });
});
