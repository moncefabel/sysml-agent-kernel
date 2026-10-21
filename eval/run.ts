import { writeFileSync, mkdirSync } from 'node:fs';
import { probes, scenarios as mainSuite } from './scenarios.js';
import { feedback, injection, selfCorrection, selfCorrectionV2, type SuiteScenario } from './suites.js';
import { large, type EvalScenario } from './large.js';
import { simulatedHuman } from './hitl.js';
import { scriptedAgent, SYSTEM, type Agent } from './agents.js';
import { runScenario, summarize, type Row, type Transport } from './harness.js';
import { Checkpoint } from './checkpoint.js';
import { DEFAULT_POLICY, type Policy } from '../src/tools.js';
import { TokenBudget } from './llm/budget.js';
import { CachedProvider } from './llm/cache.js';
import { anthropicFromEnv } from './llm/anthropic.js';
import { groqFromEnv } from './llm/groq.js';
import { llmAgent, LLM_DEFAULTS } from './llm/loop.js';
import { canonicalJson, sha256, type LLMProvider } from './llm/provider.js';

// Usage: node dist/eval/run.js [--agent scripted|groq|anthropic] [--suite main|probes|selfcorrect|injection|selfcorrect-v2|large|feedback]
//          [--only <scenario-id>] [--pass n] [--policy default|phase2] [--config default|hitl|large] [--transport inprocess|mcp]
// LLM options: [--max-turns n] [--max-output-tokens n] [--scenario-budget n] [--run-budget n]
//              [--cache-dir d] [--no-cache] [--replay-only] [--fresh]
const argv = process.argv.slice(2);
const opt = (n: string, d: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const num = (n: string, d: number) => { const v = Number(opt(n, String(d))); if (!Number.isFinite(v) || v <= 0) throw new Error(`${n} must be a positive number`); return v; };
const flag = (n: string) => argv.includes(n);
const kind = opt('--agent', 'scripted');
const only = opt('--only', '');
const pass = num('--pass', 1);

const SUITES: Record<string, EvalScenario[]> = { main: mainSuite, probes, selfcorrect: selfCorrection, injection, 'selfcorrect-v2': selfCorrectionV2, large, feedback };
const suiteName = opt('--suite', 'main');
const scenarios = SUITES[suiteName];
if (!scenarios) throw new Error(`--suite must be one of ${Object.keys(SUITES).join(', ')}`);
// --config hitl offers request_clarification, answered by the simulated human (eval/hitl.ts).
// --config large adds the search tool (policy catalog 'large') and the per call input cap; it is
// the default for the large and feedback suites.
const config = opt('--config', suiteName === 'large' || suiteName === 'feedback' ? 'large' : 'default');
if (!['default', 'hitl', 'large'].includes(config)) throw new Error('--config must be default, hitl or large');
const LARGE_INPUT_CAP = 100_000;
// File names keep the phase 2 layout for the main suite, pass 1, default configuration.
// --transport mcp calls the tools through the real MCP server (eval/mcp-client.ts).
const transport = opt('--transport', 'inprocess') as Transport;
if (!['inprocess', 'mcp'].includes(transport)) throw new Error('--transport must be inprocess or mcp');
const suffix = (suiteName === 'main' ? '' : `.${suiteName}`) + (config === 'hitl' ? '.hitl' : '') + (transport === 'mcp' ? '.mcp' : '') + (pass > 1 ? `.pass${pass}` : '');
// --policy phase2 reproduces the phase 2 runs, which had per transaction limits only.
const policyName = opt('--policy', 'default');
if (!['default', 'phase2'].includes(policyName)) throw new Error('--policy must be default or phase2');
const policy: Policy = policyName === 'phase2' ? { mode: 'write', maxRemovalsPerTx: 3, maxOpsPerTx: 20 }
  : config === 'large' ? { ...DEFAULT_POLICY, catalog: 'large' } : DEFAULT_POLICY;

let agent: Agent;
let checkpoint: Checkpoint | undefined;
let runBudget: TokenBudget | undefined;
let cache: CachedProvider | undefined;
let loopOptionsUsed: Record<string, unknown> | undefined;
let base: (LLMProvider & { retryStats?: unknown; rateLimit?: Record<string, string> }) | undefined;

if (kind === 'groq' || kind === 'anthropic') {
  const loopOptions = {
    maxTurns: num('--max-turns', LLM_DEFAULTS.maxTurns),
    maxOutputTokens: num('--max-output-tokens', LLM_DEFAULTS.maxOutputTokens),
    scenarioTokenBudget: num('--scenario-budget', LLM_DEFAULTS.scenarioTokenBudget),
    maxToolResultChars: LLM_DEFAULTS.maxToolResultChars,
    temperature: LLM_DEFAULTS.temperature,
    // Phase 6 fix: send the provider's reason on tool_use_failed. --legacy-tool-feedback
    // reproduces runs recorded before it (the first large suite run of gpt-oss).
    ...(flag('--legacy-tool-feedback') ? {} : { reportProviderError: true }),
  };
  loopOptionsUsed = loopOptions;
  let provider: LLMProvider = base = kind === 'groq' ? groqFromEnv() : anthropicFromEnv();
  if (!flag('--no-cache')) provider = cache = new CachedProvider(provider, opt('--cache-dir', 'eval/cache'), flag('--replay-only') ? 'readonly' : 'readwrite', pass);
  runBudget = argv.includes('--run-budget') ? new TokenBudget(num('--run-budget', 1)) : undefined;
  agent = llmAgent(provider, { ...loopOptions, runBudget, ...(config === 'hitl' ? { clarify: (id: string) => simulatedHuman(id) } : {}),
    ...(config === 'large' ? { maxInputTokens: LARGE_INPUT_CAP } : {}) });
  // Everything that can change a recorded row is fingerprinted; the run budget and the cache
  // only decide whether a scenario runs now, so they may change between resumes. The policy
  // entered the fingerprint in phase 3, so phase 2 checkpoints need --fresh.
  checkpoint = new Checkpoint(`eval/reports/${agent.name.replace(/[^a-z0-9-]/gi, '_')}${suffix}.checkpoint.jsonl`, {
    agent: agent.name, ...(base.settings ? { settings: base.settings } : {}), loopOptions, system: sha256(SYSTEM), policy, pass,
    // Absent for the default configuration, so earlier checkpoints stay valid.
    ...(config !== 'default' ? { config } : {}),
    ...(transport === 'mcp' ? { transport } : {}),
    scenarios: sha256(canonicalJson(scenarios.map((s) => ({ id: s.id, task: s.task, model: s.model, checks: s.checks, perturb: s.perturb })))),
  });
  if (flag('--fresh')) checkpoint.discard();
} else {
  agent = scriptedAgent;
}

const done = checkpoint?.load() ?? new Map<string, Row>();
const rows: Row[] = [];
const incomplete: Array<{ id: string; reason: string }> = [];
let halted: string | undefined;
for (const s of scenarios.filter((x) => !only || x.id === only)) {
  const prev = done.get(s.id);
  if (prev) { rows.push(prev); continue; }
  if (halted) { incomplete.push({ id: s.id, reason: `not started: ${halted}` }); continue; }
  if (runBudget?.exhausted) { incomplete.push({ id: s.id, reason: 'run budget exhausted' }); continue; }
  const before = base?.retryStats ? { ...(base.retryStats as { retries: number; waitedMs: number }) } : undefined;
  const row = await runScenario(s, agent, policy, transport);
  if (before) {
    const after = base!.retryStats as { retries: number; waitedMs: number };
    row.retries = { retries: after.retries - before.retries, waitedMs: after.waitedMs - before.waitedMs };
  }
  // A crash or a run budget stop says nothing about the model: keep it out of the checkpoint
  // and out of the success rate, so the next invocation runs it again.
  if (row.crash) {
    incomplete.push({ id: s.id, reason: row.crash });
    if (row.fatal) halted = 'provider unavailable (quota, auth or configuration), resume later';
    continue;
  }
  if (row.stopReason === 'run_budget') { incomplete.push({ id: s.id, reason: 'run budget exhausted' }); continue; }
  checkpoint?.append(row);
  rows.push(row);
}

const pad = (v: unknown, n: number) => String(v).padEnd(n);
console.log(`\nagent: ${agent.name}   suite: ${suiteName}   pass: ${pass}\n`);
console.log(pad('scenario', 30) + pad('result', 8) + pad('calls', 7) + pad('commit', 8) + pad('reject', 8) + pad('errors', 8) + pad('blocks', 8) + pad('rollbk', 8) + pad('touched', 9) + pad('extra', 7) + 'recreated');
for (const r of rows) console.log(pad(r.id, 30) + pad(r.success ? 'PASS' : 'FAIL', 8) + pad(r.toolCalls, 7) + pad(r.committed, 8) + pad(r.rejected, 8) + pad(r.structuredErrors, 8) + pad(r.policyBlocks, 8) + pad(r.rollbacks, 8)
  + pad(r.footprint ? `${r.footprint.touched}/${r.footprint.reference.touched}` : '-', 9) + pad(r.footprint?.extra.length ?? '-', 7) + (r.footprint?.recreated.length ? r.footprint.recreated.join(',') : '-'));
if (rows.some((r) => r.llm)) {
  console.log('\n' + pad('scenario', 30) + pad('turns', 7) + pad('prompt', 9) + pad('complet', 9) + pad('total', 9) + pad('billed', 9) + pad('cached', 8) + pad('llm ms', 9) + 'stop');
  for (const r of rows) if (r.llm) console.log(pad(r.id, 30) + pad(r.llm.turns, 7) + pad(r.llm.promptTokens, 9) + pad(r.llm.completionTokens, 9) + pad(r.llm.totalTokens, 9) + pad(r.llm.billedTokens, 9) + pad(r.llm.cacheHits, 8) + pad(r.llm.llmLatencyMs, 9) + r.stopReason);
}

const sum = summarize(rows);
const total = rows.length + incomplete.length;
console.log(`\nsuccess rate: ${sum.passed}/${sum.completed} completed${sum.completed ? ` (${Math.round((100 * sum.passed) / sum.completed)}%)` : ''}${incomplete.length ? `, ${incomplete.length} of ${total} not completed` : ''}`);
console.log(`self-correction: ${sum.withErrors ? `${sum.selfCorrected}/${sum.withErrors} scenarios with a structured error still succeeded` : 'n/a (no structured error was hit)'}`);
console.log(`rollbacks: ${sum.rollbacks}`);
if (sum.tokens) console.log(`tokens: ${sum.tokens.total} total (${sum.tokens.prompt} prompt, ${sum.tokens.completion} completion), ${sum.tokens.billed} billed, mean turns ${sum.meanTurns!.toFixed(1)}, llm latency ${sum.llmLatencyMs} ms`);
if (cache) console.log(`cache: ${cache.hits} hits, ${cache.misses} misses this invocation`);
// Includes tokens of scenarios dropped by a budget stop or a crash, which no row records.
if (runBudget) console.log(`billed this invocation: ${runBudget.used} tokens`);
if (base?.retryStats) console.log(`provider retries: ${JSON.stringify(base.retryStats)}`);
if (base?.rateLimit && Object.keys(base.rateLimit).length) console.log(`rate limit headers (last response): ${JSON.stringify(base.rateLimit)}`);
for (const r of rows.filter((x) => !x.success)) console.log(`  FAIL ${r.id}: ${r.checks.filter((c) => !c.ok).map((c) => `${c.check} (${c.detail})`).join('; ')}`);
for (const x of incomplete) console.log(`  NOT COMPLETED ${x.id}: ${x.reason}`);

mkdirSync('eval/reports', { recursive: true });
const out = `eval/reports/${agent.name.replace(/[^a-z0-9-]/gi, '_')}${suffix}.json`;
writeFileSync(out, JSON.stringify({
  agent: agent.name, provider: base?.provider ?? 'scripted', model: base?.model ?? 'reference', ...(base?.settings ? { settings: base.settings } : {}), suite: suiteName, pass, config, transport, ...(loopOptionsUsed ? { loopOptions: loopOptionsUsed } : {}),
  replay: flag('--replay-only'), policy, ...(runBudget ? { billedThisInvocation: runBudget.used } : {}), date: new Date().toISOString(), passed: sum.passed, total, summary: sum, incomplete,
  ...(base?.retryStats ? { retries: base.retryStats } : {}), ...(base?.rateLimit ? { rateLimit: base.rateLimit } : {}), rows,
}, null, 2));
console.log(`report: ${out}`);
process.exitCode = sum.passed === total ? 0 : 1;
