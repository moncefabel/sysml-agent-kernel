import type { Element } from '../src/ast.js';
import { parse } from '../src/parser.js';
import { Index } from '../src/semantic.js';
import { Workspace, type EditOp } from '../src/workspace.js';

/**
 * Edit footprint: which elements a run removed, added or modified, computed by diffing the
 * initial and final models, plus the elements that were deleted and then re-created (invisible
 * in a plain diff). It is a reported metric only and never part of a success check.
 */
export interface Footprint {
  removed: string[];
  added: string[];
  modified: string[];
  /** Named elements removed by a committed transaction that exist again in the final model. */
  recreated: string[];
  /** removed + added + modified + recreated, as a set. */
  touched: number;
}

export interface FootprintComparison extends Footprint {
  reference: Footprint;
  /** Elements this run touched that the reference trajectory did not touch. */
  extra: string[];
  deleteAndRecreate: boolean;
}

/** Stable identity: the path for named elements, owner + content for unnamed ones. */
function elements(root: Element): Map<string, string> {
  const idx = new Index(root);
  const out = new Map<string, string>();
  for (const [path, { el, parent }] of idx.byPath) {
    const key = el.name ? path : `${parent ?? '<root>'}#${el.kind}(${el.from ?? ''}>${el.to ?? ''}|${el.text ?? ''})`;
    const { kind, type, specializes, conjugated, multiplicity, value, text, from, to } = el;
    out.set(key, JSON.stringify({ kind, type, specializes, conjugated, multiplicity, value, text, from, to }));
  }
  return out;
}

function namedSubtree(idx: Index, path: string): string[] {
  const e = idx.byPath.get(path);
  if (!e?.el.name) return [];
  return [...idx.byPath.keys()].filter((p) => (p === path || p.startsWith(path + '::')) && !p.includes('#'));
}

/**
 * Replays the committed transactions of an audit trail (agent edits and the harness's human
 * edits) on the initial model to find deleted then re-created elements, and diffs the result.
 */
export function footprint(initialModel: string, audit: Array<Record<string, unknown>>, finalModel: string): Footprint {
  const ws = new Workspace(initialModel);
  const removedNamed = new Set<string>();
  for (const a of audit) {
    const args = a.args as { ops?: EditOp[]; dryRun?: boolean } | undefined;
    if (a.outcome !== 'committed' || !args?.ops || args.dryRun) continue;
    if (a.tool !== 'sysml_apply_edits' && a.tool !== 'human.edit') continue;
    if (a.tool === 'sysml_apply_edits') {
      const idx = ws.index();
      for (const op of args.ops) if (op.op === 'remove') namedSubtree(idx, op.path).forEach((p) => removedNamed.add(p));
    }
    ws.transact(args.ops);
  }
  const before = elements(parse(initialModel));
  const after = elements(parse(finalModel));
  const removed = [...before.keys()].filter((k) => !after.has(k));
  const added = [...after.keys()].filter((k) => !before.has(k));
  const modified = [...after.keys()].filter((k) => before.has(k) && before.get(k) !== after.get(k));
  const recreated = [...removedNamed].filter((p) => after.has(p));
  const touched = new Set([...removed, ...added, ...modified, ...recreated]).size;
  return { removed, added, modified, recreated, touched };
}

export function compareFootprint(run: Footprint, reference: Footprint): FootprintComparison {
  const refSet = new Set([...reference.removed, ...reference.added, ...reference.modified, ...reference.recreated]);
  const mine = new Set([...run.removed, ...run.added, ...run.modified, ...run.recreated]);
  return { ...run, reference, extra: [...mine].filter((k) => !refSet.has(k)), deleteAndRecreate: run.recreated.length > 0 };
}
