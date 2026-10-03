import { useEffect, useRef } from "react";
import {
  Copy,
  Clipboard,
  CheckSquare,
  Search,
  Trash2,
  RotateCw,
  Download,
} from "lucide-react";

export interface ContextMenuState {
  x: number;
  y: number;
  hasSelection: boolean;
}

interface TerminalContextMenuProps {
  menu: ContextMenuState | null;
  onClose: () => void;
  onCopy: () => void;
  onPaste: () => void;
  onSelectAll: () => void;
  onFind: () => void;
  onClear: () => void;
  onReset: () => void;
  onExport: () => void;
}

export function TerminalContextMenu({
  menu,
  onClose,
  onCopy,
  onPaste,
  onSelectAll,
  onFind,
  onClear,
  onReset,
  onExport,
}: TerminalContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menu) return;
    const handleDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };

    window.addEventListener("mousedown", handleDown);
    window.addEventListener("keydown", handleKey);
    return () => {
      window.removeEventListener("mousedown", handleDown);
      window.removeEventListener("keydown", handleKey);
    };
  }, [menu, onClose]);

  if (!menu) return null;

  // Ensure menu stays within window bounds
  const x = Math.min(menu.x, window.innerWidth - 225);
  const y = Math.min(menu.y, window.innerHeight - 280);

  return (
    <>
      <div
        className="fixed inset-0 z-[75]"
        onContextMenu={(e) => {
          e.preventDefault();
          onClose();
        }}
      />
      <div
        ref={menuRef}
        style={{ left: Math.max(8, x), top: Math.max(8, y) }}
        className="fixed z-[80] min-w-[210px] bg-[#121217]/95 border border-white/10 rounded-xl shadow-2xl backdrop-blur-md p-1 text-xs select-none animate-in fade-in zoom-in-95 duration-100 font-sans"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Copy */}
        <button
          type="button"
          disabled={!menu.hasSelection}
          onClick={() => {
            onCopy();
            onClose();
          }}
          className={`w-full flex items-center justify-between px-2.5 py-1.5 rounded-lg text-left transition-colors ${
            menu.hasSelection
              ? "text-zinc-200 hover:text-white hover:bg-white/[0.08]"
              : "text-zinc-600 cursor-not-allowed"
          }`}
        >
          <div className="flex items-center gap-2">
            <Copy size={13} className={menu.hasSelection ? "text-primary" : "text-zinc-600"} />
            <span>Copy</span>
          </div>
          <kbd className="text-[10px] text-zinc-500 font-mono">Ctrl+C</kbd>
        </button>

        {/* Paste */}
        <button
          type="button"
          onClick={() => {
            onPaste();
            onClose();
          }}
          className="w-full flex items-center justify-between px-2.5 py-1.5 rounded-lg text-left text-zinc-200 hover:text-white hover:bg-white/[0.08] transition-colors"
        >
          <div className="flex items-center gap-2">
            <Clipboard size={13} className="text-primary" />
            <span>Paste</span>
          </div>
          <kbd className="text-[10px] text-zinc-500 font-mono">Ctrl+V</kbd>
        </button>

        {/* Select All */}
        <button
          type="button"
          onClick={() => {
            onSelectAll();
            onClose();
          }}
          className="w-full flex items-center justify-between px-2.5 py-1.5 rounded-lg text-left text-zinc-200 hover:text-white hover:bg-white/[0.08] transition-colors"
        >
          <div className="flex items-center gap-2">
            <CheckSquare size={13} className="text-zinc-400" />
            <span>Select All</span>
          </div>
          <kbd className="text-[10px] text-zinc-500 font-mono">Ctrl+A</kbd>
        </button>

        <div className="my-1 border-t border-white/5" />

        {/* Find */}
        <button
          type="button"
          onClick={() => {
            onFind();
            onClose();
          }}
          className="w-full flex items-center justify-between px-2.5 py-1.5 rounded-lg text-left text-zinc-200 hover:text-white hover:bg-white/[0.08] transition-colors"
        >
          <div className="flex items-center gap-2">
            <Search size={13} className="text-indigo-400" />
            <span>Find in Terminal</span>
          </div>
          <kbd className="text-[10px] text-zinc-500 font-mono">Ctrl+F</kbd>
        </button>

        {/* Clear Scrollback */}
        <button
          type="button"
          onClick={() => {
            onClear();
            onClose();
          }}
          className="w-full flex items-center justify-between px-2.5 py-1.5 rounded-lg text-left text-zinc-200 hover:text-white hover:bg-white/[0.08] transition-colors"
        >
          <div className="flex items-center gap-2">
            <Trash2 size={13} className="text-amber-400" />
            <span>Clear Scrollback</span>
          </div>
        </button>

        {/* Reset Terminal */}
        <button
          type="button"
          onClick={() => {
            onReset();
            onClose();
          }}
          className="w-full flex items-center justify-between px-2.5 py-1.5 rounded-lg text-left text-zinc-200 hover:text-white hover:bg-white/[0.08] transition-colors"
        >
          <div className="flex items-center gap-2">
            <RotateCw size={13} className="text-zinc-400" />
            <span>Reset Terminal</span>
          </div>
        </button>

        <div className="my-1 border-t border-white/5" />

        {/* Export Buffer */}
        <button
          type="button"
          onClick={() => {
            onExport();
            onClose();
          }}
          className="w-full flex items-center justify-between px-2.5 py-1.5 rounded-lg text-left text-zinc-200 hover:text-white hover:bg-white/[0.08] transition-colors"
        >
          <div className="flex items-center gap-2">
            <Download size={13} className="text-emerald-400" />
            <span>Export Buffer to .log</span>
          </div>
        </button>
      </div>
    </>
  );
}
