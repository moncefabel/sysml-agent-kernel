import Anthropic from '@anthropic-ai/sdk';
import { ProviderError, type ChatMessage, type CompletionRequest, type CompletionResponse, type LLMProvider } from './provider.js';

export interface AnthropicOptions {
  apiKey: string;
  model: string;
  /** Injected for tests; the SDK otherwise uses the global fetch. */
  fetch?: typeof fetch;
  maxRetries?: number;
}

/**
 * Anthropic Messages API behind the same LLMProvider contract as Groq, through the official
 * SDK. Differences the adapter absorbs: the system prompt is a top-level field, tool results
 * are user content blocks, sampling parameters are not sent (current models reject them),
 * and the assistant's content blocks are kept in `raw` and sent back unchanged so thinking
 * blocks survive across turns. Server-side model fallback is deliberately not enabled: an
 * evaluation must not silently switch the model it reports on.
 */
export class AnthropicProvider implements LLMProvider {
  readonly provider = 'anthropic';
  readonly model: string;
  readonly #client: Anthropic;
  readonly #key: string;
  /** Last anthropic-ratelimit-* headers seen. */
  rateLimit: Record<string, string> = {};

  constructor(o: AnthropicOptions) {
    if (!o.apiKey) throw new ProviderError('Anthropic API key is empty', 'config');
    if (!o.model) throw new ProviderError('Anthropic model is empty', 'config');
    this.model = o.model;
    this.#key = o.apiKey;
    this.#client = new Anthropic({ apiKey: o.apiKey, maxRetries: o.maxRetries ?? 2, logLevel: 'off', ...(o.fetch ? { fetch: o.fetch } : {}) });
  }

  redact(s: string): string { return s.split(this.#key).join('[REDACTED]'); }
  toJSON() { return { provider: this.provider, model: this.model }; }

  private headers(h: Headers | undefined) {
    h?.forEach((v, k) => { if (k.startsWith('anthropic-ratelimit-')) this.rateLimit[k] = v; });
  }

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    const t0 = Date.now();
    try {
      const { data, response } = await this.#client.messages.create(anthropicRequest(this.model, req)).withResponse();
      this.headers(response.headers);
      return fromMessage(data, Date.now() - t0);
    } catch (e) {
      if (e instanceof Anthropic.APIError) this.headers(e.headers as Headers | undefined);
      throw this.classify(e);
    }
  }

  private classify(e: unknown): ProviderError {
    const msg = this.redact(`Anthropic ${(e as any)?.status ?? ''}: ${(e as Error)?.message ?? String(e)}`.slice(0, 800));
    if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) return new ProviderError(msg, 'auth', e.status);
    if (e instanceof Anthropic.RateLimitError) return new ProviderError(msg, 'rate_limit', 429);
    if (e instanceof Anthropic.BadRequestError) return new ProviderError(msg, 'bad_request', 400);
    if (e instanceof Anthropic.APIConnectionError) return new ProviderError(msg, 'network');
    if (e instanceof Anthropic.APIError) return new ProviderError(msg, 'server', e.status);
    return new ProviderError(msg, 'network');
  }
}

/** Reads APP_ANTHROPIC_API_KEY and APP_ANTHROPIC_MODEL (never ANTHROPIC_API_KEY). */
export function anthropicFromEnv(env: NodeJS.ProcessEnv = process.env, extra: Partial<AnthropicOptions> = {}): AnthropicProvider {
  const missing = ['APP_ANTHROPIC_API_KEY'].filter((k) => !env[k]);
  if (missing.length) throw new ProviderError(`Missing environment variable(s): ${missing.join(', ')}`, 'config');
  return new AnthropicProvider({ apiKey: env.APP_ANTHROPIC_API_KEY!, model: env.APP_ANTHROPIC_MODEL || 'claude-opus-5-5', ...extra });
}

/** Translates the provider-neutral request into Messages API parameters. */
export function anthropicRequest(model: string, req: CompletionRequest): Anthropic.MessageCreateParamsNonStreaming {
  const system = req.messages.filter((m) => m.role === 'system').map((m) => m.content as string).join('\n\n');
  const messages: Anthropic.MessageParam[] = [];
  const userBlocks = (): Anthropic.ContentBlockParam[] => {
    const last = messages.at(-1);
    if (last?.role === 'user' && Array.isArray(last.content)) return last.content as Anthropic.ContentBlockParam[];
    const blocks: Anthropic.ContentBlockParam[] = [];
    messages.push({ role: 'user', content: blocks });
    return blocks;
  };
  for (const m of req.messages as ChatMessage[]) {
    if (m.role === 'system') continue;
    if (m.role === 'user') userBlocks().push({ type: 'text', text: m.content });
    else if (m.role === 'tool') userBlocks().push({ type: 'tool_result', tool_use_id: m.toolCallId, content: m.content });
    else if (m.role === 'assistant') messages.push({ role: 'assistant', content: (m.raw as Anthropic.ContentBlockParam[] | undefined) ?? assistantBlocks(m) });
  }
  return {
    model,
    max_tokens: req.maxOutputTokens,
    ...(system ? { system } : {}),
    messages,
    tools: req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters as Anthropic.Tool.InputSchema })),
    tool_choice: { type: 'auto' },
  };
}

function assistantBlocks(m: Extract<ChatMessage, { role: 'assistant' }>): Anthropic.ContentBlockParam[] {
  const blocks: Anthropic.ContentBlockParam[] = m.content ? [{ type: 'text', text: m.content }] : [];
  for (const c of m.toolCalls ?? []) {
    let input: unknown = {};
    try { input = c.arguments.trim() ? JSON.parse(c.arguments) : {}; } catch { /* keep {} */ }
    blocks.push({ type: 'tool_use', id: c.id, name: c.name, input });
  }
  return blocks.length ? blocks : [{ type: 'text', text: '' }];
}

const FINISH: Record<string, string> = { end_turn: 'stop', tool_use: 'tool_calls', max_tokens: 'length', refusal: 'refusal' };

function fromMessage(data: Anthropic.Message, latencyMs: number): CompletionResponse {
  const text = data.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map((b) => b.text).join('');
  const toolCalls = data.content
    .filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
    .map((b) => ({ id: b.id, name: b.name, arguments: JSON.stringify(b.input) }));
  const prompt = data.usage.input_tokens + (data.usage.cache_read_input_tokens ?? 0) + (data.usage.cache_creation_input_tokens ?? 0);
  return {
    message: { role: 'assistant', content: text || null, ...(toolCalls.length ? { toolCalls } : {}), raw: data.content },
    usage: { promptTokens: prompt, completionTokens: data.usage.output_tokens, totalTokens: prompt + data.usage.output_tokens },
    finishReason: FINISH[data.stop_reason ?? ''] ?? String(data.stop_reason),
    latencyMs,
  };
}
