/**
 * Token counter with a hard limit. Callers reserve before a call (with an estimate) and record
 * the real usage after it, so a budget stops the run cleanly between two calls instead of
 * failing in the middle of one.
 */
export class TokenBudget {
  used = 0;
  constructor(readonly limit: number = Infinity) {
    if (!(limit > 0)) throw new Error(`Token budget must be positive, got ${limit}`);
  }
  canAfford(tokens: number): boolean { return this.used + tokens <= this.limit; }
  record(tokens: number): void { this.used += tokens; }
  get remaining(): number { return Math.max(0, this.limit - this.used); }
  get exhausted(): boolean { return this.used >= this.limit; }
}
