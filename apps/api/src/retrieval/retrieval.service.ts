import { Injectable, Logger } from '@nestjs/common';
import type { RetrievedChunk } from '@kb/rag';
import { AiService } from '../ai/ai.service.js';
import { ConfigService } from '../config/config.service.js';
import { SupabaseService } from '../supabase/supabase.service.js';

export interface RetrievalOptions {
  tags?: string[];
  documentIds?: string[];
  limit?: number;
  /** Vector-only retrieval. Used by the eval harness to measure hybrid's value. */
  mode?: 'hybrid' | 'semantic';
}

interface SearchRow {
  id: string;
  document_id: string;
  chunk_index: number;
  content: string;
  tags: string[];
  token_count: number;
  score: number;
}

/**
 * Retrieval runs through the caller's RLS-scoped client, so the database
 * enforces that a user can only ever retrieve their own chunks. There is no
 * application-level owner filter here, deliberately -- the isolation test
 * proves the policy does the work.
 */
@Injectable()
export class RetrievalService {
  private readonly logger = new Logger(RetrievalService.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly ai: AiService,
    private readonly config: ConfigService,
  ) {}

  async retrieve(
    accessToken: string,
    query: string,
    options: RetrievalOptions = {},
  ): Promise<RetrievedChunk[]> {
    const limit = options.limit ?? 12;
    const embedder = this.ai.embeddings;

    const { embeddings } = await embedder.embed({ texts: [query] });
    const queryEmbedding = embeddings[0];
    if (!queryEmbedding) return [];

    const db = this.supabase.forUser(accessToken);

    const rpc =
      options.mode === 'semantic'
        ? db.rpc('semantic_search', {
            query_embedding: JSON.stringify(queryEmbedding),
            match_count: limit,
            filter_tags: options.tags ?? null,
            filter_document_ids: options.documentIds ?? null,
            // Refuse to compare vectors produced by a different model.
            required_embedding_model: embedder.model,
          })
        : db.rpc('hybrid_search', {
            query_text: query,
            query_embedding: JSON.stringify(queryEmbedding),
            match_count: limit,
            filter_tags: options.tags ?? null,
            filter_document_ids: options.documentIds ?? null,
            required_embedding_model: embedder.model,
          });

    const { data, error } = await rpc;
    if (error) {
      this.logger.error(`Retrieval failed: ${error.message}`);
      return [];
    }

    const rows = (data ?? []) as SearchRow[];
    if (rows.length === 0) return [];

    // One extra query for titles rather than joining in SQL: it keeps the
    // search functions focused on ranking, and the id set is already small.
    const documentIds = [...new Set(rows.map((r) => r.document_id))];
    const { data: docs } = await db.from('documents').select('id, title').in('id', documentIds);
    const titles = new Map(
      (docs ?? []).map((d) => [(d as { id: string }).id, (d as { title: string }).title]),
    );

    return rows.map((r) => ({
      id: r.id,
      documentId: r.document_id,
      documentTitle: titles.get(r.document_id) ?? 'Untitled',
      content: r.content,
      score: r.score,
    }));
  }

  /**
   * Optional LLM reranker.
   *
   * Off by default. RRF fusion is the always-on baseline because it is free and
   * deterministic; this costs a model call and latency, so it has to earn its
   * place. The eval harness reports hit rate with and without it, which is what
   * the flag is for.
   */
  async rerank(query: string, chunks: RetrievedChunk[], topK: number): Promise<RetrievedChunk[]> {
    if (chunks.length <= topK) return chunks;

    const numbered = chunks.map((c, i) => `[${i + 1}] ${c.content.slice(0, 400)}`).join('\n\n');

    try {
      const result = await this.ai.chat.chat({
        messages: [
          {
            role: 'system',
            content:
              'Rank the passages by how well they answer the question. ' +
              `Reply with only the ${topK} best passage numbers, most relevant first, comma separated. ` +
              'No other text.',
          },
          { role: 'user', content: `Question: ${query}\n\nPassages:\n${numbered}` },
        ],
        temperature: 0,
        maxTokens: 50,
      });

      const order = [...result.text.matchAll(/\d+/g)]
        .map((m) => Number(m[0]) - 1)
        .filter((i) => i >= 0 && i < chunks.length);

      const seen = new Set<number>();
      const ranked: RetrievedChunk[] = [];
      for (const i of order) {
        if (seen.has(i)) continue;
        seen.add(i);
        ranked.push(chunks[i]!);
        if (ranked.length === topK) break;
      }

      // A reranker that returns nothing usable must not empty the context.
      return ranked.length > 0 ? ranked : chunks.slice(0, topK);
    } catch (error) {
      // Reranking is an enhancement; degrade to fusion order rather than fail
      // the user's question over it.
      this.logger.warn(`Rerank failed, using fusion order: ${(error as Error).message}`);
      return chunks.slice(0, topK);
    }
  }

  get rerankEnabled(): boolean {
    return this.config.env.AI_RERANK_ENABLED;
  }
}
