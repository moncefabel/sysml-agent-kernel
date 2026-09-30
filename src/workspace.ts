import { cloneElement, type Element } from './ast.js';
import { parse, parseMembers, SyntaxError } from './parser.js';
import { print } from './printer.js';
import { Index, suggest, validate, type Diagnostic } from './semantic.js';

/** Typed edit operations. The agent never writes raw text into the model file. */
export type EditOp =
  | { op: 'add'; parent: string; source: string }
  | { op: 'remove'; path: string }
  | { op: 'rename'; path: string; newName: string }
  | { op: 'set'; path: string; field: 'type' | 'value' | 'multiplicity'; value: string | null };

export interface EditError { code: string; opIndex: number; message: string; hint?: string; }

export type TxResult =
  | { status: 'committed' | 'dry_run_ok'; version: number; introducedWarnings: Diagnostic[]; resolvedDiagnostics: Diagnostic[]; remainingErrors: number }
  | { status: 'rejected'; version: number; reason: 'edit_error'; editError: EditError }
  | { status: 'rejected'; version: number; reason: 'introduces_errors'; introducedErrors: Diagnostic[] }
  | { status: 'rejected'; version: number; reason: 'version_conflict'; message: string };

const key = (d: Diagnostic) => `${d.code}|${d.path}|${d.message}`;

/**
 * Holds the authoritative model. Every change goes through `transact`, which applies typed
 * operations on a copy, re-validates, and commits only if no new error was introduced.
 */
export class Workspace {
  private ast: Element;
  private _version = 0;
  private history: string[] = [];

  constructor(source: string) { this.ast = parse(source); }

  get version() { return this._version; }
  get root(): Element { return this.ast; }
  text(): string { return print(this.ast); }
  diagnostics(): Diagnostic[] { return validate(this.ast); }
  index(): Index { return new Index(this.ast); }

  transact(ops: EditOp[], opts: { dryRun?: boolean; expectedVersion?: number } = {}): TxResult {
    if (opts.expectedVersion !== undefined && opts.expectedVersion !== this._version)
      return { status: 'rejected', version: this._version, reason: 'version_conflict', message: `Model is at version ${this._version}, edit was prepared against ${opts.expectedVersion}. Re-read and retry.` };

    const before = validate(this.ast);
    const draft = cloneElement(this.ast);
    for (let i = 0; i < ops.length; i++) {
      const err = applyOp(draft, ops[i], i);
      if (err) return { status: 'rejected', version: this._version, reason: 'edit_error', editError: err };
    }
    const after = validate(draft);
    const beforeKeys = new Set(before.map(key));
    const afterKeys = new Set(after.map(key));
    const introduced = after.filter((d) => !beforeKeys.has(key(d)));
    const introducedErrors = introduced.filter((d) => d.severity === 'error');
    if (introducedErrors.length)
      return { status: 'rejected', version: this._version, reason: 'introduces_errors', introducedErrors };

    const result = {
      introducedWarnings: introduced,
      resolvedDiagnostics: before.filter((d) => !afterKeys.has(key(d))),
      remainingErrors: after.filter((d) => d.severity === 'error').length,
    };
    if (opts.dryRun) return { status: 'dry_run_ok', version: this._version, ...result };

    this.history.push(print(this.ast));
    this.ast = parse(print(draft)); // round trip refreshes spans and guarantees printable output
    this._version++;
    return { status: 'committed', version: this._version, ...result };
  }

  undo(): boolean {
    const prev = this.history.pop();
    if (prev === undefined) return false;
    this.ast = parse(prev);
    this._version++;
    return true;
  }
}

function applyOp(root: Element, op: EditOp, opIndex: number): EditError | undefined {
  const idx = new Index(root);
  const notFound = (path: string): EditError => {
    const s = suggest(path, idx.namedPaths());
    return { code: 'EDIT_NOT_FOUND', opIndex, message: `No element at path '${path}'`, ...(s.length ? { hint: `Closest paths: ${s.join(', ')}` } : {}) };
  };

  switch (op.op) {
    case 'add': {
      const parent = op.parent === '' ? root : idx.get(op.parent);
      if (!parent) return notFound(op.parent);
      if (!parent.name || ['attribute', 'connect', 'satisfy', 'doc', 'import'].includes(parent.kind))
        return { code: 'EDIT_BAD_PARENT', opIndex, message: `Cannot add members to a ${parent.kind}` };
      try {
        parent.children.push(...parseMembers(op.source));
      } catch (e) {
        if (e instanceof SyntaxError) return { code: 'EDIT_SYNTAX', opIndex, message: `Syntax error in snippet at ${e.span.line}:${e.span.col}: ${e.message}` };
        throw e;
      }
      return;
    }
    case 'remove': {
      const el = idx.get(op.path);
      if (!el) return notFound(op.path);
      const parentPath = idx.parentOf.get(el)!;
      const parent = parentPath ? idx.get(parentPath)! : root;
      parent.children.splice(parent.children.indexOf(el), 1);
      return;
    }
    case 'set': {
      const el = idx.get(op.path);
      if (!el) return notFound(op.path);
      if (op.field === 'type' && !['part', 'port', 'attribute', 'requirement'].includes(el.kind))
        return { code: 'EDIT_BAD_FIELD', opIndex, message: `A ${el.kind} has no type` };
      if (op.field === 'value' && el.kind !== 'attribute')
        return { code: 'EDIT_BAD_FIELD', opIndex, message: 'Only attributes have a value' };
      if (op.value === null) delete el[op.field];
      else el[op.field] = op.value;
      return;
    }
    case 'rename': {
      const el = idx.get(op.path);
      if (!el) return notFound(op.path);
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(op.newName))
        return { code: 'EDIT_BAD_NAME', opIndex, message: `'${op.newName}' is not a valid name` };
      renameWithReferences(root, idx, op.path, op.newName);
      return;
    }
  }
}

/** Renames an element and rewrites every reference that resolves to it (prefix-wise). */
function renameWithReferences(root: Element, idx: Index, target: string, newName: string) {
  const oldName = target.split('::').pop()!;
  const rewrites: Array<() => void> = [];

  const rewrite = (el: Element, field: 'type' | 'specializes' | 'from' | 'to', resolve: (ref: string) => string | undefined) => {
    const ref = el[field];
    if (!ref) return;
    const parts = ref.split(/(::|\.)/); // keeps separators at odd indices
    const hits: number[] = [];
    for (let k = 0; k < parts.length; k += 2) {
      if (parts[k] !== oldName) continue;
      if (resolve(parts.slice(0, k + 1).join('')) === target) hits.push(k);
    }
    if (hits.length) rewrites.push(() => { for (const k of hits) parts[k] = newName; el[field] = parts.join(''); });
  };

  const walk = (ns: Element) => {
    for (const el of ns.children) {
      const parent = idx.parentOf.get(el)!;
      const byName = (r: string) => idx.resolveName(r, parent)?.path;
      const byFeature = (r: string) => idx.resolveFeaturePath(r, parent)?.path;
      rewrite(el, 'type', byName);
      rewrite(el, 'specializes', byName);
      if (el.kind === 'connect') { rewrite(el, 'from', byFeature); rewrite(el, 'to', byFeature); }
      if (el.kind === 'satisfy') { rewrite(el, 'from', byName); rewrite(el, 'to', byFeature); }
      if (el.name) walk(el);
    }
  };
  walk(root);
  rewrites.forEach((f) => f());
  idx.get(target)!.name = newName;
}
