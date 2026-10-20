import { SYSTEM, type Agent, type AgentRun, type LlmStats } from '../agents.js';
import { TokenBudget } from './budget.js';
import { CLARIFICATION_TOOL, HITL_SYSTEM_ADDENDUM, MAX_CLARIFICATIONS } from '../hitl.js';
import { estimateTokens, ProviderError, type ChatMessage, type CompletionRequest, type LLMProvider, type ToolSpec } from './provider.js';

export interface LlmAgentOptions {
  /** Max LLM calls per scenario. */
  maxTurns?: number;
  maxOutputTokens?: number;
  /** Max tokens (prompt + completion, cache hits included) one scenario may consume. */
  scenarioTokenBudget?: number;
  /** Shared across scenarios; counts only tokens of calls that reach the API. */
  runBudget?: TokenBudget;
  /** Tool results longer than this are truncated before being sent back to the model. */
  maxToolResultChars?: number;
  temperature?: number;
  /**
   * hitl configuration: offers request_clarification and answers it with this function (the
   * simulated human). Absent in the default configuration, which then sends exactly the same
   * requests as before.
   */
  clarify?: (scenarioId: string, question: string) => string;
  /**
   * Hard cap on the input tokens of a single call (large configuration). Checked before each
   * call with a conservative estimate (characters / 3); a call that could exceed it is not
   * sent and the scenario stops with 'input_cap'.
   */
  maxInputTokens?: number;
  /**
   * When the provider rejects a tool call it generated (tool_use_failed), also send its error
   * message back, not only the raw output. Off by default so earlier runs replay unchanged;
   * the runner turns it on for runs from phase 6 on.
   */
  reportProviderError?: boolean;
}

export const LLM_DEFAULTS = { maxTurns: 12, maxOutputTokens: 1024, scenarioTokenBudget: 60_000, maxToolResultChars: 12_000, temperature: 0 } as const;

export type LlmStopReason = 'model_done' | 'max_turns' | 'token_budget' | 'run_budget' | 'output_truncated' | 'refused' | 'input_cap';

/** Characters per token used for the input cap: lower than the budget's 4, so it errs on the safe side. */
export const CAP_CHARS_PER_TOKEN = 3;

/**
 * Tool-use loop. The model only proposes tool calls; every call goes through ToolHost.call,
 * which validates arguments, enforces policy and runs the transaction. Kernel results,
 * including structured rejections, are returned verbatim so the model can repair and retry.
 *
 * The loop stops when the model ends its turn without a tool call (it declares the task done),
 * or on a turn or token limit. It never looks at the scenario checks: success is judged by the
 * harness afterwards, exactly as for the scripted baseline.
 */
export function llmAgent(provider: LLMProvider, options: LlmAgentOptions = {}): Agent {
  const o = { ...LLM_DEFAULTS, ...options };
  return {
    name: `${provider.provider}:${provider.model}`,
    async run(s, host) {
      const tools: ToolSpec[] = host.toolDefinitions().map((t) => ({ name: t.name, description: t.description, parameters: t.input_schema }));
      if (o.clarify) tools.push(CLARIFICATION_TOOL);
      const system = o.clarify ? `${SYSTEM}\n${HITL_SYSTEM_ADDENDUM}` : SYSTEM;
      const messages: ChatMessage[] = [{ role: 'system', content: system }, { role: 'user', content: s.task }];
      const transcript: AgentRun['transcript'] = [];
      let clarifications = 0;
      const budget = new TokenBudget(o.scenarioTokenBudget);
      const stats: LlmStats = { turns: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, billedTokens: 0, cacheHits: 0, llmLatencyMs: 0, malformedToolCalls: 0, estimatedUsageTurns: 0 };
      const done = (stopReason: LlmStopReason, finalText?: string): AgentRun => ({
        toolCalls: transcript.length, transcript, stopReason, llm: stats,
        ...(finalText ? { finalText } : {}), ...(o.clarify ? { clarifications } : {}),
      });

      while (true) {
        if (stats.turns >= o.maxTurns) return done('max_turns');
        const req: CompletionRequest = { messages: structuredClone(messages), tools, maxOutputTokens: o.maxOutputTokens, temperature: o.temperature };
        // Reserve the worst case of this call before making it: estimated prompt + full output.
        const reserve = estimateTokens({ messages: req.messages, tools }) + o.maxOutputTokens;
        const requestChars = JSON.stringify({ messages: req.messages, tools }).length;
        if (o.maxInputTokens && Math.ceil(requestChars / CAP_CHARS_PER_TOKEN) > o.maxInputTokens) return done('input_cap');
        if (!budget.canAfford(reserve)) return done('token_budget');
        const cached = provider.isCached?.(req) ?? false;
        if (o.runBudget && !cached && !o.runBudget.canAfford(reserve)) return done('run_budget');

        stats.turns++;
        stats.requestChars = (stats.requestChars ?? 0) + requestChars;
        let res;
        try {
          res = await provider.complete(req);
        } catch (e) {
          if (!(e instanceof ProviderError && e.kind === 'tool_use_failed')) throw e;
          // The API rejected an unparseable tool call. Usage is unknown, so charge the reservation.
          stats.malformedToolCalls++;
          stats.estimatedUsageTurns++;
          charge(reserve, cached);
          const generation = (e.failedGeneration ?? '').slice(0, 1000);
          transcript.push({ tool: '<malformed>', args: generation, result: { error: { code: 'MALFORMED_TOOL_CALL', message: e.message } } });
          // The provider's reason (for example a schema violation it checked itself) goes back to
          // the model; without it a model can repeat the same rejected call until the turn limit.
          messages.push({ role: 'user', content: o.reportProviderError
            ? `Your previous tool call could not be parsed or did not match the tool's schema, and was not executed. API error: ${e.message.slice(0, 600)}\nRaw output: ${generation}\nCall the tool again with arguments that are valid JSON matching its schema.`
            : `Your previous tool call could not be parsed and was not executed. Raw output: ${generation}\nCall the tool again with arguments that are valid JSON matching its schema.` });
          continue;
        }

        let used = res.usage.totalTokens;
        if (!used) { used = reserve; stats.estimatedUsageTurns++; }
        else {
          stats.promptTokens += res.usage.promptTokens; stats.completionTokens += res.usage.completionTokens;
          stats.maxPromptTokens = Math.max(stats.maxPromptTokens ?? 0, res.usage.promptTokens);
        }
        charge(used, res.cached ?? false);
        stats.llmLatencyMs += res.latencyMs;
        messages.push(res.message);

        const calls = res.message.toolCalls ?? [];
        if (!calls.length) return done(res.finishReason === 'length' ? 'output_truncated' : res.finishReason === 'refusal' ? 'refused' : 'model_done', res.message.content ?? undefined);

        for (const c of calls) {
          let result: unknown;
          let args: unknown;
          try {
            args = c.arguments.trim() ? JSON.parse(c.arguments) : {};
          } catch (e) {
            stats.malformedToolCalls++;
            args = c.arguments;
            result = { error: { code: 'INVALID_JSON', message: `Tool arguments are not valid JSON: ${(e as Error).message}` } };
          }
          // A clarification goes to the simulated human, never to the kernel; it changes nothing.
          if (result === undefined && o.clarify && c.name === CLARIFICATION_TOOL.name) {
            const question = String((args as { question?: unknown })?.question ?? '');
            const answer = ++clarifications <= MAX_CLARIFICATIONS ? o.clarify(s.id, question) : 'No more questions can be answered in this run.';
            result = { answer };
            host.auditTrail.push({ ts: new Date().toISOString(), tool: 'human.clarification', args: { question }, outcome: 'answered' });
          }
          // The kernel is the only authority: the loop never executes anything itself.
          result ??= await host.call(c.name, args);
          transcript.push({ tool: c.name, args, result });
          messages.push({ role: 'tool', toolCallId: c.id, content: clip(JSON.stringify(result), o.maxToolResultChars) });
        }
      }

      function charge(tokens: number, cached: boolean) {
        stats.totalTokens += tokens;
        budget.record(tokens);
        if (cached) stats.cacheHits++;
        else { stats.billedTokens += tokens; o.runBudget?.record(tokens); }
      }
    },
  };
}

function clip(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)} ...[truncated ${s.length - max} chars]`;
}
