import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { probes, scenarios as mainSuite } from './scenarios.js';
import { injection, selfCorrection, type SuiteScenario } from './suites.js';
import { compareFootprint, footprint, type FootprintComparison } from './footprint.js';
import { referenceFootprint, type Row } from './harness.js';

/**
 * Builds eval/results/SUMMARY.md from the saved reports in eval/results. Every number comes
 * from those files; footprints missing from phase 2 reports are recomputed from their saved
 * audit trails and final models, which is deterministic.
 */
const DIR = process.argv[2] ?? 'eval/results';
const SUITES: Record<string, SuiteScenario[]> = { main: mainSuite, probes, selfcorrect: selfCorrection, injection };

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
      policyLabel: r.policy?.maxRemovedElementsPerSession !== undefined
        ? `session limit of ${r.policy.maxRemovedElementsPerSession} removed elements` : 'per transaction limits only (phase 2)',
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

const reports = load();
const runs = reports.filter((r) => !r.replay);
const replays = reports.filter((r) => r.replay);
const out: string[] = ['# Evaluation summary', '', `Generated from the reports in \`${DIR}\` by \`node dist/eval/summary.js\`. Every number below comes from those files.`, ''];

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

out.push('## Replay verification', '');
if (!replays.length) out.push('No replay report saved.', '');
else {
  out.push('Each replay ran with `--replay-only` (cache only). Identical means same final model, same checks and same (tool, arguments, outcome) audit sequence as the original run.', '');
  out.push('| Replay file | Suite | Model | Pass | Scenarios | Identical to original | Billed tokens |', '|---|---|---|---:|---:|---|---:|');
  for (const r of replays) {
    const orig = runs.find((x) => x.suite === r.suite && x.model === r.model && x.provider === r.provider && x.pass === r.pass && x.policyLabel === r.policyLabel);
    const same = orig ? r.rows.filter((x) => { const o = orig.rows.find((y) => y.id === x.id); return o && sameRun(o, x); }).length : 0;
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
  '');
writeFileSync(join(DIR, 'SUMMARY.md'), out.join('\n'));
console.log(`wrote ${join(DIR, 'SUMMARY.md')} from ${reports.length} report(s)`);
