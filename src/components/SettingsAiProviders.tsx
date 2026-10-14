import { useEffect, useState } from "react";
import { Plus, Trash2, RefreshCw } from "lucide-react";
import {
  AI_PROVIDERS_CHANGED,
  PRESETS,
  deleteProvider,
  listModels,
  listProviders,
  saveProvider,
  type AiProvider,
  type ProviderKind,
} from "../ai/providers";
import { useConfirm } from "../ui/confirm";

interface Draft {
  id?: number;
  name: string;
  kind: ProviderKind;
  baseUrl: string;
  model: string;
  apiKey: string;
  hasKey: boolean;
}

const fromPreset = (i: number): Draft => {
  const p = PRESETS[i];
  return { name: p.name, kind: p.kind, baseUrl: p.baseUrl, model: "", apiKey: "", hasKey: false };
};

const input = "bg-black/60 border border-white/10 text-white rounded-lg px-2.5 py-1 text-xs outline-none focus:border-primary/50 w-full";

export function SettingsAiProviders() {
  const confirm = useConfirm();
  const [providers, setProviders] = useState<AiProvider[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [status, setStatus] = useState("");

  const refresh = () => listProviders().then(setProviders).catch((e) => setStatus(String(e)));
  useEffect(() => { refresh(); }, []);

  const set = (patch: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...patch } : d));

  // Persists first so the model list is fetched with the stored key, which the front end never holds.
  const persist = async (d: Draft) => {
    const id = await saveProvider({
      id: d.id,
      name: d.name.trim() || "Provider",
      kind: d.kind,
      baseUrl: d.baseUrl,
      model: d.model,
      apiKey: d.apiKey ? d.apiKey : undefined,
    });
    setDraft({ ...d, id, apiKey: "", hasKey: d.hasKey || !!d.apiKey });
    await refresh();
    window.dispatchEvent(new Event(AI_PROVIDERS_CHANGED));
    return id;
  };

  const loadModels = async () => {
    if (!draft) return;
    setStatus("Loading models…");
    try {
      const list = await listModels(await persist(draft));
      setModels(list);
      setStatus(list.length ? "" : "The provider returned no models.");
    } catch (e) {
      setStatus(String(e));
    }
  };

  const save = async () => {
    if (!draft) return;
    try {
      await persist(draft);
      setDraft(null);
      setStatus("");
    } catch (e) {
      setStatus(String(e));
    }
  };

  const remove = async (p: AiProvider) => {
    if (!(await confirm({ title: "Remove provider", message: `Remove "${p.name}" and its saved API key?`, okLabel: "Remove", destructive: true }))) return;
    await deleteProvider(p.id).catch((e) => setStatus(String(e)));
    if (draft?.id === p.id) setDraft(null);
    await refresh();
    window.dispatchEvent(new Event(AI_PROVIDERS_CHANGED));
  };

  return (
    <div className="py-2 space-y-2">
      <div className="text-xs text-zinc-500">
        Models the assistant can use. API keys are stored in the encrypted vault and are not synced. Ollama and LM
        Studio run on your machine and need no key.
      </div>
      {providers.map((p) => (
        <div key={p.id} className="flex items-center gap-2 p-2 bg-black/40 border border-white/5 rounded-lg">
          <button
            type="button"
            className="min-w-0 flex-1 text-left"
            onClick={() => { setModels([]); setDraft({ ...p, apiKey: "" }); }}
          >
            <span className="block text-xs text-zinc-200">{p.name}</span>
            <span className="block text-[11px] text-zinc-500 truncate">
              {p.model || "no model picked"} · {p.baseUrl}{p.hasKey ? " · key saved" : ""}
            </span>
          </button>
          <button type="button" onClick={() => remove(p)} title="Remove" aria-label={`Remove ${p.name}`} className="p-1 text-zinc-500 hover:text-rose-400">
            <Trash2 size={13} />
          </button>
        </div>
      ))}

      {draft ? (
        <div className="p-2.5 bg-black/40 border border-white/10 rounded-lg space-y-2">
          <label className="block text-[11px] text-zinc-400">Name
            <input className={input} value={draft.name} onChange={(e) => set({ name: e.target.value })} />
          </label>
          <label className="block text-[11px] text-zinc-400">API format
            <select className={input} value={draft.kind} onChange={(e) => set({ kind: e.target.value as ProviderKind })}>
              <option value="openai">OpenAI-compatible (Ollama, OpenAI, Gemini, OpenRouter…)</option>
              <option value="anthropic">Anthropic</option>
            </select>
          </label>
          <label className="block text-[11px] text-zinc-400">Base URL
            <input className={input} value={draft.baseUrl} onChange={(e) => set({ baseUrl: e.target.value })} />
          </label>
          <label className="block text-[11px] text-zinc-400">API key
            <input
              className={input}
              type="password"
              autoComplete="off"
              value={draft.apiKey}
              placeholder={draft.hasKey ? "Saved — type to replace" : "Not needed for local models"}
              onChange={(e) => set({ apiKey: e.target.value })}
            />
          </label>
          <label className="block text-[11px] text-zinc-400">Model
            <div className="flex gap-1.5">
              <input className={input} list="ai-model-list" value={draft.model} onChange={(e) => set({ model: e.target.value })} placeholder="e.g. qwen2.5:7b, claude-sonnet-5-5, gpt-5" />
              <button type="button" onClick={loadModels} title="Load models from the provider" className="px-2 rounded-lg border border-white/10 text-zinc-300 hover:text-white">
                <RefreshCw size={12} />
              </button>
            </div>
            <datalist id="ai-model-list">{models.map((m) => <option key={m} value={m} />)}</datalist>
          </label>
          <div className="flex gap-2">
            <button type="button" onClick={save} className="px-3 py-1 rounded-lg bg-primary/10 border border-primary/30 text-primary text-xs font-bold hover:bg-primary hover:text-zinc-950">
              Save
            </button>
            <button type="button" onClick={() => { setDraft(null); setStatus(""); }} className="px-3 py-1 rounded-lg border border-white/10 text-zinc-400 text-xs hover:text-white">
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <select
            aria-label="Add provider"
            className="bg-black/60 border border-white/10 text-white rounded-lg px-2.5 py-1 text-xs outline-none"
            value=""
            onChange={(e) => { if (e.target.value !== "") { setModels([]); setDraft(fromPreset(Number(e.target.value))); } }}
          >
            <option value="">Add provider…</option>
            {PRESETS.map((p, i) => <option key={p.name} value={i}>{p.name}</option>)}
          </select>
          <Plus size={13} className="text-zinc-500" />
        </div>
      )}
      {status && <div className="text-[11px] text-amber-400/90 break-words">{status}</div>}
    </div>
  );
}
