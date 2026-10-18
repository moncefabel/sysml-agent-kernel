import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scenarios } from '../eval/scenarios.js';
import { runScenario } from '../eval/harness.js';
import { llmAgent } from '../eval/llm/loop.js';
import { CachedProvider } from '../eval/llm/cache.js';
import { AnthropicProvider, anthropicFromEnv, anthropicRequest } from '../eval/llm/anthropic.js';
import type { CompletionRequest } from '../eval/llm/provider.js';

const KEY = 'fake_anthropic_test_secret_77';
const req: CompletionRequest = { messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'x' }], tools: [], maxOutputTokens: 4096, temperature: 0 };
const msg = (content: unknown[], stop: string) =>
  ({ id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-haiku-5-5', content, stop_reason: stop, stop_sequence: null, usage: { input_tokens: 40, output_tokens: 8 } });
const fakeFetch = (responses: Array<{ status: number; body: unknown; headers?: Record<string, string> }>, seen: any[]) =>
  (async (url: any, init: any) => {
    seen.push({ url: String(url), init });
    const r = responses.shift()!;
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json', ...(r.headers ?? {}) } });
  }) as unknown as typeof fetch;
const errorBody = (type: string) => ({ type: 'error', error: { type, message: `${type} for ${KEY}` } });

test('haiku: no sampling parameter is ever sent, whatever the loop asks for', async () => {
  for (const effort of [undefined, 'low'] as const) {
    const body = anthropicRequest('claude-haiku-5-5', { ...req, temperature: 0.7 }, effort) as any;
    for (const p of ['temperature', 'top_p', 'top_k']) assert.equal(p in body, false, `${p} with effort ${effort}`);
  }
  const seen: any[] = [];
  const p = new AnthropicProvider({ apiKey: KEY, model: 'claude-haiku-5-5', effort: 'low', fetch: fakeFetch([{ status: 200, body: msg([{ type: 'text', text: 'ok' }], 'end_turn') }], seen) });
  await p.complete(req);
  const wire = JSON.parse(seen[0].init.body);
  for (const k of ['temperature', 'top_p', 'top_k']) assert.equal(k in wire, false, `${k} on the wire`);
  assert.equal(wire.model, 'claude-haiku-5-5');
});

test('haiku: effort is sent as output_config.effort only when set, and validated', () => {
  assert.deepEqual((anthropicRequest('m', req, 'low') as any).output_config, { effort: 'low' });
  assert.equal('output_config' in (anthropicRequest('m', req) as any), false);
  assert.throws(() => new AnthropicProvider({ apiKey: KEY, model: 'm', effort: 'turbo' as any }), /Unknown effort/);
  const env = anthropicFromEnv({ APP_ANTHROPIC_API_KEY: KEY, APP_ANTHROPIC_MODEL: 'claude-haiku-5-5', APP_ANTHROPIC_EFFORT: 'low' });
  assert.equal(env.effort, 'low');
  assert.deepEqual(env.settings, { effort: 'low' });
  assert.equal(anthropicFromEnv({ APP_ANTHROPIC_API_KEY: KEY }).settings, undefined);
  assert.throws(() => anthropicFromEnv({ ANTHROPIC_API_KEY: KEY, APP_ANTHROPIC_MODEL: 'claude-haiku-5-5' }), /APP_ANTHROPIC_API_KEY/);
});

test('haiku: effort is part of the cache key; providers without settings keep their keys', () => {
  const none = CachedProvider.key('anthropic', 'claude-haiku-5-5', req);
  const low = CachedProvider.key('anthropic', 'claude-haiku-5-5', req, 1, { effort: 'low' });
  const medium = CachedProvider.key('anthropic', 'claude-haiku-5-5', req, 1, { effort: 'medium' });
  assert.equal(new Set([none, low, medium]).size, 3);
  assert.equal(CachedProvider.key('groq', 'm', req, 1, undefined), CachedProvider.key('groq', 'm', req));
});

test('haiku: 429 and overload are retried by the shared policy, with retry-after', async () => {
  const slept: number[] = [];
  const seen: any[] = [];
  const p = new AnthropicProvider({ apiKey: KEY, model: 'claude-haiku-5-5', sleep: async (ms) => { slept.push(ms); }, fetch: fakeFetch([
    { status: 429, body: errorBody('rate_limit_error'), headers: { 'retry-after': '3', 'anthropic-ratelimit-tokens-remaining': '0' } },
    { status: 529, body: errorBody('overloaded_error') },
    { status: 200, body: msg([{ type: 'text', text: 'ok' }], 'end_turn') },
  ], seen) });
  const r = await p.complete(req);
  assert.equal(r.message.content, 'ok');
  assert.equal(seen.length, 3);
  assert.deepEqual(slept, [3000, 2000]);
  assert.deepEqual(p.retryStats, { retries: 2, waitedMs: 5000, byStatus: { '429': 1, '529': 1 } });
  assert.equal(p.rateLimit['anthropic-ratelimit-tokens-remaining'], '0');
});

test('haiku: a quota window or bad credentials stop the run cleanly, an overload does not', async () => {
  const s = scenarios.find((x) => x.id === 'guarded-delete')!;
  const run = (responses: Array<{ status: number; body: unknown; headers?: Record<string, string> }>, maxRetries = 4) =>
    runScenario(s, llmAgent(new AnthropicProvider({ apiKey: KEY, model: 'claude-haiku-5-5', maxRetries, sleep: async () => {}, fetch: fakeFetch(responses, []) })));
  const quota = await run([{ status: 429, body: errorBody('rate_limit_error'), headers: { 'retry-after': '7200' } }]);
  assert.equal(quota.fatal, true);
  assert.match(quota.crash!, /quota window, retry after 7200 s/);
  assert.ok(!quota.crash!.includes(KEY));
  const auth = await run([{ status: 401, body: errorBody('authentication_error') }]);
  assert.equal(auth.fatal, true);
  assert.ok(!auth.crash!.includes(KEY));
  const overloaded = await run([{ status: 529, body: errorBody('overloaded_error') }], 0);
  assert.equal(overloaded.fatal, undefined);
  assert.ok(overloaded.crash);
});

test('haiku: latency excludes retry waits', async () => {
  const p = new AnthropicProvider({ apiKey: KEY, model: 'claude-haiku-5-5', sleep: () => new Promise((r) => setTimeout(r, 30)), fetch: fakeFetch([
    { status: 429, body: errorBody('rate_limit_error'), headers: { 'retry-after': '1' } },
    { status: 200, body: msg([{ type: 'text', text: 'ok' }], 'end_turn') },
  ], []) });
  const r = await p.complete(req);
  assert.ok(r.latencyMs < 30, `latency ${r.latencyMs} ms`);
});

test('summary: the model comparison lists every model that ran the same suite and policy', async () => {
  const { mkdtempSync, writeFileSync, readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const { execFileSync } = await import('node:child_process');
  const dir = mkdtempSync(join(tmpdir(), 'summary-'));
  const s = scenarios.find((x) => x.id === 'add-brake-subsystem')!;
  const { scriptedAgent } = await import('../eval/agents.js');
  const row = await runScenario(s, scriptedAgent);
  const llm = { turns: 3, promptTokens: 90, completionTokens: 10, totalTokens: 100, billedTokens: 100, cacheHits: 0, llmLatencyMs: 1500, malformedToolCalls: 0, estimatedUsageTurns: 0 };
  for (const [provider, model] of [['groq', 'm-a'], ['anthropic', 'claude-haiku-5-5']])
    writeFileSync(join(dir, `${provider}-${model}.json`), JSON.stringify({ agent: `${provider}:${model}`, provider, model, suite: 'main', pass: 1, replay: false,
      policy: { maxRemovedElementsPerSession: 5 }, date: '2026-10-18T00:00:00Z', total: 1, incomplete: [], rows: [{ ...row, llm, retries: { retries: 2, waitedMs: 3000 } }] }));
  execFileSync(process.execPath, [new URL('../eval/summary.js', import.meta.url).pathname, dir]);
  const md = readFileSync(join(dir, 'SUMMARY.md'), 'utf8');
  const section = md.slice(md.indexOf('## Model comparison'), md.indexOf('## Replay verification'));
  assert.ok(!section.includes('Only one model'));
  assert.match(section, /\| main \(session limit of 5 removed elements\) \| anthropic:claude-haiku-5-5 \| 1 \| 1\/1 \| 3\.0 \| 100 \| .* \| 2 \| 1\.5 s \|/);
  assert.match(section, /\| groq:m-a \|/);
  assert.match(section, /not directly comparable/);
});
