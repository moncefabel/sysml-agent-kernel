import { parse } from '../dist/src/parser.js';
import { validate, Index } from '../dist/src/semantic.js';
import { Workspace } from '../dist/src/workspace.js';
import { contextSlice } from '../dist/src/context.js';
for (const N of [500, 2000]) {
  let s = 'package Big {\n port def P;\n';
  for (let i = 0; i < N; i++) s += ` part def D${i} { attribute m : Real = 1; port a : P; port b : ~P; ${i ? `part prev : D${i-1};` : ''} }\n`;
  s += '}\n';
  let t = performance.now(); const ast = parse(s); const tp = performance.now() - t;
  t = performance.now(); const d = validate(ast); const tv = performance.now() - t;
  const ws = new Workspace(s);
  t = performance.now(); ws.transact([{ op: 'add', parent: 'Big', source: 'part def X;' }]); const tt = performance.now() - t;
  t = performance.now(); const sl = contextSlice(new Index(ast), `Big::D${N-1}`, 4000); const ts = performance.now() - t;
  console.log(`N=${N} elements~${N*4} lines=${s.split('\n').length} parse=${tp.toFixed(0)}ms validate=${tv.toFixed(0)}ms tx=${tt.toFixed(0)}ms slice=${ts.toFixed(0)}ms diags=${d.length}`);
}
