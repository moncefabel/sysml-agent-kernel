import type { Span } from './ast.js';

export type TokKind = 'ident' | 'number' | 'string' | 'doc' | 'sym' | 'eof';
export interface Token { kind: TokKind; value: string; span: Span; }

export class SyntaxError extends Error {
  constructor(message: string, public span: Span) { super(message); }
}

const SYMBOLS = ['::>', '::', ':>', '..', '~', '{', '}', ';', ':', '[', ']', '=', '.', ',', '*', '-', '+'];

export function lex(src: string): Token[] {
  const toks: Token[] = [];
  let i = 0, line = 1, col = 1;
  const adv = (n: number) => {
    for (let k = 0; k < n; k++) {
      if (src[i] === '\n') { line++; col = 1; } else { col++; }
      i++;
    }
  };
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { adv(1); continue; }
    if (src.startsWith('//', i)) { while (i < src.length && src[i] !== '\n') adv(1); continue; }
    const span = { line, col };
    if (src.startsWith('/*', i)) {
      const end = src.indexOf('*/', i + 2);
      if (end < 0) throw new SyntaxError('Unterminated comment', span);
      const body = src.slice(i + 2, end).trim();
      adv(end + 2 - i);
      toks.push({ kind: 'doc', value: body, span });
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i; while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++;
      toks.push({ kind: 'ident', value: src.slice(i, j), span }); adv(j - i); continue;
    }
    if (/[0-9]/.test(c)) {
      let j = i; while (j < src.length && /[0-9]/.test(src[j])) j++;
      if (src[j] === '.' && /[0-9]/.test(src[j + 1] ?? '')) { j++; while (j < src.length && /[0-9]/.test(src[j])) j++; }
      toks.push({ kind: 'number', value: src.slice(i, j), span }); adv(j - i); continue;
    }
    if (c === '"') {
      let j = i + 1; while (j < src.length && src[j] !== '"') j++;
      if (j >= src.length) throw new SyntaxError('Unterminated string', span);
      toks.push({ kind: 'string', value: src.slice(i, j + 1), span }); adv(j + 1 - i); continue;
    }
    const sym = SYMBOLS.find((s) => src.startsWith(s, i));
    if (!sym) throw new SyntaxError(`Unexpected character '${c}'`, span);
    toks.push({ kind: 'sym', value: sym, span }); adv(sym.length);
  }
  toks.push({ kind: 'eof', value: '', span: { line, col } });
  return toks;
}
