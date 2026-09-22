import { describe, expect, it } from 'vitest';
import { chunkText } from './chunker.js';
import { diffChunks, hashChunk, reuseRatio, type ExistingChunk } from './diffing.js';

const asExisting = (contents: string[]): ExistingChunk[] =>
  contents.map((c, i) => ({ id: `row-${i}`, chunkIndex: i, contentHash: hashChunk(c) }));

const asIncoming = (contents: string[]) =>
  contents.map((content, index) => ({ index, content, tokenCount: 10 }));

describe('diffChunks', () => {
  it('reuses everything when nothing changed', () => {
    const texts = ['alpha', 'beta', 'gamma'];
    const diff = diffChunks(asExisting(texts), asIncoming(texts));

    expect(diff.unchanged).toHaveLength(3);
    expect(diff.created).toHaveLength(0);
    expect(diff.deletedIds).toHaveLength(0);
    expect(reuseRatio(diff)).toBe(1);
  });

  it('creates only the chunk that actually changed', () => {
    const before = ['alpha', 'beta', 'gamma'];
    const after = ['alpha', 'beta EDITED', 'gamma'];
    const diff = diffChunks(asExisting(before), asIncoming(after));

    expect(diff.created.map((c) => c.content)).toEqual(['beta EDITED']);
    expect(diff.unchanged).toHaveLength(2);
    expect(diff.deletedIds).toEqual(['row-1']);
  });

  it('deletes rows for removed content', () => {
    const diff = diffChunks(asExisting(['a', 'b', 'c']), asIncoming(['a', 'c']));
    expect(diff.deletedIds).toEqual(['row-1']);
    expect(diff.created).toHaveLength(0);
  });

  it('reuses a chunk that only moved position', () => {
    // Prepending a section shifts indexes; the text is identical, so it must
    // not be re-embedded.
    const diff = diffChunks(asExisting(['a', 'b']), asIncoming(['new', 'a', 'b']));

    expect(diff.created.map((c) => c.content)).toEqual(['new']);
    const moved = diff.unchanged.find((u) => u.id === 'row-0');
    expect(moved).toMatchObject({ fromIndex: 0, toIndex: 1 });
  });

  it('handles duplicate text within one document', () => {
    // A document can legitimately repeat a paragraph; each occurrence needs
    // its own row rather than collapsing to one.
    const diff = diffChunks(asExisting(['dup', 'dup']), asIncoming(['dup', 'dup', 'dup']));
    expect(diff.unchanged).toHaveLength(2);
    expect(diff.created).toHaveLength(1);
  });

  it('treats a brand new document as all-created', () => {
    const diff = diffChunks([], asIncoming(['a', 'b']));
    expect(diff.created).toHaveLength(2);
    expect(reuseRatio(diff)).toBe(0);
  });

  it('deletes everything when a document is emptied', () => {
    const diff = diffChunks(asExisting(['a', 'b']), []);
    expect(diff.deletedIds).toHaveLength(2);
    expect(diff.created).toHaveLength(0);
  });

  it('re-embeds a bounded number of chunks for a one-paragraph edit', () => {
    // The claim the design rests on, measured rather than asserted. Not "one
    // chunk": overlap means an edit usually touches two.
    const paras = Array.from(
      { length: 12 },
      (_, i) => `Section ${i}. ${'Body sentence with enough words to fill a chunk. '.repeat(5)}`,
    );
    const original = paras.join('\n\n');
    const edited = paras
      .map((p, i) => (i === 5 ? `${p} One extra clarifying sentence.` : p))
      .join('\n\n');

    const opts = { maxTokens: 120, overlapTokens: 15 };
    const before = chunkText(original, opts);
    const after = chunkText(edited, opts);

    const existing: ExistingChunk[] = before.map((c, i) => ({
      id: `row-${i}`,
      chunkIndex: i,
      contentHash: hashChunk(c.content),
    }));

    const diff = diffChunks(existing, after);

    expect(diff.created.length).toBeGreaterThan(0);
    expect(diff.created.length).toBeLessThan(before.length);
    expect(reuseRatio(diff)).toBeGreaterThan(0.5);
  });
});

describe('hashChunk', () => {
  it('is stable and content-sensitive', () => {
    expect(hashChunk('abc')).toBe(hashChunk('abc'));
    expect(hashChunk('abc')).not.toBe(hashChunk('abd'));
  });

  it('distinguishes whitespace, which changes embeddings', () => {
    expect(hashChunk('a b')).not.toBe(hashChunk('a  b'));
  });
});
