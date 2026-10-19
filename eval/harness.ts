import { Workspace } from '../src/workspace.js';
import { DEFAULT_POLICY, READ_TOOLS, schemas, ToolHost, type Policy } from '../src/tools.js';
import { scriptedAgent, type Agent, type AgentRun } from './agents.js';
import { compareFootprint, footprint, type Footprint, type FootprintComparison } from './footprint.js';
import { ProviderError } from './llm/provider.js';
import { endsWithQuestion } from './hitl.js';
import type { AnyCheck, SuiteScenario } from './suites.js';

/**
 * Deterministic success checks, evaluated on the final model. The phase 3 suites add value,
 * type and text checks, and two trajectory checks that read the audit trail.
 */
export function check(ws: Workspace, c: AnyCheck, audit: Array<Record<string, unknown>> = []): { ok: boolean; detail: string } {
  const idx = ws.index();
  switch (c.type) {
    case 'value_equals': { const v = idx.get(c.path)?.value; return { ok: v === c.value, detail: `${c.path} = ${v ?? '<missing>'}` }; }
    case 'type_equals': {
      const e = idx.byPath.get(c.path);
      const t = e?.el.type ? idx.resolveName(e.el.type, e.parent ?? '')?.path : undefined;
      return { ok: t === c.typePath, detail: `${c.path} : ${t ?? e?.el.type ?? '<missing>'}` };
    }
    case 'text_includes': return { ok: ws.text().includes(c.pattern), detail: c.pattern };
    case 'not_called': { const n = audit.filter((a) => a.tool === c.tool).length; return { ok: n === 0, detail: `${c.tool} called ${n} time(s)` }; }
    case 'no_unknown_tool': {
      const unknown = audit.filter((a) => typeof a.tool === 'string' && !(a.tool in schemas) && !a.tool.startsWith('human.')).map((a) => a.tool);
      return { ok: unknown.length === 0, detail: unknown.length ? `called ${unknown.join(', ')}` : 'none' };
    }
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
  /** Edit footprint against the reference trajectory; reported, never part of success. */
  footprint?: FootprintComparison;
  /** Provider retries during this scenario (set by the runner; absent in phase 2 reports). */
  retries?: { retries: number; waitedMs: number };
  /**
   * success when the checks pass; otherwise clarification_requested when the model ended with a
   * question in plain text, else failure. clarification_requested is never a success.
   */
  outcome?: 'success' | 'clarification_requested' | 'failure';
  /** Last message of the model, when the run ended on one. */
  finalText?: string;
  /** Questions asked through request_clarification (hitl configuration only). */
  clarifications?: number;
  /** For scenarios with a concurrent edit: whether it actually fired during the run. */
  perturbed?: boolean;
  llm?: AgentRun['llm'];
  checks: Array<{ check: string; ok: boolean; detail: string }>;
  crash?: string;
  /** The crash means no further scenario can run now (quota, auth, configuration). */
  fatal?: boolean;
  audit: Array<Record<string, unknown>>;
  finalModel: string;
}

/**
 * Runs an agent on a scenario. For scenarios with a perturbation, the colleague's edit is
 * committed right after the agent's first read tool call, through the kernel like any edit,
 * and recorded in the audit trail as 'human.edit'.
 */
async function execute(s: SuiteScenario, agent: Agent, policy: Policy) {
  const host = new ToolHost(new Workspace(s.model), policy);
  let perturbed = false;
  if (s.perturb) {
    const call = host.call.bind(host);
    host.call = (name: string, args: unknown) => {
      const result = call(name, args);
      if (!perturbed && READ_TOOLS.has(name as any)) {
        perturbed = true;
        const tx = host.ws.transact(s.perturb!.ops);
        host.auditTrail.push({ ts: new Date().toISOString(), tool: 'human.edit', args: { ops: s.perturb!.ops, note: s.perturb!.note }, version: host.ws.version, outcome: tx.status });
      }
      return result;
    };
  }
  let run: AgentRun | undefined, crash: string | undefined, fatal = false;
  try { run = await agent.run(s, host); } catch (e) {
    crash = String(e);
    fatal = e instanceof ProviderError && (e.kind === 'rate_limit' || e.kind === 'auth' || e.kind === 'config');
  }
  return { host, run, crash, fatal, perturbed };
}

const referenceFootprints = new Map<string, Footprint>();

/** Footprint of the scripted reference trajectory, the minimal edit for the scenario. */
export async function referenceFootprint(s: SuiteScenario): Promise<Footprint> {
  const key = `${s.id}\n${s.model}`;
  if (!referenceFootprints.has(key)) {
    const { host } = await execute(s, scriptedAgent, DEFAULT_POLICY);
    referenceFootprints.set(key, footprint(s.model, host.auditTrail, host.ws.text()));
  }
  return referenceFootprints.get(key)!;
}

export async function runScenario(s: SuiteScenario, agent: Agent, policy: Policy = DEFAULT_POLICY): Promise<Row> {
  const t0 = Date.now();
  const { host, run, crash, fatal, perturbed } = await execute(s, agent, policy);
  const ms = Date.now() - t0;
  const results = crash ? [] : s.checks.map((c) => ({ check: c.type, ...check(host.ws, c, host.auditTrail) }));
  const outcomes = host.auditTrail.map((a) => a.outcome as string);
  const success = !crash && results.every((r) => r.ok);
  const structuredErrors = (run?.transcript ?? []).filter((t) => isStructuredError(t.result)).length;
  const finalModel = host.ws.text();
  return {
    id: s.id, category: s.category,
    success,
    toolCalls: run?.toolCalls ?? 0,
    committed: outcomes.filter((o) => o === 'committed').length - host.auditTrail.filter((a) => a.tool === 'human.edit' && a.outcome === 'committed').length,
    rejected: outcomes.filter((o) => o.startsWith('rejected')).length,
    policyBlocks: outcomes.filter((o) => o === 'error:POLICY_LIMIT' || o === 'error:SESSION_LIMIT' || o === 'error:PERMISSION_DENIED').length,
    ms,
    stopReason: run?.stopReason,
    structuredErrors,
    selfCorrected: structuredErrors > 0 ? success : null,
    rollbacks: countRollbacks(host.auditTrail),
    footprint: compareFootprint(footprint(s.model, host.auditTrail, finalModel), await referenceFootprint(s)),
    ...(s.perturb ? { perturbed } : {}),
    ...(run?.llm ? { outcome: success ? 'success' as const : endsWithQuestion(run.finalText) ? 'clarification_requested' as const : 'failure' as const } : {}),
    ...(run?.finalText ? { finalText: run.finalText } : {}),
    ...(run?.clarifications !== undefined ? { clarifications: run.clarifications } : {}),
    ...(run?.llm ? { llm: run.llm } : {}),
    checks: results, crash, ...(fatal ? { fatal } : {}), audit: host.auditTrail, finalModel,
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
