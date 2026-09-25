import { encode } from 'gpt-tokenizer';

/**
 * Recursive, structure-aware chunking: ~512 tokens, 64 overlap, split on the
 * strongest boundary available (headings, paragraphs, sentences, words), so a
 * chunk stays self-contained enough to answer a question on its own.
 *
 * 512/64 is the common default and needs no model calls; semantic chunking's
 * published gains are small and contested. The sizes are configurable and
 * measured against our corpus by `pnpm eval`.
 */

export interface ChunkOptions {
  /** Ceiling on the emitted chunk, in tokens, including the overlap prefix. */
  maxTokens?: number;
  /** Overlap in tokens, carried from the end of the previous chunk. */
  overlapTokens?: number;
  /** Chunks below this are merged forward; avoids stranded fragments. */
  minTokens?: number;
}

export interface Chunk {
  index: number;
  content: string;
  tokenCount: number;
}

export const DEFAULT_CHUNK_OPTIONS: Required<ChunkOptions> = {
  maxTokens: 512,
  overlapTokens: 64,
  minTokens: 32,
};

export function countTokens(text: string): number {
  if (text.length === 0) return 0;
  return encode(text).length;
}

/** Zero-width and BOM characters, built from code points so the source has no invisible bytes. */
const ZERO_WIDTH = new RegExp(
  `[${String.fromCharCode(0x200b)}-${String.fromCharCode(0x200d)}${String.fromCharCode(0xfeff)}]`,
  'g',
);

/** Normalises line endings and strips control characters; leaves markdown structure intact. */
export function cleanText(raw: string): string {
  return (
    raw
      .replace(/\r\n?/g, '\n')
      .replace(ZERO_WIDTH, '')
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
      .replace(/[ \t]+$/gm, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  );
}

/** Separator hierarchy, strongest structural boundary first. */
const SEPARATORS: { pattern: RegExp; keep: boolean }[] = [
  { pattern: /\n(?=#{1,6}\s)/g, keep: true }, // markdown headings
  { pattern: /\n\n+/g, keep: false }, // paragraphs
  { pattern: /\n/g, keep: false }, // lines
  { pattern: /(?<=[.!?])\s+/g, keep: false }, // sentences
  { pattern: /\s+/g, keep: false }, // words
];

function splitOn(text: string, level: number): string[] {
  const sep = SEPARATORS[level];
  if (!sep) {
    // Past every separator: a single token-dense run with no whitespace.
    // Hard-split rather than emit an oversized chunk.
    return hardSplit(text);
  }
  const parts = sep.keep
    ? text.split(sep.pattern).filter((p) => p.length > 0)
    : text.split(sep.pattern).filter((p) => p.trim().length > 0);

  return parts.length > 1 ? parts : splitOn(text, level + 1);
}

function hardSplit(text: string): string[] {
  const out: string[] = [];
  const size = 1000; // characters; only reached for pathological input
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

/** Recursively breaks a piece down until every part fits within maxTokens. */
function breakDown(text: string, maxTokens: number, level = 0): string[] {
  if (countTokens(text) <= maxTokens) return [text];

  const parts = splitOn(text, level);
  if (parts.length <= 1) {
    return level < SEPARATORS.length ? breakDown(text, maxTokens, level + 1) : hardSplit(text);
  }

  const out: string[] = [];
  for (const part of parts) {
    if (countTokens(part) <= maxTokens) out.push(part);
    else out.push(...breakDown(part, maxTokens, level + 1));
  }
  return out;
}

/** Takes the last `overlapTokens` worth of text, snapped to a word boundary. */
function tailOverlap(text: string, overlapTokens: number): string {
  if (overlapTokens <= 0) return '';
  const words = text.split(/\s+/);
  const kept: string[] = [];

  for (let i = words.length - 1; i >= 0; i--) {
    kept.unshift(words[i]!);
    if (countTokens(kept.join(' ')) >= overlapTokens) break;
  }
  return kept.join(' ');
}

export function chunkText(raw: string, options: ChunkOptions = {}): Chunk[] {
  const opts = { ...DEFAULT_CHUNK_OPTIONS, ...options };
  const text = cleanText(raw);
  if (text.length === 0) return [];

  // `maxTokens` includes the overlap, so reserve room for it up front.
  const bodyTokens = Math.max(1, opts.maxTokens - opts.overlapTokens);

  const pieces = breakDown(text, bodyTokens);

  // Pack pieces into chunks up to maxTokens, so a chunk is not left tiny just
  // because the source had short paragraphs.
  const packed: string[] = [];
  let current = '';

  for (const piece of pieces) {
    const candidate = current ? `${current}\n\n${piece}` : piece;
    if (countTokens(candidate) <= bodyTokens) {
      current = candidate;
    } else {
      if (current) packed.push(current);
      current = piece;
    }
  }
  if (current) packed.push(current);

  // Merge a stranded final fragment backwards rather than emitting a chunk too
  // small to carry meaning.
  if (packed.length > 1) {
    const last = packed.at(-1)!;
    if (countTokens(last) < opts.minTokens) {
      packed[packed.length - 2] = `${packed.at(-2)}\n\n${last}`;
      packed.pop();
    }
  }

  return packed.map((content, i) => {
    const prefix = i > 0 ? tailOverlap(packed[i - 1]!, opts.overlapTokens) : '';
    const withOverlap = prefix ? `${prefix}\n\n${content}` : content;
    return { index: i, content: withOverlap, tokenCount: countTokens(withOverlap) };
  });
}
