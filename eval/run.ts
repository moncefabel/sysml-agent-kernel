import { writeFileSync, mkdirSync } from 'node:fs';
import { Workspace } from '../src/workspace.js';
import { DEFAULT_POLICY, ToolHost } from '../src/tools.js';
import { scenarios, type Check } from './scenarios.js';
import { anthropicAgent, scriptedAgent, type Agent } from './agents.js';

// Usage: node dist/eval/run.js [--agent scripted|anthropic] [--model <id>] [--only <scenario-id>]
const argv = process.argv.slice(2);
const opt = (n: string, d: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const agent: Agent = opt('--agent', 'scripted') === 'anthropic'
  ? anthropicAgent(opt('--model', process.env.SYSML_AGENT_MODEL ?? 'claude-sonnet-4-5'))
  : scriptedAgent;
const only = opt('--only', '');

function check(ws: Workspace, c: Check): { ok: boolean; detail: string } {
  const idx = ws.index();
  switch (c.type) {
    case 'no_errors': { const n = ws.diagnostics().filter((d) => d.severity === 'error').length; return { ok: n === 0, detail: `${n} errors` }; }
    case 'exists': { const e = idx.get(c.path); return { ok: !!e && (!c.kind || e.kind === c.kind), detail: c.path }; }
    case 'not_exists': return { ok: !idx.get(c.path), detail: c.path };
    case 'satisfied': return { ok: !!idx.get(c.requirement) && !ws.diagnostics().some((d) => d.code === 'W202' && d.path === c.requirement), detail: c.requirement };
    case 'text_excludes': return { ok: !ws.text().includes(c.pattern), detail: c.pattern };
    case 'preserved': { const missing = c.paths.filter((p) => !idx.get(p)); return { ok: missing.length === 0, detail: missing.length ? `missing ${missing.join(', ')}` : `${c.paths.length} kept` }; }
  }
}

const rows: any[] = [];
for (const s of scenarios.filter((x) => !only || x.id === only)) {
  const host = new ToolHost(new Workspace(s.model), DEFAULT_POLICY);
  const t0 = Date.now();
  let run, crash: string | undefined;
  try { run = await agent.run(s, host); } catch (e) { crash = String(e); }
  const results = crash ? [] : s.checks.map((c) => ({ check: c.type, ...check(host.ws, c) }));
  const outcomes = host.auditTrail.map((a) => a.outcome as string);
  rows.push({
    id: s.id, category: s.category,
    success: !crash && results.every((r) => r.ok),
    toolCalls: run?.toolCalls ?? 0,
    committed: outcomes.filter((o) => o === 'committed').length,
    rejected: outcomes.filter((o) => o.startsWith('rejected')).length,
    policyBlocks: outcomes.filter((o) => o === 'error:POLICY_LIMIT' || o === 'error:PERMISSION_DENIED').length,
    ms: Date.now() - t0,
    checks: results, crash, audit: host.auditTrail, finalModel: host.ws.text(),
  });
}

const pad = (v: unknown, n: number) => String(v).padEnd(n);
console.log(`\nagent: ${agent.name}\n`);
console.log(pad('scenario', 26) + pad('category', 10) + pad('result', 8) + pad('calls', 7) + pad('commit', 8) + pad('reject', 8) + 'ms');
for (const r of rows) console.log(pad(r.id, 26) + pad(r.category, 10) + pad(r.success ? 'PASS' : 'FAIL', 8) + pad(r.toolCalls, 7) + pad(r.committed, 8) + pad(r.rejected, 8) + r.ms + (r.crash ? `  ${r.crash}` : ''));
const passed = rows.filter((r) => r.success).length;
console.log(`\nsuccess rate: ${passed}/${rows.length} (${Math.round((100 * passed) / rows.length)}%)`);
for (const r of rows.filter((x) => !x.success && !x.crash)) console.log(`  ${r.id}: ${r.checks.filter((c: any) => !c.ok).map((c: any) => `${c.check} (${c.detail})`).join('; ')}`);

mkdirSync('eval/reports', { recursive: true });
const out = `eval/reports/${agent.name.replace(/[^a-z0-9-]/gi, '_')}.json`;
writeFileSync(out, JSON.stringify({ agent: agent.name, date: new Date().toISOString(), passed, total: rows.length, rows }, null, 2));
console.log(`report: ${out}`);
process.exitCode = passed === rows.length ? 0 : 1;
