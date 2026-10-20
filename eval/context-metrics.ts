import { parse } from '../src/parser.js';
import { Index } from '../src/semantic.js';
import { LLM_DEFAULTS } from './llm/loop.js';

export interface ContextRead {
  /** Named elements in the initial model. */
  elementsTotal: number;
  /** Named elements the model was shown at least once. */
  elementsRead: number;
  shareRead: number;
  /** Characters of the initial model as printed source. */
  modelChars: number;
}

const QUALIFIED = /[A-Za-z_]\w*(?:::[A-Za-z_]\w*)+/g;

/**
 * Which elements of the model the agent actually saw. An element counts as read when its
 * qualified path appears in a tool result as it was sent to the model (results are clipped
 * at the loop's maxToolResultChars), or when it lies inside an element whose full source was
 * returned unclipped (sysml_get, sysml_context_slice). Deterministic, computed after the run.
 */
export function contextRead(model: string, transcript: Array<{ tool: string; result: unknown }>, maxChars: number = LLM_DEFAULTS.maxToolResultChars): ContextRead {
  const idx = new Index(parse(model));
  const named = new Set(idx.namedPaths());
  const read = new Set<string>();
  const subtree = (p: string) => { for (const q of named) if (q === p || q.startsWith(p + '::')) read.add(q); };
  for (const t of transcript) {
    const full = JSON.stringify(t.result ?? null);
    const sent = full.slice(0, maxChars);
    for (const m of sent.match(QUALIFIED) ?? []) if (named.has(m)) read.add(m);
    if (full.length > maxChars) continue;
    const r = t.result as any;
    if (t.tool === 'sysml_get' && r?.path && named.has(r.path)) subtree(r.path);
    if (t.tool === 'sysml_context_slice') for (const p of r?.included ?? []) if (named.has(p)) subtree(p);
  }
  return { elementsTotal: named.size, elementsRead: read.size, shareRead: named.size ? read.size / named.size : 0, modelChars: model.length };
}
