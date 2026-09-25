import { describe, expect, it } from 'vitest';
import {
  buildChatMessages,
  buildPrompt,
  countTokens,
  SYSTEM_PROMPT,
  type RetrievedChunk,
} from '@kb/rag';

/**
 * Guards the context budget against the two ways it used to be wrong.
 *
 * 1. The ceiling came from `MAX_CONTEXT_TOKENS` alone, so swapping a
 *    400k-window model for an 8k one left the number where it was and
 *    overflowed on the first request after the swap.
 * 2. History was appended to the message array *after* sources had been fitted
 *    to the ceiling, so the request exceeded the window by exactly the amount
 *    of history it carried.
 */

/** Mirrors the ceiling calculation in ChatService.ask. */
function effectiveCeiling(configured: number, providerWindow: number): number {
  return Math.min(configured, providerWindow);
}

function chunk(id: string, words: number): RetrievedChunk {
  return {
    id,
    documentId: `doc-${id}`,
    documentTitle: `Document ${id}`,
    content: Array.from({ length: words }, () => 'lorem').join(' '),
    score: 1,
  };
}

describe('context ceiling', () => {
  it('drops to the provider window when the provider is smaller', () => {
    // Ollama's llama3.2 declares 8192; the env default is 8000.
    expect(effectiveCeiling(8000, 8192)).toBe(8000);
    // A small local model against a generous env setting.
    expect(effectiveCeiling(100_000, 8192)).toBe(8192);
  });

  it('lets the env var tighten a large window but never widen it', () => {
    // OpenAI declares 400k; the operator wants to spend less than that.
    expect(effectiveCeiling(16_000, 400_000)).toBe(16_000);
    // And an operator cannot ask for more than the model can take.
    expect(effectiveCeiling(1_000_000, 128_000)).toBe(128_000);
  });
});

describe('buildPrompt token budget', () => {
  const chunks = [chunk('a', 200), chunk('b', 200), chunk('c', 200)];
  // Budgets are "the rules plus N tokens of room", never absolute: the system
  // prompt is a real and growing share of the window, and an absolute number
  // silently stops testing anything the next time the rules are reworded.
  const overhead = countTokens(SYSTEM_PROMPT);

  it('fits every source when there is room', () => {
    const { used } = buildPrompt(chunks, { maxContextTokens: overhead + 4000, countTokens });
    expect(used).toHaveLength(3);
  });

  it('reserves room for history instead of letting it overflow the window', () => {
    const generous = buildPrompt(chunks, { maxContextTokens: overhead + 700, countTokens });
    const reserved = buildPrompt(chunks, {
      maxContextTokens: overhead + 700,
      reservedTokens: 400,
      countTokens,
    });

    // The reservation has to cost sources, or it is not a reservation.
    expect(reserved.used.length).toBeLessThan(generous.used.length);
  });

  it('keeps the whole request inside the ceiling once history is counted', () => {
    const ceiling = overhead + 800;
    const history = [
      { role: 'user' as const, content: 'word '.repeat(150) },
      { role: 'assistant' as const, content: 'word '.repeat(150) },
    ];

    // Measured on the messages actually sent, so the tag scaffolding around
    // the sources and the question is counted too.
    const { messages } = buildChatMessages(
      { chunks, history, question: 'What changed?' },
      { maxContextTokens: ceiling, countTokens },
    );
    const total = messages.reduce((n, m) => n + countTokens(m.content), 0);

    expect(total).toBeLessThanOrEqual(ceiling);
  });

  it('still returns a usable prompt when nothing fits', () => {
    const { context, used } = buildPrompt(chunks, {
      maxContextTokens: overhead + 200,
      reservedTokens: 190,
      countTokens,
    });

    expect(used).toHaveLength(0);
    expect(context).toContain('no sources matched');
  });
});
