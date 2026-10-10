import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ListChecks } from "lucide-react";

// Ids match SYNC_CATEGORIES in src-tauri/src/commands/sync.rs.
const CATEGORIES: { id: string; label: string; desc: string }[] = [
  { id: "servers", label: "Servers and folders", desc: "Server list, folders and per-server monitoring settings" },
  { id: "credentials", label: "Credentials and SSH keys", desc: "Saved logins and private keys" },
  { id: "commands", label: "Saved commands", desc: "Snippets and quick commands" },
  { id: "notes", label: "Notes", desc: "Library notes and runbooks" },
];

/** Per-device choice of which kinds of data take part in cloud sync. */
export function SyncScopeControls() {
  const [excluded, setExcluded] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    invoke<string[]>("get_sync_excluded").then(setExcluded).catch(() => setExcluded(null));
  }, []);

  if (excluded === null) return null; // no profile open yet

  const toggle = async (id: string) => {
    const next = excluded.includes(id) ? excluded.filter((x) => x !== id) : [...excluded, id];
    const prev = excluded;
    setExcluded(next);
    try {
      await invoke("set_sync_excluded", { categories: next });
      setError(null);
    } catch (e) {
      setExcluded(prev);
      setError(String(e));
    }
  };

  const credsOff = excluded.includes("credentials") && !excluded.includes("servers");

  return (
    <div className="p-4 bg-black/40 border border-white/5 rounded-xl space-y-3">
      <div className="flex items-center gap-1.5 text-xs font-bold text-zinc-300">
        <ListChecks size={13} className="text-primary" /> What to sync on this device
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {CATEGORIES.map((c) => {
          const on = !excluded.includes(c.id);
          return (
            <label
              key={c.id}
              className="flex items-start gap-2.5 p-2.5 bg-black/40 border border-white/5 rounded-lg cursor-pointer hover:border-white/10"
            >
              <input
                type="checkbox"
                checked={on}
                onChange={() => void toggle(c.id)}
                className="mt-0.5 accent-primary"
              />
              <span className="min-w-0">
                <span className="block text-xs text-zinc-200">{c.label}</span>
                <span className="block text-[11px] text-zinc-500">{c.desc}</span>
              </span>
            </label>
          );
        })}
      </div>
      <p className="text-[11px] text-zinc-500 leading-relaxed">
        Unchecked data is neither uploaded nor downloaded by this device, and its deletions are held back too. Other devices
        are not affected.
        {credsOff && " Servers pulled from the cloud only keep their saved login if that credential already exists on this device."}
      </p>
      {error && <p className="text-[11px] text-rose-300">{error}</p>}
    </div>
  );
}
