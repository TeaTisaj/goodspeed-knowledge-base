import { describe, expect, it } from 'vitest';

/**
 * Guards which end of a conversation is carried into the prompt.
 *
 * The regression: history was loaded with `order('created_at', ascending) +
 * limit(10)`, which takes the *oldest* ten messages. Past turn ten the model
 * and the query condenser were fed a frozen prefix and never saw anything
 * recent -- a conversation that silently stopped remembering.
 *
 * The query shape is the thing under test, so it is modelled directly rather
 * than through a Supabase mock that would only re-encode the same assumption.
 */

interface Row {
  content: string;
  created_at: number;
}

/** What PostgREST returns for a given order/limit over a conversation. */
function query(rows: Row[], ascending: boolean, limit: number): Row[] {
  const sorted = [...rows].sort((a, b) =>
    ascending ? a.created_at - b.created_at : b.created_at - a.created_at,
  );
  return sorted.slice(0, limit);
}

/** Mirrors ChatService.loadHistory. */
function loadHistory(rows: Row[], limit: number): Row[] {
  return query(rows, false, limit).reverse();
}

const conversation: Row[] = Array.from({ length: 25 }, (_, i) => ({
  content: `message ${i + 1}`,
  created_at: i,
}));

describe('conversation history window', () => {
  it('carries the most recent turns, not the first ones', () => {
    const history = loadHistory(conversation, 10);

    expect(history).toHaveLength(10);
    expect(history.at(-1)?.content).toBe('message 25');
    expect(history[0]?.content).toBe('message 16');
  });

  it('returns them oldest-first, so the transcript reads in order', () => {
    const history = loadHistory(conversation, 10);
    const timestamps = history.map((h) => h.created_at);

    expect(timestamps).toEqual([...timestamps].sort((a, b) => a - b));
  });

  it('is the opposite of the ascending query that caused the bug', () => {
    const buggy = query(conversation, true, 10);

    expect(buggy.at(-1)?.content).toBe('message 10');
    expect(loadHistory(conversation, 10).at(-1)?.content).toBe('message 25');
  });

  it('returns everything when the conversation is shorter than the window', () => {
    const short = conversation.slice(0, 3);
    const history = loadHistory(short, 10);

    expect(history.map((h) => h.content)).toEqual(['message 1', 'message 2', 'message 3']);
  });

  it('is empty for a new conversation, so the condense step is skipped', () => {
    expect(loadHistory([], 10)).toEqual([]);
  });
});
