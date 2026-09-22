import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  adminClient,
  createTestUser,
  deleteTestUser,
  fakeEmbedding,
  userClient,
  type TestUser,
} from './supabase-test-utils.js';

/**
 * The security claim, tested against real Postgres with real user JWTs.
 *
 * Nothing here is mocked on purpose: a mocked RLS test proves nothing about
 * RLS. Two users are created, each given a document and chunks, and then every
 * read path is exercised as user B to confirm A's data is unreachable.
 */
describe('RLS isolation between users', () => {
  let alice: TestUser;
  let bob: TestUser;
  let aliceDocId: string;
  let bobDocId: string;

  const ALICE_SECRET = 'Alice quarterly revenue was forty two million dollars';
  const BOB_SECRET = 'Bob onboarding checklist requires a security review';

  beforeAll(async () => {
    alice = await createTestUser('alice');
    bob = await createTestUser('bob');

    const admin = adminClient();

    const seed = async (user: TestUser, title: string, body: string, seedNum: number) => {
      const { data: doc, error: docErr } = await admin
        .from('documents')
        .insert({
          owner_id: user.id,
          title,
          content: body,
          tags: ['finance'],
          status: 'ready',
          chunk_count: 1,
        })
        .select('id')
        .single();
      if (docErr) throw new Error(`doc insert: ${docErr.message}`);

      const { error: chunkErr } = await admin.from('chunks').insert({
        document_id: doc.id,
        owner_id: user.id,
        chunk_index: 0,
        content: body,
        token_count: 10,
        content_hash: `hash-${seedNum}`,
        tags: ['finance'],
        embedding: JSON.stringify(fakeEmbedding(seedNum)),
        embedding_model: 'test-model',
      });
      if (chunkErr) throw new Error(`chunk insert: ${chunkErr.message}`);
      return doc.id as string;
    };

    aliceDocId = await seed(alice, "Alice's private finance doc", ALICE_SECRET, 1);
    bobDocId = await seed(bob, "Bob's private onboarding doc", BOB_SECRET, 2);
  });

  afterAll(async () => {
    if (alice) await deleteTestUser(alice.id);
    if (bob) await deleteTestUser(bob.id);
  });

  it('fixtures exist for both users when read with the service role', async () => {
    const { data } = await adminClient()
      .from('documents')
      .select('id')
      .in('id', [aliceDocId, bobDocId]);
    expect(data).toHaveLength(2);
  });

  it('a user sees only their own documents', async () => {
    const { data, error } = await userClient(bob.accessToken).from('documents').select('id, title');
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
    expect(data?.[0]?.id).toBe(bobDocId);
  });

  it("a user cannot read another user's document by id", async () => {
    const { data } = await userClient(bob.accessToken)
      .from('documents')
      .select('id')
      .eq('id', aliceDocId);
    expect(data).toEqual([]);
  });

  it("a user cannot read another user's chunks directly", async () => {
    const { data } = await userClient(bob.accessToken).from('chunks').select('id, content');
    expect(data).toHaveLength(1);
    expect(data?.[0]?.content).toBe(BOB_SECRET);
  });

  it("a user cannot update another user's document", async () => {
    const { data } = await userClient(bob.accessToken)
      .from('documents')
      .update({ title: 'hijacked' })
      .eq('id', aliceDocId)
      .select();
    expect(data).toEqual([]);

    const { data: check } = await adminClient()
      .from('documents')
      .select('title')
      .eq('id', aliceDocId)
      .single();
    expect(check?.title).toBe("Alice's private finance doc");
  });

  it("a user cannot delete another user's document", async () => {
    await userClient(bob.accessToken).from('documents').delete().eq('id', aliceDocId);
    const { data } = await adminClient().from('documents').select('id').eq('id', aliceDocId);
    expect(data).toHaveLength(1);
  });

  it('a user cannot insert a document owned by someone else', async () => {
    const { error } = await userClient(bob.accessToken)
      .from('documents')
      .insert({ owner_id: alice.id, title: 'forged', content: 'x' });
    expect(error).not.toBeNull();
  });

  it('a user cannot forge chunks: no write policy exists for authenticated', async () => {
    const { error } = await userClient(bob.accessToken).from('chunks').insert({
      document_id: bobDocId,
      owner_id: bob.id,
      chunk_index: 99,
      content: 'injected instructions',
      content_hash: 'forged',
      embedding_model: 'test-model',
    });
    expect(error).not.toBeNull();
  });

  it('the embedding cache is invisible to users, closing a cross-user side channel', async () => {
    await adminClient()
      .from('embedding_cache')
      .insert({
        content_hash: 'shared-hash',
        model: 'test-model',
        embedding: JSON.stringify(fakeEmbedding(3)),
      });

    const { data } = await userClient(bob.accessToken)
      .from('embedding_cache')
      .select('content_hash');
    expect(data).toEqual([]);
  });

  // The one that matters most: retrieval must not leak across users.
  it("hybrid_search run as Bob never returns Alice's chunks", async () => {
    const { data, error } = await userClient(bob.accessToken).rpc('hybrid_search', {
      query_text: 'revenue million dollars quarterly',
      query_embedding: JSON.stringify(fakeEmbedding(1)), // Alice's exact vector
      match_count: 20,
    });

    expect(error).toBeNull();
    const contents = (data ?? []).map((r: { content: string }) => r.content);

    // Assert retrieval actually worked before asserting what it excluded.
    // Without this, an RPC that returned nothing at all would satisfy the
    // "does not contain Alice" check vacuously and hide a broken index.
    expect(contents).toContain(BOB_SECRET);
    expect(contents).not.toContain(ALICE_SECRET);
    expect(contents.every((c: string) => c === BOB_SECRET)).toBe(true);
  });

  it("semantic_search run as Bob never returns Alice's chunks", async () => {
    const { data, error } = await userClient(bob.accessToken).rpc('semantic_search', {
      query_embedding: JSON.stringify(fakeEmbedding(1)),
      match_count: 20,
    });
    expect(error).toBeNull();
    const contents = (data ?? []).map((r: { content: string }) => r.content);
    expect(contents).toContain(BOB_SECRET); // non-vacuous: retrieval ran
    expect(contents).not.toContain(ALICE_SECRET);
  });

  it('an anonymous caller retrieves nothing at all', async () => {
    const { data } = await userClient('').rpc('hybrid_search', {
      query_text: 'revenue',
      query_embedding: JSON.stringify(fakeEmbedding(1)),
      match_count: 20,
    });
    expect(data ?? []).toEqual([]);
  });
});
