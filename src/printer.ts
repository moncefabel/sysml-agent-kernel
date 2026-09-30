import type { Element } from './ast.js';

/** Canonical pretty printer. parse(print(ast)) is structurally equal to ast (modulo spans). */
export function print(root: Element): string {
  const lines: string[] = [];
  const children = root.name === '$root' ? root.children : [root];
  for (const c of children) emit(c, 0, lines);
  return lines.join('\n') + '\n';
}

export function printElement(e: Element): string {
  const lines: string[] = []; emit(e, 0, lines); return lines.join('\n');
}

function head(e: Element): string {
  const kw: Record<string, string> = {
    partDef: 'part def', part: 'part', portDef: 'port def', port: 'port',
    attributeDef: 'attribute def', attribute: 'attribute',
    requirementDef: 'requirement def', requirement: 'requirement', package: 'package',
  };
  let s = `${kw[e.kind]} ${e.name}`;
  if (e.specializes) s += ` :> ${e.specializes}`;
  if (e.type) s += ` : ${e.conjugated ? '~' : ''}${e.type}`;
  if (e.multiplicity !== undefined) s += `[${e.multiplicity}]`;
  if (e.value !== undefined) s += ` = ${e.value}`;
  return s;
}

function emit(e: Element, depth: number, out: string[]) {
  const pad = '    '.repeat(depth);
  switch (e.kind) {
    case 'doc': out.push(`${pad}doc /* ${e.text} */`); return;
    case 'import': out.push(`${pad}import ${e.text};`); return;
    case 'connect': out.push(`${pad}connect ${e.from} to ${e.to};`); return;
    case 'satisfy': out.push(`${pad}satisfy ${e.from} by ${e.to};`); return;
  }
  if (e.children.length === 0) { out.push(`${pad}${head(e)};`); return; }
  out.push(`${pad}${head(e)} {`);
  for (const c of e.children) emit(c, depth + 1, out);
  out.push(`${pad}}`);
}
