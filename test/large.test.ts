import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { generateLargeModel, large, LARGE_SEED } from '../eval/large.js';
import { scriptedAgent } from '../eval/agents.js';
import { runScenario } from '../eval/harness.js';
import { contextRead } from '../eval/context-metrics.js';
import { llmAgent, CAP_CHARS_PER_TOKEN } from '../eval/llm/loop.js';
import { MockProvider, referenceProvider } from '../eval/llm/mock.js';
import { DEFAULT_POLICY, ToolHost, type Policy } from '../src/tools.js';
import { Workspace } from '../src/workspace.js';

const LARGE: Policy = { ...DEFAULT_POLICY, catalog: 'large' };
const byId = (id: string) => large.find((s) => s.id === id)!;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

test('large model: deterministic, about 8000 elements, valid', () => {
  const a = generateLargeModel(), b = generateLargeModel();
  assert.equal(a.text, b.text);
  assert.notEqual(generateLargeModel(LARGE_SEED + 1).text, a.text);
  const ws = new Workspace(a.text);
  const n = ws.index().namedPaths().length;
  assert.ok(n > 7500 && n < 8500, `${n} named elements`);
  assert.deepEqual(ws.diagnostics(), []);
  // Each scenario model differs from the base only where the scenario says.
  assert.equal(sha(byId('large-rename-port-def').model), sha(a.text));
});

test('large suite: the scripted baseline passes all 3 scenarios, in process and over MCP', async () => {
  for (const s of large) {
    assert.ok((await runScenario(s, scriptedAgent, LARGE)).success, s.id);
    assert.ok((await runScenario(s, scriptedAgent, LARGE, 'mcp')).success, `${s.id} over mcp`);
  }
});

test('large suite: each scenario starts with exactly the planted defect', () => {
  const diags = (id: string) => new Workspace(byId(id).model).diagnostics().map((d) => `${d.code} ${d.path}`);
  assert.deepEqual(diags('large-fix-buried-type'), ['E101 Plant::Area17::Unit_17_63::prev']);
  assert.deepEqual(diags('large-rename-port-def'), []);
  assert.deepEqual(diags('large-unsatisfied-requirement'), ['W202 Plant::Requirements::req23']);
});

test('satisfied_by: the subject must be the one named, not any satisfier', async () => {
  const s = byId('large-unsatisfied-requirement');
  const wrong = await runScenario(s, llmAgent(new MockProvider([
    { toolCalls: [{ name: 'sysml_apply_edits', args: { ops: [{ op: 'add', parent: 'Plant::Requirements', source: 'satisfy req23 by Plant::Area00::Unit_00_00;' }] } }] },
    { content: 'Done.' },
  ])), LARGE);
  assert.equal(wrong.checks.find((c) => c.check === 'satisfied_by')!.ok, false);
  assert.equal(wrong.success, false);
});

test('find_elements: substring, wildcard, kind filter and bounded results', () => {
  const host = new ToolHost(new Workspace(generateLargeModel().text), LARGE);
  const sub: any = host.call('sysml_find_elements', { pattern: 'unit_17_6' });
  assert.equal(sub.total, 10);
  assert.equal(sub.matches[0].path, 'Plant::Area17::Unit_17_60');
  const star: any = host.call('sysml_find_elements', { pattern: 'Unit_*_63', kind: 'partDef', limit: 5 });
  assert.equal(star.total, 20);
  assert.equal(star.matches.length, 5);
  assert.equal(star.truncated, true);
  const ports: any = host.call('sysml_find_elements', { pattern: 'fluidport' });
  assert.deepEqual(ports.matches.map((m: any) => m.path), ['Plant::FluidPort']);
  const bad: any = host.call('sysml_find_elements', { pattern: '', limit: 500 });
  assert.equal(bad.error.code, 'INVALID_ARGUMENTS');
  assert.deepEqual(host.auditTrail.map((a) => a.tool), Array(4).fill('sysml_find_elements'));
});

test('find_elements: absent from the default catalog, and rejected there by the kernel', () => {
  const host = new ToolHost(new Workspace(generateLargeModel().text));
  assert.ok(!host.toolDefinitions().some((t) => t.name === 'sysml_find_elements'));
  assert.equal(host.toolDefinitions().length, 6);
  assert.equal((host.call('sysml_find_elements', { pattern: 'x' }) as any).error.code, 'UNKNOWN_TOOL');
});

test('input cap: a call that could exceed it is never sent, and the scenario stops cleanly', async () => {
  const s = byId('large-fix-buried-type');
  const mock = new MockProvider(Array.from({ length: 10 }, () => ({ toolCalls: [{ name: 'sysml_outline', args: { depth: 3 } }] })));
  const cap = 6000;
  const row = await runScenario(s, llmAgent(mock, { maxInputTokens: cap }), LARGE);
  assert.equal(row.stopReason, 'input_cap');
  assert.ok(mock.requests.length >= 1);
  for (const r of mock.requests) assert.ok(Math.ceil(JSON.stringify({ messages: r.messages, tools: r.tools }).length / CAP_CHARS_PER_TOKEN) <= cap);
  assert.equal(row.success, false);
});

test('context metrics: the reference trajectory reads a tiny share of the large model', async () => {
  const s = byId('large-unsatisfied-requirement');
  const row = await runScenario(s, llmAgent(referenceProvider(s), { maxInputTokens: 100_000 }), LARGE);
  assert.ok(row.success);
  const c = row.context!;
  assert.ok(c.elementsTotal > 7500);
  assert.ok(c.elementsRead >= 2 && c.shareRead < 0.01, `read ${c.elementsRead}`);
  assert.ok(row.llm!.requestChars! > 0 && row.llm!.maxPromptTokens! > 0);
  assert.ok(row.llm!.maxPromptTokens! < 100_000);
});

test('context metrics: clipped results only count what was sent; get counts the subtree', () => {
  const model = generateLargeModel().text;
  const got = contextRead(model, [{ tool: 'sysml_get', result: { path: 'Plant::Area03::Unit_03_04', source: '...' } }]);
  assert.equal(got.elementsRead, 5, 'the part def and its 4 features');
  const big = { outline: Array.from({ length: 2000 }, (_, i) => ({ path: `Plant::Area0${i % 10}::Unit_0${i % 10}_${String(i % 80).padStart(2, '0')}` })) };
  const clipped = contextRead(model, [{ tool: 'sysml_outline', result: big }], 2000);
  const full = contextRead(model, [{ tool: 'sysml_outline', result: big }], 10_000_000);
  assert.ok(clipped.elementsRead < full.elementsRead);
});

test('tool_use_failed: the provider reason is fed back, so the model can correct the arguments', async () => {
  const { ProviderError } = await import('../eval/llm/provider.js');
  const s = byId('large-fix-buried-type');
  const reason = 'Groq 400: Tool call validation failed: parameters for tool sysml_find_elements did not match schema: /limit must be <= 50';
  let first = true;
  const mock = new MockProvider([
    { toolCalls: [{ name: 'sysml_validate', args: { severity: 'error' } }] },
    { toolCalls: [{ name: 'sysml_apply_edits', args: { ops: [{ op: 'set', path: 'Plant::Area17::Unit_17_63::prev', field: 'type', value: 'Unit_17_62' }] } }] },
    { content: 'Done.' },
  ]);
  const provider = { provider: 'mock', model: 'm', async complete(r: any) {
    if (first) { first = false; mock.requests.push(r); throw new ProviderError(reason, 'tool_use_failed', 400, '{"name":"sysml_find_elements","arguments":{"pattern":"*","limit":200}}'); }
    return mock.complete(r);
  } };
  const row = await runScenario(s, llmAgent(provider, { maxInputTokens: 100_000, reportProviderError: true }), LARGE);
  const feedback: any = mock.requests[1].messages.at(-1);
  assert.match(feedback.content, /API error: Groq 400: .*limit must be <= 50/);
  assert.match(feedback.content, /"limit":200/);
  assert.ok(row.success);
  assert.equal(row.llm!.malformedToolCalls, 1);
  // Without the option (earlier runs), the feedback is the original text, so they replay unchanged.
  first = true; mock.requests.length = 0;
  const legacy = new MockProvider([{ content: 'Done.' }]);
  const p2 = { provider: 'mock', model: 'm', async complete(r: any) {
    if (first) { first = false; legacy.requests.push(r); throw new ProviderError(reason, 'tool_use_failed', 400, 'x'); }
    return legacy.complete(r);
  } };
  await runScenario(s, llmAgent(p2), LARGE);
  assert.doesNotMatch((legacy.requests[1].messages.at(-1) as any).content, /API error/);
});
