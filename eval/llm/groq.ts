import { ProviderError, type ChatMessage, type CompletionRequest, type CompletionResponse, type LLMProvider } from './provider.js';

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

export interface GroqOptions {
  apiKey: string;
  model: string;
  /** Injected for tests; defaults to the global fetch. */
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
  timeoutMs?: number;
}

/**
 * Groq chat completions (OpenAI compatible) with tool calling. Retries rate limits and server
 * errors with exponential backoff; every other failure is surfaced as a typed ProviderError.
 * The key lives in a private field and is redacted from every error message, so it cannot end
 * up in a report, a checkpoint or a log.
 */
export class GroqProvider implements LLMProvider {
  readonly provider = 'groq';
  readonly model: string;
  readonly #key: string;
  readonly #fetch: typeof fetch;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #maxRetries: number;
  readonly #timeoutMs: number;

  constructor(o: GroqOptions) {
    if (!o.apiKey) throw new ProviderError('Groq API key is empty', 'config');
    if (!o.model) throw new ProviderError('Groq model is empty', 'config');
    this.model = o.model;
    this.#key = o.apiKey;
    this.#fetch = o.fetch ?? fetch;
    this.#sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.#maxRetries = o.maxRetries ?? 4;
    this.#timeoutMs = o.timeoutMs ?? 60_000;
  }

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    const body = groqRequestBody(this.model, req);

    for (let attempt = 0; ; attempt++) {
      const t0 = Date.now();
      let res: Response;
      try {
        res = await this.#fetch(GROQ_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${this.#key}` },
          body,
          signal: AbortSignal.timeout(this.#timeoutMs),
        });
      } catch (e) {
        if (attempt < this.#maxRetries) { await this.#sleep(backoff(attempt)); continue; }
        throw new ProviderError(this.redact(`Groq request failed: ${String(e)}`), 'network');
      }
      const latencyMs = Date.now() - t0;
      if (res.ok) return fromWire(await res.json(), latencyMs);

      const text = this.redact(await res.text());
      const retryable = res.status === 429 || res.status >= 500;
      if (retryable && attempt < this.#maxRetries) {
        const after = Number(res.headers.get('retry-after'));
        await this.#sleep(Number.isFinite(after) && after > 0 ? after * 1000 : backoff(attempt));
        continue;
      }
      throw classify(res.status, text);
    }
  }

  redact(s: string): string { return s.split(this.#key).join('[REDACTED]'); }
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

const backoff = (attempt: number) => 1000 * 2 ** attempt;

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
