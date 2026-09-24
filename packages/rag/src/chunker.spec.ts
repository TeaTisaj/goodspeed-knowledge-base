import { describe, expect, it } from 'vitest';
import { chunkText, cleanText, countTokens, DEFAULT_CHUNK_OPTIONS } from './chunker.js';

const para = (n: number) =>
  `Paragraph ${n}. ${'This sentence carries enough words to matter for token counting. '.repeat(6)}`;

describe('cleanText', () => {
  it('normalises CRLF without touching markdown structure', () => {
    const out = cleanText('# Title\r\n\r\nBody text here.');
    expect(out).toBe('# Title\n\nBody text here.');
  });

  it('strips zero-width characters that corrupt tokenisation', () => {
    expect(cleanText('he​llo﻿')).toBe('hello');
  });

  it('collapses excessive blank lines but preserves paragraph breaks', () => {
    expect(cleanText('a\n\n\n\n\nb')).toBe('a\n\nb');
  });

  it('leaves code fences intact', () => {
    const src = '```ts\nconst x = 1;\n```';
    expect(cleanText(src)).toBe(src);
  });

  it('returns empty string for whitespace-only input', () => {
    expect(cleanText('   \n\n  \t ')).toBe('');
  });
});

describe('chunkText', () => {
  it('returns nothing for empty input', () => {
    expect(chunkText('')).toEqual([]);
    expect(chunkText('    ')).toEqual([]);
  });

  it('keeps a short document as a single chunk', () => {
    const chunks = chunkText('A short note about deployments.');
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.index).toBe(0);
  });

  it('never exceeds maxTokens, overlap included', () => {
    const doc = Array.from({ length: 12 }, (_, i) => para(i)).join('\n\n');
    const chunks = chunkText(doc, { maxTokens: 200, overlapTokens: 20 });

    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      // The ceiling covers the emitted chunk, not just its body: overlap used
      // to be prepended on top of a full-size body, so a "200-token" chunk
      // could reach 220 and the configured number meant less than it said.
      expect(c.tokenCount).toBeLessThanOrEqual(200);
    }
  });

  it('holds the ceiling at the default settings too', () => {
    const doc = Array.from({ length: 40 }, (_, i) => para(i)).join('\n\n');
    for (const c of chunkText(doc)) {
      expect(c.tokenCount).toBeLessThanOrEqual(DEFAULT_CHUNK_OPTIONS.maxTokens);
    }
  });

  it('indexes chunks contiguously from zero', () => {
    const doc = Array.from({ length: 10 }, (_, i) => para(i)).join('\n\n');
    const chunks = chunkText(doc, { maxTokens: 150 });
    expect(chunks.map((c) => c.index)).toEqual(chunks.map((_, i) => i));
  });

  it('overlaps consecutive chunks, so a boundary cannot orphan a fact', () => {
    const doc = Array.from({ length: 8 }, (_, i) => para(i)).join('\n\n');
    const chunks = chunkText(doc, { maxTokens: 150, overlapTokens: 30 });

    expect(chunks.length).toBeGreaterThan(1);
    const prevTail = chunks[0]!.content.split(/\s+/).slice(-5).join(' ');
    expect(chunks[1]!.content).toContain(prevTail.split(' ')[0]!);
  });

  it('emits no overlap when overlapTokens is zero', () => {
    const doc = Array.from({ length: 6 }, (_, i) => para(i)).join('\n\n');
    const withOverlap = chunkText(doc, { maxTokens: 150, overlapTokens: 40 });
    const without = chunkText(doc, { maxTokens: 150, overlapTokens: 0 });

    const totalWith = withOverlap.reduce((s, c) => s + c.tokenCount, 0);
    const totalWithout = without.reduce((s, c) => s + c.tokenCount, 0);
    expect(totalWith).toBeGreaterThan(totalWithout);
  });

  it('prefers to split on markdown headings', () => {
    const doc = `# Alpha\n\n${para(1)}\n\n# Beta\n\n${para(2)}\n\n# Gamma\n\n${para(3)}`;
    const chunks = chunkText(doc, { maxTokens: 120, overlapTokens: 0 });
    // Each heading should start a chunk rather than be stranded mid-chunk.
    const startsWithHeading = chunks.filter((c) => c.content.trimStart().startsWith('#'));
    expect(startsWithHeading.length).toBeGreaterThanOrEqual(2);
  });

  it('splits a single oversized paragraph that has no structural breaks', () => {
    const wall = 'word '.repeat(4000);
    const chunks = chunkText(wall, { maxTokens: 200, overlapTokens: 0 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.tokenCount).toBeLessThanOrEqual(260);
  });

  it('handles text with no whitespace at all without looping forever', () => {
    const chunks = chunkText('x'.repeat(20_000), { maxTokens: 100 });
    expect(chunks.length).toBeGreaterThan(1);
  });

  it('preserves unicode and emoji without splitting a grapheme', () => {
    const doc = `Der Bericht zeigt: Umsätze stiegen um 18 %. 🚀 ${para(1)}`;
    const chunks = chunkText(doc, { maxTokens: 100 });
    expect(chunks.map((c) => c.content).join(' ')).toContain('🚀');
    expect(chunks.map((c) => c.content).join(' ')).toContain('Umsätze');
  });

  it('does not lose content: every source paragraph survives somewhere', () => {
    const doc = Array.from({ length: 10 }, (_, i) => `Marker${i}. ${para(i)}`).join('\n\n');
    const joined = chunkText(doc, { maxTokens: 180, overlapTokens: 20 })
      .map((c) => c.content)
      .join('\n');

    for (let i = 0; i < 10; i++) expect(joined).toContain(`Marker${i}`);
  });

  it('merges a stranded trailing fragment instead of emitting a tiny chunk', () => {
    const doc = `${para(1)}\n\n${para(2)}\n\nok.`;
    const chunks = chunkText(doc, { maxTokens: 200, overlapTokens: 0, minTokens: 40 });
    expect(chunks.at(-1)!.tokenCount).toBeGreaterThanOrEqual(40);
  });

  it('is deterministic', () => {
    const doc = Array.from({ length: 6 }, (_, i) => para(i)).join('\n\n');
    expect(chunkText(doc)).toEqual(chunkText(doc));
  });

  it('uses documented defaults', () => {
    expect(DEFAULT_CHUNK_OPTIONS).toEqual({ maxTokens: 512, overlapTokens: 64, minTokens: 32 });
  });
});

describe('countTokens', () => {
  it('counts zero for empty text', () => {
    expect(countTokens('')).toBe(0);
  });

  it('grows with text length', () => {
    expect(countTokens('hello world this is longer')).toBeGreaterThan(countTokens('hello'));
  });
});
