import { createHash } from 'node:crypto';

/**
 * Provider-neutral contract between the agent loop and an LLM API. The message shape follows
 * the OpenAI chat format because it is what Groq (and most other APIs) speak natively; another
 * provider would translate to and from it inside its own adapter.
 */

export interface ToolCall { id: string; name: string; /** Raw JSON text as produced by the model. */ arguments: string; }

export type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; toolCalls?: ToolCall[] }
  | { role: 'tool'; toolCallId: string; content: string };

export interface ToolSpec { name: string; description: string; parameters: unknown; }

export interface CompletionRequest {
  messages: ChatMessage[];
  tools: ToolSpec[];
  maxOutputTokens: number;
  temperature: number;
}

export interface Usage { promptTokens: number; completionTokens: number; totalTokens: number; }

export interface CompletionResponse {
  message: Extract<ChatMessage, { role: 'assistant' }>;
  usage: Usage;
  /** 'stop', 'tool_calls', 'length', ... as reported by the API. */
  finishReason: string;
  /** Wall time of the API call. For a cache hit, the latency of the original call. */
  latencyMs: number;
  cached?: boolean;
}

export interface LLMProvider {
  /** Provider id, e.g. 'groq'. Part of the cache key. */
  readonly provider: string;
  readonly model: string;
  complete(req: CompletionRequest): Promise<CompletionResponse>;
  /** True if `complete(req)` would be served without a network call (cache hit). */
  isCached?(req: CompletionRequest): boolean;
}

/**
 * Typed provider failure. `kind` lets the loop tell a retryable infrastructure problem from a
 * model output problem it can feed back to the model (tool_use_failed).
 */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly kind: 'auth' | 'rate_limit' | 'server' | 'bad_request' | 'tool_use_failed' | 'network' | 'config',
    readonly status?: number,
    /** For tool_use_failed: the raw generation the API could not parse into a tool call. */
    readonly failedGeneration?: string,
  ) { super(message); this.name = 'ProviderError'; }
}

/** JSON with sorted object keys, so that equal values always serialize to equal strings. */
export function canonicalJson(v: unknown): string {
  return JSON.stringify(v, (_k, x) =>
    x && typeof x === 'object' && !Array.isArray(x)
      ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]]))
      : x);
}

export function sha256(s: string): string { return createHash('sha256').update(s).digest('hex'); }

/**
 * Offline token estimate: characters / 4. A rule of thumb for BPE tokenizers on English text,
 * used only to enforce budgets before a call and for the cost estimate. Real counts always
 * come from the `usage` field of the API response.
 */
export const CHARS_PER_TOKEN = 4;
export function estimateTokens(v: unknown): number {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return Math.ceil(s.length / CHARS_PER_TOKEN);
}
