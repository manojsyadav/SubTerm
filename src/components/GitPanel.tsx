import React, { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Check, RefreshCw, MoreHorizontal, Plus, Minus, UploadCloud, ArrowDownUp, ChevronDown, ChevronRight, FolderGit2 } from "lucide-react";
import type { ExecResult } from "../ai/agentLoop";
import { getTerminalCwd, onTerminalCwdChange, shellQuote } from "../terminal/cwd";
import { parseStatusZ, parseLog, LOG_FORMAT, type GitStatus, type GitCommit, type GitFile } from "../git/porcelain";

interface GitPanelProps {
  sessionId: string;
  terminalId: string;
  isLocal?: boolean;
  disabled?: boolean;
  visible: boolean;
  /** Called after anything that changes the repo, so the branch pill can refresh. */
  onChanged?: () => void;
}

// Local tabs on Windows run git through Windows PowerShell (always present); everything else is POSIX sh.
const PS = typeof navigator !== "undefined" && navigator.userAgent.includes("Windows");
const psQuote = (v: string) => `'${v.replace(/'/g, "''")}'`;

// Paths from `git status` are relative to the repo root, not the folder git runs in.
const top = (path: string) => `:(top,literal)${path}`;

export const GitPanel: React.FC<GitPanelProps> = ({ sessionId, terminalId, isLocal, disabled, visible, onChanged }) => {
  const usePs = !!isLocal && PS;
  const [dir, setDir] = useState(() => getTerminalCwd(terminalId) ?? "");
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [log, setLog] = useState<GitCommit[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [menu, setMenu] = useState(false);
  const [open, setOpen] = useState({ staged: true, changes: true, graph: true });

  useEffect(() => {
    const cwd = getTerminalCwd(terminalId);
    if (cwd) setDir(cwd);
    return onTerminalCwdChange((id, c) => { if (id === terminalId) setDir(c); });
  }, [terminalId]);

  /** Run one or more git invocations (each an argv after `git`) in `dir`, in order. */
  const exec = useCallback(async (cmds: string[][], timeoutSecs = 60) => {
    const q = usePs ? psQuote : shellQuote;
    const git = cmds.map((a) => `git ${a.map(q).join(" ")}`).join("; ");
    let command: string;
    if (usePs) {
      command = `$env:GIT_TERMINAL_PROMPT='0'; ${dir ? `Set-Location -LiteralPath ${psQuote(dir)} -ErrorAction Stop; ` : ""}${git}`;
    } else {
      // The exec channel starts in $HOME and "~" would not expand inside quotes.
      const cd = !dir ? "" : dir === "~" ? `cd "$HOME" || exit 1; ` : dir.startsWith("~/") ? `cd "$HOME"/${shellQuote(dir.slice(2))} || exit 1; ` : `cd ${shellQuote(dir)} || exit 1; `;
      command = `export GIT_TERMINAL_PROMPT=0; ${cd}${git}`;
    }
    return invoke<ExecResult>("ai_exec", {
      sessionId: isLocal ? null : sessionId,
      command,
      shell: usePs ? "powershell" : null,
      timeoutSecs,
    });
  }, [dir, isLocal, sessionId, usePs]);

  const refresh = useCallback(async () => {
    if (disabled) return;
    try {
      const [s, l] = await Promise.all([
        exec([["status", "--porcelain=v1", "-b", "-z"]]),
        exec([["log", "-n", "50", `--format=${LOG_FORMAT}`]]),
      ]);
      if (s.exitCode !== 0) { setStatus(null); setLog([]); setError(s.stderr.trim() || "Not a git repository"); return; }
      setStatus(parseStatusZ(s.stdout));
      setLog(l.exitCode === 0 ? parseLog(l.stdout) : []);
      setError("");
    } catch (e) {
      setError(String(e));
    }
  }, [exec, disabled]);

  useEffect(() => { if (visible) refresh(); }, [visible, refresh]);

  const run = async (cmds: string[][], timeoutSecs?: number) => {
    setBusy(true);
    setMenu(false);
    try {
      // Stop at the first failure (PowerShell 5.1 has no `&&`).
      for (const c of cmds) {
        const r = await exec([c], timeoutSecs);
        if (r.exitCode !== 0) { setError((r.stderr || r.stdout).trim() || `git ${c[0]} failed`); return false; }
      }
      setError("");
      return true;
    } catch (e) {
      setError(String(e));
      return false;
    } finally {
      setBusy(false);
      await refresh();
      onChanged?.();
    }
  };

  const hasChanges = !!status && (status.staged.length > 0 || status.changes.length > 0);

  const commit = async () => {
    if (!status || !msg.trim() || busy) return;
    // Like VS Code's smart commit: with nothing staged, commit everything.
    const cmds: string[][] = status.staged.length ? [] : [["add", "-A"]];
    if (usePs) {
      // Windows PowerShell 5.1 mangles embedded double quotes in native arguments, so pass the message as a file.
      setBusy(true);
      try {
        if (cmds.length && !(await run(cmds))) return;
        const r = await invoke<ExecResult>("ai_exec", {
          sessionId: null,
          shell: "powershell",
          command: `${dir ? `Set-Location -LiteralPath ${psQuote(dir)} -ErrorAction Stop; ` : ""}$f=[IO.Path]::GetTempFileName(); [IO.File]::WriteAllText($f, ${psQuote(msg.trim())}); git commit -F $f; $c=$LASTEXITCODE; Remove-Item $f; exit $c`,
        });
        if (r.exitCode !== 0) setError((r.stderr || r.stdout).trim()); else { setMsg(""); setError(""); }
      } finally {
        setBusy(false);
        await refresh();
        onChanged?.();
      }
      return;
    }
    if (await run([...cmds, ["commit", "-m", msg.trim()]])) setMsg("");
  };

  const primary = (() => {
    if (!status) return null;
    if (hasChanges) return { label: "Commit", icon: Check, onClick: commit, disabled: !msg.trim() };
    if (!status.upstream) return { label: "Publish Branch", icon: UploadCloud, onClick: () => run([["push", "-u", "origin", "HEAD"]], 120), disabled: false };
    if (status.ahead || status.behind) {
      return { label: `Sync Changes ${status.behind}↓ ${status.ahead}↑`, icon: ArrowDownUp, onClick: () => run([["pull"], ["push"]], 120), disabled: false };
    }
    return { label: "Commit", icon: Check, onClick: commit, disabled: true };
  })();

  const menuItems: { label: string; cmds: string[][]; slow?: boolean }[] = [
    { label: "Pull", cmds: [["pull"]], slow: true },
    { label: "Push", cmds: [["push"]], slow: true },
    { label: "Fetch", cmds: [["fetch", "--all", "--prune"]], slow: true },
    { label: "Stage All Changes", cmds: [["add", "-A"]] },
    { label: "Unstage All Changes", cmds: [["reset", "-q"]] },
    { label: "Stash", cmds: [["stash", "push", "-u"]] },
    { label: "Pop Stash", cmds: [["stash", "pop"]] },
  ];

  const fileRow = (f: GitFile, staged: boolean) => {
    const name = f.path.split("/").pop() || f.path;
    const parent = f.path.slice(0, f.path.length - name.length).replace(/\/$/, "");
    const color = f.code === "D" ? "text-rose-400" : f.code === "U" || f.code === "A" ? "text-emerald-400" : "text-amber-400";
    return (
      <div key={`${staged}-${f.path}`} className="group flex items-center gap-2 px-3 py-0.5 hover:bg-white/[0.05]" title={f.orig ? `${f.orig} → ${f.path}` : f.path}>
        <span className={`truncate ${f.code === "D" ? "line-through text-zinc-400" : "text-zinc-200"}`}>{name}</span>
        <span className="truncate text-zinc-500 text-[10px] flex-1">{parent}</span>
        <button
          onClick={() => run([staged ? ["restore", "--staged", "--", top(f.path)] : ["add", "--", top(f.path)]])}
          disabled={busy}
          title={staged ? "Unstage Changes" : "Stage Changes"}
          aria-label={staged ? `Unstage ${f.path}` : `Stage ${f.path}`}
          className="p-0.5 rounded text-zinc-400 hover:text-white hover:bg-white/10 opacity-0 group-hover:opacity-100 focus:opacity-100"
        >
          {staged ? <Minus size={12} /> : <Plus size={12} />}
        </button>
        <span className={`w-3 text-center font-bold text-[10px] ${color}`}>{f.code}</span>
      </div>
    );
  };

  const section = (key: keyof typeof open, title: string, count: number | null, body: React.ReactNode, actions?: React.ReactNode) => (
    <div className="flex flex-col">
      <div className="h-6 px-1 flex items-center gap-1 text-[10.5px] font-bold uppercase tracking-wider text-zinc-400 hover:bg-white/[0.03]">
        <button onClick={() => setOpen((o) => ({ ...o, [key]: !o[key] }))} className="flex items-center gap-1 flex-1 text-left">
          {open[key] ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          <span>{title}</span>
          {count !== null && <span className="ml-1 px-1.5 rounded-full bg-white/10 text-zinc-300 text-[9.5px]">{count}</span>}
        </button>
        {actions}
      </div>
      {open[key] && body}
    </div>
  );

  return (
    <div className="flex-1 flex flex-col overflow-hidden text-[11.5px] relative">
      <div className="px-3 py-2 flex items-center gap-1.5 border-b border-white/5 shrink-0">
        <FolderGit2 size={13} className="text-zinc-500 shrink-0" />
        <input
          value={dir}
          onChange={(e) => setDir(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") refresh(); }}
          placeholder={isLocal ? "Repository folder" : "Repository folder (default: home)"}
          aria-label="Repository folder"
          className="flex-1 min-w-0 bg-transparent font-mono text-[11px] text-zinc-300 placeholder-zinc-600 focus:outline-none"
        />
        {status?.branch && <span className="px-1.5 rounded bg-primary/15 text-primary font-mono text-[10.5px] truncate max-w-[40%]">{status.branch}</span>}
        <button onClick={() => commit()} disabled={!hasChanges || !msg.trim() || busy} title="Commit" aria-label="Commit" className="p-1 rounded text-zinc-400 hover:text-white hover:bg-white/10 disabled:opacity-30">
          <Check size={14} />
        </button>
        <button onClick={() => refresh()} disabled={busy} title="Refresh" aria-label="Refresh" className="p-1 rounded text-zinc-400 hover:text-white hover:bg-white/10">
          <RefreshCw size={13} className={busy ? "animate-spin" : ""} />
        </button>
        <button onClick={() => setMenu((m) => !m)} disabled={!status} title="More Actions" aria-label="More Actions" aria-expanded={menu} className="p-1 rounded text-zinc-400 hover:text-white hover:bg-white/10 disabled:opacity-30">
          <MoreHorizontal size={14} />
        </button>
        {menu && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setMenu(false)} />
            <div className="absolute right-3 top-9 z-50 w-48 py-1 bg-[#15151a] border border-white/10 rounded-lg shadow-2xl">
              {menuItems.map((m) => (
                <button key={m.label} onClick={() => run(m.cmds, m.slow ? 120 : undefined)} className="w-full px-3 py-1.5 text-left text-zinc-300 hover:bg-white/[0.06] hover:text-white">
                  {m.label}
                </button>
              ))}
            </div>
          </>
        )}
      </div>

      <div className="flex-1 overflow-y-auto no-scrollbar">
        {!status ? (
          <div className="p-6 text-center text-zinc-500 flex flex-col gap-2">
            <p>{disabled ? "Not connected." : error || "Loading…"}</p>
            {!disabled && error && <p className="text-[10.5px]">Set the repository folder above, or <code>cd</code> into one in the terminal.</p>}
          </div>
        ) : (
          <>
            <div className="p-3 flex flex-col gap-2">
              <textarea
                value={msg}
                onChange={(e) => setMsg(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); commit(); } }}
                placeholder={`Message (Ctrl+Enter to commit on "${status.branch}")`}
                rows={2}
                className="w-full px-2 py-1.5 bg-black/30 border border-white/10 rounded text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-primary/60 resize-y font-sans"
              />
              {primary && (
                <button
                  onClick={primary.onClick}
                  disabled={primary.disabled || busy}
                  className="h-7 rounded bg-primary/80 hover:bg-primary text-white font-semibold flex items-center justify-center gap-1.5 disabled:opacity-40 disabled:hover:bg-primary/80"
                >
                  <primary.icon size={13} />
                  <span>{primary.label}</span>
                </button>
              )}
              {error && <pre className="whitespace-pre-wrap text-[10.5px] text-rose-300 bg-rose-500/10 border border-rose-500/20 rounded p-2 max-h-32 overflow-auto">{error}</pre>}
            </div>

            {status.staged.length > 0 && section("staged", "Staged Changes", status.staged.length, status.staged.map((f) => fileRow(f, true)),
              <button onClick={() => run([["reset", "-q"]])} disabled={busy} title="Unstage All Changes" aria-label="Unstage All Changes" className="p-0.5 rounded hover:bg-white/10 hover:text-white"><Minus size={12} /></button>)}
            {section("changes", "Changes", status.changes.length, status.changes.length
              ? status.changes.map((f) => fileRow(f, false))
              : <p className="px-6 py-1 text-zinc-500">No changes.</p>,
              status.changes.length > 0 && <button onClick={() => run([["add", "-A"]])} disabled={busy} title="Stage All Changes" aria-label="Stage All Changes" className="p-0.5 rounded hover:bg-white/10 hover:text-white"><Plus size={12} /></button>)}

            {section("graph", "Graph", null, (
              <div className="pb-2">
                {log.length === 0 && <p className="px-6 py-1 text-zinc-500">No commits yet.</p>}
                {log.map((c, i) => (
                  <div key={c.hash} className="flex items-center gap-2 px-3 h-[22px] hover:bg-white/[0.05]" title={`${c.hash} · ${c.author}\n${c.subject}`}>
                    <span className="relative w-3 self-stretch flex justify-center shrink-0">
                      <span className={`absolute w-px bg-primary/60 ${i === 0 ? "top-1/2" : "top-0"} ${i === log.length - 1 ? "bottom-1/2" : "bottom-0"}`} />
                      <span className={`relative self-center w-2 h-2 rounded-full ${i === 0 ? "border border-primary bg-[#0e0e13]" : "bg-primary"}`} />
                    </span>
                    <span className={`truncate ${i === 0 ? "font-bold text-zinc-100" : "text-zinc-300"}`}>{c.subject}</span>
                    <span className="text-zinc-500 text-[10px] truncate shrink-0 max-w-[30%]">{c.author}</span>
                    {c.refs.map((r) => (
                      <span key={r} className="px-1.5 rounded-full border border-primary/40 bg-primary/10 text-primary text-[9.5px] truncate max-w-[40%] shrink-0">
                        {r.replace(/^HEAD -> /, "")}
                      </span>
                    ))}
                  </div>
                ))}
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
};

export default GitPanel;
