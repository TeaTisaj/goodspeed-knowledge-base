import { createHash } from 'node:crypto';
import type { EmbedRequest, EmbedResult, EmbeddingProvider } from '../types.js';

/**
 * Storage for cached embeddings. Kept as an interface so the AI package stays
 * framework- and database-free; the API supplies a Postgres-backed store.
 */
export interface EmbeddingCacheStore {
  getMany(hashes: string[], model: string): Promise<Map<string, number[]>>;
  setMany(entries: { hash: string; embedding: number[] }[], model: string): Promise<void>;
}

/** In-memory store. Used by tests and as a per-process L1 cache. */
export class MemoryEmbeddingCache implements EmbeddingCacheStore {
  private readonly map = new Map<string, number[]>();

  private key(hash: string, model: string) {
    return `${model}:${hash}`;
  }

  async getMany(hashes: string[], model: string): Promise<Map<string, number[]>> {
    const out = new Map<string, number[]>();
    for (const h of hashes) {
      const hit = this.map.get(this.key(h, model));
      if (hit) out.set(h, hit);
    }
    return out;
  }

  async setMany(entries: { hash: string; embedding: number[] }[], model: string): Promise<void> {
    for (const e of entries) this.map.set(this.key(e.hash, model), e.embedding);
  }

  get size(): number {
    return this.map.size;
  }
}

export function contentHash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * Caches embeddings by (content hash, model).
 *
 * This is what makes re-ingestion cheap: editing one paragraph of a long
 * document leaves every other chunk's hash unchanged, so only the touched
 * chunks reach the provider. The cache is keyed by the text itself, so it also
 * deduplicates identical content across documents.
 *
 * Partial hits matter: a batch of 40 chunks with 38 cached must send only the
 * 2 misses, then reassemble the results in the caller's original order.
 */
export class CachingEmbeddingProvider implements EmbeddingProvider {
  readonly id: string;
  readonly model: string;
  readonly capabilities: EmbeddingProvider['capabilities'];

  private hits = 0;
  private misses = 0;

  constructor(
    private readonly inner: EmbeddingProvider,
    private readonly store: EmbeddingCacheStore,
  ) {
    this.id = inner.id;
    this.model = inner.model;
    this.capabilities = inner.capabilities;
  }

  get stats() {
    return { hits: this.hits, misses: this.misses };
  }

  async embed(request: EmbedRequest): Promise<EmbedResult> {
    const { texts } = request;
    if (texts.length === 0) {
      return {
        embeddings: [],
        usage: { promptTokens: 0, totalTokens: 0 },
        provider: { id: this.id, model: this.model },
      };
    }

    const hashes = texts.map(contentHash);
    const cached = await this.store.getMany([...new Set(hashes)], this.model);

    // Deduplicate within the request too: the same text twice should cost one
    // embedding, not two.
    const missingIndexes: number[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < texts.length; i++) {
      const h = hashes[i]!;
      if (cached.has(h) || seen.has(h)) continue;
      seen.add(h);
      missingIndexes.push(i);
    }

    this.hits += texts.length - missingIndexes.length;
    this.misses += missingIndexes.length;

    let usage = { promptTokens: 0, totalTokens: 0 };

    if (missingIndexes.length > 0) {
      const result = await this.inner.embed({
        texts: missingIndexes.map((i) => texts[i]!),
        signal: request.signal,
      });
      usage = result.usage;

      const fresh: { hash: string; embedding: number[] }[] = [];
      for (let j = 0; j < missingIndexes.length; j++) {
        const h = hashes[missingIndexes[j]!]!;
        const emb = result.embeddings[j]!;
        cached.set(h, emb);
        fresh.push({ hash: h, embedding: emb });
      }
      await this.store.setMany(fresh, this.model);
    }

    return {
      embeddings: hashes.map((h) => cached.get(h)!),
      usage,
      provider: { id: this.id, model: this.model },
    };
  }
}
