import type { Element, Kind } from './ast.js';
import { lex, SyntaxError, type Token } from './lexer.js';

export { SyntaxError };

/** Parses a SysML v2 subset. Returns a synthetic root namespace holding top-level members. */
export function parse(src: string): Element {
  const p = new Parser(lex(src));
  const children = p.members(true);
  return { kind: 'package', name: '$root', children };
}

/** Parses a fragment of members (used by edit operations that insert snippets). */
export function parseMembers(src: string): Element[] {
  return parse(src).children;
}

class Parser {
  private i = 0;
  constructor(private toks: Token[]) {}

  private peek(o = 0): Token { return this.toks[Math.min(this.i + o, this.toks.length - 1)]; }
  private next(): Token { return this.toks[this.i++]; }
  private is(v: string, o = 0) { const t = this.peek(o); return (t.kind === 'sym' || t.kind === 'ident') && t.value === v; }
  private expect(v: string): Token {
    const t = this.next();
    if (t.value !== v) throw new SyntaxError(`Expected '${v}' but found '${t.value || 'end of input'}'`, t.span);
    return t;
  }
  private ident(): string {
    const t = this.next();
    if (t.kind !== 'ident') throw new SyntaxError(`Expected a name but found '${t.value || 'end of input'}'`, t.span);
    return t.value;
  }
  private qname(): string {
    let s = this.ident();
    while (this.is('::') && this.peek(1).kind === 'ident') { this.next(); s += '::' + this.ident(); }
    return s;
  }
  private path(): string {
    let s = this.ident();
    while ((this.is('.') || this.is('::')) && this.peek(1).kind === 'ident') { s += this.next().value + this.ident(); }
    return s;
  }

  members(top: boolean): Element[] {
    const out: Element[] = [];
    while (true) {
      const t = this.peek();
      if (t.kind === 'eof') { if (!top) throw new SyntaxError("Expected '}'", t.span); return out; }
      if (this.is('}')) { if (top) throw new SyntaxError("Unexpected '}'", t.span); return out; }
      out.push(this.member());
    }
  }

  private body(e: Element): Element {
    if (this.is(';')) { this.next(); return e; }
    this.expect('{');
    e.children = this.members(false);
    this.expect('}');
    return e;
  }

  private mult(e: Element) {
    if (!this.is('[')) return;
    this.next();
    let s = '';
    while (!this.is(']')) { const t = this.next(); if (t.kind === 'eof') throw new SyntaxError("Expected ']'", t.span); s += t.value; }
    this.next();
    e.multiplicity = s;
  }

  private member(): Element {
    const t = this.peek();
    const span = t.span;
    const mk = (kind: Kind, extra: Partial<Element> = {}): Element => ({ kind, children: [], span, ...extra });

    if (t.kind === 'doc') { this.next(); return mk('doc', { text: t.value }); }
    if (t.kind !== 'ident') throw new SyntaxError(`Unexpected '${t.value}'`, span);

    switch (t.value) {
      case 'doc': {
        this.next();
        const d = this.next();
        if (d.kind !== 'doc') throw new SyntaxError('Expected /* comment */ after doc', d.span);
        return mk('doc', { text: d.value });
      }
      case 'package': {
        this.next();
        return this.body(mk('package', { name: this.ident() }));
      }
      case 'import': {
        this.next();
        let target = this.qname();
        if (this.is('::') && this.peek(1).value === '*') { this.next(); this.next(); target += '::*'; }
        this.expect(';');
        return mk('import', { text: target });
      }
      case 'part': case 'port': case 'attribute': case 'requirement': {
        this.next();
        const isDef = this.is('def');
        if (isDef) this.next();
        const kind = (t.value + (isDef ? 'Def' : '')) as Kind;
        const e = mk(kind, { name: this.ident() });
        if (isDef) {
          if (this.is(':>')) { this.next(); e.specializes = this.qname(); }
          return this.body(e);
        }
        if (this.is(':')) {
          this.next();
          if (this.is('~')) { this.next(); e.conjugated = true; }
          e.type = this.qname();
        }
        this.mult(e);
        if (this.is('=')) {
          this.next();
          const parts: string[] = [];
          while (!this.is(';') && !this.is('{')) {
            const v = this.next();
            if (v.kind === 'eof') throw new SyntaxError("Expected ';'", v.span);
            parts.push(v.value);
          }
          e.value = parts.join(' ').replace(/ \. /g, '.').replace(/- (\d)/g, '-$1');
        }
        return this.body(e);
      }
      case 'connect': {
        this.next();
        const from = this.path(); this.expect('to'); const to = this.path(); this.expect(';');
        return mk('connect', { from, to });
      }
      case 'satisfy': {
        this.next();
        const from = this.qname(); this.expect('by'); const to = this.path(); this.expect(';');
        return mk('satisfy', { from, to });
      }
      default:
        throw new SyntaxError(`Unknown keyword '${t.value}'`, span);
    }
  }
}
