import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { scenarios } from '../eval/scenarios.js';
import { selfCorrection, selfCorrectionV2 } from '../eval/suites.js';
import { scriptedAgent, SYSTEM } from '../eval/agents.js';
import { runScenario } from '../eval/harness.js';
import { llmAgent } from '../eval/llm/loop.js';
import { MockProvider } from '../eval/llm/mock.js';
import { CLARIFICATION_TOOL, CLARIFICATIONS, DEFAULT_CLARIFICATION, endsWithQuestion, MAX_CLARIFICATIONS, simulatedHuman } from '../eval/hitl.js';

const original = selfCorrection.find((s) => s.id === 'sc-hidden-port-type')!;
const v2 = selfCorrectionV2[0];
const clarify = (id: string) => simulatedHuman(id);
const ask = (question: string) => ({ toolCalls: [{ name: 'request_clarification', args: { question } }] });
const FIX = [
  { op: 'set', path: 'VehicleModel::FuelFilter::inlet', field: 'type', value: 'FuelPort' },
  { op: 'add', parent: 'VehicleModel::Vehicle', source: 'part filter : FuelFilter;' },
  { op: 'remove', path: 'VehicleModel::Vehicle#connect[0]' },
  { op: 'add', parent: 'VehicleModel::Vehicle', source: 'connect tank.fuelOut to filter.inlet; connect filter.outlet to engine.fuelIn;' },
];

// ---- A1: clarification channel ----

test('hitl: the default configuration sends exactly the same requests as before', async () => {
  const mock = new MockProvider([{ content: 'Done.' }]);
  await runScenario(scenarios[0], llmAgent(mock));
  const r = mock.requests[0];
  assert.equal(r.messages[0].content, SYSTEM);
  assert.ok(!r.tools.some((t) => t.name === CLARIFICATION_TOOL.name));
  assert.equal(r.tools.length, 6);
});

test('hitl: request_clarification is offered, answered by the simulated human, and the run continues', async () => {
  const mock = new MockProvider([
    ask('May I retype FuelFilter::inlet to FuelPort?'),
    { toolCalls: [{ name: 'sysml_apply_edits', args: { ops: FIX } }] },
    { content: 'Done.' },
  ]);
  const row = await runScenario(original, llmAgent(mock, { clarify }));
  assert.ok(mock.requests[0].tools.some((t) => t.name === 'request_clarification'));
  assert.match(String(mock.requests[0].messages[0].content), /request_clarification/);
  const reply: any = mock.requests[1].messages.at(-1);
  assert.equal(reply.role, 'tool');
  assert.deepEqual(JSON.parse(reply.content), { answer: CLARIFICATIONS['sc-hidden-port-type'] });
  assert.equal(row.clarifications, 1);
  assert.equal(row.outcome, 'success');
  assert.ok(row.success);
  assert.deepEqual(row.audit.map((a) => a.tool), ['human.clarification', 'sysml_apply_edits']);
  assert.equal(row.audit[0].outcome, 'answered');
  assert.ok(!row.audit.some((a) => a.outcome === 'error:UNKNOWN_TOOL'), 'the kernel never sees the clarification');
  assert.equal(row.structuredErrors, 0);
});

test('hitl: unknown scenarios get the default reply, and questions are capped', async () => {
  assert.equal(simulatedHuman('no-such-scenario'), DEFAULT_CLARIFICATION);
  const mock = new MockProvider([...Array.from({ length: MAX_CLARIFICATIONS + 1 }, (_, i) => ask(`q${i}`)), { content: 'Done.' }]);
  const row = await runScenario(scenarios[0], llmAgent(mock, { clarify }));
  assert.equal(row.clarifications, MAX_CLARIFICATIONS + 1);
  const last: any = mock.requests.at(-1)!.messages.at(-1);
  assert.match(JSON.parse(last.content).answer, /No more questions/);
});

test('hitl: without the configuration the tool does not exist and the kernel rejects it', async () => {
  const row = await runScenario(scenarios[0], llmAgent(new MockProvider([ask('?'), { content: 'Done.' }])));
  assert.equal(row.audit[0].outcome, 'error:UNKNOWN_TOOL');
  assert.equal(row.clarifications, undefined);
});

test('outcome: a plain text question is clarification_requested, never success', async () => {
  const question = 'Retyping the inlet would fix it, but you asked me to keep every definition.\n\nShould I make that change?';
  const asked = await runScenario(original, llmAgent(new MockProvider([{ content: question }])));
  assert.equal(asked.outcome, 'clarification_requested');
  assert.equal(asked.success, false);
  assert.equal(asked.finalText, question);
  const failed = await runScenario(original, llmAgent(new MockProvider([{ content: 'I could not do it.' }])));
  assert.equal(failed.outcome, 'failure');
  // A run that passes its checks is a success even if it ends with a polite question.
  const done = await runScenario(v2, llmAgent(new MockProvider([{ toolCalls: [{ name: 'sysml_apply_edits', args: { ops: FIX } }] }, { content: 'Done. Anything else?' }])));
  assert.equal(done.outcome, 'success');
  assert.equal(endsWithQuestion('Line one?\n\nDone.'), false);
  assert.equal(endsWithQuestion(undefined), false);
});

// ---- A2: unambiguous v2 scenario ----

test('v2: same model, checks and reference trajectory as the original; only id and task differ', async () => {
  assert.equal(v2.model, original.model);
  assert.deepEqual(v2.checks, original.checks);
  assert.deepEqual(v2.scripted, original.scripted);
  assert.notEqual(v2.task, original.task);
  assert.match(v2.task, /retyping an existing port/);
  assert.match(v2.task, /only thing forbidden is deleting/);
  assert.match(original.task, /Keep every existing definition\.$/, 'the original task is unchanged');
  assert.ok((await runScenario(v2, scriptedAgent)).success);
});

// ---- A3: variance and clarification sections of the summary ----

test('summary: variance flags passes that disagree, and hitl runs are listed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'summary5-'));
  const ok = await runScenario(v2, scriptedAgent);
  const llm = (turns: number, total: number) => ({ turns, promptTokens: total - 10, completionTokens: 10, totalTokens: total, billedTokens: total, cacheHits: 0, llmLatencyMs: 1000, malformedToolCalls: 0, estimatedUsageTurns: 0 });
  const report = (pass: number, row: object, config = 'default') => JSON.stringify({ agent: 'groq:m', provider: 'groq', model: 'm', suite: 'selfcorrect-v2', pass, config, replay: false,
    policy: { maxRemovedElementsPerSession: 5 }, date: '2026-10-19T00:00:00Z', total: 1, incomplete: [], rows: [row] });
  writeFileSync(join(dir, 'p1.json'), report(1, { ...ok, llm: llm(4, 1000), outcome: 'success' }));
  writeFileSync(join(dir, 'p2.json'), report(2, { ...ok, success: false, llm: llm(6, 1500), outcome: 'clarification_requested' }));
  writeFileSync(join(dir, 'h1.json'), report(1, { ...ok, llm: llm(3, 900), outcome: 'success', clarifications: 1,
    audit: [{ tool: 'human.clarification', args: { question: 'May I retype the inlet?' }, outcome: 'answered' }, ...ok.audit] }, 'hitl'));
  execFileSync(process.execPath, [new URL('../eval/summary.js', import.meta.url).pathname, dir]);
  const md = readFileSync(join(dir, 'SUMMARY.md'), 'utf8');
  const variance = md.slice(md.indexOf('## Variance'), md.indexOf('## Clarifications'));
  assert.match(variance, /sc-hidden-port-type-v2 \| 2 \| success, clarification_requested \| \*\*no\*\* \| 4 to 6 \| 1000 to 1500 \| 40 % \|/);
  const clar = md.slice(md.indexOf('## Clarifications'), md.indexOf('## Replay verification'));
  assert.match(clar, /hitl configuration\) \| groq:m \| 1 \| sc-hidden-port-type-v2 \| success \| 1 \| May I retype the inlet\? \|/);
  assert.match(clar, /\| 2 \| sc-hidden-port-type-v2 \| clarification_requested \| 0 \|/);
});

test('summary: a row replayed entirely from the cache in a later report is counted once', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'summary5d-'));
  const ok = await runScenario(v2, scriptedAgent);
  const llm = { turns: 4, promptTokens: 990, completionTokens: 10, totalTokens: 1000, malformedToolCalls: 0, estimatedUsageTurns: 0, llmLatencyMs: 1 };
  const report = (date: string, rows: object[]) => JSON.stringify({ agent: 'groq:m', provider: 'groq', model: 'm', suite: 'selfcorrect-v2', pass: 2, replay: false,
    policy: { maxRemovedElementsPerSession: 5 }, date, total: rows.length, incomplete: [], rows });
  writeFileSync(join(dir, 'a.json'), report('2026-10-18T00:00:00Z', [{ ...ok, llm: { ...llm, billedTokens: 1000, cacheHits: 0 } }]));
  writeFileSync(join(dir, 'b.json'), report('2026-10-19T00:00:00Z', [{ ...ok, llm: { ...llm, billedTokens: 0, cacheHits: 4 } }]));
  execFileSync(process.execPath, [new URL('../eval/summary.js', import.meta.url).pathname, dir]);
  const md = readFileSync(join(dir, 'SUMMARY.md'), 'utf8');
  assert.match(md, /counted once although saved twice.*sc-hidden-port-type-v2 in b\.json/);
  assert.match(md, /\| sc-hidden-port-type-v2 \| 1\/1 \|/);
});
