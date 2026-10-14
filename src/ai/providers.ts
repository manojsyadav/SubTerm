import { Channel, invoke } from "@tauri-apps/api/core";

export type ProviderKind = "openai" | "anthropic";

/** As returned by `ai_list_providers` — the key itself never comes back. */
export interface AiProvider {
  id: number;
  name: string;
  kind: ProviderKind;
  baseUrl: string;
  model: string;
  hasKey: boolean;
}

export interface ToolCall {
  id: string;
  name: string;
  /** Raw JSON text from the model. */
  arguments: string;
}

export interface ChatMsg {
  role: "user" | "assistant" | "tool";
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
}

export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export const PRESETS: { name: string; kind: ProviderKind; baseUrl: string; needsKey: boolean }[] = [
  { name: "Ollama (local)", kind: "openai", baseUrl: "http://localhost:11434/v1", needsKey: false },
  { name: "LM Studio (local)", kind: "openai", baseUrl: "http://localhost:1234/v1", needsKey: false },
  { name: "Anthropic Claude", kind: "anthropic", baseUrl: "https://api.anthropic.com/v1", needsKey: true },
  { name: "OpenAI", kind: "openai", baseUrl: "https://api.openai.com/v1", needsKey: true },
  { name: "Google Gemini", kind: "openai", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", needsKey: true },
  { name: "OpenRouter", kind: "openai", baseUrl: "https://openrouter.ai/api/v1", needsKey: true },
];

export const AI_PROVIDERS_CHANGED = "subterm-ai-providers-changed";
const LAST_PROVIDER_KEY = "subterm-ai-provider";

export const listProviders = () => invoke<AiProvider[]>("ai_list_providers");
export const listModels = (id: number) => invoke<string[]>("ai_list_models", { id });
export const deleteProvider = (id: number) => invoke<void>("ai_delete_provider", { id });
/** `apiKey`: undefined keeps the stored key, "" clears it. */
export const saveProvider = (p: Omit<AiProvider, "id" | "hasKey"> & { id?: number; apiKey?: string }) =>
  invoke<number>("ai_save_provider", { provider: { ...p, id: p.id ?? null, apiKey: p.apiKey ?? null } });

/** `requestId` lets `cancelChat` stop it; a stopped call rejects with STOPPED. */
export function chat(id: number, system: string, messages: ChatMsg[], tools: ToolDef[], onText: (t: string) => void, requestId?: string) {
  const ch = new Channel<string>();
  ch.onmessage = onText;
  return invoke<ChatMsg>("ai_chat", { id, system, messages, tools, onText: ch, requestId: requestId ?? null });
}

export const STOPPED = "[AI] STOPPED";
export const cancelChat = (requestId: string) => invoke<void>("ai_cancel", { requestId });

export const getLastProvider = () => Number(localStorage.getItem(LAST_PROVIDER_KEY)) || null;
export const setLastProvider = (id: number) => localStorage.setItem(LAST_PROVIDER_KEY, String(id));

/** True when the endpoint is this machine or a private-network address (a homelab Ollama box). */
export function isLocalEndpoint(baseUrl: string): boolean {
  let host: string;
  try {
    host = new URL(baseUrl).hostname.replace(/^\[|\]$/g, "");
  } catch {
    return false;
  }
  return (
    host === "localhost" ||
    host === "::1" ||
    host.endsWith(".local") ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  );
}
