import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  adminClient,
  createTestUser,
  deleteTestUser,
  userClient,
  type TestUser,
} from './supabase-test-utils.js';

/**
 * The answer-quality rollup, against real Postgres.
 *
 * Two properties matter: the counts are right, and -- because it aggregates
 * message rows -- a user can only ever count their own. The function is
 * SECURITY INVOKER, so the second is RLS doing its job, proven here rather
 * than assumed.
 */
describe('answer_quality_summary', () => {
  let alice: TestUser;
  let bob: TestUser;

  async function seedMessages(user: TestUser, rows: Record<string, unknown>[]) {
    const db = adminClient();
    const { data: conv } = await db
      .from('conversations')
      .insert({ owner_id: user.id, title: 'quality' })
      .select('id')
      .single();
    const { error } = await db.from('messages').insert(
      rows.map((r) => ({
        conversation_id: (conv as { id: string }).id,
        owner_id: user.id,
        role: 'assistant',
        content: 'x',
        // Explicit, because a multi-row PostgREST insert unions the rows'
        // keys and sends null -- not the column default -- for missing ones.
        refused_without_model: false,
        flagged_sources: 0,
        ...r,
      })),
    );
    if (error) throw new Error(error.message);
  }

  const summary = async (user: TestUser) => {
    const { data, error } = await userClient(user.accessToken).rpc('answer_quality_summary');
    if (error) throw new Error(error.message);
    return (data as Record<string, number>[])[0]!;
  };

  beforeAll(async () => {
    alice = await createTestUser('quality-alice');
    bob = await createTestUser('quality-bob');
    await seedMessages(alice, [
      { grounding: 'grounded' },
      { grounding: 'grounded', flagged_sources: 2 },
      { grounding: 'refusal', refused_without_model: true },
      { grounding: 'refusal' },
      { grounding: 'ungrounded' },
      // Predates the migration: no grounding recorded, so not counted.
      { grounding: null },
    ]);
    await seedMessages(bob, [{ grounding: 'ungrounded' }]);
  });

  afterAll(async () => {
    if (alice) await deleteTestUser(alice.id);
    if (bob) await deleteTestUser(bob.id);
  });

  it('counts each class of answer', async () => {
    const s = await summary(alice);
    expect(Number(s.answers)).toBe(5);
    expect(Number(s.grounded)).toBe(2);
    expect(Number(s.refusals)).toBe(2);
    expect(Number(s.refused_without_model)).toBe(1);
    expect(Number(s.ungrounded)).toBe(1);
    expect(Number(s.flagged_answers)).toBe(1);
  });

  it("never counts another user's answers", async () => {
    const s = await summary(bob);
    expect(Number(s.answers)).toBe(1);
    expect(Number(s.ungrounded)).toBe(1);
  });

  it('rejects a grounding value outside the three classes', async () => {
    await expect(seedMessages(alice, [{ grounding: 'probably-fine' }])).rejects.toThrow();
  });
});
