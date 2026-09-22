import { describe, expect, it, vi } from 'vitest';
import {
  AiProviderError,
  type ChatProvider,
  type ChatRequest,
  type ChatResult,
  type ChatStreamEvent,
  type EmbedRequest,
  type EmbedResult,
  type EmbeddingProvider,
} from '../types.js';
import { CachingEmbeddingProvider, MemoryEmbeddingCache, contentHash } from './caching.js';
import { FallbackChatProvider } from './fallback.js';
import { RetryingChatProvider, computeBackoff } from './retry.js';
import { UsageTrackingChatProvider, estimateCostUsd } from './usage-tracking.js';

const caps = {
  streaming: true,
  toolCalls: false,
  jsonMode: false,
  streamingUsage: true,
  maxContextTokens: 8192,
};

/** Fails a set number of times, then succeeds. Records call count. */
class FlakyChat implements ChatProvider {
  readonly id = 'flaky';
  readonly model = 'm';
  readonly capabilities = caps;
  calls = 0;

  constructor(
    private readonly failures: number,
    private readonly error: AiProviderError,
  ) {}

  async chat(_r: ChatRequest): Promise<ChatResult> {
    this.calls++;
    if (this.calls <= this.failures) throw this.error;
    return {
      text: 'ok',
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      finishReason: 'stop',
      provider: { id: this.id, model: this.model },
    };
  }

  async *streamChat(_r: ChatRequest): AsyncIterable<ChatStreamEvent> {
    this.calls++;
    if (this.calls <= this.failures) throw this.error;
    yield { type: 'text', delta: 'ok' };
    yield { type: 'done', finishReason: 'stop' };
  }
}

/** Throws after emitting a token, to test mid-stream behaviour. */
class MidStreamFailChat implements ChatProvider {
  readonly id = 'midfail';
  readonly model = 'm';
  readonly capabilities = caps;
  calls = 0;

  async chat(): Promise<ChatResult> {
    throw new Error('not used');
  }

  async *streamChat(): AsyncIterable<ChatStreamEvent> {
    this.calls++;
    yield { type: 'text', delta: 'partial' };
    throw new AiProviderError('died mid-stream', { code: 'server_error', providerId: this.id });
  }
}

const rateLimit = new AiProviderError('429', { code: 'rate_limit', providerId: 'flaky' });
const badRequest = new AiProviderError('400', { code: 'bad_request', providerId: 'flaky' });

const noSleep = { sleep: async () => {}, random: () => 1 };

describe('RetryingChatProvider', () => {
  it('retries retryable failures and eventually succeeds', async () => {
    const inner = new FlakyChat(2, rateLimit);
    const p = new RetryingChatProvider(inner, { maxRetries: 3, ...noSleep });
    const res = await p.chat({ messages: [] });
    expect(res.text).toBe('ok');
    expect(inner.calls).toBe(3);
  });

  it('does not retry non-retryable failures', async () => {
    const inner = new FlakyChat(5, badRequest);
    const p = new RetryingChatProvider(inner, { maxRetries: 3, ...noSleep });
    await expect(p.chat({ messages: [] })).rejects.toThrow('400');
    expect(inner.calls).toBe(1);
  });

  it('gives up after maxRetries and surfaces the last error', async () => {
    const inner = new FlakyChat(99, rateLimit);
    const p = new RetryingChatProvider(inner, { maxRetries: 2, ...noSleep });
    await expect(p.chat({ messages: [] })).rejects.toThrow('429');
    expect(inner.calls).toBe(3); // initial + 2 retries
  });

  it('retries a stream that fails before any token is emitted', async () => {
    const inner = new FlakyChat(1, rateLimit);
    const p = new RetryingChatProvider(inner, { maxRetries: 2, ...noSleep });
    const events: ChatStreamEvent[] = [];
    for await (const e of p.streamChat({ messages: [] })) events.push(e);
    expect(events.at(-1)?.type).toBe('done');
    expect(inner.calls).toBe(2);
  });

  it('never retries once tokens have reached the client', async () => {
    // Retrying here would replay the response and duplicate visible text,
    // which is worse for the user than surfacing the error.
    const inner = new MidStreamFailChat();
    const p = new RetryingChatProvider(inner, { maxRetries: 3, ...noSleep });

    const events: ChatStreamEvent[] = [];
    await expect(async () => {
      for await (const e of p.streamChat({ messages: [] })) events.push(e);
    }).rejects.toThrow('died mid-stream');

    expect(inner.calls).toBe(1);
    expect(events).toHaveLength(1);
  });

  it('honours Retry-After over its own backoff', () => {
    const delay = computeBackoff(0, { baseDelayMs: 100, maxDelayMs: 60_000 }, () => 1, 5);
    expect(delay).toBe(5000);
  });

  it('caps Retry-After at maxDelayMs', () => {
    const delay = computeBackoff(0, { baseDelayMs: 100, maxDelayMs: 2_000 }, () => 1, 300);
    expect(delay).toBe(2000);
  });

  it('applies jitter so concurrent clients do not retry in lockstep', () => {
    const a = computeBackoff(3, { baseDelayMs: 100, maxDelayMs: 60_000 }, () => 0.1);
    const b = computeBackoff(3, { baseDelayMs: 100, maxDelayMs: 60_000 }, () => 0.9);
    expect(a).not.toBe(b);
    expect(a).toBeLessThan(b);
  });

  it('grows the delay exponentially with attempt number', () => {
    const d0 = computeBackoff(0, { baseDelayMs: 100, maxDelayMs: 60_000 }, () => 1);
    const d3 = computeBackoff(3, { baseDelayMs: 100, maxDelayMs: 60_000 }, () => 1);
    expect(d3).toBeGreaterThan(d0);
    expect(d3).toBe(800);
  });
});

class CountingEmbeddings implements EmbeddingProvider {
  readonly id = 'counting';
  readonly model = 'm';
  readonly capabilities = {
    dimensions: 4,
    maxBatchSize: 100,
    maxInputTokens: 100,
    configurableDimensions: false,
  };
  embeddedTexts: string[] = [];

  async embed(request: EmbedRequest): Promise<EmbedResult> {
    this.embeddedTexts.push(...request.texts);
    return {
      embeddings: request.texts.map((t) => [t.length, 0, 0, 0]),
      usage: { promptTokens: request.texts.length, totalTokens: request.texts.length },
      provider: { id: this.id, model: this.model },
    };
  }
}

describe('CachingEmbeddingProvider', () => {
  it('sends only cache misses to the provider', async () => {
    const inner = new CountingEmbeddings();
    const p = new CachingEmbeddingProvider(inner, new MemoryEmbeddingCache());

    await p.embed({ texts: ['a', 'b', 'c'] });
    await p.embed({ texts: ['a', 'b', 'd'] });

    expect(inner.embeddedTexts).toEqual(['a', 'b', 'c', 'd']);
    expect(p.stats).toEqual({ hits: 2, misses: 4 });
  });

  it('preserves input order when a batch mixes hits and misses', async () => {
    const inner = new CountingEmbeddings();
    const p = new CachingEmbeddingProvider(inner, new MemoryEmbeddingCache());

    await p.embed({ texts: ['bb'] });
    const res = await p.embed({ texts: ['aaa', 'bb', 'cccc'] });

    expect(res.embeddings.map((e) => e[0])).toEqual([3, 2, 4]);
  });

  it('deduplicates repeated text within one batch', async () => {
    const inner = new CountingEmbeddings();
    const p = new CachingEmbeddingProvider(inner, new MemoryEmbeddingCache());

    const res = await p.embed({ texts: ['same', 'same', 'same'] });
    expect(inner.embeddedTexts).toEqual(['same']);
    expect(res.embeddings).toHaveLength(3);
    expect(res.embeddings[0]).toEqual(res.embeddings[2]);
  });

  it('keys the cache by model, so switching models cannot mix vector spaces', async () => {
    const store = new MemoryEmbeddingCache();
    const a = new CountingEmbeddings();
    const b = new CountingEmbeddings();
    Object.defineProperty(b, 'model', { value: 'other-model' });

    await new CachingEmbeddingProvider(a, store).embed({ texts: ['x'] });
    await new CachingEmbeddingProvider(b, store).embed({ texts: ['x'] });

    expect(a.embeddedTexts).toEqual(['x']);
    expect(b.embeddedTexts).toEqual(['x']);
  });

  it('hashes content stably', () => {
    expect(contentHash('hello')).toBe(contentHash('hello'));
    expect(contentHash('hello')).not.toBe(contentHash('hellp'));
  });
});

class AlwaysFailsChat implements ChatProvider {
  readonly id = 'primary';
  readonly model = 'm';
  readonly capabilities = caps;
  constructor(private readonly error: AiProviderError) {}
  async chat(): Promise<ChatResult> {
    throw this.error;
  }
  // eslint-disable-next-line require-yield -- fails before emitting anything, by design
  async *streamChat(): AsyncIterable<ChatStreamEvent> {
    throw this.error;
  }
}

class OkChat implements ChatProvider {
  readonly id = 'secondary';
  readonly model = 'm';
  readonly capabilities = caps;
  async chat(): Promise<ChatResult> {
    return {
      text: 'from secondary',
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      finishReason: 'stop',
      provider: { id: this.id, model: this.model },
    };
  }
  async *streamChat(): AsyncIterable<ChatStreamEvent> {
    yield { type: 'text', delta: 'from secondary' };
    yield { type: 'done', finishReason: 'stop' };
  }
}

describe('FallbackChatProvider', () => {
  it('falls back when the primary fails transiently', async () => {
    const onFallback = vi.fn();
    const p = new FallbackChatProvider(
      new AlwaysFailsChat(
        new AiProviderError('boom', { code: 'server_error', providerId: 'primary' }),
      ),
      new OkChat(),
      { onFallback },
    );
    const res = await p.chat({ messages: [] });
    expect(res.text).toBe('from secondary');
    expect(onFallback).toHaveBeenCalledOnce();
  });

  it('does not fall back on request-shaped errors', async () => {
    // A second provider would reject an over-long prompt identically, so
    // falling back just doubles the latency before the same failure.
    const p = new FallbackChatProvider(
      new AlwaysFailsChat(
        new AiProviderError('too long', { code: 'context_length', providerId: 'primary' }),
      ),
      new OkChat(),
    );
    await expect(p.chat({ messages: [] })).rejects.toThrow('too long');
  });

  it('does not fall back on cancellation', async () => {
    const p = new FallbackChatProvider(
      new AlwaysFailsChat(
        new AiProviderError('aborted', { code: 'cancelled', providerId: 'primary' }),
      ),
      new OkChat(),
    );
    await expect(p.chat({ messages: [] })).rejects.toThrow('aborted');
  });

  it('advertises the intersection of both providers’ capabilities', () => {
    const limited = new OkChat();
    Object.defineProperty(limited, 'capabilities', {
      value: { ...caps, toolCalls: false, maxContextTokens: 4096 },
    });
    const rich = new OkChat();
    Object.defineProperty(rich, 'capabilities', {
      value: { ...caps, toolCalls: true, maxContextTokens: 128_000 },
    });

    const p = new FallbackChatProvider(rich, limited);
    expect(p.capabilities.toolCalls).toBe(false);
    expect(p.capabilities.maxContextTokens).toBe(4096);
  });

  it('falls back on a stream that fails before any token', async () => {
    const p = new FallbackChatProvider(
      new AlwaysFailsChat(new AiProviderError('down', { code: 'network', providerId: 'primary' })),
      new OkChat(),
    );
    const events: ChatStreamEvent[] = [];
    for await (const e of p.streamChat({ messages: [] })) events.push(e);
    expect(events.some((e) => e.type === 'text' && e.delta === 'from secondary')).toBe(true);
  });
});

describe('usage tracking', () => {
  it('records usage and latency for a completed chat', async () => {
    const events: unknown[] = [];
    const p = new UsageTrackingChatProvider(new OkChat(), (e) => events.push(e));
    await p.chat({ messages: [] });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ operation: 'chat', totalTokens: 2 });
  });

  it('records usage after a stream completes', async () => {
    const events: unknown[] = [];
    const p = new UsageTrackingChatProvider(new OkChat(), (e) => events.push(e));
    for await (const _ of p.streamChat({ messages: [] })) {
      /* drain */
    }
    expect(events).toHaveLength(1);
  });

  it('prices known models and returns zero for unknown ones', () => {
    const usage = { promptTokens: 1_000_000, completionTokens: 0, totalTokens: 1_000_000 };
    expect(estimateCostUsd('text-embedding-3-small', usage)).toBeCloseTo(0.02, 6);
    // A fabricated price in a cost view is worse than a visible zero.
    expect(estimateCostUsd('some-unknown-model', usage)).toBe(0);
  });
});
