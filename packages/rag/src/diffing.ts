import { createHash } from 'node:crypto';
import type { Chunk } from './chunker.js';

/**
 * Incremental re-ingestion.
 *
 * Editing a document must not re-embed the whole thing. Chunks are matched by
 * content hash, so unchanged text is kept and only genuinely new text reaches
 * the embedding provider.
 *
 * The honest caveat, which belongs next to the code rather than buried in a
 * doc: a large insertion can shift downstream chunk boundaries, changing hashes
 * for chunks whose text did not meaningfully change. Structure-aware splitting
 * makes that uncommon — boundaries land on headings and paragraph breaks that
 * an edit elsewhere does not move — but it does not eliminate it. The reported
 * `reused` count is the real measurement, not an advertised best case.
 */

export function hashChunk(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

export interface ExistingChunk {
  id: string;
  chunkIndex: number;
  contentHash: string;
}

export interface ChunkDiff {
  /** Chunks whose text is unchanged; keep the row, possibly reindex it. */
  unchanged: { id: string; fromIndex: number; toIndex: number; contentHash: string }[];
  /** Chunks needing an embedding. */
  created: (Chunk & { contentHash: string })[];
  /** Row ids to delete. */
  deletedIds: string[];
}

export function diffChunks(existing: ExistingChunk[], incoming: Chunk[]): ChunkDiff {
  const incomingHashed = incoming.map((c) => ({ ...c, contentHash: hashChunk(c.content) }));

  // A document can legitimately contain the same text twice, so map each hash
  // to a queue of rows rather than a single row.
  const byHash = new Map<string, ExistingChunk[]>();
  for (const e of existing) {
    const list = byHash.get(e.contentHash);
    if (list) list.push(e);
    else byHash.set(e.contentHash, [e]);
  }

  const unchanged: ChunkDiff['unchanged'] = [];
  const created: ChunkDiff['created'] = [];
  const consumed = new Set<string>();

  for (const chunk of incomingHashed) {
    const candidates = byHash.get(chunk.contentHash);
    const match = candidates?.shift();
    if (match) {
      consumed.add(match.id);
      unchanged.push({
        id: match.id,
        fromIndex: match.chunkIndex,
        toIndex: chunk.index,
        contentHash: chunk.contentHash,
      });
    } else {
      created.push(chunk);
    }
  }

  const deletedIds = existing.filter((e) => !consumed.has(e.id)).map((e) => e.id);
  return { unchanged, created, deletedIds };
}

/** Reuse ratio, for reporting what incremental ingestion actually saved. */
export function reuseRatio(diff: ChunkDiff): number {
  const total = diff.unchanged.length + diff.created.length;
  return total === 0 ? 0 : diff.unchanged.length / total;
}
