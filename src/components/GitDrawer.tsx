import React, { useState } from "react";
import { 
  GitBranch, GitCommit, GitPullRequest, RefreshCw, X, Play, 
  Check, ArrowUp, ArrowDown, FileCode, CheckSquare, Square
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";

export interface GitRepoInfo {
  branch: string;
  isDirty: boolean;
  dirtyCount: number;
  statusText: string;
}

interface GitDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  sessionId: string;
  terminalId: string;
  gitInfo: GitRepoInfo | null;
  onRefresh: () => Promise<void>;
}

export const GitDrawer: React.FC<GitDrawerProps> = ({
  isOpen,
  onClose,
  sessionId,
  terminalId,
  gitInfo,
  onRefresh,
}) => {
  const [commitMsg, setCommitMsg] = useState("");
  const [autoPush, setAutoPush] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  if (!isOpen) return null;

  const handleRefresh = async () => {
    setRefreshing(true);
    await onRefresh();
    setRefreshing(false);
  };

  const sendTerminalCmd = (cmd: string) => {
    const payload = cmd.endsWith("\r") || cmd.endsWith("\n") ? cmd : cmd + "\r";
    const bytes = Array.from(new TextEncoder().encode(payload));
    invoke("write_terminal_data", { terminalId, data: bytes }).catch(console.error);
    onClose();
  };

  const handleCommit = () => {
    if (!commitMsg.trim()) return;
    setSubmitting(true);
    const cleanMsg = commitMsg.trim().replace(/"/g, '\\"');
    const cmd = autoPush
      ? `git add -A && git commit -m "${cleanMsg}" && git push\r`
      : `git add -A && git commit -m "${cleanMsg}"\r`;
    sendTerminalCmd(cmd);
    setCommitMsg("");
    setSubmitting(false);
  };

  // Parse `git status -s` lines
  const statusItems = (gitInfo?.statusText || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const code = line.slice(0, 2).trim();
      const file = line.slice(2).trim();
      return { code, file };
    });

  return (
    <div className="fixed inset-y-0 right-0 z-50 w-full sm:w-96 bg-[#0e0e13] border-l border-white/10 shadow-2xl flex flex-col animate-in slide-in-from-right duration-200 text-xs font-mono">
      {/* Header */}
      <div className="h-12 px-4 border-b border-white/10 bg-[#14141a] flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <GitBranch size={16} className="text-emerald-400 shrink-0" />
          <span className="font-bold text-white uppercase tracking-wider text-[11px]">
            Git Control
          </span>
          {gitInfo?.branch && (
            <span className="px-2 py-0.5 rounded bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 font-bold truncate max-w-[120px]">
              {gitInfo.branch}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          <button
            onClick={handleRefresh}
            disabled={refreshing}
            className="p-1 rounded text-zinc-400 hover:text-white hover:bg-white/10 transition-colors"
            title="Refresh Git status"
          >
            <RefreshCw size={13} className={refreshing ? "animate-spin" : ""} />
          </button>
          <button
            onClick={onClose}
            className="p-1 rounded text-zinc-400 hover:text-white hover:bg-white/10 transition-colors"
            title="Close Git Drawer"
          >
            <X size={15} />
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-4 no-scrollbar">
        {!gitInfo ? (
          <div className="text-center py-12 text-zinc-500 flex flex-col items-center gap-2">
            <GitBranch size={28} className="opacity-30" />
            <p className="text-[11px]">No Git repository detected in active directory.</p>
            <button
              onClick={() => sendTerminalCmd("git status\r")}
              className="mt-2 px-3 py-1 rounded bg-white/5 border border-white/10 text-zinc-300 hover:text-white hover:bg-white/10"
            >
              Run "git status" in Terminal
            </button>
          </div>
        ) : (
          <>
            {/* Status Summary */}
            <div className="p-3 bg-white/[0.02] border border-white/5 rounded-lg flex items-center justify-between">
              <div>
                <span className="text-zinc-400 text-[10px] block uppercase">Working Tree</span>
                <span className={`font-bold ${gitInfo.isDirty ? "text-amber-400" : "text-emerald-400"}`}>
                  {gitInfo.isDirty ? `${gitInfo.dirtyCount} modified file(s)` : "Clean working tree"}
                </span>
              </div>
              <div className="flex items-center gap-1.5">
                <button
                  onClick={() => sendTerminalCmd("git pull\r")}
                  className="px-2 py-1 rounded bg-white/5 hover:bg-white/10 text-zinc-300 hover:text-white border border-white/10 flex items-center gap-1 text-[10px]"
                  title="Pull latest changes"
                >
                  <ArrowDown size={11} /> Pull
                </button>
                <button
                  onClick={() => sendTerminalCmd("git fetch\r")}
                  className="px-2 py-1 rounded bg-white/5 hover:bg-white/10 text-zinc-300 hover:text-white border border-white/10 flex items-center gap-1 text-[10px]"
                  title="Fetch remote branches"
                >
                  Fetch
                </button>
              </div>
            </div>

            {/* Changed Files List */}
            {statusItems.length > 0 && (
              <div className="flex flex-col gap-1.5">
                <span className="text-[10px] uppercase font-bold text-zinc-500 tracking-wider">
                  Modified Files ({statusItems.length})
                </span>
                <div className="max-h-48 overflow-y-auto space-y-1 bg-black/30 border border-white/5 p-2 rounded-lg no-scrollbar">
                  {statusItems.map((item, idx) => (
                    <div
                      key={idx}
                      className="flex items-center justify-between gap-2 p-1 rounded hover:bg-white/5 text-[11px]"
                    >
                      <div className="flex items-center gap-2 truncate">
                        <span
                          className={`w-5 text-center font-bold px-1 rounded text-[9.5px] ${
                            item.code.includes("M")
                              ? "bg-amber-500/20 text-amber-300"
                              : item.code.includes("A") || item.code.includes("??")
                              ? "bg-emerald-500/20 text-emerald-300"
                              : item.code.includes("D")
                              ? "bg-rose-500/20 text-rose-300"
                              : "bg-zinc-700 text-zinc-300"
                          }`}
                        >
                          {item.code}
                        </span>
                        <span className="truncate text-zinc-300">{item.file}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Quick Commit & Push Dialog */}
            <div className="p-3 bg-[#131319] border border-white/10 rounded-lg flex flex-col gap-2.5">
              <span className="text-[10px] uppercase font-bold text-zinc-400 tracking-wider flex items-center gap-1.5">
                <GitCommit size={13} className="text-primary" />
                Quick Commit
              </span>
              <textarea
                value={commitMsg}
                onChange={(e) => setCommitMsg(e.target.value)}
                placeholder="Commit message (e.g., Fix nginx config...)"
                rows={3}
                className="w-full p-2 bg-black/40 border border-white/10 rounded text-xs text-white placeholder-zinc-600 focus:outline-none focus:border-primary/50 resize-none font-mono"
              />
              <label className="flex items-center gap-2 text-zinc-400 cursor-pointer select-none text-[11px]">
                <input
                  type="checkbox"
                  checked={autoPush}
                  onChange={(e) => setAutoPush(e.target.checked)}
                  className="rounded bg-black/40 border-white/20 accent-primary"
                />
                <span>Push immediately after commit</span>
              </label>
              <button
                onClick={handleCommit}
                disabled={!commitMsg.trim() || submitting}
                className="w-full h-8 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 disabled:hover:bg-emerald-600 text-white font-bold flex items-center justify-center gap-1.5 shadow transition-all"
              >
                <Check size={13} />
                <span>{autoPush ? "Commit & Push" : "Commit Changes"}</span>
              </button>
            </div>

            {/* Quick Terminal Git Shortcuts */}
            <div className="flex flex-col gap-1.5 pt-2 border-t border-white/5">
              <span className="text-[9.5px] uppercase font-bold text-zinc-500 tracking-wider">
                Common Git Commands
              </span>
              <div className="grid grid-cols-2 gap-1.5">
                {[
                  { label: "git diff", cmd: "git diff\r" },
                  { label: "git log (last 5)", cmd: "git log --oneline -n 5\r" },
                  { label: "git stash", cmd: "git stash\r" },
                  { label: "git stash pop", cmd: "git stash pop\r" },
                ].map((act) => (
                  <button
                    key={act.label}
                    onClick={() => sendTerminalCmd(act.cmd)}
                    className="p-1.5 rounded bg-white/[0.03] hover:bg-white/10 border border-white/5 hover:border-white/20 text-zinc-300 hover:text-white text-left transition-all truncate"
                  >
                    {act.label}
                  </button>
                ))}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
};
