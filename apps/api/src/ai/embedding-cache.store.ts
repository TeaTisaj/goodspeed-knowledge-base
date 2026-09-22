import { Injectable, Logger } from '@nestjs/common';
import type { EmbeddingCacheStore } from '@kb/ai';
import { SupabaseService } from '../supabase/supabase.service.js';

/**
 * Postgres-backed embedding cache, keyed by (content hash, model).
 *
 * Shared across documents and users because the key is the text itself. That
 * is precisely why the table has RLS enabled with no policy: readable by users,
 * it would reveal whether someone else had already ingested a given piece of
 * text. Only this service-role path touches it.
 *
 * Cache failures are logged and swallowed: a cache is an optimisation, and an
 * unavailable cache must degrade to a slower ingestion, never a failed one.
 */
@Injectable()
export class PostgresEmbeddingCache implements EmbeddingCacheStore {
  private readonly logger = new Logger(PostgresEmbeddingCache.name);

  constructor(private readonly supabase: SupabaseService) {}

  async getMany(hashes: string[], model: string): Promise<Map<string, number[]>> {
    const out = new Map<string, number[]>();
    if (hashes.length === 0) return out;

    try {
      const { data, error } = await this.supabase
        .admin()
        .from('embedding_cache')
        .select('content_hash, embedding')
        .eq('model', model)
        .in('content_hash', hashes);

      if (error) {
        this.logger.warn(`Cache read failed, continuing uncached: ${error.message}`);
        return out;
      }

      for (const row of data ?? []) {
        const raw = (row as { embedding: string | number[] }).embedding;
        const vec = typeof raw === 'string' ? (JSON.parse(raw) as number[]) : raw;
        out.set((row as { content_hash: string }).content_hash, vec);
      }
    } catch (e) {
      this.logger.warn(`Cache read threw, continuing uncached: ${(e as Error).message}`);
    }
    return out;
  }

  async setMany(entries: { hash: string; embedding: number[] }[], model: string): Promise<void> {
    if (entries.length === 0) return;
    try {
      const { error } = await this.supabase
        .admin()
        .from('embedding_cache')
        .upsert(
          entries.map((e) => ({
            content_hash: e.hash,
            model,
            embedding: JSON.stringify(e.embedding),
          })),
          { onConflict: 'content_hash,model' },
        );
      if (error) this.logger.warn(`Cache write failed: ${error.message}`);
    } catch (e) {
      this.logger.warn(`Cache write threw: ${(e as Error).message}`);
    }
  }
}
