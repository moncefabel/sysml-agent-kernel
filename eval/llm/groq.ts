import { RetryingHttp, type HttpOptions } from './http.js';
import { ProviderError, type ChatMessage, type CompletionRequest, type CompletionResponse, type LLMProvider } from './provider.js';

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

export interface GroqOptions extends HttpOptions {
  apiKey: string;
  model: string;
}

/**
 * Groq chat completions (OpenAI compatible) with tool calling. Retries and quota handling
 * live in RetryingHttp; every other failure is surfaced as a typed ProviderError. The key
 * lives in a private field and is redacted from every error message, so it cannot end up in
 * a report, a checkpoint or a log.
 */
export class GroqProvider implements LLMProvider {
  readonly provider = 'groq';
  readonly model: string;
  readonly #key: string;
  readonly #http: RetryingHttp;

  constructor(o: GroqOptions) {
    if (!o.apiKey) throw new ProviderError('Groq API key is empty', 'config');
    if (!o.model) throw new ProviderError('Groq model is empty', 'config');
    this.model = o.model;
    this.#key = o.apiKey;
    this.#http = new RetryingHttp('Groq', o.apiKey, ['x-ratelimit-'], o);
  }

  get retryStats() { return this.#http.retryStats; }
  get rateLimit() { return this.#http.rateLimit; }
  redact(s: string): string { return this.#http.redact(s); }

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    const r = await this.#http.post(GROQ_URL, { 'content-type': 'application/json', authorization: `Bearer ${this.#key}` }, groqRequestBody(this.model, req));
    if (r.ok) return fromWire(r.data, r.latencyMs);
    throw classify(r.status, r.text);
  }

  toJSON() { return { provider: this.provider, model: this.model }; }
}

/** Reads GROQ_API_KEY and GROQ_MODEL. Fails without echoing either value. */
export function groqFromEnv(env: NodeJS.ProcessEnv = process.env, extra: Partial<GroqOptions> = {}): GroqProvider {
  const missing = ['GROQ_API_KEY', 'GROQ_MODEL'].filter((k) => !env[k]);
  if (missing.length) throw new ProviderError(`Missing environment variable(s): ${missing.join(', ')}`, 'config');
  return new GroqProvider({ apiKey: env.GROQ_API_KEY!, model: env.GROQ_MODEL!, ...extra });
}

/** Exact JSON body sent to Groq. Exported so the offline estimate measures the real payload. */
export function groqRequestBody(model: string, req: CompletionRequest): string {
  return JSON.stringify({
    model,
    messages: req.messages.map(toWire),
    tools: req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })),
    tool_choice: 'auto',
    temperature: req.temperature,
    max_tokens: req.maxOutputTokens,
  });
}

function classify(status: number, text: string): ProviderError {
  let err: any;
  try { err = JSON.parse(text).error; } catch { /* not JSON */ }
  const msg = `Groq ${status}: ${err?.message ?? text.slice(0, 500)}`;
  // Groq answers 400 tool_use_failed when the model emitted a tool call it could not parse.
  if (err?.code === 'tool_use_failed') return new ProviderError(msg, 'tool_use_failed', status, String(err.failed_generation ?? ''));
  if (status === 401 || status === 403) return new ProviderError(msg, 'auth', status);
  if (status === 429) return new ProviderError(msg, 'rate_limit', status);
  if (status >= 500) return new ProviderError(msg, 'server', status);
  return new ProviderError(msg, 'bad_request', status);
}

function toWire(m: ChatMessage): unknown {
  switch (m.role) {
    case 'tool': return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
    case 'assistant': return {
      role: 'assistant',
      content: m.content,
      ...(m.toolCalls?.length ? { tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } })) } : {}),
    };
    default: return m;
  }
}

function fromWire(data: any, latencyMs: number): CompletionResponse {
  const choice = data?.choices?.[0];
  if (!choice?.message) throw new ProviderError('Groq response has no choices[0].message', 'server');
  const m = choice.message;
  const toolCalls = (m.tool_calls ?? []).map((c: any) => ({ id: String(c.id), name: String(c.function?.name), arguments: String(c.function?.arguments ?? '') }));
  const u = data.usage ?? {};
  return {
    message: { role: 'assistant', content: m.content ?? null, ...(toolCalls.length ? { toolCalls } : {}) },
    usage: { promptTokens: u.prompt_tokens ?? 0, completionTokens: u.completion_tokens ?? 0, totalTokens: u.total_tokens ?? 0 },
    finishReason: String(choice.finish_reason ?? 'unknown'),
    latencyMs,
  };
}
