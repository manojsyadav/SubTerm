import { useState, useMemo } from "react";
import {
  Terminal,
  Plus,
  Trash2,
  ArrowUp,
  ArrowDown,
  RotateCcw,
  Edit2,
  Check,
  X,
  Sparkles,
  CornerDownLeft,
  Layers,
} from "lucide-react";
import {
  useQuickCommands,
  DEFAULT_QUICK_COMMANDS,
  QuickCommandItem,
} from "../utils/quickCommandsStore";

export function SettingsQuickCommands() {
  const {
    config,
    updateCommandsForEnv,
    addCommand,
    removeCommand,
    updateCommand,
    reorderCommands,
    resetEnv,
    resetAll,
    addCustomEnv,
    removeCustomEnv,
  } = useQuickCommands();

  const envKeys = useMemo(() => Object.keys(config), [config]);
  const [selectedEnv, setSelectedEnv] = useState<string>("linux");
  const [isAdding, setIsAdding] = useState(false);
  const [newLabel, setNewLabel] = useState("");
  const [newCmd, setNewCmd] = useState("");
  const [newAutoEnter, setNewAutoEnter] = useState(true);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editLabel, setEditLabel] = useState("");
  const [editCmd, setEditCmd] = useState("");
  const [editAutoEnter, setEditAutoEnter] = useState(true);

  const [isAddingEnv, setIsAddingEnv] = useState(false);
  const [newEnvId, setNewEnvId] = useState("");
  const [newEnvName, setNewEnvName] = useState("");
  const [newEnvIcon, setNewEnvIcon] = useState("⚡");

  const currentGroup = config[selectedEnv] || config["linux"] || DEFAULT_QUICK_COMMANDS["linux"];
  const commands = currentGroup?.commands || [];
  const isDefaultEnv = Boolean(DEFAULT_QUICK_COMMANDS[selectedEnv]);

  const handleStartAdd = () => {
    setIsAdding(true);
    setNewLabel("");
    setNewCmd("");
    setNewAutoEnter(true);
  };

  const handleSaveAdd = () => {
    if (!newLabel.trim() || !newCmd.trim()) return;
    const finalCmd = newAutoEnter
      ? newCmd.trim().endsWith("\r")
        ? newCmd.trim()
        : `${newCmd.trim()}\r`
      : newCmd.trim().replace(/\r+$/, "");

    addCommand(selectedEnv, {
      label: newLabel.trim(),
      cmd: finalCmd,
      autoEnter: newAutoEnter,
    });
    setIsAdding(false);
    setNewLabel("");
    setNewCmd("");
  };

  const handleStartEdit = (cmd: QuickCommandItem) => {
    setEditingId(cmd.id);
    setEditLabel(cmd.label);
    const hasEnter = cmd.cmd.endsWith("\r");
    setEditCmd(cmd.cmd.replace(/\r+$/, ""));
    setEditAutoEnter(cmd.autoEnter !== false && hasEnter);
  };

  const handleSaveEdit = (cmdId: string) => {
    if (!editLabel.trim() || !editCmd.trim()) return;
    const finalCmd = editAutoEnter
      ? editCmd.trim().endsWith("\r")
        ? editCmd.trim()
        : `${editCmd.trim()}\r`
      : editCmd.trim().replace(/\r+$/, "");

    updateCommand(selectedEnv, cmdId, {
      label: editLabel.trim(),
      cmd: finalCmd,
      autoEnter: editAutoEnter,
    });
    setEditingId(null);
  };

  const handleSaveCustomEnv = () => {
    if (!newEnvId.trim() || !newEnvName.trim()) return;
    const success = addCustomEnv(newEnvId, newEnvName, newEnvIcon || "⚡");
    if (success) {
      setSelectedEnv(newEnvId.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "-"));
      setIsAddingEnv(false);
      setNewEnvId("");
      setNewEnvName("");
    }
  };

  return (
    <section className="break-inside-avoid mb-4 sm:mb-8 bg-[#121215] border border-white/5 rounded-2xl p-5 sm:p-6 shadow-xl" id="quick-commands-setting">
      <div className="flex items-center justify-between gap-3 mb-4">
        <h3 className="flex items-center gap-2 text-sm font-bold text-white">
          <Terminal size={14} className="text-primary" /> Quick Commands by OS / Environment
        </h3>
        <button
          type="button"
          onClick={() => {
            if (window.confirm("Reset all environments to factory default quick commands?")) {
              resetAll();
            }
          }}
          className="text-[11px] text-zinc-500 hover:text-rose-400 transition-colors flex items-center gap-1"
          title="Reset all environments to default quick commands"
        >
          <RotateCcw size={11} /> Reset All Defaults
        </button>
      </div>

      <div className="space-y-5">
        <div className="space-y-1">
          <p className="text-xs text-zinc-400 leading-relaxed">
            Customize the quick action ribbon buttons that appear atop the terminal. SubTerm automatically detects the connected host OS (Linux, TrueNAS, Windows PowerShell/CMD, macOS) and renders the matching commands.
          </p>
        </div>

        {/* Environment Selector Tabs */}
        <div className="space-y-2">
          <div className="flex items-center justify-between text-[11px] font-semibold text-zinc-400">
            <span>Target Environment / OS:</span>
            {!isAddingEnv && (
              <button
                type="button"
                onClick={() => setIsAddingEnv(true)}
                className="text-primary hover:underline flex items-center gap-1 text-[11px]"
              >
                <Plus size={12} /> Add Custom Environment
              </button>
            )}
          </div>

          <div className="flex flex-wrap gap-1.5 p-1 bg-black/40 border border-white/5 rounded-xl">
            {envKeys.map((key) => {
              const group = config[key];
              const isSelected = selectedEnv === key;
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => {
                    setSelectedEnv(key);
                    setIsAdding(false);
                    setEditingId(null);
                  }}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all flex items-center gap-1.5 ${
                    isSelected
                      ? "bg-primary/20 border border-primary/40 text-primary shadow-sm"
                      : "text-zinc-400 hover:text-zinc-200 hover:bg-white/[0.04] border border-transparent"
                  }`}
                >
                  <span className="text-sm">{group?.icon || "⚡"}</span>
                  <span>{group?.name || key}</span>
                  <span
                    className={`ml-1 text-[10px] px-1.5 py-0.2 rounded-full font-mono ${
                      isSelected
                        ? "bg-primary/30 text-primary font-bold"
                        : "bg-white/5 text-zinc-500"
                    }`}
                  >
                    {group?.commands?.length || 0}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Custom Environment Creation Form */}
        {isAddingEnv && (
          <div className="p-3.5 bg-black/60 border border-primary/30 rounded-xl space-y-3 animate-in fade-in">
            <div className="text-xs font-semibold text-zinc-200 flex items-center justify-between">
              <span>Create New Custom Environment</span>
              <button
                onClick={() => setIsAddingEnv(false)}
                className="text-zinc-500 hover:text-zinc-300"
              >
                <X size={14} />
              </button>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              <input
                type="text"
                placeholder="ID (e.g. k8s, bsd, router)"
                value={newEnvId}
                onChange={(e) => setNewEnvId(e.target.value)}
                className="bg-black/50 border border-white/10 rounded-lg px-2.5 py-1.5 text-xs text-white outline-none focus:border-primary/50"
              />
              <input
                type="text"
                placeholder="Display Name (e.g. Kubernetes)"
                value={newEnvName}
                onChange={(e) => setNewEnvName(e.target.value)}
                className="bg-black/50 border border-white/10 rounded-lg px-2.5 py-1.5 text-xs text-white outline-none focus:border-primary/50"
              />
              <div className="flex gap-2">
                <input
                  type="text"
                  placeholder="Icon (e.g. ☸️, 🐬, 📦)"
                  value={newEnvIcon}
                  onChange={(e) => setNewEnvIcon(e.target.value)}
                  className="w-20 bg-black/50 border border-white/10 rounded-lg px-2.5 py-1.5 text-xs text-white outline-none focus:border-primary/50 text-center"
                />
                <button
                  type="button"
                  onClick={handleSaveCustomEnv}
                  disabled={!newEnvId.trim() || !newEnvName.trim()}
                  className="flex-1 bg-primary text-zinc-950 font-bold rounded-lg text-xs hover:bg-primary/90 disabled:opacity-40"
                >
                  Create
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Selected Environment Header */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pt-2 border-t border-white/5">
          <div className="space-y-0.5">
            <div className="flex items-center gap-2">
              <span className="text-base">{currentGroup?.icon}</span>
              <span className="text-sm font-bold text-white">{currentGroup?.name}</span>
              <span className="text-[11px] text-zinc-500 font-mono">({commands.length} commands)</span>
            </div>
            <p className="text-[11px] text-zinc-400">{currentGroup?.description}</p>
          </div>

          <div className="flex items-center gap-2">
            {!isDefaultEnv && (
              <button
                type="button"
                onClick={() => {
                  if (window.confirm(`Delete custom environment "${currentGroup?.name}"?`)) {
                    removeCustomEnv(selectedEnv);
                    setSelectedEnv("linux");
                  }
                }}
                className="h-7 px-2 text-[11px] font-medium text-rose-400 hover:bg-rose-500/10 border border-rose-500/20 rounded-lg transition-colors flex items-center gap-1"
              >
                <Trash2 size={12} /> Delete Env
              </button>
            )}
            {isDefaultEnv && (
              <button
                type="button"
                onClick={() => resetEnv(selectedEnv)}
                className="h-7 px-2 text-[11px] font-medium text-zinc-400 hover:text-zinc-200 bg-white/[0.04] hover:bg-white/[0.08] border border-white/5 rounded-lg transition-colors flex items-center gap-1"
                title="Reset this environment to defaults"
              >
                <RotateCcw size={12} /> Reset to Default
              </button>
            )}
            <button
              type="button"
              onClick={handleStartAdd}
              className="h-7 px-2.5 text-[11px] font-bold text-zinc-950 bg-primary hover:bg-primary/90 rounded-lg transition-colors flex items-center gap-1"
            >
              <Plus size={12} /> Add Command
            </button>
          </div>
        </div>

        {/* Add Command Form Card */}
        {isAdding && (
          <div className="p-4 bg-black/60 border border-primary/30 rounded-xl space-y-3 animate-in fade-in duration-150">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-primary flex items-center gap-1.5">
                <Plus size={13} /> Add Quick Command for {currentGroup?.name}
              </span>
              <button
                type="button"
                onClick={() => setIsAdding(false)}
                className="text-zinc-500 hover:text-zinc-300"
              >
                <X size={14} />
              </button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="text-[10px] font-bold uppercase text-zinc-400 tracking-wider block mb-1">
                  Button Label
                </label>
                <input
                  type="text"
                  placeholder="e.g. docker stats, k9s, git pull"
                  value={newLabel}
                  onChange={(e) => setNewLabel(e.target.value)}
                  className="w-full bg-black/60 border border-white/10 rounded-lg px-3 py-1.5 text-xs text-white outline-none focus:border-primary/50"
                  autoFocus
                />
              </div>

              <div>
                <label className="text-[10px] font-bold uppercase text-zinc-400 tracking-wider block mb-1">
                  Shell Command
                </label>
                <input
                  type="text"
                  placeholder="e.g. docker stats --no-stream, git pull origin main"
                  value={newCmd}
                  onChange={(e) => setNewCmd(e.target.value)}
                  className="w-full bg-black/60 border border-white/10 rounded-lg px-3 py-1.5 text-xs font-mono text-emerald-400 outline-none focus:border-primary/50"
                />
              </div>
            </div>

            <div className="flex items-center justify-between pt-1">
              <label className="flex items-center gap-2 cursor-pointer select-none text-xs text-zinc-300">
                <input
                  type="checkbox"
                  checked={newAutoEnter}
                  onChange={(e) => setNewAutoEnter(e.target.checked)}
                  className="accent-primary rounded"
                />
                <span className="flex items-center gap-1">
                  <CornerDownLeft size={12} className="text-primary" /> Auto-execute immediately (append Enter)
                </span>
              </label>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setIsAdding(false)}
                  className="px-3 py-1 text-xs text-zinc-400 hover:text-zinc-200"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={!newLabel.trim() || !newCmd.trim()}
                  onClick={handleSaveAdd}
                  className="px-3.5 py-1 text-xs font-bold bg-primary text-zinc-950 rounded-lg hover:bg-primary/90 disabled:opacity-40"
                >
                  Add Command
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Command Items List */}
        <div className="space-y-2">
          {commands.length === 0 ? (
            <div className="p-6 text-center border border-dashed border-white/10 rounded-xl">
              <Terminal size={24} className="mx-auto text-zinc-600 mb-2" />
              <p className="text-xs text-zinc-400">No quick commands configured for this environment yet.</p>
              <button
                type="button"
                onClick={handleStartAdd}
                className="mt-2 text-xs text-primary hover:underline font-medium"
              >
                + Add first command
              </button>
            </div>
          ) : (
            commands.map((item, index) => {
              const isEditing = editingId === item.id;
              const hasEnter = item.cmd.endsWith("\r");
              const displayCmd = item.cmd.replace(/\r+$/, "");

              if (isEditing) {
                return (
                  <div
                    key={item.id}
                    className="p-3 bg-black/60 border border-primary/40 rounded-xl space-y-3"
                  >
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      <div>
                        <span className="text-[10px] text-zinc-500 font-bold uppercase tracking-wider block mb-1">
                          Button Label
                        </span>
                        <input
                          type="text"
                          value={editLabel}
                          onChange={(e) => setEditLabel(e.target.value)}
                          className="w-full bg-black/70 border border-white/10 rounded-lg px-2.5 py-1 text-xs text-white outline-none focus:border-primary/50"
                        />
                      </div>
                      <div>
                        <span className="text-[10px] text-zinc-500 font-bold uppercase tracking-wider block mb-1">
                          Shell Command
                        </span>
                        <input
                          type="text"
                          value={editCmd}
                          onChange={(e) => setEditCmd(e.target.value)}
                          className="w-full bg-black/70 border border-white/10 rounded-lg px-2.5 py-1 text-xs font-mono text-emerald-400 outline-none focus:border-primary/50"
                        />
                      </div>
                    </div>

                    <div className="flex items-center justify-between pt-1">
                      <label className="flex items-center gap-1.5 text-xs text-zinc-300 cursor-pointer select-none">
                        <input
                          type="checkbox"
                          checked={editAutoEnter}
                          onChange={(e) => setEditAutoEnter(e.target.checked)}
                          className="accent-primary rounded"
                        />
                        <span className="flex items-center gap-1 text-[11px]">
                          <CornerDownLeft size={11} className="text-primary" /> Auto-execute (append Enter)
                        </span>
                      </label>

                      <div className="flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => setEditingId(null)}
                          className="h-6 px-2 text-[11px] text-zinc-400 hover:text-zinc-200"
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          onClick={() => handleSaveEdit(item.id)}
                          className="h-6 px-2.5 text-[11px] font-bold bg-primary text-zinc-950 rounded flex items-center gap-1 hover:bg-primary/90"
                        >
                          <Check size={12} /> Save
                        </button>
                      </div>
                    </div>
                  </div>
                );
              }

              return (
                <div
                  key={item.id}
                  className="group p-2.5 bg-black/30 hover:bg-white/[0.03] border border-white/5 hover:border-white/10 rounded-xl flex items-center justify-between gap-3 transition-colors"
                >
                  <div className="flex items-center gap-3 min-w-0 flex-1">
                    {/* Reorder Buttons */}
                    <div className="flex flex-col gap-0.5 shrink-0 opacity-40 group-hover:opacity-100 transition-opacity">
                      <button
                        type="button"
                        disabled={index === 0}
                        onClick={() => reorderCommands(selectedEnv, index, index - 1)}
                        className="p-0.5 hover:bg-white/10 rounded text-zinc-400 hover:text-white disabled:opacity-20"
                        title="Move Up"
                      >
                        <ArrowUp size={11} />
                      </button>
                      <button
                        type="button"
                        disabled={index === commands.length - 1}
                        onClick={() => reorderCommands(selectedEnv, index, index + 1)}
                        className="p-0.5 hover:bg-white/10 rounded text-zinc-400 hover:text-white disabled:opacity-20"
                        title="Move Down"
                      >
                        <ArrowDown size={11} />
                      </button>
                    </div>

                    {/* Ribbon Button Preview */}
                    <div className="h-6 px-2 rounded bg-white/[0.04] border border-white/10 text-primary font-medium text-xs flex items-center gap-1 shrink-0 select-none">
                      <span>{item.label}</span>
                    </div>

                    {/* Command string */}
                    <div className="min-w-0 flex-1 flex items-center gap-2">
                      <code className="text-[11px] font-mono text-zinc-300 truncate bg-black/40 px-2 py-0.5 rounded border border-white/5">
                        {displayCmd}
                      </code>
                      {hasEnter ? (
                        <span
                          className="shrink-0 text-[9px] font-mono px-1 py-0.2 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 flex items-center gap-0.5"
                          title="Auto-executes on click (includes Enter)"
                        >
                          <CornerDownLeft size={8} /> Enter
                        </span>
                      ) : (
                        <span
                          className="shrink-0 text-[9px] font-mono px-1 py-0.2 rounded bg-amber-500/10 text-amber-400 border border-amber-500/20"
                          title="Inserts text without pressing Enter"
                        >
                          Paste only
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Actions */}
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      type="button"
                      onClick={() => handleStartEdit(item)}
                      className="p-1.5 hover:bg-white/10 rounded-lg text-zinc-400 hover:text-zinc-200 transition-colors"
                      title="Edit Command"
                    >
                      <Edit2 size={13} />
                    </button>
                    <button
                      type="button"
                      onClick={() => removeCommand(selectedEnv, item.id)}
                      className="p-1.5 hover:bg-rose-500/10 rounded-lg text-zinc-500 hover:text-rose-400 transition-colors"
                      title="Remove Command"
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </section>
  );
}
