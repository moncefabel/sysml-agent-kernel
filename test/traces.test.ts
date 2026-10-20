import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generate, rebuild, renderTrace, REPRESENTATIVE } from '../eval/traces.js';

// Built from parts so that a search of the repository for the key prefixes finds no file.
const KEY_PATTERNS = [new RegExp(['gs', 'k_'].join('') + '[A-Za-z0-9]{8,}'), new RegExp(['sk', '-ant-'].join('') + '[A-Za-z0-9_-]{8,}')];
const realKeys = [process.env.GROQ_API_KEY, process.env.APP_ANTHROPIC_API_KEY].filter((k): k is string => !!k && k.length > 8);

test('traces: a saved report is rebuilt from the cache and rendered as a self-contained page', async () => {
  const pick = REPRESENTATIVE.find((r) => r.id === 'sc-concurrent-edit')!;
  const report = { ...JSON.parse(readFileSync(join('eval/results', pick.file), 'utf8')), file: pick.file };
  const row = report.rows.find((x: any) => x.id === pick.id);
  const t = await rebuild(report, row);
  assert.equal(t.verified, true);
  assert.equal(t.turns.length, row.llm.turns);
  assert.deepEqual(t.turns.map((x) => x.usage.promptTokens).reduce((a, b) => a + b, 0), row.llm.promptTokens);
  const html = renderTrace(t);
  assert.match(html, /rejected: version conflict/);
  assert.match(html, /A colleague committed a concurrent edit/);
  assert.match(html, /^<!doctype html>/);
  assert.ok(!/<script|<link|https?:\/\//.test(html), 'no script, stylesheet link or external URL');
});

test('traces: the generator writes an index and pages that contain no API key', async () => {
  const out = mkdtempSync(join(tmpdir(), 'traces-'));
  const entries = await generate({ out });
  assert.equal(entries.length, REPRESENTATIVE.length);
  assert.ok(entries.every((e) => e.t.verified));
  const files = readdirSync(out);
  assert.ok(files.includes('index.html'));
  for (const f of files) {
    const html = readFileSync(join(out, f), 'utf8');
    for (const p of KEY_PATTERNS) assert.ok(!p.test(html), `${f} matches ${p}`);
    for (const k of realKeys) assert.ok(!html.includes(k), `${f} contains a real key`);
  }
  const index = readFileSync(join(out, 'index.html'), 'utf8');
  for (const e of entries) assert.ok(index.includes(`href="${e.href}"`));
});
