import React, { useState, useEffect, useMemo, lazy, Suspense } from "react";
import { invoke } from "@tauri-apps/api/core";
import { 
  X, Save, FileCode, Check, RefreshCw, SplitSquareHorizontal, 
  Copy, MessageSquareOff, Eye, Pencil, Search, ChevronUp, ChevronDown
} from "lucide-react";
import { FileEntry, FileProvider } from "../fs/types";
import { computeDiff } from "../fs/diff";
import { useFeatureFlag } from "../featureFlags";
import { detectLanguage } from "../editor/language";
import { hiddenCommentLineCount, supportsCommentHiding } from "../editor/comments";
import { readEditorPrefs } from "../editor/editorPrefs";

const MarkdownView = lazy(() => import("../editor/markdown").then((m) => ({ default: m.MarkdownView })));
const isMarkdown = (name: string) => /\.(md|markdown|mdown|mkd)$/i.test(name);

// Lazy so the CodeMirror bundle is only downloaded/evaluated when highlighting is enabled and a file is opened.
const CodeEditor = lazy(() => import("../editor/CodeEditor").then((m) => ({ default: m.CodeEditor })));

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
  // Editing and saving need the file's real content; after a failed read the buffer is not
  // the file, and saving it would overwrite the file (a >2 MB log with a few bytes).
  const [loaded, setLoaded] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [showDiff, setShowDiff] = useState(false);
  const [copied, setCopied] = useState(false);
  // Every file opens in the viewer (Markdown rendered, anything else read-only); Edit switches over.
  const [mode, setMode] = useState<"view" | "edit">("view");

  const highlightEnabled = useFeatureFlag("editorSyntaxHighlight");
  // Read once per open: changing these in Settings applies the next time a file is opened.
  const editorPrefs = useMemo(() => readEditorPrefs(), []);
  const hideCommentsAvailable = useFeatureFlag("editorHideComments") && highlightEnabled;
  const [hideComments, setHideComments] = useState(() => localStorage.getItem("subterm-editor-hide-comments") === "true");
  const toggleHideComments = () => setHideComments((p) => {
    localStorage.setItem("subterm-editor-hide-comments", String(!p));
    return !p;
  });

  const isDirty = content !== originalContent;

  const [showSearch, setShowSearch] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchIndex, setSearchIndex] = useState(0);

  const matchesCount = useMemo(() => {
    if (!searchQuery.trim()) return 0;
    try {
      const rx = new RegExp(searchQuery.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
      return (content.match(rx) || []).length;
    } catch {
      return 0;
    }
  }, [content, searchQuery]);

  const findNext = (backwards = false) => {
    if (!searchQuery.trim()) return;
    if (typeof window !== "undefined" && typeof (window as unknown as { find?: (q: string, caseSensitive: boolean, backwards: boolean, wrap: boolean) => boolean }).find === "function") {
      (window as unknown as { find: (q: string, caseSensitive: boolean, backwards: boolean, wrap: boolean) => boolean }).find(searchQuery, false, backwards, true);
    }
    if (matchesCount > 0) {
      setSearchIndex((prev) => (backwards ? (prev <= 1 ? matchesCount : prev - 1) : (prev >= matchesCount ? 1 : prev + 1)));
    }
  };

  // Load file content whenever entry opens
  useEffect(() => {
    if (!isOpen || !entry || entry.isDir) return;

    let mounted = true;
    setLoading(true);
    setLoaded(false);
    setOriginalContent("");
    setContent("");
    setError(null);
    setShowDiff(false);
    setMode("view");

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
          setLoaded(true);
        }
      } catch (err) {
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
    if (!entry || saving || !isDirty || !loaded) return;

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
    } catch (err) {
      setError(`Save failed: ${err}`);
    } finally {
      setSaving(false);
    }
  };

  // Keyboard shortcut Ctrl+S / Cmd+S and Ctrl+F in viewer
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        handleSave();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
        if (mode === "view") {
          e.preventDefault();
          setShowSearch((prev) => !prev);
        }
      } else if (e.key === "Escape") {
        if (showSearch) {
          e.preventDefault();
          setShowSearch(false);
          return;
        }
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
  }, [isOpen, content, originalContent, isDirty, saving, entry, mode, showSearch]);

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
            {/* Hide comments (view only) */}
            {hideCommentsAvailable && !showDiff && supportsCommentHiding(detectLanguage(entry.name, entry.path)) && (
              <button
                onClick={toggleHideComments}
                disabled={loading}
                className={`h-7 px-2.5 rounded-lg border text-xs font-mono font-medium flex items-center gap-1.5 transition-all ${
                  hideComments
                    ? "bg-indigo-600/20 border-indigo-500/50 text-indigo-300"
                    : "bg-white/[0.04] border-white/10 text-zinc-400 hover:text-zinc-200 hover:bg-white/10"
                }`}
                title="Hide comment lines (view only — the saved file is unchanged)"
              >
                <MessageSquareOff size={13} />
                <span className="hidden sm:inline">{hideComments ? "Comments hidden" : "Hide comments"}</span>
              </button>
            )}

            {/* View / Edit */}
            <div role="group" aria-label="Mode" className="h-7 flex rounded-lg border border-white/10 bg-white/[0.04] overflow-hidden text-xs font-mono">
              {([["view", Eye, isMarkdown(entry.name) ? "Preview" : "View"], ["edit", Pencil, "Edit"]] as const).map(([m, Icon, label]) => (
                <button
                  key={m}
                  onClick={() => { setMode(m); setShowDiff(false); }}
                  disabled={loading || (m === "edit" && !loaded)}
                  aria-pressed={mode === m}
                  title={m === "view" ? "Read-only view" : "Edit the file"}
                  className={`px-2.5 flex items-center gap-1.5 transition-colors ${mode === m ? "bg-indigo-600/25 text-indigo-200" : "text-zinc-400 hover:text-zinc-200 hover:bg-white/10"}`}
                >
                  <Icon size={13} />
                  <span className="hidden sm:inline">{label}</span>
                </button>
              ))}
            </div>

            {/* Diff Toggle */}
            {(mode === "edit" || isDirty) && (
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
            )}

            {/* Find in viewer */}
            {mode === "view" && (
              <button
                onClick={() => setShowSearch((s) => !s)}
                className={`h-7 px-2 rounded-lg border text-xs flex items-center gap-1 transition-all ${
                  showSearch
                    ? "bg-primary/20 border-primary/40 text-primary font-semibold"
                    : "bg-white/[0.04] border-white/10 text-zinc-400 hover:text-zinc-200 hover:bg-white/10"
                }`}
                title="Find in viewer (Ctrl+F)"
                aria-label="Find in viewer"
              >
                <Search size={13} />
              </button>
            )}

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
            {(mode === "edit" || isDirty) && (
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
            )}

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

        {/* In-viewer Find Bar */}
        {showSearch && (
          <div className="px-4 py-1.5 bg-[#17171f] border-b border-white/10 flex items-center gap-2 text-xs">
            <Search size={13} className="text-zinc-500 shrink-0" />
            <input
              type="text"
              autoFocus
              value={searchQuery}
              onChange={(e) => {
                setSearchQuery(e.target.value);
                setSearchIndex(e.target.value.trim() ? 1 : 0);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  findNext(e.shiftKey);
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  setShowSearch(false);
                }
              }}
              placeholder="Find in document…"
              aria-label="Find in document"
              className="bg-black/30 border border-white/10 rounded px-2 py-0.5 text-zinc-200 placeholder-zinc-500 font-mono text-[11px] focus:outline-none focus:border-primary/50 w-64"
            />
            <span className="text-[10.5px] text-zinc-400 font-mono select-none min-w-[70px]">
              {searchQuery.trim()
                ? matchesCount > 0
                  ? `${searchIndex || 1} of ${matchesCount}`
                  : "No matches"
                : ""}
            </span>
            <button
              onClick={() => findNext(true)}
              disabled={!matchesCount}
              className="p-1 rounded text-zinc-400 hover:text-white hover:bg-white/10 disabled:opacity-30"
              title="Previous match (Shift+Enter)"
              aria-label="Previous match"
            >
              <ChevronUp size={13} />
            </button>
            <button
              onClick={() => findNext(false)}
              disabled={!matchesCount}
              className="p-1 rounded text-zinc-400 hover:text-white hover:bg-white/10 disabled:opacity-30"
              title="Next match (Enter)"
              aria-label="Next match"
            >
              <ChevronDown size={13} />
            </button>
            <button
              onClick={() => setShowSearch(false)}
              className="p-1 rounded text-zinc-400 hover:text-white hover:bg-white/10 ml-auto"
              title="Close find (Esc)"
              aria-label="Close find"
            >
              <X size={13} />
            </button>
          </div>
        )}

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
          ) : mode === "view" && isMarkdown(entry.name) ? (
            <Suspense fallback={<div className="flex-1 flex items-center justify-center text-zinc-500">Loading…</div>}>
              <MarkdownView source={content} />
            </Suspense>
          ) : (
            /* Syntax-highlighted code editor (CodeMirror 6) */
            <div className="flex-1 flex overflow-hidden relative">
              {highlightEnabled ? (
                <Suspense fallback={<div className="flex-1 flex items-center justify-center text-zinc-500">Loading editor…</div>}>
                  <CodeEditor value={content} onChange={setContent} fileName={entry.name} filePath={entry.path} hideComments={hideCommentsAvailable && hideComments} readOnly={mode === "view" || !loaded} />
                </Suspense>
              ) : (
                <textarea
                  value={content}
                  onChange={(e) => setContent(e.target.value)}
                  readOnly={mode === "view" || !loaded}
                  spellCheck={false}
                  style={{ fontSize: `${editorPrefs.fontSize}px`, tabSize: editorPrefs.tabSize, whiteSpace: editorPrefs.wordWrap ? "pre-wrap" : "pre" }}
                  className="flex-1 h-full p-3 bg-transparent text-zinc-200 placeholder-zinc-600 resize-none focus:outline-none font-mono leading-5 overflow-auto custom-scrollbar"
                  placeholder="File is empty"
                />
              )}
            </div>
          )}
        </div>

        {/* Footer Status Bar */}
        <div className="h-7 px-4 bg-[#09090c] border-t border-white/10 flex items-center justify-between text-[10px] font-mono text-zinc-500 shrink-0">
          <div className="flex items-center gap-3">
            <span>Lines: {lines.length}</span>
            {hideCommentsAvailable && hideComments && (
              <span className="text-indigo-300">{hiddenCommentLineCount(content, detectLanguage(entry.name, entry.path))} comment lines hidden</span>
            )}
            <span>Length: {content.length} chars</span>
            <span>Provider: {provider.label}</span>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-zinc-400">{mode === "view" ? "Read-only · Edit to change" : "Ctrl+S to Save"}</span>
            <span className="text-zinc-400">Esc to Close</span>
          </div>
        </div>
      </div>
    </div>
  );
};
