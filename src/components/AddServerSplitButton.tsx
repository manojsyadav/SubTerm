import { useEffect, useRef, useState } from "react";
import { Plus, ChevronDown, Download } from "lucide-react";

interface Props {
  onAdd: (arg?: unknown) => void;
  /** Import from OpenSSH ~/.ssh/config, PuTTY or MobaXterm. Omit to hide the menu. */
  onImport?: (arg?: unknown) => void;
}

// "Add server" with the import action folded into a menu on the same control, so the two
// related actions take one slot at the end of the search row.
export const AddServerSplitButton = ({ onAdd, onImport }: Props) => {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("mousedown", away);
    window.addEventListener("keydown", esc);
    return () => { window.removeEventListener("mousedown", away); window.removeEventListener("keydown", esc); };
  }, [open]);

  return (
    <div ref={ref} className="relative inline-flex">
      <button
        type="button"
        onClick={() => onAdd()}
        className={`inline-flex items-center gap-1.5 h-9 px-3.5 bg-primary/15 border border-primary/30 text-primary text-[11px] font-bold uppercase tracking-wider hover:bg-primary/25 transition-colors ${onImport ? "rounded-l-lg border-r-0" : "rounded-lg"}`}
      >
        <Plus size={13} /> Add server
      </button>
      {onImport && (
        <>
          <button
            type="button"
            aria-haspopup="menu"
            aria-expanded={open}
            aria-label="More ways to add servers"
            onClick={() => setOpen((o) => !o)}
            className="inline-flex items-center justify-center h-9 w-8 rounded-r-lg bg-primary/15 border border-primary/30 border-l-primary/20 text-primary hover:bg-primary/25 transition-colors"
          >
            <ChevronDown size={13} />
          </button>
          {open && (
            <div role="menu" className="absolute right-0 top-full mt-1 z-30 min-w-[230px] rounded-xl bg-[#15151a] border border-white/10 shadow-2xl p-1 text-xs">
              <button
                role="menuitem"
                type="button"
                onClick={() => { setOpen(false); onImport(); }}
                className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-left text-zinc-200 hover:bg-white/[0.07] hover:text-white"
                title="Import hosts from OpenSSH ~/.ssh/config, PuTTY, or MobaXterm"
              >
                <Download size={13} className="text-sky-400" /> Import SSH config
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
};
