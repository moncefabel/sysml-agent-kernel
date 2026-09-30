import { BUILTIN_TYPES, DEFINITION_KINDS, type Element, type Kind, type Span } from './ast.js';

export type Severity = 'error' | 'warning';

/** Structured diagnostic, designed to be consumed by an agent as much as by a human. */
export interface Diagnostic {
  code: string;
  severity: Severity;
  message: string;
  /** Qualified path of the element the diagnostic is attached to. */
  path: string;
  span?: Span;
  /** Machine-usable repair hint (e.g. closest valid names). */
  hint?: string;
}

export interface Entry { el: Element; path: string; parent?: string; }

/** Symbol index over the model: qualified path -> element. */
export class Index {
  readonly byPath = new Map<string, Entry>();
  readonly parentOf = new Map<Element, string>();
  readonly pathOf = new Map<Element, string>();
  readonly duplicates: Diagnostic[] = [];

  constructor(readonly root: Element) { this.walk(root, ''); }

  private walk(ns: Element, prefix: string) {
    let anon = 0;
    for (const c of ns.children) {
      this.parentOf.set(c, prefix);
      let p: string;
      if (c.name) {
        p = prefix ? `${prefix}::${c.name}` : c.name;
        if (this.byPath.has(p)) {
          this.duplicates.push({ code: 'E102', severity: 'error', message: `Duplicate name '${c.name}' in namespace '${prefix || '<root>'}'`, path: p, span: c.span, hint: 'Rename or remove one of the duplicate elements.' });
        } else this.byPath.set(p, { el: c, path: p, parent: prefix || undefined });
      } else {
        p = `${prefix || '<root>'}#${c.kind}[${anon++}]`;
        // Unnamed elements (connect, satisfy, doc, import) stay addressable for edit operations.
        this.byPath.set(p, { el: c, path: p, parent: prefix || undefined });
      }
      this.pathOf.set(c, p);
      if (c.name) this.walk(c, p);
    }
  }

  get(path: string): Element | undefined { return this.byPath.get(path)?.el; }

  ancestors(path: string): string[] {
    const segs = path ? path.split('::') : [];
    const out: string[] = [];
    for (let k = segs.length; k >= 0; k--) out.push(segs.slice(0, k).join('::'));
    return out;
  }

  /** Resolves a (possibly qualified) name as seen from namespace `from`. */
  resolveName(ref: string, from: string): Entry | undefined {
    for (const ns of this.ancestors(from)) {
      const direct = this.byPath.get(ns ? `${ns}::${ref}` : ref);
      if (direct) return direct;
      const nsEl = ns ? this.get(ns) : this.root;
      for (const imp of nsEl?.children.filter((c) => c.kind === 'import') ?? []) {
        const t = imp.text!;
        if (t.endsWith('::*')) {
          const hit = this.byPath.get(`${t.slice(0, -3)}::${ref}`);
          if (hit) return hit;
        } else if (t.split('::').pop() === ref.split('::')[0]) {
          const hit = this.byPath.get(t + ref.slice(ref.split('::')[0].length));
          if (hit) return hit;
        }
      }
    }
    return undefined;
  }

  /** Features of a definition, including inherited ones through :> specialization. */
  members(defPath: string, seen = new Set<string>()): Entry[] {
    if (seen.has(defPath)) return [];
    seen.add(defPath);
    const def = this.get(defPath);
    if (!def) return [];
    const own = def.children.filter((c) => c.name).map((c) => this.byPath.get(`${defPath}::${c.name}`)!).filter(Boolean);
    if (def.specializes) {
      const sup = this.resolveName(def.specializes, this.byPath.get(defPath)?.parent ?? '');
      if (sup) for (const m of this.members(sup.path, seen)) if (!own.some((o) => o.el.name === m.el.name)) own.push(m);
    }
    return own;
  }

  typeOf(entry: Entry): Entry | undefined {
    if (!entry.el.type) return undefined;
    return this.resolveName(entry.el.type, entry.parent ?? '');
  }

  /** Resolves a feature chain like `tank.fuelOut` relative to a context namespace. */
  resolveFeaturePath(ref: string, ctx: string): Entry | undefined {
    const segs = ref.split('.');
    let cur: Entry | undefined =
      this.members(ctx).find((m) => m.el.name === segs[0]) ?? this.resolveName(segs[0], ctx);
    for (const s of segs.slice(1)) {
      if (!cur) return undefined;
      const scope = DEFINITION_KINDS.has(cur.el.kind) ? cur : this.typeOf(cur);
      if (!scope) return undefined;
      cur = this.members(scope.path).find((m) => m.el.name === s);
    }
    return cur;
  }

  namedPaths(): string[] { return [...this.byPath.keys()].filter((p) => !p.includes('#')); }
}

const EXPECTED_DEF: Partial<Record<Kind, Kind>> = {
  part: 'partDef', port: 'portDef', attribute: 'attributeDef', requirement: 'requirementDef',
};

function lev(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++)
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

export function suggest(name: string, candidates: string[], max = 3): string[] {
  const last = name.split(/::|\./).pop()!.toLowerCase();
  return candidates
    .map((c) => ({ c, d: lev(last, c.split('::').pop()!.toLowerCase()) }))
    .filter((x) => x.d <= Math.max(2, Math.floor(last.length / 3)))
    .sort((x, y) => x.d - y.d)
    .slice(0, max)
    .map((x) => x.c);
}

/** Runs all semantic rules. Deterministic and side-effect free. */
export function validate(root: Element): Diagnostic[] {
  const idx = new Index(root);
  const diags: Diagnostic[] = [...idx.duplicates];
  const all = idx.namedPaths();
  const satisfied = new Set<string>();

  const visit = (ns: Element) => {
    for (const el of ns.children) {
      const path = idx.pathOf.get(el)!;
      const parent = idx.parentOf.get(el)!;
      const at = (code: string, severity: Severity, message: string, hint?: string) =>
        diags.push({ code, severity, message, path, span: el.span, ...(hint ? { hint } : {}) });

      if (el.type) {
        const expected = EXPECTED_DEF[el.kind];
        const builtinOk = el.kind === 'attribute' && BUILTIN_TYPES.has(el.type);
        const t = builtinOk ? undefined : idx.resolveName(el.type, parent);
        if (!builtinOk && !t) {
          const cands = all.filter((p) => idx.get(p)!.kind === expected);
          const s = suggest(el.type, el.kind === 'attribute' ? [...cands, 'Real', 'Integer', 'Boolean', 'String'] : cands);
          at('E101', 'error', `Unresolved type '${el.type}' for ${el.kind} '${el.name}'`, s.length ? `Did you mean: ${s.join(', ')}?` : `No ${expected} with a similar name exists; define it first.`);
        } else if (t && expected && t.el.kind !== expected) {
          at('E107', 'error', `${el.kind} '${el.name}' is typed by ${t.el.kind} '${t.path}', expected a ${expected}`);
        }
        if (el.kind === 'attribute' && el.value !== undefined) {
          const ty = el.type.split('::').pop();
          const v = el.value.trim();
          const numeric = /^[-+0-9.\s*/()eE]+$/.test(v);
          const bad = (ty === 'Real' && !numeric) || ((ty === 'Integer' || ty === 'Natural') && !/^[-+]?\d+$/.test(v))
            || (ty === 'Boolean' && !/^(true|false)$/.test(v)) || (ty === 'String' && !/^".*"$/.test(v));
          if (bad) at('W203', 'warning', `Value '${v}' does not look like a ${ty}`);
        }
      }
      if (el.specializes) {
        const s = idx.resolveName(el.specializes, parent);
        if (!s) at('E101', 'error', `Unresolved specialization '${el.specializes}'`, (() => { const x = suggest(el.specializes!, all.filter((p) => idx.get(p)!.kind === el.kind)); return x.length ? `Did you mean: ${x.join(', ')}?` : undefined; })());
        else if (s.el.kind !== el.kind) at('E107', 'error', `${el.kind} '${el.name}' cannot specialize ${s.el.kind} '${s.path}'`);
      }
      if (el.kind === 'connect') {
        const ends = [el.from!, el.to!].map((r) => ({ r, e: idx.resolveFeaturePath(r, parent) }));
        let ok = true;
        for (const { r, e } of ends) {
          if (!e) {
            ok = false;
            const head = r.split('.').slice(0, -1).join('.');
            const scope = head ? idx.resolveFeaturePath(head, parent) : undefined;
            const scopeDef = scope ? (DEFINITION_KINDS.has(scope.el.kind) ? scope : idx.typeOf(scope)) : undefined;
            const cands = scopeDef ? idx.members(scopeDef.path).map((m) => m.el.name!) : idx.members(parent).map((m) => m.el.name!);
            const s = suggest(r, cands);
            at('E103', 'error', `Connection end '${r}' does not resolve`, s.length ? `Available features there: ${s.join(', ')}` : cands.length ? `Available features there: ${cands.join(', ')}` : undefined);
          } else if (e.el.kind !== 'port') {
            ok = false;
            at('E104', 'error', `Connection end '${r}' is a ${e.el.kind}, only ports can be connected`);
          }
        }
        if (ok) {
          const [a, b] = ends.map((x) => x.e!);
          const ta = idx.typeOf(a), tb = idx.typeOf(b);
          if (ta && tb && ta.path !== tb.path) at('E105', 'error', `Port types differ: '${el.from}' is ${ta.path}, '${el.to}' is ${tb.path}`);
          else if (!!a.el.conjugated === !!b.el.conjugated) at('W201', 'warning', `Both ends of '${el.from} to ${el.to}' have the same direction`, 'One end should be conjugated (~PortDef).');
        }
      }
      if (el.kind === 'satisfy') {
        const req = idx.resolveName(el.from!, parent);
        if (!req || req.el.kind !== 'requirement') {
          const s = suggest(el.from!, all.filter((p) => idx.get(p)!.kind === 'requirement'));
          at('E106', 'error', `'${el.from}' is not a requirement usage`, s.length ? `Did you mean: ${s.join(', ')}?` : undefined);
        } else satisfied.add(req.path);
        if (!idx.resolveFeaturePath(el.to!, parent)) at('E106', 'error', `Satisfying element '${el.to}' does not resolve`);
      }
      if (el.name) visit(el);
    }
  };
  visit(root);

  for (const p of all) {
    const e = idx.get(p)!;
    if (e.kind === 'requirement' && !satisfied.has(p))
      diags.push({ code: 'W202', severity: 'warning', message: `Requirement '${p}' is not satisfied by any element`, path: p, span: e.span, hint: `Add: satisfy ${e.name} by <part>;` });
  }
  return diags;
}
