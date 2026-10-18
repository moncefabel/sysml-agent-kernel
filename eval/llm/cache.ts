import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalJson, ProviderError, sha256, type CompletionRequest, type CompletionResponse, type LLMProvider } from './provider.js';

/**
 * Content-addressed response cache, as a decorator over any provider. The key covers everything
 * that can change the answer: provider, model, messages, tools and sampling parameters. Because
 * the kernel is deterministic, a run replayed from a full cache reproduces the same trajectory
 * and the same report without any network call.
 */
export class CachedProvider implements LLMProvider {
  readonly provider: string;
  readonly model: string;
  hits = 0;
  misses = 0;

  constructor(readonly inner: LLMProvider, readonly dir: string, readonly mode: 'readwrite' | 'readonly' = 'readwrite') {
    this.provider = inner.provider;
    this.model = inner.model;
    mkdirSync(dir, { recursive: true });
  }

  static key(provider: string, model: string, req: CompletionRequest): string {
    return sha256(canonicalJson({
      provider, model,
      messages: req.messages, tools: req.tools,
      maxOutputTokens: req.maxOutputTokens, temperature: req.temperature,
    }));
  }

  private file(key: string): string { return join(this.dir, `${key}.json`); }

  isCached(req: CompletionRequest): boolean {
    return existsSync(this.file(CachedProvider.key(this.provider, this.model, req)));
  }

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    const key = CachedProvider.key(this.provider, this.model, req);
    const file = this.file(key);
    if (existsSync(file)) {
      this.hits++;
      const { response, toolUseFailed } = JSON.parse(readFileSync(file, 'utf8'));
      if (toolUseFailed) throw new ProviderError(toolUseFailed.message, 'tool_use_failed', toolUseFailed.status, toolUseFailed.failedGeneration);
      return { ...response, cached: true };
    }
    if (this.mode === 'readonly') throw new Error(`Cache miss in read-only mode (key ${key.slice(0, 12)})`);
    this.misses++;
    try {
      const response = await this.inner.complete(req);
      this.write(file, { response });
      return response;
    } catch (e) {
      // A malformed tool call is a deterministic model output, not an infrastructure failure,
      // so it is cached too. Every other error is left uncached and retried on the next run.
      if (e instanceof ProviderError && e.kind === 'tool_use_failed')
        this.write(file, { toolUseFailed: { message: e.message, status: e.status, failedGeneration: e.failedGeneration } });
      throw e;
    }
  }

  private write(file: string, payload: object) {
    // Write then rename, so an interrupted run never leaves a truncated entry behind.
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ provider: this.provider, model: this.model, createdAt: new Date().toISOString(), ...payload }, null, 1));
    renameSync(tmp, file);
  }
}
