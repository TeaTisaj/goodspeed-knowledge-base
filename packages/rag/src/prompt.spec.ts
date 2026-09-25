import { describe, expect, it } from 'vitest';
import {
  buildCondensePrompt,
  buildPrompt,
  extractCitationNumbers,
  resolveCitations,
  type RetrievedChunk,
} from './prompt.js';

const chunk = (n: number, content = `Content number ${n}.`): RetrievedChunk => ({
  id: `chunk-${n}`,
  documentId: `doc-${n}`,
  documentTitle: `Document ${n}`,
  content,
  score: 1 / n,
});

describe('buildPrompt', () => {
  it('numbers sources from one', () => {
    const { context } = buildPrompt([chunk(1), chunk(2)]);
    expect(context).toContain('<source id="1" title="Document 1">');
    expect(context).toContain('<source id="2" title="Document 2">');
  });

  it('instructs the model to cite and to refuse when unsupported', () => {
    const { system } = buildPrompt([chunk(1)]);
    expect(system).toMatch(/cite/i);
    expect(system).toMatch(/do not guess/i);
  });

  it('states plainly when there are no sources', () => {
    const { context, used } = buildPrompt([]);
    expect(context).toContain('no sources matched');
    expect(used).toEqual([]);
  });

  // Budgets here are expressed as "instructions plus N tokens of room", not as
  // absolute numbers. The preamble is a real and growing share of the budget,
  // so an absolute ceiling silently stops testing what it says it tests the
  // next time the prompt is reworded -- it starts fitting nothing at all, and
  // "the big chunk was dropped" passes for the wrong reason.
  const overhead = Math.ceil(buildPrompt([]).system.length / 4);

  it('drops sources that do not fit rather than truncating them', () => {
    // A half-sentence source invites a citation pointing at text the model
    // never saw.
    const big = chunk(1, 'x'.repeat(4000));
    const small = chunk(2, 'short');
    const { used } = buildPrompt([big, small], { maxContextTokens: overhead + 60 });

    expect(used.map((u) => u.id)).toEqual(['chunk-2']);
  });

  it('renumbers so citation numbers always match what the model was shown', () => {
    const big = chunk(1, 'x'.repeat(4000));
    const { context, used } = buildPrompt([big, chunk(2), chunk(3)], {
      maxContextTokens: overhead + 60,
    });
    expect(context).toContain('<source id="1" title="Document 2">');
    expect(used[0]?.id).toBe('chunk-2');
  });
});

describe('extractCitationNumbers', () => {
  it('extracts markers in order of appearance', () => {
    expect(extractCitationNumbers('First [2] then [1].')).toEqual([2, 1]);
  });

  it('deduplicates repeats', () => {
    expect(extractCitationNumbers('[1] and again [1]')).toEqual([1]);
  });

  it('handles adjacent markers', () => {
    expect(extractCitationNumbers('Supported [1][3].')).toEqual([1, 3]);
  });

  it('ignores bracketed text that is not a citation', () => {
    expect(extractCitationNumbers('an array[i] and [note]')).toEqual([]);
  });

  it("reads gpt-oss's native lenticular citations", () => {
    // The Groq preset's default model writes 【1】 whatever the prompt says;
    // missing these dropped every citation it produced.
    expect(extractCitationNumbers('Eight minutes【1】, then【3】.')).toEqual([1, 3]);
  });

  it('reads fullwidth square brackets and tolerates inner spaces', () => {
    expect(extractCitationNumbers('See \uFF3B2\uFF3D and [ 4 ].')).toEqual([2, 4]);
  });

  it('returns nothing for an uncited answer', () => {
    expect(extractCitationNumbers('No citations here.')).toEqual([]);
  });
});

describe('resolveCitations', () => {
  it('maps numbers back to real chunk and document ids', () => {
    const used = [chunk(1), chunk(2)];
    const [first] = resolveCitations('See [2].', used);
    expect(first).toMatchObject({ number: 2, chunkId: 'chunk-2', documentId: 'doc-2' });
  });

  it('drops out-of-range citations instead of clamping them', () => {
    // A model inventing [9] against 2 sources must produce no citation.
    // Clamping would attach a confident link to an unsupporting document.
    expect(resolveCitations('As shown in [9].', [chunk(1), chunk(2)])).toEqual([]);
  });

  it('drops [0], which no source can be', () => {
    expect(resolveCitations('see [0]', [chunk(1)])).toEqual([]);
  });

  it('returns nothing when the answer cites nothing', () => {
    expect(resolveCitations('Plain answer.', [chunk(1)])).toEqual([]);
  });

  it('includes a quote snapshot so citations survive re-chunking', () => {
    const [c] = resolveCitations('[1]', [chunk(1, 'The deploy takes eight minutes.')]);
    expect(c?.quote).toContain('eight minutes');
  });
});

describe('buildCondensePrompt', () => {
  it('includes recent history and the follow-up', () => {
    const p = buildCondensePrompt(
      [
        { role: 'user', content: 'What are our deploy steps?' },
        { role: 'assistant', content: 'Merging to main deploys automatically.' },
      ],
      'How long does it take?',
    );
    expect(p).toContain('deploy steps');
    expect(p).toContain('How long does it take?');
  });

  it('caps history so the condense call stays cheap', () => {
    const history = Array.from({ length: 20 }, (_, i) => ({
      role: 'user' as const,
      content: `message ${i}`,
    }));
    const p = buildCondensePrompt(history, 'and then?');
    expect(p).not.toContain('message 0');
    expect(p).toContain('message 19');
  });

  it('asks for the question only, so the output can be embedded directly', () => {
    expect(buildCondensePrompt([], 'x')).toMatch(/Output only the question/);
  });
});
