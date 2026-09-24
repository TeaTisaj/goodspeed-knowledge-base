import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { IngestionService } from './ingestion.service.js';
import type { AiService } from '../ai/ai.service.js';
import type { SupabaseService } from '../supabase/supabase.service.js';
import { contentHash } from '@kb/ai';
import { cleanText } from '@kb/rag';

/**
 * Guards the status a skipped ingestion leaves behind.
 *
 * The regression: every update parks the document in `queued`, and a re-save
 * that did not change the text takes the hash-matches early return -- which did
 * no work and, crucially, restored no status. The document stayed fully indexed
 * and searchable while the UI showed "Queued" forever, which looks exactly like
 * a worker that never picked the job up.
 */

interface Recorded {
  table: string;
  patch: Record<string, unknown>;
}

/**
 * Minimal stand-in for the PostgREST builder: chainable, and thenable so an
 * `update(...).eq(...)` can be awaited without a terminal call, which is how
 * the service writes status.
 */
function fakeDb(row: Record<string, unknown>, recorded: Recorded[]): SupabaseClient {
  const builder = (table: string) => {
    const self: Record<string, unknown> = {
      select: () => self,
      eq: () => self,
      update: (patch: Record<string, unknown>) => {
        recorded.push({ table, patch });
        return self;
      },
      maybeSingle: () => Promise.resolve({ data: row, error: null }),
      then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
        Promise.resolve({ data: null, error: null }).then(res, rej),
    };
    return self;
  };
  return { from: builder } as unknown as SupabaseClient;
}

function serviceFor(row: Record<string, unknown>, recorded: Recorded[]): IngestionService {
  const supabase = { admin: () => fakeDb(row, recorded) } as unknown as SupabaseService;
  const ai = { embeddings: { model: 'test-model' } } as unknown as AiService;
  return new IngestionService(supabase, ai);
}

const CONTENT = 'Madrid is the capital of Spain.';

function docRow(status: string): Record<string, unknown> {
  return {
    id: 'doc-1',
    owner_id: 'user-1',
    content: CONTENT,
    tags: ['travel'],
    content_hash: contentHash(cleanText(CONTENT)),
    chunk_count: 16,
    status,
  };
}

describe('ingestion skip path', () => {
  it('skips the work when the content hash is unchanged', async () => {
    const outcome = await serviceFor(docRow('ready'), []).ingest('doc-1');

    expect(outcome.skipped).toBe(true);
    expect(outcome.chunksCreated).toBe(0);
    expect(outcome.chunksReused).toBe(16);
  });

  it('clears a stale `queued` status left by the update that enqueued it', async () => {
    const recorded: Recorded[] = [];
    await serviceFor(docRow('queued'), recorded).ingest('doc-1');

    const statusWrite = recorded.find((r) => r.table === 'documents');
    expect(statusWrite?.patch).toEqual({ status: 'ready', error_message: null });
  });

  it('clears a stale `failed` status once the document indexes cleanly', async () => {
    const recorded: Recorded[] = [];
    await serviceFor(docRow('failed'), recorded).ingest('doc-1');

    expect(recorded.find((r) => r.table === 'documents')?.patch).toEqual({
      status: 'ready',
      error_message: null,
    });
  });

  it('leaves an already-ready document alone rather than writing a no-op row', async () => {
    const recorded: Recorded[] = [];
    await serviceFor(docRow('ready'), recorded).ingest('doc-1');

    expect(recorded.filter((r) => r.table === 'documents')).toHaveLength(0);
  });

  it('still syncs tags onto the chunks, whatever the status was', async () => {
    const recorded: Recorded[] = [];
    await serviceFor(docRow('queued'), recorded).ingest('doc-1');

    expect(recorded.find((r) => r.table === 'chunks')?.patch).toEqual({ tags: ['travel'] });
  });
});
