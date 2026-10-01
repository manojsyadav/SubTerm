import React, { useState, useEffect, useRef } from "react";
import { Sparkles, Terminal, Copy, Check, Play, ArrowRight, ShieldCheck, AlertTriangle, X, Lightbulb } from "lucide-react";

interface AiCopilotModalProps {
  isOpen: boolean;
  onClose: () => void;
  onInsertCommand: (command: string, execute: boolean) => void;
}

interface CommandSuggestion {
  prompt: string;
  command: string;
  explanation: string;
  flags: { flag: string; desc: string }[];
  isDestructive?: boolean;
}

const COMMON_RECIPES: CommandSuggestion[] = [
  {
    prompt: "Find files larger than 100MB",
    command: "find . -type f -size +100M -exec ls -lh {} +",
    explanation: "Searches recursively from current directory for regular files greater than 100 megabytes and displays their human-readable sizes.",
    flags: [
      { flag: "-type f", desc: "Only match regular files (not directories or symlinks)" },
      { flag: "-size +100M", desc: "Filter files strictly larger than 100 Megabytes" },
      { flag: "-exec ls -lh {} +", desc: "Run `ls -lh` in batch on all matching files" },
    ],
  },
  {
    prompt: "Find files modified in the last 24 hours",
    command: "find . -type f -mtime -1 -ls",
    explanation: "Lists all files modified within the past 24 hours.",
    flags: [
      { flag: "-mtime -1", desc: "Modified less than 1 day ago" },
      { flag: "-ls", desc: "Output detailed file metadata" },
    ],
  },
  {
    prompt: "List top 10 memory consuming processes",
    command: "ps aux --sort=-%mem | head -n 11",
    explanation: "Sorts all system processes descending by percentage of physical RAM consumed and prints the top 10.",
    flags: [
      { flag: "aux", desc: "Show processes for all users with terminal & non-terminal processes" },
      { flag: "--sort=-%mem", desc: "Sort descending by memory usage" },
      { flag: "head -n 11", desc: "Include header row plus top 10 rows" },
    ],
  },
  {
    prompt: "Show active listening ports and processes",
    command: "sudo ss -tulpn | grep LISTEN",
    explanation: "Displays all listening TCP and UDP sockets with their associated PID and process names.",
    flags: [
      { flag: "-t", desc: "Display TCP sockets" },
      { flag: "-u", desc: "Display UDP sockets" },
      { flag: "-l", desc: "Display listening sockets only" },
      { flag: "-p", desc: "Show process using socket (requires sudo)" },
      { flag: "-n", desc: "Do not resolve service names (faster)" },
    ],
  },
  {
    prompt: "Docker cleanup dangling images and volumes",
    command: "docker system prune -f --volumes",
    explanation: "Removes all unused containers, networks, dangling images, and unreferenced volumes.",
    flags: [
      { flag: "-f", desc: "Do not prompt for confirmation" },
      { flag: "--volumes", desc: "Prune anonymous and dangling volumes" },
    ],
    isDestructive: true,
  },
  {
    prompt: "Check disk usage by top directories",
    command: "du -sh ./* 2>/dev/null | sort -hr | head -n 10",
    explanation: "Calculates total size of all top-level entries in the current directory and sorts them from largest to smallest.",
    flags: [
      { flag: "-s", desc: "Display summary total only per argument" },
      { flag: "-h", desc: "Human readable units (K, M, G)" },
      { flag: "sort -hr", desc: "Sort by human-numeric value in reverse order" },
    ],
  },
  {
    prompt: "Count established network connections by IP",
    command: "ss -tan state established | awk '{print $4}' | cut -d: -f1 | sort | uniq -c | sort -nr | head -n 10",
    explanation: "Aggregates established TCP connections by remote IP address to identify high-traffic sources.",
    flags: [
      { flag: "state established", desc: "Filter strictly for ESTABLISHED TCP connections" },
      { flag: "uniq -c", desc: "Count occurrences of each unique remote IP" },
    ],
  },
  {
    prompt: "View real-time auth failures in syslog",
    command: "sudo journalctl -u ssh -f -n 50",
    explanation: "Streams live authentication and SSH daemon logs with the last 50 entries.",
    flags: [
      { flag: "-u ssh", desc: "Filter logs from ssh.service unit only" },
      { flag: "-f", desc: "Follow / live stream new log entries" },
      { flag: "-n 50", desc: "Show the most recent 50 lines" },
    ],
  },
];

export const AiCopilotModal: React.FC<AiCopilotModalProps> = ({
  isOpen,
  onClose,
  onInsertCommand,
}) => {
  const [query, setQuery] = useState("");
  const [copied, setCopied] = useState(false);
  const [activeSuggestion, setActiveSuggestion] = useState<CommandSuggestion | null>(COMMON_RECIPES[0]);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen) {
      setQuery("");
      setActiveSuggestion(COMMON_RECIPES[0]);
      setTimeout(() => inputRef.current?.focus(), 60);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  // Filter recipes based on query
  const q = query.trim().toLowerCase();
  const matchingRecipes = COMMON_RECIPES.filter(
    (r) => r.prompt.toLowerCase().includes(q) || r.command.toLowerCase().includes(q)
  );

  const current = activeSuggestion || (matchingRecipes.length > 0 ? matchingRecipes[0] : null);

  const handleCopy = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center p-4 bg-black/80 backdrop-blur-xs animate-in fade-in duration-150"
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl bg-[#0f0f14] border border-white/10 rounded-2xl shadow-2xl flex flex-col overflow-hidden animate-in zoom-in-95 duration-150"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="p-4 border-b border-white/10 bg-[#14141a] flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-primary/10 border border-primary/25 flex items-center justify-center text-primary shadow-sm shadow-primary/20">
              <Sparkles size={16} />
            </div>
            <div>
              <h2 className="text-[14px] font-bold text-white flex items-center gap-2">
                Shell AI Copilot
                <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-primary/15 text-primary border border-primary/25 font-bold">
                  Ctrl+I
                </span>
              </h2>
              <p className="text-[11px] text-zinc-400">Describe a goal in natural language to generate verified shell commands</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="w-7 h-7 rounded-lg text-zinc-400 hover:text-white hover:bg-white/10 flex items-center justify-center transition-colors"
          >
            <X size={15} />
          </button>
        </div>

        {/* Search Bar */}
        <div className="p-4 border-b border-white/5 bg-[#121217]">
          <div className="relative flex items-center">
            <input
              ref={inputRef}
              type="text"
              className="w-full h-11 pl-4 pr-10 bg-black/60 rounded-xl text-[13px] text-white border border-white/10 outline-none focus:border-primary/50 focus:bg-black/90 transition-all font-medium placeholder-zinc-500 shadow-inner"
              placeholder="e.g., find files over 100mb, check ports, sort processes by memory..."
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                const match = COMMON_RECIPES.find(
                  (r) => r.prompt.toLowerCase().includes(e.target.value.toLowerCase()) || r.command.toLowerCase().includes(e.target.value.toLowerCase())
                );
                if (match) setActiveSuggestion(match);
              }}
              onKeyDown={(e) => {
                if (e.key === "Escape") onClose();
                if (e.key === "Enter" && current) {
                  onInsertCommand(current.command, false);
                  onClose();
                }
              }}
            />
            {query && (
              <button
                onClick={() => setQuery("")}
                className="absolute right-3 text-zinc-500 hover:text-white"
              >
                <X size={14} />
              </button>
            )}
          </div>

          {/* Quick Recipe Chips */}
          <div className="flex items-center gap-1.5 mt-2.5 overflow-x-auto no-scrollbar py-0.5">
            <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-500 shrink-0 mr-1 flex items-center gap-1">
              <Lightbulb size={11} className="text-amber-400" /> Quick:
            </span>
            {COMMON_RECIPES.slice(0, 5).map((r, i) => (
              <button
                key={i}
                type="button"
                onClick={() => {
                  setActiveSuggestion(r);
                  setQuery(r.prompt);
                }}
                className={`px-2.5 py-1 rounded-lg text-[11px] whitespace-nowrap transition-colors border ${
                  activeSuggestion?.prompt === r.prompt
                    ? "bg-primary/15 text-primary border-primary/30 font-semibold"
                    : "bg-white/[0.03] text-zinc-400 border-white/5 hover:bg-white/[0.08] hover:text-zinc-200"
                }`}
              >
                {r.prompt}
              </button>
            ))}
          </div>
        </div>

        {/* Content Body */}
        <div className="p-5 flex-1 overflow-y-auto space-y-4 max-h-[380px] custom-scrollbar">
          {current ? (
            <>
              {/* Generated Command Card */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-bold text-zinc-400 uppercase tracking-wider flex items-center gap-1.5">
                    <Terminal size={12} className="text-primary" /> Generated Shell Command
                  </span>
                  {current.isDestructive ? (
                    <span className="text-[10px] font-bold uppercase px-2 py-0.5 rounded bg-rose-500/15 text-rose-300 border border-rose-500/30 flex items-center gap-1">
                      <AlertTriangle size={11} /> Caution
                    </span>
                  ) : (
                    <span className="text-[10px] font-bold uppercase px-2 py-0.5 rounded bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 flex items-center gap-1">
                      <ShieldCheck size={11} /> Verified Safe
                    </span>
                  )}
                </div>

                <div className="relative group bg-black/90 rounded-xl p-3.5 border border-white/10 font-mono text-[13px] text-primary flex items-center justify-between shadow-inner">
                  <span className="break-all select-all font-medium pr-8">{current.command}</span>
                  <button
                    onClick={() => handleCopy(current.command)}
                    title="Copy command"
                    className="absolute right-3 top-3 p-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-zinc-400 hover:text-white transition-colors"
                  >
                    {copied ? <Check size={14} className="text-emerald-400" /> : <Copy size={14} />}
                  </button>
                </div>
              </div>

              {/* Explanation */}
              <div className="p-3 bg-white/[0.03] border border-white/5 rounded-xl space-y-1.5">
                <span className="text-[11px] font-bold text-zinc-400 uppercase tracking-wider block">Description</span>
                <p className="text-[12px] text-zinc-300 leading-relaxed">{current.explanation}</p>
              </div>

              {/* Flag Breakdown */}
              {current.flags && current.flags.length > 0 && (
                <div className="space-y-1.5">
                  <span className="text-[11px] font-bold text-zinc-400 uppercase tracking-wider block">Flag Breakdown</span>
                  <div className="grid grid-cols-1 gap-1.5">
                    {current.flags.map((f, idx) => (
                      <div key={idx} className="flex items-center gap-3 px-3 py-1.5 bg-black/40 border border-white/5 rounded-lg text-[12px]">
                        <span className="font-mono text-primary font-bold text-[11px] min-w-[120px] shrink-0">{f.flag}</span>
                        <span className="text-zinc-400 text-[11.5px]">{f.desc}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          ) : (
            <div className="text-center py-10 text-zinc-500 text-[13px]">
              No predefined recipe found for "{query}". Try a simpler term like "files", "ports", "docker", or "memory".
            </div>
          )}
        </div>

        {/* Footer Actions */}
        <div className="p-4 border-t border-white/10 bg-[#121217] flex items-center justify-between">
          <span className="text-[11px] text-zinc-500 hidden sm:inline">
            Press <kbd className="px-1.5 py-0.5 rounded bg-black/60 border border-white/10 font-mono text-[10px]">Enter</kbd> to insert
          </span>
          <div className="flex items-center gap-2 ml-auto">
            <button
              type="button"
              onClick={onClose}
              className="px-3.5 py-1.5 rounded-lg bg-white/[0.05] hover:bg-white/10 text-zinc-300 hover:text-white text-[12px] font-medium transition-colors"
            >
              Cancel
            </button>
            {current && (
              <>
                <button
                  type="button"
                  onClick={() => {
                    onInsertCommand(current.command, false);
                    onClose();
                  }}
                  className="px-3.5 py-1.5 rounded-lg bg-white/10 hover:bg-white/15 text-white text-[12px] font-bold transition-all flex items-center gap-1.5 border border-white/10"
                >
                  <ArrowRight size={13} />
                  Insert to Prompt
                </button>
                <button
                  type="button"
                  onClick={() => {
                    onInsertCommand(current.command, true);
                    onClose();
                  }}
                  className="px-3.5 py-1.5 rounded-lg bg-primary hover:bg-primary/90 text-black text-[12px] font-bold shadow-md shadow-primary/20 transition-all flex items-center gap-1.5"
                >
                  <Play size={13} />
                  Run Now
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
