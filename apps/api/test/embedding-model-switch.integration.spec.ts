import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildEmbeddingProvider } from '@kb/ai';
import type { AiService } from '../src/ai/ai.service.js';
import { IngestionService } from '../src/ingestion/ingestion.service.js';
import type { SupabaseService } from '../src/supabase/supabase.service.js';
import {
  adminClient,
  createTestUser,
  deleteTestUser,
  userClient,
  type TestUser,
} from './supabase-test-utils.js';

/**
 * Switching to an embedding model of the same width passes the boot-time
 * dimension check, so nothing stops the app. Search only compares vectors
 * within one model, so every existing chunk silently drops out of retrieval
 * until its document is re-ingested with the new model.
 */
describe('embedding model switch', () => {
  let user: TestUser;
  const OLD = 'switch-test-old';
  const NEW = 'switch-test-new';

  const CONTENT = Array.from(
    { length: 12 },
    (_, i) =>
      `## Section ${i}\n\nProcedure ${i} applies to production systems. Escalate to the ` +
      `platform team first, then to the service owner after thirty minutes. Record the ` +
      `outcome in the incident log so the weekly review can pick it up.`,
  ).join('\n\n');

  /** The real ingestion service, with only the embedding model varied. */
  function ingestionWith(model: string): IngestionService {
    const supabase = { admin: () => adminClient() } as unknown as SupabaseService;
    const embeddings = buildEmbeddingProvider({ provider: 'fake', model, dimensions: 1536 });
    return new IngestionService(supabase, { embeddings } as unknown as AiService);
  }

  async function createDocument(title: string): Promise<string> {
    const { data, error } = await adminClient()
      .from('documents')
      .insert({ owner_id: user.id, title, content: CONTENT, status: 'queued' })
      .select('id')
      .single();
    if (error) throw new Error(error.message);
    return (data as { id: string }).id;
  }

  async function documentRow(id: string) {
    const { data } = await adminClient()
      .from('documents')
      .select('status, content_hash, chunk_count')
      .eq('id', id)
      .single();
    return data as { status: string; content_hash: string | null; chunk_count: number };
  }

  async function chunkModels(id: string): Promise<string[]> {
    const { data } = await adminClient()
      .from('chunks')
      .select('embedding_model')
      .eq('document_id', id);
    return (data ?? []).map((r) => r.embedding_model as string);
  }

  beforeAll(async () => {
    user = await createTestUser('model-switch');
  });

  afterAll(async () => {
    await deleteTestUser(user.id);
  });

  it('requeues only documents embedded by another model', async () => {
    const stale = await createDocument('Embedded by the old model');
    const current = await createDocument('Embedded by the current model');
    await ingestionWith(OLD).ingest(stale);
    await ingestionWith(NEW).ingest(current);

    const { data, error } = await adminClient().rpc('requeue_stale_embeddings', { p_model: NEW });

    expect(error).toBeNull();
    expect(data).toBeGreaterThanOrEqual(1);
    // The hash must be cleared too: ingestion skips a document whose hash still matches.
    expect(await documentRow(stale)).toMatchObject({ status: 'queued', content_hash: null });
    expect(await documentRow(current)).toMatchObject({ status: 'ready' });
    expect((await documentRow(current)).content_hash).not.toBeNull();
  });

  it('replaces every old-model chunk when the document is re-ingested', async () => {
    const id = await createDocument('Re-ingested after the switch');
    const before = await ingestionWith(OLD).ingest(id);
    await adminClient().rpc('requeue_stale_embeddings', { p_model: NEW });

    // Old and new chunks share (document_id, chunk_index), so leftovers collide on insert.
    const after = await ingestionWith(NEW).ingest(id);

    expect(after.chunksReused).toBe(0);
    expect(after.chunksDeleted).toBe(before.chunksCreated);
    const models = await chunkModels(id);
    expect(new Set(models)).toEqual(new Set([NEW]));
    expect(models).toHaveLength((await documentRow(id)).chunk_count);
    expect(await documentRow(id)).toMatchObject({ status: 'ready' });
  });

  it('re-ingests an edit made after the switch, before any requeue', async () => {
    const id = await createDocument('Edited after the switch');
    await ingestionWith(OLD).ingest(id);
    await adminClient()
      .from('documents')
      .update({ content: `${CONTENT}\n\nAn added closing paragraph.`, status: 'queued' })
      .eq('id', id);

    await ingestionWith(NEW).ingest(id);

    expect(new Set(await chunkModels(id))).toEqual(new Set([NEW]));
  });

  it('cannot be called by a signed-in user', async () => {
    const { error } = await userClient(user.accessToken).rpc('requeue_stale_embeddings', {
      p_model: NEW,
    });
    expect(error).not.toBeNull();
  });
});
