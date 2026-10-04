import React, { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { X, RefreshCw, GitCompare, ArrowLeftRight } from "lucide-react";
import { computeDiff } from "../fs/diff";

export interface DiffFileRef {
  label: string;
  path: string;
  provider: "local" | "remote";
  sessionId?: string;
}

interface FileDiffModalProps {
  isOpen: boolean;
  onClose: () => void;
  left: DiffFileRef | null;
  right: DiffFileRef | null;
  onOverwritten?: () => void;
}

async function readFile(ref: DiffFileRef): Promise<string> {
  if (ref.provider === "remote") {
    if (!ref.sessionId) throw new Error("Remote session ID missing");
    return invoke<string>("sftp_read_file_text", {
      sessionId: ref.sessionId,
      remotePath: ref.path,
      maxBytes: 2 * 1024 * 1024,
    });
  }
  return invoke<string>("local_read_file_text", { localPath: ref.path, maxBytes: 2 * 1024 * 1024 });
}

async function writeFile(ref: DiffFileRef, content: string): Promise<void> {
  if (ref.provider === "remote") {
    if (!ref.sessionId) throw new Error("Remote session ID missing");
    await invoke("sftp_write_file_text", { sessionId: ref.sessionId, remotePath: ref.path, content });
    return;
  }
  await invoke("local_write_file_text", { localPath: ref.path, content });
}

// Unified side-by-side-free diff viewer for comparing two arbitrary text
// files — local vs. remote, or two remote files from different sessions
// (the caller just supplies two independently-addressed DiffFileRefs).
// Deliberately unified rather than a true side-by-side layout: it reuses
// the exact same line-diff rendering QuickEditorModal already ships for
// "my unsaved edits vs. what's on disk", so there's one diff visualization
// in the whole app instead of two. "Merge" is scoped down to one-directional
// overwrite (copy the whole left file over the right, or vice versa) rather
// than an interactive per-line merge tool — covers the real use case
// (promote a config from staging to prod, or pull a fix back) without a
// much larger 3-way-merge UI.
export const FileDiffModal: React.FC<FileDiffModalProps> = ({ isOpen, onClose, left, right, onOverwritten }) => {
  const [leftContent, setLeftContent] = useState("");
  const [rightContent, setRightContent] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [overwriting, setOverwriting] = useState<"left" | "right" | null>(null);

  useEffect(() => {
    if (!isOpen || !left || !right) return;
    let mounted = true;
    setLoading(true);
    setError(null);
    Promise.all([readFile(left), readFile(right)])
      .then(([l, r]) => {
        if (!mounted) return;
        setLeftContent(l);
        setRightContent(r);
      })
      .catch((err) => { if (mounted) setError(String(err)); })
      .finally(() => { if (mounted) setLoading(false); });
    return () => { mounted = false; };
  }, [isOpen, left, right]);

  const diffLines = useMemo(() => computeDiff(leftContent, rightContent), [leftContent, rightContent]);
  const additions = diffLines.filter((l) => l.type === "add").length;
  const deletions = diffLines.filter((l) => l.type === "del").length;

  const overwrite = async (direction: "left-to-right" | "right-to-left") => {
    if (!left || !right) return;
    const key = direction === "left-to-right" ? "right" : "left";
    setOverwriting(key);
    setError(null);
    try {
      if (direction === "left-to-right") {
        await writeFile(right, leftContent);
        setRightContent(leftContent);
      } else {
        await writeFile(left, rightContent);
        setLeftContent(rightContent);
      }
      onOverwritten?.();
    } catch (err: any) {
      setError(`Overwrite failed: ${err}`);
    } finally {
      setOverwriting(null);
    }
  };

  if (!isOpen || !left || !right) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4 animate-in fade-in duration-150">
      <div className="w-full max-w-5xl h-[85vh] bg-[#0d0d11] border border-white/10 rounded-xl shadow-2xl flex flex-col overflow-hidden">
        <div className="h-12 px-4 border-b border-white/10 bg-[#121217] flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2.5 min-w-0 font-mono text-xs">
            <GitCompare size={16} className="text-indigo-400 shrink-0" />
            <span className="text-zinc-100 truncate" title={left.path}>{left.label}</span>
            <ArrowLeftRight size={12} className="text-zinc-600 shrink-0" />
            <span className="text-zinc-100 truncate" title={right.path}>{right.label}</span>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => overwrite("left-to-right")}
              disabled={loading || overwriting !== null}
              title={`Overwrite ${right.label} with ${left.label}'s contents`}
              className="h-7 px-2.5 rounded-lg bg-sky-500/15 text-sky-300 hover:bg-sky-500/25 disabled:opacity-40 text-[10.5px] font-bold uppercase flex items-center gap-1"
            >
              {overwriting === "right" ? <RefreshCw size={12} className="animate-spin" /> : null}
              Use Left →
            </button>
            <button
              type="button"
              onClick={() => overwrite("right-to-left")}
              disabled={loading || overwriting !== null}
              title={`Overwrite ${left.label} with ${right.label}'s contents`}
              className="h-7 px-2.5 rounded-lg bg-sky-500/15 text-sky-300 hover:bg-sky-500/25 disabled:opacity-40 text-[10.5px] font-bold uppercase flex items-center gap-1"
            >
              {overwriting === "left" ? <RefreshCw size={12} className="animate-spin" /> : null}
              ← Use Right
            </button>
            <div className="h-4 w-px bg-white/10 mx-1" />
            <button onClick={onClose} className="p-1 rounded-lg text-zinc-400 hover:text-white hover:bg-white/10 transition-colors">
              <X size={16} />
            </button>
          </div>
        </div>

        {error && (
          <div className="p-2.5 bg-rose-950/60 border-b border-rose-500/30 text-rose-300 text-xs flex items-center gap-2 font-mono">
            <span className="truncate">{error}</span>
          </div>
        )}

        <div className="flex-1 overflow-hidden relative font-mono text-xs">
          {loading ? (
            <div className="flex-1 h-full flex flex-col items-center justify-center gap-3 text-zinc-400">
              <RefreshCw size={24} className="animate-spin text-indigo-400" />
              <span>Loading both files…</span>
            </div>
          ) : (
            <div className="h-full overflow-auto bg-[#0a0a0d] p-3 no-scrollbar select-text">
              <div className="mb-2 text-[11px] text-zinc-400 font-bold border-b border-white/5 pb-1 flex justify-between">
                <span>Unified Diff</span>
                <span className="text-zinc-500 font-normal">{additions} additions, {deletions} deletions</span>
              </div>
              {diffLines.length === 0 ? (
                <p className="text-zinc-500 italic py-2">Both files are empty.</p>
              ) : diffLines.map((line, idx) => (
                <div
                  key={idx}
                  className={`flex font-mono leading-relaxed px-2 rounded-sm ${
                    line.type === "add"
                      ? "bg-emerald-950/40 text-emerald-300"
                      : line.type === "del"
                      ? "bg-rose-950/40 text-rose-400 line-through opacity-80"
                      : "text-zinc-400 hover:bg-white/[0.02]"
                  }`}
                >
                  <span className="w-8 shrink-0 text-right pr-3 select-none text-zinc-600">{line.oldNum || ""}</span>
                  <span className="w-8 shrink-0 text-right pr-3 select-none text-zinc-600">{line.newNum || ""}</span>
                  <span className="w-4 shrink-0 select-none font-bold">
                    {line.type === "add" ? "+" : line.type === "del" ? "-" : " "}
                  </span>
                  <pre className="flex-1 font-mono whitespace-pre-wrap break-all select-text">{line.text || " "}</pre>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
