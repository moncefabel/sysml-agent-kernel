import { test } from 'node:test';
import assert from 'node:assert/strict';
import { feedback } from '../eval/suites.js';
import { scriptedAgent } from '../eval/agents.js';
import { runScenario } from '../eval/harness.js';
import { llmAgent } from '../eval/llm/loop.js';
import { MockProvider, type MockTurn } from '../eval/llm/mock.js';
import { DEFAULT_POLICY, ToolHost, type Policy } from '../src/tools.js';
import { Workspace } from '../src/workspace.js';

const LARGE: Policy = { ...DEFAULT_POLICY, catalog: 'large' };
const s = feedback.find((x) => x.id === 'fb-suffixed-unit')!;
const OVER_LIMIT = '{"name":"sysml_find_elements","arguments":{"pattern":"Unit_*","limit":200}}';
const RENAME = { ops: [{ op: 'rename', path: 'Plant::Area11::Unit_11_67_tmp', newName: 'Unit_11_67' }] };

test('feedback suite: the model is valid, the suffixed unit is found only by search, the task invites a call above the limit', () => {
  const host = new ToolHost(new Workspace(s.model), LARGE);
  assert.equal((host.call('sysml_validate', {}) as any).errors, 0, 'validation does not point at the unit');
  const found = host.call('sysml_find_elements', { pattern: 'Unit_*_*_*', kind: 'partDef' }) as any;
  assert.deepEqual(found.matches.map((m: any) => m.path), ['Plant::Area11::Unit_11_67_tmp']);
  const schema = host.toolDefinitions().find((t) => t.name === 'sysml_find_elements')!.input_schema as any;
  assert.equal(schema.properties.limit.maximum, 50);
  assert.match(s.task, /up to 200 matching elements in a single call/);
  assert.equal((host.call('sysml_find_elements', { pattern: 'Unit_*', limit: 200 }) as any).error.code, 'INVALID_ARGUMENTS');
});

test('feedback suite: the scripted reference trajectory passes, and an unchanged model fails the checks', async () => {
  const row = await runScenario(s, scriptedAgent, LARGE);
  assert.ok(row.success, JSON.stringify(row.checks.filter((c) => !c.ok)));
  assert.equal(row.committed, 1);
  const idle = await runScenario(s, llmAgent(new MockProvider([{ content: 'Done.' }])), LARGE);
  assert.equal(idle.success, false);
});

const corrected: MockTurn[] = [
  { toolUseFailed: OVER_LIMIT },
  { toolCalls: [{ name: 'sysml_find_elements', args: { pattern: 'Unit_*_*_*', kind: 'partDef', limit: 50 } }] },
  { toolCalls: [{ name: 'sysml_apply_edits', args: RENAME }] },
  { content: 'Renamed Unit_11_67_tmp to Unit_11_67.' },
];

test('feedback suite: with reportProviderError a rejected call is explained, and a corrected run passes', async () => {
  const mock = new MockProvider(corrected);
  const row = await runScenario(s, llmAgent(mock, { maxInputTokens: 100_000, reportProviderError: true }), LARGE);
  const sent = mock.requests[1].messages.at(-1) as any;
  assert.match(sent.content, /API error: mock 400: tool_use_failed/);
  assert.match(sent.content, /"limit":200/);
  assert.ok(row.success, JSON.stringify(row.checks.filter((c) => !c.ok)));
  assert.equal(row.llm!.malformedToolCalls, 1);
  // The rejected call never reached the kernel: the audit holds only the corrected search.
  assert.deepEqual(row.audit.filter((a) => a.tool === 'sysml_find_elements').map((a) => (a.args as any).limit), [50]);
});

test('feedback suite: without the option the feedback omits the reason; repeated rejections end on the turn limit', async () => {
  const mock = new MockProvider(Array.from({ length: 12 }, () => ({ toolUseFailed: OVER_LIMIT })));
  const row = await runScenario(s, llmAgent(mock, { maxInputTokens: 100_000 }), LARGE);
  assert.doesNotMatch((mock.requests[1].messages.at(-1) as any).content, /API error/);
  assert.equal(row.stopReason, 'max_turns');
  assert.equal(row.llm!.malformedToolCalls, 12);
  assert.equal(row.success, false);
  assert.equal(row.audit.length, 0, 'the kernel saw no call');
});
