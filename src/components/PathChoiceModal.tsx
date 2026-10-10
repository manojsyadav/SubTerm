import React, { useEffect } from "react";
import { FileText, X } from "lucide-react";

interface PathChoiceModalProps {
  /** Absolute candidate paths, already ordered best-first. */
  paths: string[];
  /** The name the user clicked, shown in the title. */
  name: string;
  onChoose: (path: string) => void;
  onClose: () => void;
}

const splitPath = (p: string) => {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return { dir: i >= 0 ? p.slice(0, i + 1) : "", base: i >= 0 ? p.slice(i + 1) : p };
};

/** Shown when a clicked file name exists in several places and we can't tell which one was meant. */
export const PathChoiceModal: React.FC<PathChoiceModalProps> = ({ paths, name, onChoose, onClose }) => {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); onClose(); }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
      onMouseDown={onClose}
    >
      <div
        className="w-full max-w-2xl max-h-[70vh] bg-[#0d0d11] border border-white/10 rounded-xl shadow-2xl flex flex-col overflow-hidden"
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={`Choose which ${name} to open`}
      >
        <div className="h-11 px-4 border-b border-white/10 bg-[#121217] flex items-center justify-between shrink-0">
          <span className="text-xs font-mono text-zinc-200 truncate">
            {paths.length} files named <span className="text-indigo-300 font-bold">{name}</span> — which one?
          </span>
          <button onClick={onClose} className="p-1 rounded-lg text-zinc-400 hover:text-white hover:bg-white/10" title="Close (Esc)">
            <X size={15} />
          </button>
        </div>
        <div className="overflow-auto p-1.5">
          {paths.map((p, i) => {
            const { dir, base } = splitPath(p);
            return (
              <button
                key={p}
                autoFocus={i === 0}
                onClick={() => onChoose(p)}
                className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-left font-mono text-xs hover:bg-white/[0.06] focus:bg-white/[0.08] focus:outline-none"
              >
                <FileText size={13} className="text-cyan-400 shrink-0" />
                <span className="truncate">
                  <span className="text-zinc-500">{dir}</span>
                  <span className="text-zinc-100">{base}</span>
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
};
