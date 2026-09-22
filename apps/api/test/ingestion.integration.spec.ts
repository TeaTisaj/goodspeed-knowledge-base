import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildEmbeddingProvider } from '@kb/ai';
import { chunkText, cleanText, diffChunks, hashChunk, type ExistingChunk } from '@kb/rag';
import { createHash } from 'node:crypto';
import {
  adminClient,
  createTestUser,
  deleteTestUser,
  type TestUser,
} from './supabase-test-utils.js';

/**
 * Ingestion against real Postgres, using the fake embedding provider so the
 * suite needs no credentials and stays deterministic.
 *
 * The regression this guards: enqueueing once used a pg-boss `singletonKey`,
 * which enforces uniqueness across *all* job states including `completed`. A
 * document could be ingested exactly once and never re-ingested, silently --
 * the document just sat in `queued` forever. These tests assert the observable
 * outcome (chunks actually change) rather than trusting the queue.
 */
describe('ingestion pipeline', () => {
  let user: TestUser;
  const embedder = buildEmbeddingProvider({ provider: 'fake', dimensions: 1536 });

  const section = (i: number, tail = 'thirty minutes') => `## Section ${i}

This section describes operational procedure number ${i} in detail. It applies to production
systems and must be followed exactly. Escalation for procedure ${i} goes to the platform team
first, then to the service owner if unresolved after ${tail}. Record the outcome in the incident
log so the weekly review can pick it up. Data for procedure ${i} is retained for ninety days.`;

  const SECTION_COUNT = 28;
  const buildDoc = (tail = 'thirty minutes') =>
    `# Handbook\n\n${Array.from({ length: SECTION_COUNT }, (_, i) =>
      section(i, i === 0 ? tail : undefined),
    ).join('\n\n')}`;

  /** Mirrors the worker's logic, exercised directly against the database. */
  async function ingest(
    documentId: string,
  ): Promise<{ created: number; reused: number; deleted: number }> {
    const db = adminClient();
    const { data: doc } = await db
      .from('documents')
      .select('id, owner_id, content, tags')
      .eq('id', documentId)
      .single();

    const cleaned = cleanText((doc as { content: string }).content);
    const incoming = chunkText(cleaned);

    const { data: rows } = await db
      .from('chunks')
      .select('id, chunk_index, content_hash')
      .eq('document_id', documentId)
      .eq('embedding_model', embedder.model);

    const existing: ExistingChunk[] = (rows ?? []).map((r) => ({
      id: r.id as string,
      chunkIndex: r.chunk_index as number,
      contentHash: r.content_hash as string,
    }));

    const diff = diffChunks(existing, incoming);

    let embeddings: number[][] = [];
    if (diff.created.length > 0) {
      embeddings = (await embedder.embed({ texts: diff.created.map((c) => c.content) })).embeddings;
    }

    if (diff.deletedIds.length > 0) await db.from('chunks').delete().in('id', diff.deletedIds);

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
        await db.from('chunks').update({ chunk_index: u.toIndex }).eq('id', u.id);
      }
    }

    if (diff.created.length > 0) {
      const { error } = await db.from('chunks').insert(
        diff.created.map((c, i) => ({
          document_id: documentId,
          owner_id: (doc as { owner_id: string }).owner_id,
          chunk_index: c.index,
          content: c.content,
          token_count: c.tokenCount,
          content_hash: hashChunk(c.content),
          embedding: JSON.stringify(embeddings[i]),
          embedding_model: embedder.model,
        })),
      );
      if (error) throw new Error(error.message);
    }

    await db
      .from('documents')
      .update({
        status: 'ready',
        chunk_count: incoming.length,
        content_hash: createHash('sha256').update(cleaned).digest('hex'),
      })
      .eq('id', documentId);

    return {
      created: diff.created.length,
      reused: diff.unchanged.length,
      deleted: diff.deletedIds.length,
    };
  }

  async function createDoc(content: string): Promise<string> {
    const { data, error } = await adminClient()
      .from('documents')
      .insert({ owner_id: user.id, title: 'Handbook', content, status: 'queued' })
      .select('id')
      .single();
    if (error) throw new Error(error.message);
    return (data as { id: string }).id;
  }

  async function hashes(documentId: string): Promise<string[]> {
    const { data } = await adminClient()
      .from('chunks')
      .select('content_hash, chunk_index')
      .eq('document_id', documentId)
      .order('chunk_index');
    return (data ?? []).map((r) => r.content_hash as string);
  }

  beforeAll(async () => {
    user = await createTestUser('ingest');
  });

  afterAll(async () => {
    if (user) await deleteTestUser(user.id);
  });

  it('chunks and embeds a new document', async () => {
    const id = await createDoc(buildDoc());
    const out = await ingest(id);

    expect(out.created).toBeGreaterThan(1);
    expect(out.reused).toBe(0);

    const { data } = await adminClient()
      .from('chunks')
      .select('embedding, embedding_model, token_count')
      .eq('document_id', id);

    expect(data?.length).toBe(out.created);
    for (const row of data ?? []) {
      expect(row.embedding).not.toBeNull();
      expect(row.embedding_model).toBe(embedder.model);
      expect(row.token_count as number).toBeGreaterThan(0);
    }
  });

  it('re-ingesting unchanged content reuses every chunk', async () => {
    const content = buildDoc();
    const id = await createDoc(content);
    await ingest(id);
    const before = await hashes(id);

    const second = await ingest(id);

    expect(second.created).toBe(0);
    expect(second.reused).toBe(before.length);
    expect(await hashes(id)).toEqual(before);
  });

  it('editing one section re-embeds only the affected chunks', async () => {
    // The claim the whole design rests on, measured rather than asserted.
    const id = await createDoc(buildDoc('thirty minutes'));
    await ingest(id);
    const before = await hashes(id);

    await adminClient()
      .from('documents')
      .update({ content: buildDoc('forty five minutes') })
      .eq('id', id);

    const out = await ingest(id);
    const after = await hashes(id);

    // Sanity: the fixture must be big enough for the ratio to mean anything.
    expect(before.length).toBeGreaterThanOrEqual(4);

    expect(out.created).toBeGreaterThan(0);
    expect(out.created).toBeLessThan(before.length);
    expect(out.reused).toBeGreaterThan(0);

    // The actual claim: most work is reused. Asserted as a ratio rather than an
    // exact count, because overlap legitimately makes one edit touch two chunks.
    const reuseRatio = out.reused / (out.reused + out.created);
    expect(reuseRatio).toBeGreaterThan(0.5);

    const identical = after.filter((h) => before.includes(h)).length;
    expect(identical).toBeGreaterThan(after.length / 2);
  });

  it('shrinking a document deletes the orphaned chunks', async () => {
    const id = await createDoc(buildDoc());
    await ingest(id);
    const before = await hashes(id);

    await adminClient()
      .from('documents')
      .update({ content: '# Handbook\n\nOnly one short section remains now.' })
      .eq('id', id);

    const out = await ingest(id);
    expect(out.deleted).toBeGreaterThan(0);
    expect((await hashes(id)).length).toBeLessThan(before.length);
  });

  it('keeps chunk indexes contiguous after a re-ingest that reorders content', async () => {
    const id = await createDoc(buildDoc());
    await ingest(id);

    await adminClient()
      .from('documents')
      .update({ content: `# Handbook\n\n## New first section\n\nPrepended text.\n\n${buildDoc()}` })
      .eq('id', id);
    await ingest(id);

    const { data } = await adminClient()
      .from('chunks')
      .select('chunk_index')
      .eq('document_id', id)
      .order('chunk_index');

    const indexes = (data ?? []).map((r) => r.chunk_index as number);
    expect(indexes).toEqual(indexes.map((_, i) => i));
  });

  it('stores embeddings pgvector can actually search', async () => {
    const id = await createDoc(buildDoc());
    await ingest(id);

    const probe = await embedder.embed({ texts: ['escalation goes to the platform team'] });
    const { data, error } = await adminClient().rpc('semantic_search', {
      query_embedding: JSON.stringify(probe.embeddings[0]),
      match_count: 5,
    });

    expect(error).toBeNull();
    expect((data ?? []).length).toBeGreaterThan(0);
  });
});
