import { ProviderError } from './provider.js';

export interface HttpOptions {
  /** Injected for tests; defaults to the global fetch. */
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
  timeoutMs?: number;
  /**
   * Longest retry-after worth sleeping through. A longer one means a quota window (for
   * example a daily token limit), so the call fails fast instead of hanging.
   */
  maxRetryWaitMs?: number;
}

export type HttpResult = { ok: true; data: unknown; latencyMs: number } | { ok: false; status: number; text: string };

/**
 * POST with retries on 429 and 5xx (honouring retry-after), shared by the provider adapters.
 * Records retries and the provider's rate limit headers, and redacts the secret from every
 * message it produces.
 */
export class RetryingHttp {
  /** Retries made and time spent waiting, so wall time can be explained in the report. */
  readonly retryStats = { retries: 0, waitedMs: 0, byStatus: {} as Record<string, number> };
  /** Last rate limit headers seen (limits and remaining quota, never credentials). */
  rateLimit: Record<string, string> = {};
  readonly #secret: string;
  readonly #fetch: typeof fetch;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #maxRetries: number;
  readonly #timeoutMs: number;
  readonly #maxRetryWaitMs: number;

  constructor(readonly label: string, secret: string, readonly rateLimitPrefixes: string[], o: HttpOptions = {}) {
    this.#secret = secret;
    this.#fetch = o.fetch ?? fetch;
    this.#sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.#maxRetries = o.maxRetries ?? 4;
    this.#timeoutMs = o.timeoutMs ?? 60_000;
    this.#maxRetryWaitMs = o.maxRetryWaitMs ?? 60_000;
  }

  redact(s: string): string { return this.#secret ? s.split(this.#secret).join('[REDACTED]') : s; }

  private async wait(ms: number, status: string) {
    this.retryStats.retries++;
    this.retryStats.waitedMs += ms;
    this.retryStats.byStatus[status] = (this.retryStats.byStatus[status] ?? 0) + 1;
    await this.#sleep(ms);
  }

  /** Latency of the last attempt only, so retry waits do not inflate the reported latency. */
  lastLatencyMs = 0;

  /**
   * fetch with the retry policy. Returns the final response, successful or not, with its body
   * unread; throws a ProviderError for a quota window or when the network keeps failing. Also
   * usable as the fetch of an SDK client whose own retries are turned off.
   */
  async fetch(url: string, init: RequestInit): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const t0 = Date.now();
      let res: Response;
      try {
        res = await this.#fetch(url, { ...init, signal: init.signal ?? AbortSignal.timeout(this.#timeoutMs) });
      } catch (e) {
        if (attempt < this.#maxRetries) { await this.wait(1000 * 2 ** attempt, 'network'); continue; }
        throw new ProviderError(this.redact(`${this.label} request failed: ${String(e)}`), 'network');
      }
      this.lastLatencyMs = Date.now() - t0;
      res.headers.forEach((v, k) => { if (this.rateLimitPrefixes.some((p) => k.startsWith(p))) this.rateLimit[k] = v; });
      if (res.ok) return res;

      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable) return res;
      const after = Number(res.headers.get('retry-after'));
      const waitMs = Number.isFinite(after) && after > 0 ? after * 1000 : 1000 * 2 ** attempt;
      if (waitMs > this.#maxRetryWaitMs) {
        const text = this.redact(await res.text());
        throw new ProviderError(`${this.label} ${res.status}: quota window, retry after ${Math.round(waitMs / 1000)} s. ${text.slice(0, 300)}`, res.status === 429 ? 'rate_limit' : 'server', res.status);
      }
      if (attempt >= this.#maxRetries) return res;
      await res.text(); // drain before retrying
      await this.wait(waitMs, String(res.status));
    }
  }

  async post(url: string, headers: Record<string, string>, body: string): Promise<HttpResult> {
    const res = await this.fetch(url, { method: 'POST', headers, body });
    if (res.ok) return { ok: true, data: await res.json(), latencyMs: this.lastLatencyMs };
    return { ok: false, status: res.status, text: this.redact(await res.text()) };
  }
}
