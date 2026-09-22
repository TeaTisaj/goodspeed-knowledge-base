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

export interface RetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Injectable for tests, so retry logic never needs real waiting. */
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function computeBackoff(
  attempt: number,
  opts: Required<Pick<RetryOptions, 'baseDelayMs' | 'maxDelayMs'>>,
  random: () => number,
  retryAfterSeconds?: number,
): number {
  // A provider telling us when to come back beats our own guess.
  if (retryAfterSeconds !== undefined && Number.isFinite(retryAfterSeconds)) {
    return Math.min(retryAfterSeconds * 1000, opts.maxDelayMs);
  }
  const exponential = Math.min(opts.baseDelayMs * 2 ** attempt, opts.maxDelayMs);
  // Full jitter. Without it, concurrent failures retry in lockstep and
  // reproduce the same spike that caused the rate limit.
  return Math.floor(random() * exponential);
}

async function withRetry<T>(
  fn: () => Promise<T>,
  opts: Required<Omit<RetryOptions, 'sleep' | 'random'>> & {
    sleep: (ms: number) => Promise<void>;
    random: () => number;
  },
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const isRetryable = err instanceof AiProviderError && err.retryable;
      if (!isRetryable || attempt === opts.maxRetries) throw err;

      const delay = computeBackoff(
        attempt,
        { baseDelayMs: opts.baseDelayMs, maxDelayMs: opts.maxDelayMs },
        opts.random,
        err instanceof AiProviderError ? err.retryAfterSeconds : undefined,
      );
      await opts.sleep(delay);
    }
  }
  throw lastError;
}

function resolve(opts: RetryOptions) {
  return {
    maxRetries: opts.maxRetries ?? 2,
    baseDelayMs: opts.baseDelayMs ?? 250,
    maxDelayMs: opts.maxDelayMs ?? 8_000,
    sleep: opts.sleep ?? defaultSleep,
    random: opts.random ?? Math.random,
  };
}

/**
 * Retries transient failures with exponential backoff and full jitter.
 *
 * Streaming is deliberately retried only *before the first token*. Once bytes
 * have reached the client, a retry would replay the response from the start and
 * the user would see duplicated text — worse than the original failure.
 */
export class RetryingChatProvider implements ChatProvider {
  readonly id: string;
  readonly model: string;
  readonly capabilities: ChatProvider['capabilities'];
  private readonly opts: ReturnType<typeof resolve>;

  constructor(
    private readonly inner: ChatProvider,
    options: RetryOptions = {},
  ) {
    this.id = inner.id;
    this.model = inner.model;
    this.capabilities = inner.capabilities;
    this.opts = resolve(options);
  }

  chat(request: ChatRequest): Promise<ChatResult> {
    return withRetry(() => this.inner.chat(request), this.opts);
  }

  async *streamChat(request: ChatRequest): AsyncIterable<ChatStreamEvent> {
    let attempt = 0;

    for (;;) {
      let emitted = false;
      try {
        for await (const event of this.inner.streamChat(request)) {
          emitted = true;
          yield event;
        }
        return;
      } catch (err) {
        const retryable = err instanceof AiProviderError && err.retryable;
        if (emitted || !retryable || attempt >= this.opts.maxRetries) throw err;

        const delay = computeBackoff(
          attempt,
          { baseDelayMs: this.opts.baseDelayMs, maxDelayMs: this.opts.maxDelayMs },
          this.opts.random,
          err instanceof AiProviderError ? err.retryAfterSeconds : undefined,
        );
        await this.opts.sleep(delay);
        attempt++;
      }
    }
  }
}

export class RetryingEmbeddingProvider implements EmbeddingProvider {
  readonly id: string;
  readonly model: string;
  readonly capabilities: EmbeddingProvider['capabilities'];
  private readonly opts: ReturnType<typeof resolve>;

  constructor(
    private readonly inner: EmbeddingProvider,
    options: RetryOptions = {},
  ) {
    this.id = inner.id;
    this.model = inner.model;
    this.capabilities = inner.capabilities;
    this.opts = resolve(options);
  }

  embed(request: EmbedRequest): Promise<EmbedResult> {
    return withRetry(() => this.inner.embed(request), this.opts);
  }
}
