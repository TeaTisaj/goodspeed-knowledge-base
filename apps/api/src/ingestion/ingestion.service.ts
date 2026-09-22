import { Injectable, Logger } from '@nestjs/common';
import { contentHash, type EmbeddingProvider } from '@kb/ai';
import { chunkText, cleanText, diffChunks, hashChunk, type ExistingChunk } from '@kb/rag';
import type { SupabaseClient } from '@supabase/supabase-js';
import { AiService } from '../ai/ai.service.js';
import { ConfigService } from '../config/config.service.js';
import { SupabaseService } from '../supabase/supabase.service.js';

export interface IngestionOutcome {
  documentId: string;
  chunksCreated: number;
  chunksReused: number;
  chunksDeleted: number;
  skipped: boolean;
}

/**
 * Turns a document into retrievable chunks.
 *
 * Runs in the worker with the service-role client, because it writes chunks on
 * a user's behalf outside any request. Ownership is therefore enforced in code
 * here: `owner_id` is copied from the document row and never taken from job
 * input, so a forged job cannot write chunks into someone else's namespace.
 */
@Injectable()
export class IngestionService {
  private readonly logger = new Logger(IngestionService.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly ai: AiService,
    private readonly config: ConfigService,
  ) {}

  async ingest(documentId: string): Promise<IngestionOutcome> {
    const db = this.supabase.admin();
    const embedder = this.ai.embeddings;

    const doc = await this.loadDocument(db, documentId);
    const cleaned = cleanText(doc.content);
    const docHash = contentHash(cleaned);

    // Nothing changed: skip before doing any chunking work at all. This is what
    // makes duplicate jobs cheap, and therefore what lets the queue stay free of
    // a debounce that could drop an update.
    if (doc.content_hash === docHash && doc.chunk_count > 0) {
      return {
        documentId,
        chunksCreated: 0,
        chunksReused: doc.chunk_count,
        chunksDeleted: 0,
        skipped: true,
      };
    }

    await this.setStatus(db, documentId, 'processing');

    try {
      const outcome = await this.rebuildChunks(db, embedder, doc, cleaned, docHash);
      return outcome;
    } catch (error) {
      const message = (error as Error).message;
      this.logger.error(`Ingestion failed for ${documentId}: ${message}`);
      await db
        .from('documents')
        .update({ status: 'failed', error_message: message })
        .eq('id', documentId);
      throw error;
    }
  }

  private async rebuildChunks(
    db: SupabaseClient,
    embedder: EmbeddingProvider,
    doc: DocumentRow,
    cleaned: string,
    docHash: string,
  ): Promise<IngestionOutcome> {
    const incoming = chunkText(cleaned);

    const { data: existingRows } = await db
      .from('chunks')
      .select('id, chunk_index, content_hash')
      .eq('document_id', doc.id)
      // A chunk embedded by a different model is not comparable, so treat it
      // as absent and force a re-embed rather than mixing vector spaces.
      .eq('embedding_model', embedder.model);

    const existing: ExistingChunk[] = (existingRows ?? []).map((r) => ({
      id: r.id as string,
      chunkIndex: r.chunk_index as number,
      contentHash: r.content_hash as string,
    }));

    const diff = diffChunks(existing, incoming);

    // Only the genuinely new chunks are embedded. The caching decorator then
    // deduplicates further against text seen anywhere before.
    let embeddings: number[][] = [];
    if (diff.created.length > 0) {
      const result = await embedder.embed({ texts: diff.created.map((c) => c.content) });
      embeddings = result.embeddings;
    }

    if (diff.deletedIds.length > 0) {
      await db.from('chunks').delete().in('id', diff.deletedIds);
    }

    // Reindex kept rows first. Indexes are unique per document, so shift them
    // out of the way before inserting to avoid colliding mid-write.
    for (const u of diff.unchanged) {
      if (u.fromIndex !== u.toIndex) {
        await db
          .from('chunks')
          .update({ chunk_index: -1 - u.toIndex })
          .eq('id', u.id);
      }
    }
    for (const u of diff.unchanged) {
      if (u.fromIndex !== u.toIndex) {
        await db.from('chunks').update({ chunk_index: u.toIndex, tags: doc.tags }).eq('id', u.id);
      } else {
        await db.from('chunks').update({ tags: doc.tags }).eq('id', u.id);
      }
    }

    if (diff.created.length > 0) {
      const rows = diff.created.map((c, i) => ({
        document_id: doc.id,
        owner_id: doc.owner_id,
        chunk_index: c.index,
        content: c.content,
        token_count: c.tokenCount,
        content_hash: hashChunk(c.content),
        tags: doc.tags,
        embedding: JSON.stringify(embeddings[i]),
        embedding_model: embedder.model,
      }));
      const { error } = await db.from('chunks').insert(rows);
      if (error) throw new Error(`chunk insert failed: ${error.message}`);
    }

    await db
      .from('documents')
      .update({
        status: 'ready',
        chunk_count: incoming.length,
        content_hash: docHash,
        error_message: null,
      })
      .eq('id', doc.id);

    return {
      documentId: doc.id,
      chunksCreated: diff.created.length,
      chunksReused: diff.unchanged.length,
      chunksDeleted: diff.deletedIds.length,
      skipped: false,
    };
  }

  private async loadDocument(db: SupabaseClient, id: string): Promise<DocumentRow> {
    const { data, error } = await db
      .from('documents')
      .select('id, owner_id, content, tags, content_hash, chunk_count, status')
      .eq('id', id)
      .maybeSingle();

    if (error) throw new Error(`Failed to load document: ${error.message}`);
    if (!data) throw new Error(`Document ${id} not found`);
    return data as DocumentRow;
  }

  private async setStatus(db: SupabaseClient, id: string, status: string): Promise<void> {
    await db.from('documents').update({ status }).eq('id', id);
  }

  /** Embedding dimension the schema expects. Guards against a model swap. */
  get expectedDimensions(): number {
    return this.config.env.AI_EMBEDDING_DIMENSIONS;
  }
}

interface DocumentRow {
  id: string;
  owner_id: string;
  content: string;
  tags: string[];
  content_hash: string | null;
  chunk_count: number;
  status: string;
}
