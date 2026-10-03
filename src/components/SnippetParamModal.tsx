import { useState, useEffect, useMemo } from "react";
import { X, Play, Terminal, Sparkles, Radio } from "lucide-react";
import {
  parseSnippetVariables,
  getSavedSnippetParams,
  saveSnippetParams,
  interpolateSnippet,
  SnippetVariable,
} from "../utils/snippetTemplate";

interface SnippetParamModalProps {
  isOpen: boolean;
  onClose: () => void;
  rawCommand: string;
  title?: string;
  onRun: (resolvedCommand: string, execute: boolean) => void;
  broadcastSessionCount?: number;
}

export function SnippetParamModal({
  isOpen,
  onClose,
  rawCommand,
  title,
  onRun,
  broadcastSessionCount = 0,
}: SnippetParamModalProps) {
  const variables = useMemo<SnippetVariable[]>(() => {
    if (!isOpen || !rawCommand) return [];
    return parseSnippetVariables(rawCommand);
  }, [isOpen, rawCommand]);

  const [values, setValues] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!isOpen) return;
    const saved = getSavedSnippetParams();
    const initial: Record<string, string> = {};
    for (const v of variables) {
      initial[v.name] = saved[v.name] !== undefined ? saved[v.name] : v.defaultValue;
    }
    setValues(initial);
  }, [isOpen, variables]);

  const resolvedCommand = useMemo(() => {
    return interpolateSnippet(rawCommand, values);
  }, [rawCommand, values]);

  if (!isOpen) return null;

  const handleExecute = (execute: boolean) => {
    saveSnippetParams(values);
    onRun(resolvedCommand, execute);
    onClose();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      onClose();
    } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey || !e.shiftKey)) {
      e.preventDefault();
      handleExecute(true);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/75 backdrop-blur-sm animate-in fade-in duration-200"
      onClick={onClose}
      onKeyDown={handleKeyDown}
    >
      <div
        className="relative w-full max-w-lg bg-[#111116] border border-white/10 rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-white/10 bg-white/[0.02]">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-8 h-8 rounded-xl bg-primary/10 border border-primary/20 flex items-center justify-center text-primary shrink-0">
              <Sparkles size={16} />
            </div>
            <div className="min-w-0">
              <h3 className="text-sm font-bold text-white tracking-tight truncate">
                {title || "Parameterized Snippet"}
              </h3>
              <p className="text-[11px] text-zinc-400">
                Provide parameters for this snippet before executing
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="w-7 h-7 rounded-lg flex items-center justify-center text-zinc-400 hover:text-white hover:bg-white/10 transition-colors"
          >
            <X size={15} />
          </button>
        </div>

        {/* Fleet Broadcast notice */}
        {broadcastSessionCount >= 2 && (
          <div className="px-5 py-2 bg-orange-500/10 border-b border-orange-500/20 flex items-center gap-2 text-[11px] text-orange-200">
            <Radio size={13} className="text-orange-400 animate-pulse shrink-0" />
            <span>
              <strong>Fleet Broadcast Active:</strong> This command will be dispatched to <strong>{broadcastSessionCount} sessions</strong> concurrently.
            </span>
          </div>
        )}

        {/* Content & Inputs */}
        <div className="p-5 overflow-y-auto space-y-4 custom-scrollbar flex-1">
          {/* Variable Inputs */}
          <div className="space-y-3">
            {variables.map((v, idx) => (
              <div key={v.name} className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <label className="text-xs font-semibold text-zinc-200 font-mono flex items-center gap-1.5">
                    <span className="w-1.5 h-1.5 rounded-full bg-primary" />
                    {v.name}
                  </label>
                  {v.defaultValue && (
                    <span className="text-[10px] text-zinc-500 font-mono">
                      default: {v.defaultValue}
                    </span>
                  )}
                </div>
                <input
                  type="text"
                  autoFocus={idx === 0}
                  value={values[v.name] ?? ""}
                  placeholder={v.defaultValue || `Value for ${v.name}`}
                  onChange={(e) =>
                    setValues((prev) => ({ ...prev, [v.name]: e.target.value }))
                  }
                  className="w-full h-9 bg-black/60 border border-white/10 rounded-xl px-3 text-xs text-zinc-100 font-mono placeholder:text-zinc-600 outline-none focus:border-primary/50 focus:ring-1 focus:ring-primary/20 transition-all"
                />
              </div>
            ))}
          </div>

          {/* Live Preview */}
          <div className="space-y-1.5 pt-2">
            <div className="text-[11px] font-bold uppercase tracking-wider text-zinc-400 flex items-center gap-1.5">
              <Terminal size={12} className="text-primary" />
              Live Resolved Preview
            </div>
            <div className="bg-black/80 border border-white/5 rounded-xl p-3 max-h-36 overflow-y-auto custom-scrollbar">
              <pre className="text-xs font-mono text-emerald-400/90 whitespace-pre-wrap break-all leading-relaxed">
                {resolvedCommand}
              </pre>
            </div>
          </div>
        </div>

        {/* Footer Actions */}
        <div className="px-5 py-3.5 border-t border-white/10 bg-white/[0.02] flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={onClose}
            className="px-3.5 py-1.5 rounded-xl border border-white/10 bg-white/5 hover:bg-white/10 text-zinc-300 hover:text-white text-xs font-medium transition-colors"
          >
            Cancel
          </button>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => handleExecute(false)}
              title="Insert into shell prompt without pressing Enter"
              className="px-3.5 py-1.5 rounded-xl border border-white/10 bg-white/5 hover:bg-white/10 text-zinc-200 hover:text-white text-xs font-medium transition-colors"
            >
              Paste to Prompt
            </button>
            <button
              type="button"
              onClick={() => handleExecute(true)}
              className="px-4 py-1.5 rounded-xl bg-primary hover:bg-primary/90 text-black text-xs font-bold transition-all flex items-center gap-1.5 shadow-lg shadow-primary/20 active:scale-[0.98]"
            >
              <Play size={12} className="fill-black" />
              Run Command
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
