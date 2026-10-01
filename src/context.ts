import { DEFINITION_KINDS, type Element } from './ast.js';
import { printElement } from './printer.js';
import type { Index } from './semantic.js';

export interface OutlineNode { path: string; kind: string; type?: string; text?: string; children?: OutlineNode[]; more?: number; }

export function outline(idx: Index, rootPath: string, depth: number): OutlineNode[] {
  const base = rootPath ? idx.get(rootPath) : idx.root;
  if (!base) return [];
  const rec = (el: Element, d: number): OutlineNode[] =>
    el.children.filter((c) => c.name || c.kind === 'connect' || c.kind === 'satisfy').map((c) => {
      const path = idx.pathOf.get(c)!;
      if (!c.name) return { path, kind: c.kind, text: `${c.from} ${c.kind === 'connect' ? 'to' : 'by'} ${c.to}` };
      const n: OutlineNode = { path, kind: c.kind, ...(c.type ? { type: (c.conjugated ? '~' : '') + c.type } : {}) };
      const named = c.children.filter((x) => x.name);
      if (named.length) { if (d > 1) n.children = rec(c, d - 1); else n.more = named.length; }
      return n;
    });
  return rec(base, depth);
}

export interface Reference { path: string; via: string; text: string; }

const reverseCache = new WeakMap<Index, Map<string, Reference[]>>();

/** Reverse-reference index, built in one pass over the model and cached per Index. */
export function reverseReferences(idx: Index): Map<string, Reference[]> {
  const cached = reverseCache.get(idx);
  if (cached) return cached;
  const map = new Map<string, Reference[]>();
  const add = (target: string, r: Reference) => {
    const list = map.get(target) ?? [];
    if (!list.some((x) => x.path === r.path && x.via === r.via)) list.push(r);
    map.set(target, list);
  };
  const visit = (ns: Element) => {
    for (const el of ns.children) {
      const parent = idx.parentOf.get(el)!;
      const path = idx.pathOf.get(el)!;
      let text: string | undefined;
      const check = (via: string, ref: string | undefined, feature: boolean) => {
        if (!ref) return;
        const segs = ref.split('.');
        for (let k = 1; k <= segs.length; k++) {
          const pre = segs.slice(0, k).join('.');
          const hit = feature ? idx.resolveFeaturePath(pre, parent) : idx.resolveName(pre, parent);
          if (hit) add(hit.path, { path, via, text: (text ??= printElement(el).split('\n')[0]) });
        }
      };
      check('type', el.type, false);
      check('specializes', el.specializes, false);
      if (el.kind === 'connect') { check('connect', el.from, true); check('connect', el.to, true); }
      if (el.kind === 'satisfy') { check('satisfy.requirement', el.from, false); check('satisfy.subject', el.to, true); }
      if (el.name) visit(el);
    }
  };
  visit(idx.root);
  reverseCache.set(idx, map);
  return map;
}

/** Every element that references `target` through a type, specialization, connection or satisfy. */
export function findReferences(idx: Index, target: string): Reference[] {
  return reverseReferences(idx).get(target) ?? [];
}

/**
 * Builds a budgeted context window around an element: the element itself, then its type
 * definitions, then elements that reference it, breadth-first, until the character budget is
 * spent. Lets an agent work on a large model without loading all of it.
 */
export function contextSlice(idx: Index, focus: string, budgetChars: number) {
  const included: string[] = [];
  const chunks: string[] = [];
  let used = 0, truncated = false;
  const queue: string[] = [focus];
  const seen = new Set<string>();

  while (queue.length) {
    const p = queue.shift()!;
    if (seen.has(p)) continue;
    seen.add(p);
    const entry = idx.byPath.get(p);
    if (!entry) continue;
    const text = `// ${p}\n${printElement(entry.el)}`;
    if (used + text.length > budgetChars) { truncated = true; continue; }
    used += text.length; included.push(p); chunks.push(text);

    // 1) definitions this element depends on
    const deps: string[] = [];
    const scan = (el: Element, parent: string) => {
      for (const ref of [el.type, el.specializes]) {
        if (!ref) continue;
        const t = idx.resolveName(ref, parent);
        if (t) deps.push(t.path);
      }
      if (el.name) for (const c of el.children) scan(c, idx.pathOf.get(el)!);
    };
    scan(entry.el, entry.parent ?? '');
    // 2) owner, so the agent knows where the element lives
    if (entry.parent && !DEFINITION_KINDS.has(entry.el.kind)) deps.push(entry.parent);
    // 3) elements that reference this one
    const refs = findReferences(idx, p).map((r) => r.path.split('#')[0]).filter(Boolean);
    if (!entry.el.name) continue;
    queue.push(...deps, ...refs);
  }
  return { focus, included, truncated, usedChars: used, budgetChars, text: chunks.join('\n\n') };
}
