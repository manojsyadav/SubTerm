import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { X, GitCompare } from "lucide-react";
import { computeDiff } from "../fs/diff";

// Read-only visual diff of one out-of-sync entity (local vault copy vs. the
// cloud's copy), shown before a sync's Last-Write-Wins merge overwrites one
// side. Part of the Cloud Sync Enhancements TODO item — scoped down to
// visibility only, not interactive merge/resolution (the LWW rule itself is
// unchanged). Reuses the same line-diff algorithm FileDiffModal uses for
// SFTP file comparisons, but not the modal itself: that component's
// read/write abstraction is built around addressing real files over
// SFTP/local-fs commands, which doesn't fit an encrypted vault entity.

interface ConflictDiff {
  entity_type: string;
  local_updated_at: string | null;
  remote_updated_at: string | null;
  local_json: string | null;
  remote_json: string | null;
}

interface SyncConflictDiffModalProps {
  isOpen: boolean;
  onClose: () => void;
  uuid: string | null;
  name: string | null;
}

export function SyncConflictDiffModal({ isOpen, onClose, uuid, name }: SyncConflictDiffModalProps) {
  const [diff, setDiff] = useState<ConflictDiff | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen || !uuid) return;
    let mounted = true;
    setLoading(true);
    setError(null);
    setDiff(null);
    invoke<ConflictDiff>("sync_conflict_diff", { uuid })
      .then((d) => { if (mounted) setDiff(d); })
      .catch((e) => { if (mounted) setError(String(e).replace(/^\[[A-Z_]+\]\s*/, "")); })
      .finally(() => { if (mounted) setLoading(false); });
    return () => { mounted = false; };
  }, [isOpen, uuid]);

  if (!isOpen) return null;

  const local = diff?.local_json ?? "";
  const remote = diff?.remote_json ?? "";
  const lines = diff ? computeDiff(local, remote) : [];

  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-[#16161a] border border-white/10 rounded-2xl w-full max-w-3xl max-h-[80vh] flex flex-col overflow-hidden shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between gap-3 px-4 py-3 border-b border-white/5 shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <GitCompare size={15} className="text-primary shrink-0" />
            <h3 className="text-[14px] font-bold text-zinc-100 truncate">
              {name ? `"${name}"` : "Entity"} — local vs. cloud
            </h3>
          </div>
          <button onClick={onClose} className="text-zinc-500 hover:text-white shrink-0">
            <X size={16} />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto custom-scrollbar p-4 space-y-3">
          {loading && <div className="text-zinc-500 text-[13px] italic">Loading diff…</div>}
          {error && <div className="text-red-400 text-[13px]">{error}</div>}
          {diff && !loading && !error && (
            <>
              <div className="grid grid-cols-2 gap-2 text-[11px] text-zinc-500 font-mono">
                <div>Local: {diff.local_json ? diff.local_updated_at : "(not present locally)"}</div>
                <div>Cloud: {diff.remote_json ? diff.remote_updated_at : "(not present on cloud)"}</div>
              </div>
              <div className="bg-black/40 rounded-xl border border-white/5 p-3 font-mono text-[12px] leading-relaxed overflow-x-auto">
                {lines.length === 0 ? (
                  <div className="text-zinc-600 italic">No differences.</div>
                ) : (
                  lines.map((l, i) => (
                    <div
                      key={i}
                      className={
                        l.type === "add"
                          ? "bg-emerald-500/10 text-emerald-300"
                          : l.type === "del"
                          ? "bg-red-500/10 text-red-300"
                          : "text-zinc-400"
                      }
                    >
                      <span className="select-none opacity-50 mr-2">{l.type === "add" ? "+" : l.type === "del" ? "-" : " "}</span>
                      {l.text}
                    </div>
                  ))
                )}
              </div>
              <p className="text-[11px] text-zinc-600">
                Sensitive fields (passwords, private keys, passphrases) are redacted. This view is read-only —
                the next sync still applies the normal last-write-wins rule.
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
