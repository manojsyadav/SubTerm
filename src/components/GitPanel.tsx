import React, { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Check,
  RefreshCw,
  MoreHorizontal,
  Plus,
  Minus,
  UploadCloud,
  ArrowDownUp,
  ChevronDown,
  ChevronRight,
  FolderGit2,
  Sparkles,
  RotateCcw,
  GitBranch as GitBranchIcon,
  ArrowDown,
  ArrowUp,
  Search,
} from "lucide-react";
import type { ExecResult } from "../ai/agentLoop";
import { getTerminalCwd, onTerminalCwdChange, setTerminalGitBranch, shellQuote } from "../terminal/cwd";
import {
  parseStatusZ,
  parseLog,
  parseBranches,
  parseDiffTree,
  LOG_FORMAT,
  type GitStatus,
  type GitCommit,
  type GitFile,
  type GitBranch,
  type CommitFileChange,
} from "../git/porcelain";
import { buildCommitGraph, ROW_HEIGHT, LANE_WIDTH, LANE_OFFSET } from "../git/graph";
import { listProviders, getLastProvider, chat, type ChatMsg } from "../ai/providers";

interface GitPanelProps {
  sessionId: string;
  terminalId: string;
  isLocal?: boolean;
  disabled?: boolean;
  visible: boolean;
}

// Local tabs on Windows run git through Windows PowerShell (always present); everything else is POSIX sh.
const PS = typeof navigator !== "undefined" && navigator.userAgent.includes("Windows");
const psQuote = (v: string) => `'${v.replace(/'/g, "''")}'`;

// Paths from `git status` are relative to the repo root, not the folder git runs in.
const top = (path: string) => `:(top,literal)${path}`;

export const GitPanel: React.FC<GitPanelProps> = ({ sessionId, terminalId, isLocal, disabled, visible }) => {
  const usePs = !!isLocal && PS;
  const [dir, setDir] = useState(() => getTerminalCwd(terminalId) ?? "");
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [log, setLog] = useState<GitCommit[]>([]);
  const [branches, setBranches] = useState<GitBranch[]>([]);
  const [branchMenu, setBranchMenu] = useState(false);
  const [branchFilter, setBranchFilter] = useState("");
  const [selectedCommit, setSelectedCommit] = useState<string | null>(null);
  const [commitFiles, setCommitFiles] = useState<Record<string, CommitFileChange[]>>({});
  const [loadingCommitHash, setLoadingCommitHash] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [menu, setMenu] = useState(false);
  const [open, setOpen] = useState({
    staged: true,
    changes: true,
    untracked: true,
    branches: false,
    graph: true,
  });
  const [aiGenerating, setAiGenerating] = useState(false);

  const graphNodes = useMemo(() => buildCommitGraph(log), [log]);
  const maxLanes = useMemo(() => Math.max(1, ...graphNodes.map((n) => n.maxLanes)), [graphNodes]);

  const modifiedFiles = useMemo(() => status?.changes.filter((f) => f.code !== "U") ?? [], [status]);
  const untrackedFiles = useMemo(() => status?.changes.filter((f) => f.code === "U") ?? [], [status]);

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
      const [s, l, b] = await Promise.all([
        exec([["status", "--porcelain=v1", "-b", "-z"]]),
        exec([["log", "-n", "50", `--format=${LOG_FORMAT}`]]),
        exec([["branch", "--format=%(refname:short)%09%(HEAD)%09%(upstream:short)%09%(upstream:track)%09%(objectname:short)%09%(subject)"]]),
      ]);
      if (s.exitCode !== 0) {
        setStatus(null);
        setLog([]);
        setBranches([]);
        setError(s.stderr.trim() || "Not a git repository");
        setTerminalGitBranch(terminalId, "");
        return;
      }
      const parsedStatus = parseStatusZ(s.stdout);
      setStatus(parsedStatus);
      setTerminalGitBranch(terminalId, parsedStatus.branch || "");
      setLog(l.exitCode === 0 ? parseLog(l.stdout) : []);

      let parsedBranches = b.exitCode === 0 ? parseBranches(b.stdout) : [];
      if (parsedBranches.length === 0 && parsedStatus.branch) {
        parsedBranches = [{
          name: parsedStatus.branch,
          isCurrent: true,
          upstream: parsedStatus.upstream,
          ahead: parsedStatus.ahead,
          behind: parsedStatus.behind,
          hash: "",
          subject: "",
        }];
      }
      setBranches(parsedBranches);
      setError("");
    } catch (e) {
      setError(String(e));
    }
  }, [exec, disabled, terminalId]);

  const generateAiCommit = async () => {
    if (busy || aiGenerating) return;
    setError("");
    try {
      const providers = await listProviders();
      if (!providers || providers.length === 0) {
        setError("No AI providers configured. Configure one in Settings → AI.");
        return;
      }
      const lastId = getLastProvider();
      const provider = providers.find((p) => p.id === lastId) ?? providers[0];

      const diffRes = await exec([status?.staged.length ? ["diff", "--cached"] : ["diff", "HEAD"]]);
      let diff = diffRes.stdout.trim();
      if (!diff && !status?.staged.length) {
        const unstaged = await exec([["diff"]]);
        diff = unstaged.stdout.trim();
      }
      if (!diff) {
        const stRes = await exec([["status", "-s"]]);
        diff = stRes.stdout.trim();
      }
      if (!diff) {
        setError("No changes found to generate a commit message for.");
        return;
      }

      if (diff.length > 8000) {
        diff = diff.slice(0, 8000) + "\n... [diff truncated]";
      }

      setAiGenerating(true);
      let generated = "";
      const system =
        "You are an expert developer. Generate a concise Conventional Commits message summarizing the provided git diff. Output ONLY the raw commit message (imperative mood, e.g. 'feat: add user auth' or 'fix: resolve tab crash', optionally followed by brief bullet points if needed). Do NOT include markdown code fences, quotes, or any conversational preamble.";
      const userMsg: ChatMsg = {
        role: "user",
        content: `Generate a commit message for the following changes:\n\n${diff}`,
      };

      await chat(
        provider.id,
        system,
        [userMsg],
        [],
        (chunk) => {
          generated += chunk;
          setMsg(generated.trim());
        }
      );
    } catch (e) {
      setError(`AI generation failed: ${e}`);
    } finally {
      setAiGenerating(false);
    }
  };

  useEffect(() => { if (visible) refresh(); }, [visible, refresh]);

  const run = async (cmds: string[][], timeoutSecs?: number) => {
    setBusy(true);
    setMenu(false);
    setBranchMenu(false);
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
    }
  };

  const checkoutBranch = async (branchName: string) => {
    setBranchMenu(false);
    if (status?.branch === branchName) return;
    await run([["checkout", branchName]]);
  };

  const createNewBranch = async () => {
    setBranchMenu(false);
    const name = window.prompt("New branch name:")?.trim();
    if (name) {
      await run([["checkout", "-b", name]]);
    }
  };

  const toggleCommit = async (hash: string) => {
    if (selectedCommit === hash) {
      setSelectedCommit(null);
      return;
    }
    setSelectedCommit(hash);
    if (!commitFiles[hash]) {
      setLoadingCommitHash(hash);
      try {
        const res = await exec([["diff-tree", "--no-commit-id", "--name-status", "-r", "--root", hash]]);
        if (res.exitCode === 0) {
          setCommitFiles((prev) => ({ ...prev, [hash]: parseDiffTree(res.stdout) }));
        }
      } catch {
        // ignore
      } finally {
        setLoadingCommitHash(null);
      }
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

  const discardFile = (f: GitFile) => {
    if (!window.confirm(`Discard changes in "${f.path}"? This cannot be undone.`)) return;
    if (f.code === "U" || f.code === "?") {
      run([["clean", "-f", "--", top(f.path)]]);
    } else {
      run([["restore", "--", top(f.path)]]);
    }
  };

  const discardAll = () => {
    if (!window.confirm("Discard ALL changes in the working tree? This cannot be undone.")) return;
    run([["restore", "."], ["clean", "-fd"]]);
  };

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
        {!staged && (
          <button
            onClick={() => discardFile(f)}
            disabled={busy}
            title="Discard Changes"
            aria-label={`Discard changes in ${f.path}`}
            className="p-0.5 rounded text-zinc-400 hover:text-rose-400 hover:bg-rose-500/10 opacity-0 group-hover:opacity-100 focus:opacity-100"
          >
            <RotateCcw size={12} />
          </button>
        )}
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

  const filteredBranches = useMemo(() => {
    if (!branchFilter.trim()) return branches;
    const q = branchFilter.toLowerCase();
    return branches.filter((b) => b.name.toLowerCase().includes(q));
  }, [branches, branchFilter]);

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
          className="flex-1 min-w-[100px] bg-transparent font-mono text-[11px] text-zinc-300 placeholder-zinc-600 focus:outline-none"
        />

        {/* Current Branch Badge & Switcher Trigger */}
        {status?.branch && (
          <div className="relative">
            <button
              onClick={() => setBranchMenu((m) => !m)}
              title="Switch Branch"
              aria-label="Switch Branch"
              className="h-6 px-2 rounded bg-primary/15 hover:bg-primary/25 text-primary font-mono text-[10.5px] flex items-center gap-1.5 transition-colors"
            >
              <GitBranchIcon size={11} className="shrink-0" />
              <span className="truncate max-w-[110px] font-semibold">{status.branch}</span>
              {(status.ahead > 0 || status.behind > 0) && (
                <span className="text-[9px] font-bold">
                  {status.ahead > 0 && <span className="text-amber-300">{status.ahead}↑</span>}
                  {status.behind > 0 && <span className="text-sky-300">{status.behind}↓</span>}
                </span>
              )}
              <ChevronDown size={10} className="shrink-0 opacity-60" />
            </button>

            {branchMenu && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setBranchMenu(false)} />
                <div className="absolute right-0 top-7 z-50 w-64 max-h-72 flex flex-col bg-[#15151a] border border-white/10 rounded-lg shadow-2xl overflow-hidden">
                  <div className="p-2 border-b border-white/5 flex items-center gap-1.5 bg-black/20">
                    <Search size={12} className="text-zinc-500 shrink-0" />
                    <input
                      value={branchFilter}
                      onChange={(e) => setBranchFilter(e.target.value)}
                      placeholder="Filter branches…"
                      className="flex-1 bg-transparent text-[11px] text-zinc-200 placeholder-zinc-500 focus:outline-none"
                      autoFocus
                    />
                  </div>
                  <div className="flex-1 overflow-y-auto py-1 no-scrollbar max-h-48">
                    {filteredBranches.map((b) => (
                      <button
                        key={b.name}
                        onClick={() => checkoutBranch(b.name)}
                        className={`w-full px-3 py-1.5 text-left text-[11px] flex items-center justify-between transition-colors ${
                          b.isCurrent
                            ? "bg-primary/20 text-white font-bold"
                            : "text-zinc-300 hover:bg-white/[0.06] hover:text-white"
                        }`}
                      >
                        <div className="flex items-center gap-1.5 truncate flex-1 mr-2">
                          <GitBranchIcon size={11} className={b.isCurrent ? "text-primary" : "text-zinc-500"} />
                          <span className="truncate">{b.name}</span>
                        </div>
                        <div className="flex items-center gap-1 text-[9.5px] font-mono shrink-0">
                          {b.ahead > 0 && <span className="text-amber-300">{b.ahead}↑</span>}
                          {b.behind > 0 && <span className="text-sky-300">{b.behind}↓</span>}
                          {b.isCurrent && <span className="px-1 rounded bg-primary text-black text-[9px] font-bold">HEAD</span>}
                        </div>
                      </button>
                    ))}
                    {filteredBranches.length === 0 && (
                      <div className="px-3 py-2 text-zinc-500 text-[10.5px]">No branches match &quot;{branchFilter}&quot;</div>
                    )}
                  </div>
                  <div className="p-1.5 border-t border-white/5 bg-black/30">
                    <button
                      onClick={createNewBranch}
                      className="w-full h-6 px-2 rounded bg-white/5 hover:bg-white/10 text-zinc-200 text-[10.5px] font-medium flex items-center justify-center gap-1 transition-colors"
                    >
                      <Plus size={11} />
                      <span>New Branch…</span>
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
        )}

        {/* Action Triggers: Fetch, Pull, Push */}
        <button
          onClick={() => run([["fetch", "--all", "--prune"]], 120)}
          disabled={!status || busy}
          title="Fetch All Remotes"
          aria-label="Fetch"
          className="p-1 rounded text-zinc-400 hover:text-white hover:bg-white/10 disabled:opacity-30 transition-colors"
        >
          <RefreshCw size={12} className={busy ? "animate-spin" : ""} />
        </button>
        <button
          onClick={() => run([["pull"]], 120)}
          disabled={!status || busy}
          title="Pull Changes"
          aria-label="Pull"
          className="p-1 rounded text-zinc-400 hover:text-white hover:bg-white/10 disabled:opacity-30 transition-colors"
        >
          <ArrowDown size={13} />
        </button>
        <button
          onClick={() => run([["push"]], 120)}
          disabled={!status || busy}
          title="Push Changes"
          aria-label="Push"
          className="p-1 rounded text-zinc-400 hover:text-white hover:bg-white/10 disabled:opacity-30 transition-colors"
        >
          <ArrowUp size={13} />
        </button>

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
              <div className="flex items-center justify-between">
                <label className="text-[10.5px] font-medium text-zinc-400">Commit Message</label>
                <button
                  type="button"
                  onClick={generateAiCommit}
                  disabled={busy || aiGenerating || (!status?.staged.length && !status?.changes.length)}
                  className="flex items-center gap-1 text-[10.5px] px-1.5 py-0.5 rounded text-primary hover:text-white hover:bg-primary/20 disabled:opacity-40 transition-colors"
                  title="Generate commit message with AI"
                  aria-label="Generate commit message with AI"
                >
                  <Sparkles size={11} className={aiGenerating ? "animate-spin text-amber-400" : ""} />
                  <span>{aiGenerating ? "Generating…" : "AI Generate"}</span>
                </button>
              </div>
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
                  disabled={primary.disabled || busy || aiGenerating}
                  className="h-7 rounded bg-primary/80 hover:bg-primary text-white font-semibold flex items-center justify-center gap-1.5 disabled:opacity-40 disabled:hover:bg-primary/80"
                >
                  <primary.icon size={13} />
                  <span>{primary.label}</span>
                </button>
              )}
              {error && <pre className="whitespace-pre-wrap text-[10.5px] text-rose-300 bg-rose-500/10 border border-rose-500/20 rounded p-2 max-h-32 overflow-auto">{error}</pre>}
            </div>

            {/* Branches Section */}
            {section("branches", "Branches", branches.length, (
              <div className="py-1">
                {branches.map((b) => (
                  <div
                    key={b.name}
                    className={`flex items-center justify-between px-3 py-1 hover:bg-white/[0.05] ${
                      b.isCurrent ? "bg-primary/10" : ""
                    }`}
                  >
                    <div className="flex items-center gap-2 truncate flex-1 mr-2">
                      <GitBranchIcon size={12} className={b.isCurrent ? "text-primary" : "text-zinc-500"} />
                      <span className={`truncate font-mono text-[11px] ${b.isCurrent ? "text-primary font-bold" : "text-zinc-200"}`}>
                        {b.name}
                      </span>
                      {b.isCurrent && (
                        <span className="px-1.5 py-0.2 rounded bg-primary/20 text-primary text-[9px] font-bold">
                          HEAD
                        </span>
                      )}
                      {(b.ahead > 0 || b.behind > 0) && (
                        <span className="text-[9.5px] font-mono">
                          {b.ahead > 0 && <span className="text-amber-300 mr-1">{b.ahead}↑</span>}
                          {b.behind > 0 && <span className="text-sky-300">{b.behind}↓</span>}
                        </span>
                      )}
                    </div>
                    {!b.isCurrent && (
                      <button
                        onClick={() => checkoutBranch(b.name)}
                        disabled={busy}
                        title={`Switch to branch ${b.name}`}
                        className="px-2 py-0.5 rounded bg-white/5 hover:bg-white/10 text-zinc-300 hover:text-white text-[10px] font-medium transition-colors"
                      >
                        Switch
                      </button>
                    )}
                  </div>
                ))}
              </div>
            ), (
              <button
                onClick={createNewBranch}
                disabled={busy}
                title="New Branch"
                aria-label="New Branch"
                className="p-0.5 rounded hover:bg-white/10 hover:text-white"
              >
                <Plus size={12} />
              </button>
            ))}

            {/* Staged Changes Section */}
            {status.staged.length > 0 && section(
              "staged",
              "Staged Changes",
              status.staged.length,
              status.staged.map((f) => fileRow(f, true)),
              <button onClick={() => run([["reset", "-q"]])} disabled={busy} title="Unstage All Changes" aria-label="Unstage All Changes" className="p-0.5 rounded hover:bg-white/10 hover:text-white"><Minus size={12} /></button>
            )}

            {/* Tracked Changes (Modified / Deleted) Section */}
            {section(
              "changes",
              "Changes",
              modifiedFiles.length,
              modifiedFiles.length
                ? modifiedFiles.map((f) => fileRow(f, false))
                : <p className="px-6 py-1 text-zinc-500">No changes.</p>,
              modifiedFiles.length > 0 && (
                <div className="flex items-center gap-0.5">
                  <button onClick={discardAll} disabled={busy} title="Discard All Changes" aria-label="Discard All Changes" className="p-0.5 rounded text-zinc-400 hover:text-rose-400 hover:bg-rose-500/10"><RotateCcw size={12} /></button>
                  <button onClick={() => run([["add", "-u"]])} disabled={busy} title="Stage All Tracked Changes" aria-label="Stage All Changes" className="p-0.5 rounded hover:bg-white/10 hover:text-white"><Plus size={12} /></button>
                </div>
              )
            )}

            {/* Untracked Files Section */}
            {untrackedFiles.length > 0 && section(
              "untracked",
              "Untracked Files",
              untrackedFiles.length,
              untrackedFiles.map((f) => fileRow(f, false)),
              <div className="flex items-center gap-0.5">
                <button
                  onClick={() => {
                    if (window.confirm("Delete ALL untracked files? This cannot be undone.")) {
                      run([["clean", "-fd"]]);
                    }
                  }}
                  disabled={busy}
                  title="Discard All Untracked Files"
                  aria-label="Discard All Untracked"
                  className="p-0.5 rounded text-zinc-400 hover:text-rose-400 hover:bg-rose-500/10"
                >
                  <RotateCcw size={12} />
                </button>
                <button
                  onClick={() => run([["add", "-A"]])}
                  disabled={busy}
                  title="Stage All Untracked Files"
                  aria-label="Stage All Untracked"
                  className="p-0.5 rounded hover:bg-white/10 hover:text-white"
                >
                  <Plus size={12} />
                </button>
              </div>
            )}

            {/* Commit Graph Section with inspection on click */}
            {section("graph", "Graph", null, (
              <div className="pb-2">
                {log.length === 0 && <p className="px-6 py-1 text-zinc-500">No commits yet.</p>}
                {log.map((c, i) => {
                  const node = graphNodes[i];
                  const svgWidth = Math.max(20, LANE_OFFSET * 2 + (maxLanes - 1) * LANE_WIDTH);
                  const isSelected = selectedCommit === c.hash;
                  const changedFiles = commitFiles[c.hash];
                  const isLoadingFiles = loadingCommitHash === c.hash;

                  return (
                    <div key={c.hash} className="flex flex-col border-b border-white/[0.03]">
                      <div
                        onClick={() => toggleCommit(c.hash)}
                        className={`flex items-center gap-2 px-3 h-[24px] cursor-pointer transition-colors ${
                          isSelected ? "bg-primary/15 text-white" : "hover:bg-white/[0.05]"
                        }`}
                        title={`${c.hash} · ${c.author}\n${c.subject}\nClick to view changed files`}
                      >
                        <svg width={svgWidth} height={ROW_HEIGHT} className="shrink-0 overflow-visible">
                          {node?.lines.map((l, lineIdx) => {
                            if (l.isCurve) {
                              return (
                                <path
                                  key={lineIdx}
                                  d={`M ${l.x1} ${l.y1} C ${l.x1} ${l.y1 + 7}, ${l.x2} ${l.y2 - 7}, ${l.x2} ${l.y2}`}
                                  stroke={l.color}
                                  strokeWidth={1.5}
                                  fill="none"
                                  strokeLinecap="round"
                                />
                              );
                            }
                            return (
                              <line
                                key={lineIdx}
                                x1={l.x1}
                                y1={l.y1}
                                x2={l.x2}
                                y2={l.y2}
                                stroke={l.color}
                                strokeWidth={1.5}
                                strokeLinecap="round"
                              />
                            );
                          })}
                          {node && (
                            <>
                              <circle
                                cx={node.x}
                                cy={node.y}
                                r={3.5}
                                fill={node.color}
                                stroke="#0e0e13"
                                strokeWidth={1.5}
                              />
                              {i === 0 && (
                                <circle cx={node.x} cy={node.y} r={1.5} fill="#ffffff" />
                              )}
                            </>
                          )}
                        </svg>
                        <span className="font-mono text-[10px] text-zinc-500 hover:text-primary shrink-0 select-all">{c.hash}</span>
                        <span className={`truncate flex-1 ${i === 0 ? "font-bold text-zinc-100" : "text-zinc-300"}`}>{c.subject}</span>
                        <span className="text-zinc-500 text-[10px] truncate shrink-0 max-w-[20%]">{c.author}</span>
                        {c.date && <span className="text-zinc-600 text-[9.5px] truncate shrink-0">{c.date}</span>}
                        {c.refs.map((r) => (
                          <span key={r} className="px-1.5 rounded-full border border-primary/40 bg-primary/10 text-primary text-[9.5px] truncate max-w-[30%] shrink-0">
                            {r.replace(/^HEAD -> /, "")}
                          </span>
                        ))}
                      </div>

                      {/* Expanded Commit Details & Changed Files on click */}
                      {isSelected && (
                        <div className="bg-black/40 px-6 py-2 border-t border-white/[0.04] text-[11px] flex flex-col gap-1.5">
                          <div className="flex items-center justify-between text-[10px] text-zinc-400 pb-1 border-b border-white/5">
                            <span className="font-mono text-zinc-300">Commit: {c.hash}</span>
                            <span>{c.author} {c.date ? `· ${c.date}` : ""}</span>
                          </div>
                          <p className="text-zinc-200 font-medium whitespace-pre-wrap">{c.subject}</p>
                          <div className="mt-1 flex flex-col gap-1">
                            <div className="text-[10px] font-bold uppercase tracking-wider text-zinc-500 flex items-center justify-between">
                              <span>Changed Files</span>
                              <span>{changedFiles ? changedFiles.length : (isLoadingFiles ? "…" : 0)}</span>
                            </div>
                            {isLoadingFiles && (
                              <p className="text-zinc-500 text-[10.5px] py-1">Loading changed files…</p>
                            )}
                            {changedFiles?.map((cf) => {
                              const color = cf.code === "D" ? "text-rose-400 bg-rose-500/10" : cf.code === "A" ? "text-emerald-400 bg-emerald-500/10" : "text-amber-400 bg-amber-500/10";
                              return (
                                <div key={cf.path} className="flex items-center gap-2 py-0.5 text-zinc-300 font-mono text-[10.5px]">
                                  <span className={`w-4 text-center rounded text-[9.5px] font-bold ${color}`}>{cf.code}</span>
                                  <span className="truncate flex-1 text-zinc-300" title={cf.path}>{cf.path}</span>
                                </div>
                              );
                            })}
                            {changedFiles && changedFiles.length === 0 && (
                              <p className="text-zinc-500 text-[10.5px]">No file changes recorded for this commit.</p>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
};

export default GitPanel;
