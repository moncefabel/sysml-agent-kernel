import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { probes, scenarios as mainSuite } from './scenarios.js';
import { injection, selfCorrection, selfCorrectionV2, type SuiteScenario } from './suites.js';
import { compareFootprint, footprint, type FootprintComparison } from './footprint.js';
import { referenceFootprint, type Row } from './harness.js';

/**
 * Builds eval/results/SUMMARY.md from the saved reports in eval/results. Every number comes
 * from those files; footprints missing from phase 2 reports are recomputed from their saved
 * audit trails and final models, which is deterministic.
 */
const DIR = process.argv[2] ?? 'eval/results';
const SUITES: Record<string, SuiteScenario[]> = { main: mainSuite, probes, selfcorrect: selfCorrection, injection, 'selfcorrect-v2': selfCorrectionV2 };

interface Report {
  file: string; agent: string; provider: string; model: string; suite: string; pass: number; replay: boolean; date: string;
  total: number; policyLabel: string; rows: Row[]; incomplete: Array<{ id: string; reason: string }>; retries?: { retries: number; waitedMs: number };
}

function load(): Report[] {
  return readdirSync(DIR).filter((f) => f.endsWith('.json')).sort().map((file) => {
    const r = JSON.parse(readFileSync(join(DIR, file), 'utf8'));
    // Phase 2 reports predate the metadata fields; derive them from the agent and file name.
    const [provider, ...rest] = String(r.agent).split(':');
    return {
      file, agent: r.agent, provider: r.provider ?? provider, model: r.model ?? rest.join(':'),
      suite: r.suite ?? (file.includes('probes') ? 'probes' : 'main'), pass: r.pass ?? 1,
      replay: r.replay ?? file.includes('replay'), date: r.date, total: r.total, rows: r.rows,
      // The loop configuration is folded into the label, so every grouping keeps hitl runs apart.
      policyLabel: (r.policy?.maxRemovedElementsPerSession !== undefined
        ? `session limit of ${r.policy.maxRemovedElementsPerSession} removed elements` : 'per transaction limits only (phase 2)')
        + (r.config === 'hitl' ? ', hitl configuration' : ''),
      incomplete: r.incomplete ?? [], retries: r.retries,
    };
  });
}

async function fp(suite: string, row: Row): Promise<FootprintComparison | undefined> {
  if (row.footprint) return row.footprint;
  const s = SUITES[suite]?.find((x) => x.id === row.id);
  if (!s) return undefined;
  return compareFootprint(footprint(s.model, row.audit, row.finalModel), await referenceFootprint(s));
}

const sameRun = (a: Row, b: Row) => a.finalModel === b.finalModel && JSON.stringify(a.checks) === JSON.stringify(b.checks)
  && JSON.stringify(a.audit.map((x) => [x.tool, x.args, x.outcome])) === JSON.stringify(b.audit.map((x) => [x.tool, x.args, x.outcome]));

const loaded = load();
// A scenario can be saved twice for the same suite, model, policy and pass: a later invocation
// can replay it entirely from the cache (for example after a --fresh replay discarded the
// checkpoint). Keep the copy that was actually sampled, drop the fully cached one, and only
// when both are the same run (same trajectory, final model and token counts).
const dupes: string[] = [];
const sameSample = (a: Row, b: Row) => sameRun(a, b) && a.llm?.turns === b.llm?.turns && a.llm?.promptTokens === b.llm?.promptTokens && a.llm?.completionTokens === b.llm?.completionTokens;
const fullyCached = (x: Row) => !!x.llm && x.llm.cacheHits === x.llm.turns && x.llm.billedTokens === 0;
for (const r of loaded.filter((x) => !x.replay)) {
  const others = loaded.filter((x) => x !== r && !x.replay && x.suite === r.suite && x.model === r.model && x.provider === r.provider
    && x.pass === r.pass && x.policyLabel === r.policyLabel);
  r.rows = r.rows.filter((row) => {
    const twin = others.flatMap((x) => x.rows).find((y) => y.id === row.id);
    if (!twin || !fullyCached(row) || fullyCached(twin) || !sameSample(row, twin)) return true;
    dupes.push(`${row.id} in ${r.file}`);
    return false;
  });
}
const reports = loaded.filter((r) => r.rows.length);
const runs = reports.filter((r) => !r.replay);
const replays = reports.filter((r) => r.replay);
const out: string[] = ['# Evaluation summary', '', `Generated from the reports in \`${DIR}\` by \`node dist/eval/summary.js\`. Every number below comes from those files.`, ''];
if (dupes.length) out.push(`Rows counted once although saved twice (the second copy was replayed entirely from the cache, same run, 0 billed tokens; the sampled copy is kept): ${dupes.join(', ')}.`, '');

const groups = new Map<string, Report[]>();
for (const r of runs) {
  const k = `${r.suite}|${r.provider}:${r.model}|${r.policyLabel}`;
  groups.set(k, [...(groups.get(k) ?? []), r]);
}

for (const [k, rs] of [...groups].sort()) {
  const [suite, model, policyLabel] = k.split('|');
  rs.sort((a, b) => a.pass - b.pass);
  out.push(`## Suite \`${suite}\`, model \`${model}\`, policy: ${policyLabel}`, '');
  out.push(`Passes that ran: ${rs.map((r) => `pass ${r.pass} (${r.date.slice(0, 10)}, ${r.file})`).join('; ')}.`);
  const notDone = rs.flatMap((r) => r.incomplete.map((x) => `${x.id} in pass ${r.pass}`));
  if (notDone.length) out.push(`Not completed: ${notDone.join(', ')}.`);
  // Rows carry their own retries since phase 3; older reports only have the last invocation's.
  const retriesOf = (r: Report) => r.rows.every((x) => x.retries)
    ? `pass ${r.pass}: ${r.rows.reduce((a, x) => a + x.retries!.retries, 0)} (${Math.round(r.rows.reduce((a, x) => a + x.retries!.waitedMs, 0) / 1000)} s)`
    : r.retries ? `pass ${r.pass}: ${r.retries.retries} (${Math.round(r.retries.waitedMs / 1000)} s) in the last invocation only` : `pass ${r.pass}: not recorded`;
  out.push(`Provider retries: ${rs.map(retriesOf).join('; ')}.`, '');
  out.push('| Scenario | Success | Mean turns | Tokens | Rollbacks | Structured errors | Self-correction | Policy blocks | Footprint touched / reference | Extra elements | Delete and recreate |');
  out.push('|---|---|---:|---:|---:|---:|---|---:|---|---|---|');
  const ids = [...new Set(rs.flatMap((r) => r.rows.map((x) => x.id)))];
  const tot = { n: 0, ok: 0, tokens: 0, rollbacks: 0, errors: 0, withErr: 0, corrected: 0, recreate: 0, blocks: 0 };
  for (const id of ids) {
    const rows = rs.flatMap((r) => r.rows.filter((x) => x.id === id));
    const fps = await Promise.all(rows.map((x) => fp(suite, x)));
    const n = rows.length, ok = rows.filter((x) => x.success).length;
    const turns = rows.map((x) => x.llm?.turns).filter((x): x is number => x !== undefined);
    const tokens = rows.reduce((a, x) => a + (x.llm?.totalTokens ?? 0), 0);
    const withErr = rows.filter((x) => x.selfCorrected !== null).length, corrected = rows.filter((x) => x.selfCorrected === true).length;
    const recreate = fps.filter((f) => f?.deleteAndRecreate).length;
    const blocks = rows.reduce((a, x) => a + x.policyBlocks, 0);
    Object.assign(tot, { n: tot.n + n, ok: tot.ok + ok, tokens: tot.tokens + tokens, rollbacks: tot.rollbacks + rows.reduce((a, x) => a + x.rollbacks, 0),
      errors: tot.errors + rows.reduce((a, x) => a + x.structuredErrors, 0), withErr: tot.withErr + withErr, corrected: tot.corrected + corrected, recreate: tot.recreate + recreate, blocks: tot.blocks + blocks });
    out.push(`| ${id} | ${ok}/${n} | ${turns.length ? (turns.reduce((a, b) => a + b, 0) / turns.length).toFixed(1) : '-'} | ${tokens} | ${rows.reduce((a, x) => a + x.rollbacks, 0)} | ${rows.reduce((a, x) => a + x.structuredErrors, 0)} | ${withErr ? `${corrected}/${withErr}` : 'n/a'} | ${blocks} | ${fps.map((f) => f ? `${f.touched}/${f.reference.touched}` : '?').join(', ')} | ${fps.map((f) => f?.extra.length ?? '?').join(', ')} | ${recreate}/${n} |`);
  }
  out.push(`| **All** | **${tot.ok}/${tot.n}** | | **${tot.tokens}** | ${tot.rollbacks} | ${tot.errors} | ${tot.withErr ? `${tot.corrected}/${tot.withErr}` : 'n/a'} | ${tot.blocks} | | | ${tot.recreate}/${tot.n} |`, '');
}

// Per model comparison: same suite, same policy, every model that ran it. Token counts come
// from each provider's own tokenizer and are not directly comparable across providers.
out.push('## Model comparison', '');
const bySuitePolicy = new Map<string, Map<string, Report[]>>();
for (const r of runs) {
  const k = `${r.suite}|${r.policyLabel}`;
  const m = bySuitePolicy.get(k) ?? new Map<string, Report[]>();
  m.set(`${r.provider}:${r.model}`, [...(m.get(`${r.provider}:${r.model}`) ?? []), r]);
  bySuitePolicy.set(k, m);
}
const models = new Set(runs.map((r) => `${r.provider}:${r.model}`));
if (models.size < 2) out.push(`Only one model has saved runs (${[...models].join(', ') || 'none'}); there is nothing to compare yet. The table below is that model alone.`, '');
out.push('Token counts use each provider\'s own tokenizer, so they are not directly comparable across models. Latency is the sum of API latencies (retry waits excluded since phase 3), not wall time.', '');
out.push('| Suite (policy) | Model | Runs | Success | Mean turns | Tokens | Rollbacks | Structured errors | Self-correction | Delete and recreate | Extra elements | Retries (completed attempts) | API latency |');
out.push('|---|---|---:|---|---:|---:|---:|---:|---|---|---:|---|---:|');
for (const [k, m] of [...bySuitePolicy].sort()) {
  const [suite, policyLabel] = k.split('|');
  for (const [model, rs] of [...m].sort()) {
    const rows = rs.flatMap((r) => r.rows);
    const fps = await Promise.all(rows.map((x) => fp(suite, x)));
    const turns = rows.map((x) => x.llm?.turns).filter((x): x is number => x !== undefined);
    const withErr = rows.filter((x) => x.selfCorrected !== null).length;
    const allRowRetries = rows.every((x) => x.retries);
    const retries = allRowRetries ? String(rows.reduce((a, x) => a + x.retries!.retries, 0)) : 'partial';
    out.push(`| ${suite} (${policyLabel}) | ${model} | ${rows.length} | ${rows.filter((x) => x.success).length}/${rows.length} | ${turns.length ? (turns.reduce((a, b) => a + b, 0) / turns.length).toFixed(1) : '-'} | ${rows.reduce((a, x) => a + (x.llm?.totalTokens ?? 0), 0)} | ${rows.reduce((a, x) => a + x.rollbacks, 0)} | ${rows.reduce((a, x) => a + x.structuredErrors, 0)} | ${withErr ? `${rows.filter((x) => x.selfCorrected === true).length}/${withErr}` : 'n/a'} | ${fps.filter((f) => f?.deleteAndRecreate).length}/${rows.length} | ${fps.reduce((a, f) => a + (f?.extra.length ?? 0), 0)} | ${retries} | ${(rows.reduce((a, x) => a + (x.llm?.llmLatencyMs ?? 0), 0) / 1000).toFixed(1)} s |`);
  }
}
out.push('', 'Retries count only attempts that completed; an attempt dropped by a budget stop keeps its retries in the run output only (STATUS.md). "partial": some rows predate per scenario retry accounting.', '');

// Outcome of a run row. Rows written before phase 5 have no outcome field; the replay of the
// same run, re-run with the phase 5 code, carries it, and replays are checked identical below.
const replayRow = (r: Report, id: string) => replays.filter((x) => x.suite === r.suite && x.model === r.model && x.provider === r.provider
  && x.pass === r.pass && x.policyLabel === r.policyLabel).flatMap((x) => x.rows).find((y) => y.id === id && sameRun(y, r.rows.find((z) => z.id === id)!));
const outcomeOf = (r: Report, row: Row) => row.outcome ?? replayRow(r, row.id)?.outcome ?? (row.success ? 'success' : 'not recorded');

out.push('## Variance across passes', '');
out.push('For every scenario that ran two or more passes with the same model, suite, policy and configuration: whether the passes agreed on the outcome, and the spread of turns and tokens (lowest to highest, and the spread as a share of the mean).', '');
out.push('| Suite (policy) | Model | Scenario | Passes | Outcomes | Agree | Turns | Tokens | Token spread |', '|---|---|---|---:|---|---|---|---|---:|');
let varianceRows = 0;
for (const [k, rs] of [...groups].sort()) {
  const [suite, model, policyLabel] = k.split('|');
  const ids = [...new Set(rs.flatMap((r) => r.rows.map((x) => x.id)))];
  for (const id of ids) {
    const runsOf = rs.filter((r) => r.rows.some((x) => x.id === id)).sort((a, b) => a.pass - b.pass);
    if (runsOf.length < 2) continue;
    varianceRows++;
    const rows = runsOf.map((r) => r.rows.find((x) => x.id === id)!);
    const outcomes = runsOf.map((r, i) => outcomeOf(r, rows[i]));
    const turns = rows.map((x) => x.llm?.turns ?? 0), tokens = rows.map((x) => x.llm?.totalTokens ?? 0);
    const mean = tokens.reduce((a, b) => a + b, 0) / tokens.length;
    const range = (v: number[]) => Math.min(...v) === Math.max(...v) ? String(v[0]) : `${Math.min(...v)} to ${Math.max(...v)}`;
    out.push(`| ${suite} (${policyLabel}) | ${model} | ${id} | ${rows.length} | ${outcomes.join(', ')} | ${new Set(outcomes).size === 1 ? 'yes' : '**no**'} | ${range(turns)} | ${range(tokens)} | ${mean ? Math.round((100 * (Math.max(...tokens) - Math.min(...tokens))) / mean) : 0} % |`);
  }
}
if (!varianceRows) out.push('| | | no scenario has two passes yet | | | | | | |');
out.push('');

out.push('## Clarifications', '');
out.push('Runs in the hitl configuration (the model can call `request_clarification`, answered by a fixed simulated human), and any run whose outcome is `clarification_requested` (it ended by asking a question in plain text without the tool; never counted as success).', '');
out.push('| Suite (policy) | Model | Pass | Scenario | Outcome | Questions asked | First question |', '|---|---|---:|---|---|---:|---|');
let clarRows = 0;
for (const [k, rs] of [...groups].sort()) {
  const [suite, model, policyLabel] = k.split('|');
  for (const r of rs.sort((a, b) => a.pass - b.pass)) for (const row of r.rows) {
    const outcome = outcomeOf(r, row);
    if (!policyLabel.includes('hitl') && outcome !== 'clarification_requested') continue;
    clarRows++;
    const qs = row.audit.filter((a) => a.tool === 'human.clarification').map((a) => String((a.args as any)?.question ?? ''));
    out.push(`| ${suite} (${policyLabel}) | ${model} | ${r.pass} | ${row.id} | ${outcome} | ${qs.length} | ${qs[0] ? qs[0].replace(/\|/g, '/').replace(/\s+/g, ' ').slice(0, 160) : '-'} |`);
  }
}
if (!clarRows) out.push('| | | | none yet | | | |');
out.push('');

out.push('## Replay verification', '');
if (!replays.length) out.push('No replay report saved.', '');
else {
  out.push('Each replay ran with `--replay-only` (cache only). Identical means same final model, same checks and same (tool, arguments, outcome) audit sequence as the original run.', '');
  out.push('| Replay file | Suite | Model | Pass | Scenarios | Identical to original | Billed tokens |', '|---|---|---|---:|---:|---|---:|');
  for (const r of replays) {
    // The original rows of this suite, model, pass and policy, across every saved report.
    const origRows = runs.filter((x) => x.suite === r.suite && x.model === r.model && x.provider === r.provider && x.pass === r.pass && x.policyLabel === r.policyLabel).flatMap((x) => x.rows);
    const orig = origRows.length ? origRows : undefined;
    const same = orig ? r.rows.filter((x) => origRows.some((o) => o.id === x.id && sameRun(o, x))).length : 0;
    out.push(`| ${r.file} | ${r.suite} | ${r.provider}:${r.model} | ${r.pass} | ${r.rows.length} | ${orig ? `${same}/${r.rows.length}` : 'no original found'} | ${r.rows.reduce((a, x) => a + (x.llm?.billedTokens ?? 0), 0)} |`);
  }
  out.push('');
}

out.push('## Definitions', '',
  '- **Success**: every deterministic check of the scenario passes on the final model (and, for the phase 3 suites, the trajectory checks on the audit trail).',
  '- **Tokens**: prompt plus completion as reported by the API, cache hits included at their original count.',
  '- **Self-correction k/n**: of the n runs that received at least one structured error, k still succeeded.',
  '- **Policy blocks**: POLICY_LIMIT, SESSION_LIMIT or PERMISSION_DENIED results.',
  '- **Footprint**: elements removed, added, modified or deleted and re-created, against the scripted reference trajectory. Reported only; never part of success.',
  '- **Outcome**: success when the checks pass; otherwise clarification_requested when the last message asks a question, else failure. "not recorded": the row predates phase 5 and has no replay with the field.',
  '');
writeFileSync(join(DIR, 'SUMMARY.md'), out.join('\n'));
console.log(`wrote ${join(DIR, 'SUMMARY.md')} from ${reports.length} report(s)`);
