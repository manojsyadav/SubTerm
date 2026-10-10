import React, { useState } from "react";
import { X, Plus, RotateCcw } from "lucide-react";
import {
  loadFileLinkExtensions, loadFileLinkNames, saveFileLinkExtensions, saveFileLinkNames,
  resetFileLinkTypes, normalizeExtension, normalizeFileName,
  DEFAULT_FILE_LINK_EXTENSIONS, DEFAULT_FILE_LINK_NAMES,
} from "../terminal/fileLinkTypes";
import { useFeatureFlag } from "../featureFlags";

interface ChipListProps {
  label: string;
  hint: string;
  placeholder: string;
  items: string[];
  display?: (item: string) => string;
  normalize: (raw: string) => string | null;
  onChange: (next: string[]) => void;
}

const ChipList: React.FC<ChipListProps> = ({ label, hint, placeholder, items, display = (s) => s, normalize, onChange }) => {
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");

  const add = () => {
    // Allow several at once: "tpl, j2  conf"
    const parts = draft.split(/[\s,]+/).filter(Boolean);
    if (parts.length === 0) return;
    const bad = parts.filter((p) => !normalize(p));
    if (bad.length) {
      setError(`Not a valid entry: ${bad.join(", ")}`);
      return;
    }
    const next = [...items];
    for (const p of parts) {
      const v = normalize(p)!;
      if (!next.some((x) => x.toLowerCase() === v.toLowerCase())) next.push(v);
    }
    onChange(next);
    setDraft("");
    setError("");
  };

  return (
    <div className="py-2">
      <div className="text-xs font-semibold text-zinc-200">{label}</div>
      <p className="text-[11px] text-zinc-500 mt-0.5 mb-2 leading-relaxed">{hint}</p>
      <div className="flex flex-wrap gap-1.5 mb-2">
        {items.length === 0 && <span className="text-[11px] text-zinc-600 italic">None — nothing of this kind will be clickable.</span>}
        {items.map((item) => (
          <span key={item} className="inline-flex items-center gap-1 pl-2 pr-1 py-0.5 rounded-md bg-black/50 border border-white/10 text-[11px] font-mono text-zinc-200">
            {display(item)}
            <button
              type="button"
              onClick={() => onChange(items.filter((x) => x !== item))}
              className="p-0.5 rounded text-zinc-500 hover:text-rose-300 hover:bg-white/10"
              title={`Remove ${display(item)}`}
              aria-label={`Remove ${display(item)}`}
            >
              <X size={10} />
            </button>
          </span>
        ))}
      </div>
      <div className="flex items-center gap-2">
        <input
          value={draft}
          onChange={(e) => { setDraft(e.target.value); setError(""); }}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }}
          placeholder={placeholder}
          spellCheck={false}
          className="flex-1 min-w-0 bg-black/60 border border-white/10 text-white rounded-lg px-2.5 py-1 text-xs font-mono outline-none focus:border-primary/50"
        />
        <button
          type="button"
          onClick={add}
          disabled={!draft.trim()}
          className="h-7 px-2.5 rounded-lg bg-white/[0.06] border border-white/10 text-xs text-zinc-200 hover:bg-white/10 disabled:opacity-40 flex items-center gap-1"
        >
          <Plus size={12} /> Add
        </button>
      </div>
      {error && <p className="text-[11px] text-rose-400 mt-1">{error}</p>}
    </div>
  );
};

/** Editor for which file names in terminal output become clickable. Changes apply immediately. */
export const SettingsFileLinkTypes: React.FC = () => {
  const linksEnabled = useFeatureFlag("terminalFileLinks");
  const [exts, setExts] = useState<string[]>(loadFileLinkExtensions);
  const [names, setNames] = useState<string[]>(loadFileLinkNames);

  const isDefault =
    exts.length === DEFAULT_FILE_LINK_EXTENSIONS.length && exts.every((e, i) => e === DEFAULT_FILE_LINK_EXTENSIONS[i]) &&
    names.length === DEFAULT_FILE_LINK_NAMES.length && names.every((n, i) => n === DEFAULT_FILE_LINK_NAMES[i]);

  return (
    <div>
      {!linksEnabled && (
        <p className="text-[11px] text-amber-400/90 mb-2">
          "Open file in editor on click" is switched off above, so these settings have no effect until you turn it back on.
        </p>
      )}
      <ChipList
        label="File extensions"
        hint="A file name ending in one of these (for example server.crt or app.yml) is underlined in terminal output and opens in the editor when clicked. Add several at once separated by spaces or commas."
        placeholder="e.g. tpl, j2, conf"
        items={exts}
        display={(e) => `.${e}`}
        normalize={normalizeExtension}
        onChange={(next) => { setExts(next); saveFileLinkExtensions(next); }}
      />
      <ChipList
        label="Exact file names"
        hint="Files recognised by their full name even without an extension."
        placeholder="e.g. Dockerfile, Jenkinsfile"
        items={names}
        normalize={normalizeFileName}
        onChange={(next) => { setNames(next); saveFileLinkNames(next); }}
      />
      <div className="pt-1">
        <button
          type="button"
          onClick={() => { resetFileLinkTypes(); setExts(loadFileLinkExtensions()); setNames(loadFileLinkNames()); }}
          disabled={isDefault}
          className="h-7 px-2.5 rounded-lg bg-white/[0.04] border border-white/10 text-xs text-zinc-300 hover:bg-white/10 disabled:opacity-40 flex items-center gap-1.5"
        >
          <RotateCcw size={12} /> Reset to defaults
        </button>
      </div>
    </div>
  );
};
