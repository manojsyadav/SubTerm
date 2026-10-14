import { useState } from "react";
import { Copy, RefreshCw } from "lucide-react";
import { DEFAULT_PORT, claudeAddCommand, getMcpSettings, mcpUrl, newToken, saveMcpSettings, type McpSettings } from "../ai/mcp";

export function SettingsMcp() {
  const [s, setS] = useState<McpSettings>(getMcpSettings);
  const [copied, setCopied] = useState(false);

  const update = (next: McpSettings) => {
    setS(next);
    saveMcpSettings(next);
  };
  const toggle = () => update({ ...s, enabled: !s.enabled, token: s.token || newToken() });
  const copy = () => {
    navigator.clipboard.writeText(claudeAddCommand(s)).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div className="py-2 space-y-2" data-setting="mcp">
      <label className="flex items-start gap-2.5 cursor-pointer">
        <input type="checkbox" checked={s.enabled} onChange={toggle} className="mt-0.5 accent-primary" />
        <span>
          <span className="block text-xs text-zinc-200">Let agent CLIs use open SSH sessions (MCP)</span>
          <span className="block text-[11px] text-zinc-500">
            Claude Code, Codex and other MCP clients on this computer can list your open SSH sessions and ask to run
            commands on them. SubTerm asks you before every command. Listens on 127.0.0.1 only.
          </span>
        </span>
      </label>
      {s.enabled && (
        <div className="ml-6 space-y-2">
          <label className="flex items-center gap-2 text-[11px] text-zinc-400">
            Port
            <input
              type="number"
              min={1024}
              max={65535}
              value={s.port}
              onChange={(e) => setS({ ...s, port: Number(e.target.value) || DEFAULT_PORT })}
              onBlur={() => update(s)}
              className="w-24 bg-black/60 border border-white/10 text-white rounded-lg px-2 py-0.5 text-xs outline-none focus:border-primary/50"
            />
            <span className="text-zinc-500">{mcpUrl(s.port)}</span>
          </label>
          <div className="text-[11px] text-zinc-400">Add it to Claude Code with:</div>
          <div className="flex items-start gap-1.5">
            <code className="flex-1 min-w-0 px-2 py-1.5 rounded bg-black/60 border border-white/10 font-mono text-[10.5px] text-emerald-200 break-all select-text">
              {claudeAddCommand(s)}
            </code>
            <button type="button" onClick={copy} title="Copy" aria-label="Copy command" className="p-1.5 rounded border border-white/10 text-zinc-300 hover:text-white">
              <Copy size={12} />
            </button>
            <button
              type="button"
              onClick={() => update({ ...s, token: newToken() })}
              title="New token (agents set up with the old one stop working)"
              aria-label="New token"
              className="p-1.5 rounded border border-white/10 text-zinc-300 hover:text-white"
            >
              <RefreshCw size={12} />
            </button>
          </div>
          {copied && <div className="text-[11px] text-emerald-400">Copied.</div>}
          <div className="text-[11px] text-zinc-500">
            Other clients: use the URL above with the header <code className="font-mono">Authorization: Bearer &lt;token&gt;</code>. The token
            is in the command. Treat it like a password.
          </div>
        </div>
      )}
    </div>
  );
}
