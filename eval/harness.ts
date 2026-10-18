import { Workspace } from '../src/workspace.js';
import { DEFAULT_POLICY, ToolHost } from '../src/tools.js';
import type { Check, Scenario } from './scenarios.js';
import type { Agent, AgentRun } from './agents.js';

/** Deterministic success checks, evaluated on the final model only. */
export function check(ws: Workspace, c: Check): { ok: boolean; detail: string } {
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

/** A tool result the agent can learn from: a kernel rejection or any structured error. */
export function isStructuredError(result: unknown): boolean {
  const r = result as any;
  return Boolean(r?.error) || r?.status === 'rejected';
}

/**
 * A rollback is a transaction that was applied to a draft and then discarded. Version
 * conflicts are rejected before anything is applied, and dry runs never intend to commit,
 * so neither counts.
 */
export function countRollbacks(audit: Array<Record<string, unknown>>): number {
  return audit.filter((a) => a.tool === 'sysml_apply_edits'
    && String(a.outcome).startsWith('rejected:')
    && a.outcome !== 'rejected:version_conflict'
    && (a.args as any)?.dryRun !== true).length;
}

export interface Row {
  id: string; category: string; success: boolean;
  toolCalls: number; committed: number; rejected: number; policyBlocks: number; ms: number;
  stopReason?: string;
  structuredErrors: number;
  /** null when the run never hit a structured error, so there was nothing to correct. */
  selfCorrected: boolean | null;
  rollbacks: number;
  llm?: AgentRun['llm'];
  checks: Array<{ check: string; ok: boolean; detail: string }>;
  crash?: string;
  audit: Array<Record<string, unknown>>;
  finalModel: string;
}

export async function runScenario(s: Scenario, agent: Agent): Promise<Row> {
  const host = new ToolHost(new Workspace(s.model), DEFAULT_POLICY);
  const t0 = Date.now();
  let run: AgentRun | undefined, crash: string | undefined;
  try { run = await agent.run(s, host); } catch (e) { crash = String(e); }
  const results = crash ? [] : s.checks.map((c) => ({ check: c.type, ...check(host.ws, c) }));
  const outcomes = host.auditTrail.map((a) => a.outcome as string);
  const success = !crash && results.every((r) => r.ok);
  const structuredErrors = (run?.transcript ?? []).filter((t) => isStructuredError(t.result)).length;
  return {
    id: s.id, category: s.category,
    success,
    toolCalls: run?.toolCalls ?? 0,
    committed: outcomes.filter((o) => o === 'committed').length,
    rejected: outcomes.filter((o) => o.startsWith('rejected')).length,
    policyBlocks: outcomes.filter((o) => o === 'error:POLICY_LIMIT' || o === 'error:PERMISSION_DENIED').length,
    ms: Date.now() - t0,
    stopReason: run?.stopReason,
    structuredErrors,
    selfCorrected: structuredErrors > 0 ? success : null,
    rollbacks: countRollbacks(host.auditTrail),
    ...(run?.llm ? { llm: run.llm } : {}),
    checks: results, crash, audit: host.auditTrail, finalModel: host.ws.text(),
  };
}

export interface Summary {
  completed: number; passed: number;
  /** Scenarios that hit at least one structured error, and how many of those still succeeded. */
  withErrors: number; selfCorrected: number;
  rollbacks: number;
  meanTurns?: number;
  tokens?: { prompt: number; completion: number; total: number; billed: number };
  cacheHits?: number;
  llmLatencyMs?: number;
}

/** Aggregates over completed rows. Ratios are kept as counts so small samples stay visible. */
export function summarize(rows: Row[]): Summary {
  const llm = rows.map((r) => r.llm).filter((x) => x !== undefined);
  const sum = (f: (x: NonNullable<Row['llm']>) => number) => llm.reduce((a, x) => a + f(x), 0);
  return {
    completed: rows.length,
    passed: rows.filter((r) => r.success).length,
    withErrors: rows.filter((r) => r.selfCorrected !== null).length,
    selfCorrected: rows.filter((r) => r.selfCorrected === true).length,
    rollbacks: rows.reduce((a, r) => a + r.rollbacks, 0),
    ...(llm.length ? {
      meanTurns: sum((x) => x.turns) / llm.length,
      tokens: { prompt: sum((x) => x.promptTokens), completion: sum((x) => x.completionTokens), total: sum((x) => x.totalTokens), billed: sum((x) => x.billedTokens) },
      cacheHits: sum((x) => x.cacheHits),
      llmLatencyMs: sum((x) => x.llmLatencyMs),
    } : {}),
  };
}
