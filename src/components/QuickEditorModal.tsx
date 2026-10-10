import React, { useState, useEffect, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { 
  X, Save, FileCode, Check, RefreshCw, SplitSquareHorizontal, 
  Copy
} from "lucide-react";
import { FileEntry, FileProvider } from "../fs/types";
import { computeDiff } from "../fs/diff";
import { CodeEditor } from "../editor/CodeEditor";

interface QuickEditorModalProps {
  isOpen: boolean;
  onClose: () => void;
  entry: FileEntry | null;
  provider: Pick<FileProvider, "id" | "label"> | FileProvider;
  sessionId?: string;
  onSaved?: () => void;
}

export const QuickEditorModal: React.FC<QuickEditorModalProps> = ({
  isOpen,
  onClose,
  entry,
  provider,
  sessionId,
  onSaved,
}) => {
  const [originalContent, setOriginalContent] = useState("");
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [showDiff, setShowDiff] = useState(false);
  const [copied, setCopied] = useState(false);

  const isDirty = content !== originalContent;

  // Load file content whenever entry opens
  useEffect(() => {
    if (!isOpen || !entry || entry.isDir) return;

    let mounted = true;
    setLoading(true);
    setError(null);
    setShowDiff(false);

    (async () => {
      try {
        let text = "";
        if (provider.id === "remote") {
          if (!sessionId) throw new Error("Remote session ID missing");
          text = await invoke<string>("sftp_read_file_text", {
            sessionId,
            remotePath: entry.path,
            maxBytes: 2 * 1024 * 1024, // 2MB limit
          });
        } else {
          text = await invoke<string>("local_read_file_text", {
            localPath: entry.path,
            maxBytes: 2 * 1024 * 1024,
          });
        }
        if (mounted) {
          setOriginalContent(text);
          setContent(text);
        }
      } catch (err: any) {
        if (mounted) setError(String(err));
      } finally {
        if (mounted) setLoading(false);
      }
    })();

    return () => {
      mounted = false;
    };
  }, [isOpen, entry, provider, sessionId]);

  // Handle Save
  const handleSave = async () => {
    if (!entry || saving || !isDirty) return;

    setSaving(true);
    setError(null);
    try {
      if (provider.id === "remote") {
        if (!sessionId) throw new Error("Remote session ID missing");
        await invoke("sftp_write_file_text", {
          sessionId,
          remotePath: entry.path,
          content,
        });
      } else {
        await invoke("local_write_file_text", {
          localPath: entry.path,
          content,
        });
      }
      setOriginalContent(content);
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 2000);
      onSaved?.();
    } catch (err: any) {
      setError(`Save failed: ${err}`);
    } finally {
      setSaving(false);
    }
  };

  // Keyboard shortcut Ctrl+S / Cmd+S
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        handleSave();
      } else if (e.key === "Escape") {
        if (isDirty) {
          if (window.confirm("You have unsaved changes. Discard and close?")) {
            onClose();
          }
        } else {
          onClose();
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, content, originalContent, isDirty, saving, entry]);

  const lines = useMemo(() => content.split("\n"), [content]);
  const diffLines = useMemo(() => {
    if (!showDiff) return [];
    return computeDiff(originalContent, content);
  }, [showDiff, originalContent, content]);

  if (!isOpen || !entry) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4 animate-in fade-in duration-150">
      <div className="w-full max-w-5xl h-[85vh] bg-[#0d0d11] border border-white/10 rounded-xl shadow-2xl flex flex-col overflow-hidden">
        {/* Top Header */}
        <div className="h-12 px-4 border-b border-white/10 bg-[#121217] flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2.5 min-w-0">
            <FileCode size={16} className="text-indigo-400 shrink-0" />
            <div className="flex items-center gap-1.5 min-w-0">
              <span className="text-xs font-bold text-zinc-100 font-mono truncate">
                {entry.name}
              </span>
              {isDirty && (
                <span className="text-amber-400 font-bold text-xs" title="Unsaved changes">●</span>
              )}
            </div>
            <span className="text-[10px] text-zinc-500 font-mono truncate max-w-md hidden sm:inline">
              ({entry.path})
            </span>
          </div>

          <div className="flex items-center gap-2">
            {/* Diff Toggle */}
            <button
              onClick={() => setShowDiff((p) => !p)}
              disabled={loading}
              className={`h-7 px-2.5 rounded-lg border text-xs font-mono font-medium flex items-center gap-1.5 transition-all ${
                showDiff
                  ? "bg-indigo-600/20 border-indigo-500/50 text-indigo-300"
                  : "bg-white/[0.04] border-white/10 text-zinc-400 hover:text-zinc-200 hover:bg-white/10"
              }`}
              title="Compare changes with original"
            >
              <SplitSquareHorizontal size={13} />
              <span className="hidden sm:inline">{showDiff ? "Editor" : "Diff"}</span>
            </button>

            {/* Copy Button */}
            <button
              onClick={async () => {
                await navigator.clipboard.writeText(content);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
              className="h-7 px-2 rounded-lg bg-white/[0.04] border border-white/10 text-zinc-400 hover:text-zinc-200 hover:bg-white/10 text-xs flex items-center gap-1 transition-all"
              title="Copy to clipboard"
            >
              {copied ? <Check size={13} className="text-emerald-400" /> : <Copy size={13} />}
            </button>

            {/* Save Button */}
            <button
              onClick={handleSave}
              disabled={saving || loading || !isDirty}
              className="h-7 px-3 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 disabled:hover:bg-emerald-600 text-white font-mono text-xs font-bold flex items-center gap-1.5 shadow transition-all"
              title="Save file (Ctrl+S)"
            >
              {saving ? (
                <RefreshCw size={13} className="animate-spin" />
              ) : saveSuccess ? (
                <Check size={13} className="text-white" />
              ) : (
                <Save size={13} />
              )}
              <span>{saveSuccess ? "Saved" : "Save"}</span>
            </button>

            <div className="h-4 w-px bg-white/10 mx-1" />

            {/* Close */}
            <button
              onClick={() => {
                if (isDirty && !window.confirm("Discard unsaved changes?")) return;
                onClose();
              }}
              className="p-1 rounded-lg text-zinc-400 hover:text-white hover:bg-white/10 transition-colors"
              title="Close editor (Esc)"
            >
              <X size={16} />
            </button>
          </div>
        </div>

        {/* Error Banner */}
        {error && (
          <div className="p-2.5 bg-rose-950/60 border-b border-rose-500/30 text-rose-300 text-xs flex items-center gap-2 font-mono">
            <span className="truncate">{error}</span>
          </div>
        )}

        {/* Editor or Diff View Area */}
        <div className="flex-1 flex overflow-hidden relative font-mono text-xs">
          {loading ? (
            <div className="flex-1 flex flex-col items-center justify-center gap-3 text-zinc-400">
              <RefreshCw size={24} className="animate-spin text-indigo-400" />
              <span>Loading file contents…</span>
            </div>
          ) : showDiff ? (
            /* Visual Diff View */
            <div className="flex-1 overflow-auto bg-[#0a0a0d] p-3 no-scrollbar select-text">
              <div className="mb-2 text-[11px] text-zinc-400 font-bold border-b border-white/5 pb-1 flex justify-between">
                <span>Changes Diff Preview</span>
                <span className="text-zinc-500 font-normal">
                  {diffLines.filter((l) => l.type === "add").length} additions,{" "}
                  {diffLines.filter((l) => l.type === "del").length} deletions
                </span>
              </div>
              {diffLines.map((line, idx) => (
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
                  <span className="w-8 shrink-0 text-right pr-3 select-none text-zinc-600">
                    {line.oldNum || ""}
                  </span>
                  <span className="w-8 shrink-0 text-right pr-3 select-none text-zinc-600">
                    {line.newNum || ""}
                  </span>
                  <span className="w-4 shrink-0 select-none font-bold">
                    {line.type === "add" ? "+" : line.type === "del" ? "-" : " "}
                  </span>
                  <pre className="flex-1 font-mono whitespace-pre-wrap break-all select-text">
                    {line.text || " "}
                  </pre>
                </div>
              ))}
            </div>
          ) : (
            /* Syntax-highlighted code editor (CodeMirror 6) */
            <div className="flex-1 flex overflow-hidden relative">
              <CodeEditor value={content} onChange={setContent} fileName={entry.name} filePath={entry.path} />
            </div>
          )}
        </div>

        {/* Footer Status Bar */}
        <div className="h-7 px-4 bg-[#09090c] border-t border-white/10 flex items-center justify-between text-[10px] font-mono text-zinc-500 shrink-0">
          <div className="flex items-center gap-3">
            <span>Lines: {lines.length}</span>
            <span>Length: {content.length} chars</span>
            <span>Provider: {provider.label}</span>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-zinc-400">Ctrl+S to Save</span>
            <span className="text-zinc-400">Esc to Close</span>
          </div>
        </div>
      </div>
    </div>
  );
};
