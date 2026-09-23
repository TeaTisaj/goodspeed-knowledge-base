import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildEmbeddingProvider } from '@kb/ai';
import { chunkText, hashChunk } from '@kb/rag';
import {
  adminClient,
  createTestUser,
  deleteTestUser,
  userClient,
  type TestUser,
} from './supabase-test-utils.js';

/**
 * Retrieval behaviour against real Postgres.
 *
 * Uses the fake embedder, whose hashing vectorizer produces similarity that
 * tracks lexical overlap -- enough for ranking assertions to be meaningful
 * without any API key.
 */
describe('retrieval', () => {
  let user: TestUser;
  const embedder = buildEmbeddingProvider({ provider: 'fake', dimensions: 1536 });

  const DOCS = [
    {
      title: 'Deployment runbook',
      tags: ['ops'],
      body: 'To roll back a bad deploy, re-run the previous successful deploy from the Actions tab. A rollback takes about eight minutes to finish completely.',
    },
    {
      title: 'Q3 revenue summary',
      tags: ['finance'],
      body: 'Total revenue for the third quarter was four point two million dollars, up eighteen percent from the previous quarter across enterprise accounts.',
    },
    {
      title: 'Onboarding guide',
      tags: ['hr'],
      body: 'New engineers receive a laptop on their first day and should run the bootstrap command in the platform repository before writing any code.',
    },
  ];

  async function seed(): Promise<void> {
    const db = adminClient();
    for (const doc of DOCS) {
      const { data } = await db
        .from('documents')
        .insert({
          owner_id: user.id,
          title: doc.title,
          content: doc.body,
          tags: doc.tags,
          status: 'ready',
          chunk_count: 1,
        })
        .select('id')
        .single();

      const chunks = chunkText(doc.body);
      const { embeddings } = await embedder.embed({ texts: chunks.map((c) => c.content) });

      await db.from('chunks').insert(
        chunks.map((c, i) => ({
          document_id: (data as { id: string }).id,
          owner_id: user.id,
          chunk_index: c.index,
          content: c.content,
          token_count: c.tokenCount,
          content_hash: hashChunk(c.content),
          tags: doc.tags,
          embedding: JSON.stringify(embeddings[i]),
          embedding_model: embedder.model,
        })),
      );
    }
  }

  async function search(query: string, extra: Record<string, unknown> = {}) {
    const { embeddings } = await embedder.embed({ texts: [query] });
    const { data, error } = await userClient(user.accessToken).rpc('hybrid_search', {
      query_text: query,
      query_embedding: JSON.stringify(embeddings[0]),
      match_count: 10,
      required_embedding_model: embedder.model,
      ...extra,
    });
    if (error) throw new Error(error.message);
    return (data ?? []) as {
      content: string;
      score: number;
      semantic_rank: number | null;
      full_text_rank: number | null;
    }[];
  }

  beforeAll(async () => {
    user = await createTestUser('retrieval');
    await seed();
  });

  afterAll(async () => {
    if (user) await deleteTestUser(user.id);
  });

  it('ranks the relevant document first', async () => {
    const rows = await search('how do I roll back a failed deploy');
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]?.content).toMatch(/roll back/i);
  });

  it('finds content by keyword even when phrased differently', async () => {
    const rows = await search('revenue');
    expect(rows[0]?.content).toMatch(/revenue/i);
  });

  it('returns results from both arms, which is what fusion is for', async () => {
    const rows = await search('rollback deploy Actions tab eight minutes');
    // At least one row should have been found by each retrieval arm.
    expect(rows.some((r) => r.semantic_rank !== null)).toBe(true);
    expect(rows.some((r) => r.full_text_rank !== null)).toBe(true);
  });

  it('scores a row found by both arms above one found by a single arm', async () => {
    const rows = await search('roll back deploy');
    const both = rows.filter((r) => r.semantic_rank !== null && r.full_text_rank !== null);
    const one = rows.filter((r) => r.semantic_rank === null || r.full_text_rank === null);
    if (both.length > 0 && one.length > 0) {
      expect(Math.max(...both.map((r) => r.score))).toBeGreaterThan(
        Math.max(...one.map((r) => r.score)),
      );
    }
  });

  it('restricts results to the requested tag', async () => {
    const rows = await search('what happened', { filter_tags: ['finance'] });
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.content).toMatch(/revenue/i);
  });

  it('returns nothing for a tag with no documents', async () => {
    expect(await search('anything', { filter_tags: ['nonexistent-tag'] })).toEqual([]);
  });

  it('refuses to mix embedding models', async () => {
    // A vector from another model is not comparable, so retrieval must return
    // nothing rather than silently ranking across incompatible vector spaces.
    const rows = await search('roll back deploy', { required_embedding_model: 'some-other-model' });
    expect(rows).toEqual([]);
  });

  it('respects match_count', async () => {
    const rows = await search('deploy revenue onboarding', { match_count: 1 });
    expect(rows).toHaveLength(1);
  });

  it('handles a query with no lexical or semantic match', async () => {
    const rows = await search('zzzxqv nonexistent gibberish token');
    // Vector search always returns its nearest neighbours, so this asserts the
    // query succeeds rather than that it returns nothing.
    expect(Array.isArray(rows)).toBe(true);
  });

  it('survives punctuation that would break a raw tsquery', async () => {
    // websearch_to_tsquery tolerates this; to_tsquery would throw.
    await expect(search('what about "roll back" & deploy!?')).resolves.toBeDefined();
  });
});
