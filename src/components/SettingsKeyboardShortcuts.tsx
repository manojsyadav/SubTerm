import { useState, useEffect, useRef, useMemo } from "react";
import { Keyboard, Search, RotateCcw, AlertTriangle, Check, X, Edit2 } from "lucide-react";
import {
  DEFAULT_SHORTCUTS,
  useShortcutsStore,
  splitKeyCombo,
  eventToKeyCombo,
  ShortcutAction,
  ShortcutCategory,
} from "../shortcuts";

export function SettingsKeyboardShortcuts() {
  const {
    getShortcut,
    updateShortcut,
    resetShortcut,
    resetAll,
    isCustomized,
    getConflict,
  } = useShortcutsStore();

  const [search, setSearch] = useState("");
  const [selectedCategory, setSelectedCategory] = useState<string>("All");
  const [recordingId, setRecordingId] = useState<string | null>(null);
  const [recordedCombo, setRecordedCombo] = useState<string>("");
  const [conflictWarning, setConflictWarning] = useState<string | null>(null);

  const categories: string[] = useMemo(() => {
    const cats = Array.from(new Set(DEFAULT_SHORTCUTS.map((a) => a.category)));
    return ["All", ...cats];
  }, []);

  const filteredActions = useMemo(() => {
    const q = search.trim().toLowerCase();
    return DEFAULT_SHORTCUTS.filter((action) => {
      if (selectedCategory !== "All" && action.category !== selectedCategory) {
        return false;
      }
      if (!q) return true;
      const currentKey = getShortcut(action.id).toLowerCase();
      return (
        action.name.toLowerCase().includes(q) ||
        action.description.toLowerCase().includes(q) ||
        action.category.toLowerCase().includes(q) ||
        currentKey.includes(q)
      );
    });
  }, [search, selectedCategory, getShortcut]);

  // Handle key recording when recordingId is active
  useEffect(() => {
    if (!recordingId) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();

      // Escape cancels recording
      if (e.key === "Escape") {
        setRecordingId(null);
        setRecordedCombo("");
        setConflictWarning(null);
        return;
      }

      const combo = eventToKeyCombo(e);
      if (combo) {
        setRecordedCombo(combo);
        const conflict = getConflict(recordingId, combo);
        setConflictWarning(conflict);
      }
    };

    window.addEventListener("keydown", handleKeyDown, { capture: true });
    return () => {
      window.removeEventListener("keydown", handleKeyDown, { capture: true });
    };
  }, [recordingId, getConflict]);

  const handleStartRecording = (actionId: string) => {
    setRecordingId(actionId);
    setRecordedCombo("");
    setConflictWarning(null);
  };

  const handleSaveRecording = () => {
    if (recordingId && recordedCombo) {
      updateShortcut(recordingId, recordedCombo);
    }
    setRecordingId(null);
    setRecordedCombo("");
    setConflictWarning(null);
  };

  const handleCancelRecording = () => {
    setRecordingId(null);
    setRecordedCombo("");
    setConflictWarning(null);
  };

  return (
    <section className="bg-[#121215] border border-white/5 rounded-2xl p-4 sm:p-6 space-y-6 shadow-xl break-inside-avoid">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-zinc-400 font-bold uppercase tracking-widest text-xs">
            <Keyboard size={14} className="text-primary" /> Keyboard Shortcuts
          </div>
          <p className="text-xs text-zinc-400 mt-1">
            Customize hotkeys for terminal actions, panels, and tab navigation.
          </p>
        </div>

        <button
          type="button"
          onClick={resetAll}
          title="Reset all keyboard shortcuts to factory defaults"
          className="h-8 px-3 rounded-lg border border-white/10 hover:border-white/20 bg-white/[0.03] hover:bg-white/[0.08] text-zinc-300 hover:text-white text-xs font-semibold flex items-center gap-1.5 transition-all self-start sm:self-auto"
        >
          <RotateCcw size={12} />
          Reset All
        </button>
      </div>

      {/* Filter and Search Bar */}
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
        <div className="relative flex-1">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search shortcuts by name or keys..."
            className="w-full h-8 pl-8 pr-3 bg-white/[0.03] border border-white/10 rounded-lg text-xs text-white placeholder-zinc-500 focus:outline-none focus:border-primary/50 transition-all"
          />
          {search && (
            <button
              onClick={() => setSearch("")}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-white"
            >
              <X size={12} />
            </button>
          )}
        </div>

        {/* Category Pills */}
        <div className="flex items-center gap-1 overflow-x-auto no-scrollbar py-0.5">
          {categories.map((cat) => (
            <button
              key={cat}
              type="button"
              onClick={() => setSelectedCategory(cat)}
              className={`h-7 px-2.5 rounded-md text-[11px] font-semibold whitespace-nowrap transition-all ${
                selectedCategory === cat
                  ? "bg-primary/15 text-primary border border-primary/30"
                  : "bg-white/[0.03] text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-200 border border-transparent"
              }`}
            >
              {cat}
            </button>
          ))}
        </div>
      </div>

      {/* Shortcuts List */}
      <div className="space-y-1.5 max-h-[460px] overflow-y-auto custom-scrollbar pr-1">
        {filteredActions.length === 0 ? (
          <div className="text-center py-8 text-xs text-zinc-500">
            No keyboard shortcuts matched your search query.
          </div>
        ) : (
          filteredActions.map((action) => {
            const currentKey = getShortcut(action.id);
            const customized = isCustomized(action.id);
            const isRecording = recordingId === action.id;

            return (
              <div
                key={action.id}
                className={`p-3 rounded-xl border transition-all flex flex-col sm:flex-row sm:items-center justify-between gap-3 ${
                  isRecording
                    ? "bg-primary/[0.06] border-primary/40 ring-1 ring-primary/30"
                    : customized
                    ? "bg-white/[0.03] border-white/10"
                    : "bg-white/[0.015] border-white/5 hover:bg-white/[0.03]"
                }`}
              >
                <div className="space-y-0.5 min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-semibold text-white tracking-tight">
                      {action.name}
                    </span>
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-white/[0.05] text-zinc-400 font-mono">
                      {action.category}
                    </span>
                    {customized && !isRecording && (
                      <span className="text-[9px] px-1.5 py-0.2 rounded-full bg-amber-500/15 text-amber-300 font-medium">
                        Custom
                      </span>
                    )}
                  </div>
                  <p className="text-[11px] text-zinc-400 truncate">
                    {action.description}
                  </p>
                </div>

                {/* Right controls: Keys & Edit */}
                <div className="flex items-center gap-2 self-end sm:self-auto shrink-0">
                  {isRecording ? (
                    <div className="flex items-center gap-2 animate-in fade-in">
                      <div className="h-7 px-3 rounded-md bg-black/60 border border-primary/50 flex items-center gap-1.5 text-xs font-mono text-primary animate-pulse">
                        {recordedCombo ? (
                          splitKeyCombo(recordedCombo).map((k) => (
                            <kbd
                              key={k}
                              className="px-1.5 py-0.5 rounded bg-primary/20 text-primary font-bold text-[10px]"
                            >
                              {k}
                            </kbd>
                          ))
                        ) : (
                          <span className="text-[11px] text-zinc-400">Press keys now (Esc to cancel)...</span>
                        )}
                      </div>

                      {recordedCombo && (
                        <button
                          type="button"
                          onClick={handleSaveRecording}
                          title="Save shortcut"
                          className="h-7 w-7 rounded-md bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30 flex items-center justify-center transition-all"
                        >
                          <Check size={14} />
                        </button>
                      )}

                      <button
                        type="button"
                        onClick={handleCancelRecording}
                        title="Cancel"
                        className="h-7 w-7 rounded-md bg-white/[0.05] text-zinc-400 hover:text-white flex items-center justify-center transition-all"
                      >
                        <X size={14} />
                      </button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-1.5">
                      <div
                        onClick={() => handleStartRecording(action.id)}
                        className="cursor-pointer group flex items-center gap-1"
                        title="Click to rebind shortcut"
                      >
                        {splitKeyCombo(currentKey).map((k) => (
                          <kbd
                            key={k}
                            className="h-6 px-2 min-w-[20px] rounded bg-white/[0.06] border border-white/10 group-hover:border-primary/50 text-zinc-200 group-hover:text-primary font-mono text-[11px] font-semibold flex items-center justify-center shadow-xs transition-all"
                          >
                            {k}
                          </kbd>
                        ))}
                      </div>

                      <button
                        type="button"
                        onClick={() => handleStartRecording(action.id)}
                        title="Rebind shortcut"
                        className="h-6 w-6 rounded-md hover:bg-white/10 text-zinc-400 hover:text-white flex items-center justify-center transition-all"
                      >
                        <Edit2 size={12} />
                      </button>

                      {customized && (
                        <button
                          type="button"
                          onClick={() => resetShortcut(action.id)}
                          title={`Reset to default (${action.defaultKey})`}
                          className="h-6 w-6 rounded-md hover:bg-white/10 text-zinc-400 hover:text-amber-400 flex items-center justify-center transition-all"
                        >
                          <RotateCcw size={12} />
                        </button>
                      )}
                    </div>
                  )}
                </div>

                {/* Conflict Notice if Recording */}
                {isRecording && conflictWarning && (
                  <div className="w-full text-[11px] text-amber-400 flex items-center gap-1.5 pt-1">
                    <AlertTriangle size={12} />
                    <span>
                      Conflict: <strong>{recordedCombo}</strong> is also used for <strong>{conflictWarning}</strong>.
                    </span>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </section>
  );
}
