import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { scenarios } from '../eval/scenarios.js';
import { injection, selfCorrection } from '../eval/suites.js';
import { scriptedAgent } from '../eval/agents.js';
import { runScenario } from '../eval/harness.js';
import { McpToolClient } from '../eval/mcp-client.js';
import { llmAgent } from '../eval/llm/loop.js';
import { MockProvider } from '../eval/llm/mock.js';
import { ToolHost } from '../src/tools.js';
import { Workspace } from '../src/workspace.js';
import type { CompletionRequest, LLMProvider } from '../eval/llm/provider.js';

const src = readFileSync(new URL('../../examples/vehicle.sysml', import.meta.url), 'utf8');
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const waitDead = async (pid: number) => { for (let i = 0; i < 50 && alive(pid); i++) await new Promise((r) => setTimeout(r, 20)); return !alive(pid); };

test('mcp: tool names, descriptions and schemas are identical to the in-process catalog', async () => {
  const client = await McpToolClient.start(src);
  try {
    assert.deepEqual(client.toolDefinitions(), new ToolHost(new Workspace(src)).toolDefinitions());
  } finally { await client.close(); }
});

test('mcp: the large catalog is identical too, and absent by default', async () => {
  const large = await McpToolClient.start(src, { catalog: 'large' });
  try {
    assert.deepEqual(large.toolDefinitions(), new ToolHost(new Workspace(src), { mode: 'write', maxRemovalsPerTx: 3, maxOpsPerTx: 20, catalog: 'large' }).toolDefinitions());
    assert.ok(large.toolDefinitions().some((t) => t.name === 'sysml_find_elements'));
  } finally { await large.close(); }
});

test('mcp: the scripted baseline gives the same rows over both transports', async () => {
  for (const s of [...scenarios, ...selfCorrection, ...injection]) {
    const a = await runScenario(s, scriptedAgent);
    const b = await runScenario(s, scriptedAgent, undefined, 'mcp');
    assert.ok(b.success, s.id);
    assert.equal(b.finalModel, a.finalModel, s.id);
    assert.deepEqual(b.checks, a.checks, s.id);
    assert.deepEqual(b.audit.map((e) => [e.tool, e.outcome]), a.audit.map((e) => [e.tool, e.outcome]), s.id);
    assert.equal(b.perturbed, a.perturbed, s.id);
  }
});

test('mcp: results are identical, and the server process exits on close', async () => {
  const client = await McpToolClient.start(src);
  const pid = client.pid!;
  assert.ok(alive(pid));
  const host = new ToolHost(new Workspace(src));
  for (const [name, args] of [['sysml_outline', { depth: 2 }], ['sysml_validate', {}], ['sysml_get', { path: 'VehicleModel::Engine' }], ['sysml_get', { path: 'Nope' }],
    ['sysml_apply_edits', { ops: [{ op: 'remove', path: 'VehicleModel::FuelTank' }] }], ['sysml_apply_edits', { ops: [{ op: 'add', parent: 'VehicleModel', source: 'part def Seat;' }] }]] as const)
    assert.deepEqual(await client.call(name, args), host.call(name, args), name);
  assert.equal(client.auditTrail.length, 6);
  const finalModel = await client.close();
  assert.match(finalModel, /part def Seat;/, 'the server saved the committed model');
  assert.ok(await waitDead(pid), 'server process is gone');
});

test('mcp: an unknown tool is rejected by the SDK before the kernel, and recorded by the client', async () => {
  const client = await McpToolClient.start(src);
  try {
    const r: any = await client.call('sysml_admin_set_policy', { mode: 'write' });
    assert.equal(r.error.code, 'MCP_ERROR');
    assert.match(r.error.message, /not found/);
    assert.deepEqual(client.auditTrail.map((e) => [e.tool, e.outcome, e.recordedBy]), [['sysml_admin_set_policy', 'error:MCP_ERROR', 'mcp-client']]);
    // In process, the same call reaches the kernel and gets its structured error.
    assert.equal((new ToolHost(new Workspace(src)).call('sysml_admin_set_policy', {}) as any).error.code, 'UNKNOWN_TOOL');
  } finally { await client.close(); }
});

test('mcp: a server crash mid run ends the scenario as a crash, not a success', async () => {
  let pid = 0;
  // A provider that kills the server between the first and the second tool call.
  const mock = new MockProvider([
    { toolCalls: [{ name: 'sysml_outline', args: {} }] },
    { toolCalls: [{ name: 'sysml_apply_edits', args: { ops: [{ op: 'add', parent: 'VehicleModel', source: 'part def Brake { attribute mass : Real = 12; }' }, { op: 'add', parent: 'VehicleModel::Vehicle', source: 'part brakes : Brake[4];' }] } }] },
    { content: 'Done.' },
  ]);
  const killer: LLMProvider = {
    provider: 'mock', model: 'killer',
    async complete(req: CompletionRequest) {
      if (mock.requests.length === 1) {
        const ps = await import('node:child_process');
        pid = Number(ps.execSync(`pgrep -n -f "dist/src/mcp-server.js"`).toString().trim());
        process.kill(pid, 'SIGKILL');
        await waitDead(pid);
      }
      return mock.complete(req);
    },
  };
  const row = await runScenario(scenarios[0], llmAgent(killer), undefined, 'mcp');
  assert.ok(row.crash, 'the run is reported as crashed');
  assert.equal(row.success, false);
  assert.equal(row.fatal, undefined, 'a transport crash is not a quota or auth stop');
  assert.ok(pid > 0 && !alive(pid));
});

test('mcp: a non default policy is refused rather than silently ignored', async () => {
  await assert.rejects(runScenario(scenarios[0], scriptedAgent, { mode: 'write', maxRemovalsPerTx: 3, maxOpsPerTx: 20 }, 'mcp'), /default policy only/);
});
