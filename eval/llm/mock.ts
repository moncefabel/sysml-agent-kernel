import type { Scenario } from '../scenarios.js';
import { estimateTokens, ProviderError, type CompletionRequest, type CompletionResponse, type LLMProvider } from './provider.js';

export type MockTurn =
  | { toolCalls: Array<{ name: string; args: unknown } | { name: string; rawArgs: string }>; content?: string }
  | { content: string; finishReason?: string }
  | { toolUseFailed: string };

/**
 * Offline provider that plays a fixed list of turns and records every request it receives.
 * Usage is the chars/4 estimate of the request and of the reply, so token accounting can be
 * exercised and measured without a network call.
 */
export class MockProvider implements LLMProvider {
  readonly provider = 'mock';
  readonly requests: CompletionRequest[] = [];
  readonly responses: CompletionResponse[] = [];
  private i = 0;

  constructor(private turns: MockTurn[], readonly model = 'mock-model') {}

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    this.requests.push(structuredClone(req));
    const t = this.turns[this.i++] ?? { content: 'Done.' };
    if ('toolUseFailed' in t) throw new ProviderError('mock 400: tool_use_failed', 'tool_use_failed', 400, t.toolUseFailed);
    const toolCalls = 'toolCalls' in t
      ? t.toolCalls.map((c, k) => ({ id: `call_${this.i}_${k}`, name: c.name, arguments: 'rawArgs' in c ? c.rawArgs : JSON.stringify(c.args) }))
      : undefined;
    const message = { role: 'assistant' as const, content: t.content ?? null, ...(toolCalls ? { toolCalls } : {}) };
    const promptTokens = estimateTokens({ messages: req.messages, tools: req.tools });
    const completionTokens = estimateTokens(message);
    const res: CompletionResponse = {
      message,
      usage: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens },
      finishReason: toolCalls ? 'tool_calls' : ('finishReason' in t && t.finishReason) || 'stop',
      latencyMs: 0,
    };
    this.responses.push(res);
    return res;
  }
}

/**
 * A model that follows the scenario's reference trajectory exactly: one tool call per turn,
 * then a one line summary. Used to measure the smallest realistic context an LLM run sends.
 */
export function referenceProvider(s: Scenario): MockProvider {
  return new MockProvider([
    ...s.scripted.map((step) => ({ toolCalls: [{ name: step.tool, args: step.args }] })),
    { content: 'Done: the requested change is committed and the model validates.' },
  ], 'reference-trajectory');
}
