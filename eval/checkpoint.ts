import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { canonicalJson, sha256 } from './llm/provider.js';
import type { Row } from './harness.js';

/**
 * Append-only JSONL checkpoint: a header line with a fingerprint of the run configuration,
 * then one line per completed scenario. Resuming skips the scenarios already recorded. A
 * checkpoint written under another configuration is refused rather than silently mixed in.
 */
export class Checkpoint {
  readonly fingerprint: string;

  constructor(readonly file: string, readonly config: unknown) {
    this.fingerprint = sha256(canonicalJson(config));
  }

  /** Rows already completed, by scenario id. Creates the file with its header if needed. */
  load(): Map<string, Row> {
    const done = new Map<string, Row>();
    if (!existsSync(this.file)) {
      mkdirSync(dirname(this.file), { recursive: true });
      appendFileSync(this.file, JSON.stringify({ type: 'header', fingerprint: this.fingerprint, config: this.config }) + '\n');
      return done;
    }
    const lines = readFileSync(this.file, 'utf8').split('\n').filter(Boolean);
    lines.forEach((line, i) => {
      let rec: any;
      try { rec = JSON.parse(line); } catch {
        // Only the last line can be torn by a crash during the write; anything else is corruption.
        // Drop it from the file too, otherwise the next append would be glued to it.
        if (i === lines.length - 1 && i > 0) { writeFileSync(this.file, lines.slice(0, -1).join('\n') + '\n'); return; }
        throw new Error(`${this.file}:${i + 1} is not valid JSON`);
      }
      if (i === 0) {
        if (rec.type !== 'header' || rec.fingerprint !== this.fingerprint)
          throw new Error(`${this.file} was written with a different configuration. Pass --fresh to discard it.`);
        return;
      }
      if (rec.type === 'row') done.set(rec.row.id, rec.row);
    });
    return done;
  }

  append(row: Row): void { appendFileSync(this.file, JSON.stringify({ type: 'row', row }) + '\n'); }

  discard(): void { rmSync(this.file, { force: true }); }
}
