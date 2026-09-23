import { describe, expect, it } from 'vitest';
import { FakeEmbeddingProvider, hashingVector } from './fake.js';

function cosine(a: number[], b: number[]): number {
  return a.reduce((s, x, i) => s + x * (b[i] ?? 0), 0);
}

/**
 * The fake embedder has to produce a *meaningful* similarity signal, not just
 * a deterministic one. A random-vector fake would make the zero-key demo look
 * broken and the CI eval measure noise, so these tests pin the property that
 * actually matters: similarity tracks lexical overlap.
 */
describe('hashing vectorizer', () => {
  it('is deterministic', () => {
    expect(hashingVector('hello world', 64)).toEqual(hashingVector('hello world', 64));
  });

  it('emits unit vectors', () => {
    const v = hashingVector('some example text', 128);
    expect(Math.sqrt(v.reduce((s, x) => s + x * x, 0))).toBeCloseTo(1, 6);
  });

  it('scores overlapping text higher than unrelated text', () => {
    const query = hashingVector('deployment pipeline takes eight minutes', 512);
    const related = hashingVector('a deployment takes about eight minutes to finish', 512);
    const unrelated = hashingVector('quarterly revenue grew across enterprise accounts', 512);

    expect(cosine(query, related)).toBeGreaterThan(cosine(query, unrelated));
  });

  it('ranks a corpus sensibly, which is what retrieval depends on', () => {
    const dims = 512;
    const query = hashingVector('how do I roll back a failed deploy', dims);
    const corpus = [
      'To roll back, re-run the previous successful deploy from the Actions tab.',
      'Total revenue for Q3 was 4.2 million dollars, up 18 percent.',
      'Gross churn was 2.1 percent, down from 3.4 percent in Q2.',
    ];
    const ranked = corpus
      .map((text) => ({ text, score: cosine(query, hashingVector(text, dims)) }))
      .sort((a, b) => b.score - a.score);

    expect(ranked[0]?.text).toMatch(/roll back/);
  });

  it('handles empty text without producing a zero vector', () => {
    // pgvector rejects a zero vector for cosine distance.
    const v = hashingVector('', 32);
    expect(Math.sqrt(v.reduce((s, x) => s + x * x, 0))).toBeCloseTo(1, 6);
  });

  it('does not let one repeated word dominate the vector', () => {
    const repeated = hashingVector('spam '.repeat(50) + 'signal', 256);
    const balanced = hashingVector('spam signal', 256);
    expect(cosine(repeated, balanced)).toBeGreaterThan(0.5);
  });
});

describe('FakeEmbeddingProvider', () => {
  it('honours the configured dimension', async () => {
    const p = new FakeEmbeddingProvider({ dimensions: 384 });
    const res = await p.embed({ texts: ['a', 'b'] });
    expect(res.embeddings[0]).toHaveLength(384);
    expect(res.embeddings).toHaveLength(2);
  });
});

describe('FakeChatProvider answer composition', () => {
  const prompt = (sources: string) =>
    `You answer questions using only the numbered sources below.

Rules:
- Cite every claim with the source number in square brackets, like [1].
- If the sources do not contain the answer, say so plainly. Do not guess.

Sources:

${sources}`;

  it('never quotes the instruction preamble back as the answer', async () => {
    // Regression: extracting from the whole system message made the "answer"
    // the rules text, which looks broken and tells a reviewer nothing.
    const { FakeChatProvider } = await import('./fake.js');
    const res = await new FakeChatProvider().chat({
      messages: [
        { role: 'system', content: prompt('[1] Runbook\nA deploy takes eight minutes.') },
        { role: 'user', content: 'how long does a deploy take' },
      ],
    });
    expect(res.text).not.toMatch(/Cite every claim/);
    expect(res.text).not.toMatch(/Do not guess/);
    expect(res.text).toMatch(/eight minutes/);
  });

  it('emits citation markers, so the zero-key demo exercises citations', async () => {
    const { FakeChatProvider } = await import('./fake.js');
    const res = await new FakeChatProvider().chat({
      messages: [
        {
          role: 'system',
          content: prompt(
            '[1] Runbook\nA deploy takes eight minutes.\n\n[2] Finance\nRevenue was four million dollars.',
          ),
        },
        { role: 'user', content: 'what was revenue' },
      ],
    });
    expect(res.text).toMatch(/\[2\]/);
    expect(res.text).toMatch(/four million/);
  });

  it('says so plainly when the sources do not answer the question', async () => {
    const { FakeChatProvider } = await import('./fake.js');
    const res = await new FakeChatProvider().chat({
      messages: [
        { role: 'system', content: prompt('[1] Runbook\nA deploy takes eight minutes.') },
        { role: 'user', content: 'unladen swallow airspeed velocity migratory' },
      ],
    });
    expect(res.text).toMatch(/do not contain|could not find/i);
  });

  it('returns a no-answer response when there are no sources at all', async () => {
    const { FakeChatProvider } = await import('./fake.js');
    const res = await new FakeChatProvider().chat({
      messages: [
        { role: 'system', content: 'You answer questions.\n\nSources:\n\n(none found)' },
        { role: 'user', content: 'anything' },
      ],
    });
    expect(res.text).toMatch(/could not find|do not contain/i);
  });
});
