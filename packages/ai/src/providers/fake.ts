import {
  type ChatCapabilities,
  type ChatProvider,
  type ChatRequest,
  type ChatResult,
  type ChatStreamEvent,
  type EmbedRequest,
  type EmbedResult,
  type EmbeddingCapabilities,
  type EmbeddingProvider,
} from '../types.js';

/**
 * Deterministic, offline provider. No credentials, no network.
 *
 * It has three jobs, and the third is what shapes the design:
 *   1. the app runs for a reviewer who has no API keys,
 *   2. it is the test double for every unit test,
 *   3. CI runs the retrieval eval without secrets.
 *
 * Because of (1) and (3), embeddings cannot be random. A hash-to-random-vector
 * fake produces vectors with no relationship to the text, so retrieval returns
 * arbitrary chunks — the demo looks broken and the eval measures noise.
 *
 * Instead this is a **hashing vectorizer**: tokens are hashed into buckets and
 * the vector is L2-normalised, so cosine similarity approximates lexical
 * overlap. It is not semantic — "car" and "automobile" stay unrelated — but it
 * is a real, monotonic similarity signal, which is enough for the demo to
 * behave sensibly and for the eval to produce a meaningful baseline.
 */

const FNV_OFFSET = 2166136261;
const FNV_PRIME = 16777619;

function hash32(s: string): number {
  let h = FNV_OFFSET;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, FNV_PRIME);
  }
  return h >>> 0;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1);
}

/** Hashing vectorizer with sublinear term-frequency scaling. */
export function hashingVector(text: string, dims: number): number[] {
  const v = new Array<number>(dims).fill(0);
  const tokens = tokenize(text);

  for (const token of tokens) {
    const h = hash32(token);
    const bucket = h % dims;
    // Signed hashing: halves collision bias by letting collisions cancel.
    const sign = (h >>> 31) & 1 ? -1 : 1;
    v[bucket] = (v[bucket] ?? 0) + sign;
  }

  // Sublinear scaling, so one repeated word cannot dominate the vector.
  for (let i = 0; i < dims; i++) {
    const x = v[i] ?? 0;
    v[i] = x === 0 ? 0 : Math.sign(x) * (1 + Math.log(Math.abs(x)));
  }

  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  if (norm === 0) {
    // Empty or stop-word-only text still needs a valid unit vector, or
    // pgvector rejects the insert.
    v[0] = 1;
    return v;
  }
  return v.map((x) => x / norm);
}

interface ParsedSource {
  number: number;
  title: string;
  body: string;
}

/**
 * Extracts the numbered source blocks from a built prompt.
 *
 * Kept tolerant on purpose: if the prompt format changes and nothing matches,
 * the caller returns a "no answer" response rather than quietly falling back to
 * quoting the instructions.
 */
function parseSources(system: string): ParsedSource[] {
  const marker = system.indexOf('Sources:');
  if (marker === -1) return [];

  const body = system.slice(marker + 'Sources:'.length);
  const out: ParsedSource[] = [];
  const pattern = /\[(\d{1,2})\]\s*([^\n]*)\n([\s\S]*?)(?=\n\[\d{1,2}\]\s|$)/g;

  for (const m of body.matchAll(pattern)) {
    out.push({ number: Number(m[1]), title: (m[2] ?? '').trim(), body: (m[3] ?? '').trim() });
  }
  return out;
}

export interface FakeChatOptions {
  id?: string;
  model?: string;
  /** Delay between streamed tokens, so streaming UI can be exercised. */
  streamDelayMs?: number;
}

export class FakeChatProvider implements ChatProvider {
  readonly id: string;
  readonly model: string;
  readonly capabilities: ChatCapabilities = {
    streaming: true,
    toolCalls: false,
    jsonMode: true,
    streamingUsage: true,
    maxContextTokens: 128_000,
  };
  private readonly streamDelayMs: number;

  constructor(opts: FakeChatOptions = {}) {
    this.id = opts.id ?? 'fake';
    this.model = opts.model ?? 'fake-chat-v1';
    this.streamDelayMs = opts.streamDelayMs ?? 0;
  }

  async chat(request: ChatRequest): Promise<ChatResult> {
    const text = this.compose(request);
    return {
      text,
      usage: this.estimateUsage(request, text),
      finishReason: 'stop',
      provider: { id: this.id, model: this.model },
    };
  }

  async *streamChat(request: ChatRequest): AsyncIterable<ChatStreamEvent> {
    const text = this.compose(request);
    const parts = text.match(/\S+\s*/g) ?? [];

    for (const part of parts) {
      if (request.signal?.aborted) {
        yield { type: 'done', finishReason: 'error' };
        return;
      }
      yield { type: 'text', delta: part };
      if (this.streamDelayMs > 0) {
        await new Promise((r) => setTimeout(r, this.streamDelayMs));
      }
    }

    yield { type: 'usage', usage: this.estimateUsage(request, text) };
    yield { type: 'done', finishReason: 'stop' };
  }

  /**
   * Extractive, not generative: it answers from the retrieved sources in the
   * prompt and cites them.
   *
   * Two details matter for the zero-key demo to be honest:
   *
   *  - Only the numbered source blocks are searched, never the instruction
   *    preamble. Otherwise the "answer" is the system prompt read back, which
   *    looks broken and tells a reviewer nothing.
   *  - It emits real `[n]` citation markers, so the citation resolution and the
   *    clickable-source UI are exercised without any API key.
   */
  private compose(request: ChatRequest): string {
    const question = [...request.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
    const system = request.messages.find((m) => m.role === 'system')?.content ?? '';

    const sources = parseSources(system);
    const queryTerms = new Set(tokenize(question));

    if (queryTerms.size === 0 || sources.length === 0) {
      return 'I could not find anything in your documents that answers that.';
    }

    const scored: { sentence: string; source: number; score: number }[] = [];
    for (const source of sources) {
      const sentences = source.body
        .split(/(?<=[.!?])\s+/)
        .map((x) => x.trim())
        .filter((x) => x.length > 0);

      for (const sentence of sentences) {
        const terms = tokenize(sentence);
        // Filter on token count, not characters: "A deploy takes eight
        // minutes." is 29 characters and is exactly the kind of short, factual
        // sentence a user asks about.
        if (terms.length < 4) continue;
        const overlap = terms.filter((t) => queryTerms.has(t)).length;
        if (overlap === 0) continue;
        scored.push({
          sentence,
          source: source.number,
          score: overlap / Math.sqrt(terms.length),
        });
      }
    }

    if (scored.length === 0) {
      return 'The sources provided do not contain an answer to that question.';
    }

    scored.sort((a, b) => b.score - a.score);
    return scored
      .slice(0, 3)
      .map((s) => `${s.sentence} [${s.source}]`)
      .join(' ');
  }

  private estimateUsage(request: ChatRequest, output: string) {
    // ~4 characters per token is close enough for a fake.
    const promptChars = request.messages.reduce((n, m) => n + m.content.length, 0);
    const promptTokens = Math.ceil(promptChars / 4);
    const completionTokens = Math.ceil(output.length / 4);
    return { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens };
  }
}

export interface FakeEmbeddingOptions {
  id?: string;
  model?: string;
  dimensions?: number;
}

export class FakeEmbeddingProvider implements EmbeddingProvider {
  readonly id: string;
  readonly model: string;
  readonly capabilities: EmbeddingCapabilities;

  constructor(opts: FakeEmbeddingOptions = {}) {
    this.id = opts.id ?? 'fake';
    this.model = opts.model ?? 'fake-embed-v1';
    this.capabilities = {
      dimensions: opts.dimensions ?? 1536,
      maxBatchSize: 512,
      maxInputTokens: 8192,
      configurableDimensions: true,
    };
  }

  async embed(request: EmbedRequest): Promise<EmbedResult> {
    const dims = this.capabilities.dimensions;
    const embeddings = request.texts.map((t) => hashingVector(t, dims));
    const totalTokens = request.texts.reduce((n, t) => n + Math.ceil(t.length / 4), 0);
    return {
      embeddings,
      usage: { promptTokens: totalTokens, totalTokens },
      provider: { id: this.id, model: this.model },
    };
  }
}
