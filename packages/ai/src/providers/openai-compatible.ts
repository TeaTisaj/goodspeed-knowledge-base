import OpenAI from 'openai';
import {
  AiProviderError,
  type AiErrorCode,
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

export interface OpenAICompatibleChatOptions {
  id: string;
  baseUrl: string;
  apiKey?: string;
  model: string;
  capabilities: ChatCapabilities;
  timeoutMs?: number;
}

export interface OpenAICompatibleEmbeddingOptions {
  id: string;
  baseUrl: string;
  apiKey?: string;
  model: string;
  capabilities: EmbeddingCapabilities;
  timeoutMs?: number;
  /** Request truncated vectors where the provider supports it (Matryoshka). */
  dimensions?: number;
}

/** Maps vendor errors onto the normalised taxonomy, once, so retry logic never parses vendor shapes. */
function toAiError(err: unknown, providerId: string): AiProviderError {
  if (err instanceof AiProviderError) return err;

  if (err instanceof OpenAI.APIError) {
    const status = err.status;
    let code: AiErrorCode = 'unknown';
    if (status === 401 || status === 403) code = 'auth';
    else if (status === 429) code = 'rate_limit';
    else if (status === 408) code = 'timeout';
    else if (status === 400 && /context length|maximum context|too long/i.test(err.message))
      code = 'context_length';
    // Some providers (Gemini) reject a bad key with 400, not 401. Matched on the
    // message, not the provider id, so the next one needs no branch.
    else if (
      status === 400 &&
      /\b(api[ _-]?key|credential|unauthenticated|unauthorized)\b/i.test(err.message)
    )
      code = 'auth';
    else if (status === 400 || status === 404 || status === 422) code = 'bad_request';
    else if (status && status >= 500) code = 'server_error';

    const header = err.headers instanceof Headers ? err.headers.get('retry-after') : undefined;
    const retryAfter = header ? Number(header) : undefined;

    return new AiProviderError(`[${providerId}] ${err.message}`, {
      code,
      providerId,
      status,
      retryAfterSeconds: Number.isFinite(retryAfter) ? retryAfter : undefined,
      cause: err,
    });
  }

  if (err instanceof OpenAI.APIConnectionTimeoutError) {
    return new AiProviderError(`[${providerId}] request timed out`, {
      code: 'timeout',
      providerId,
      cause: err,
    });
  }
  if (err instanceof OpenAI.APIConnectionError) {
    return new AiProviderError(`[${providerId}] connection failed`, {
      code: 'network',
      providerId,
      cause: err,
    });
  }
  if (err instanceof Error && err.name === 'AbortError') {
    return new AiProviderError(`[${providerId}] request cancelled`, {
      code: 'cancelled',
      providerId,
      retryable: false,
      cause: err,
    });
  }

  return new AiProviderError(`[${providerId}] ${(err as Error)?.message ?? 'unknown error'}`, {
    code: 'unknown',
    providerId,
    cause: err,
  });
}

function makeClient(baseUrl: string, apiKey: string | undefined, timeoutMs: number): OpenAI {
  return new OpenAI({
    baseURL: baseUrl,
    // Providers that need no auth (Ollama) still require a non-empty string
    // for the SDK to construct; it is never sent anywhere meaningful.
    apiKey: apiKey ?? 'not-required',
    timeout: timeoutMs,
    maxRetries: 0, // retries are a decorator's job, not the SDK's
  });
}

/** One adapter for every OpenAI-spec provider; the differences live in presets.ts as data. */
export class OpenAICompatibleChatProvider implements ChatProvider {
  readonly id: string;
  readonly model: string;
  readonly capabilities: ChatCapabilities;
  private readonly client: OpenAI;

  constructor(opts: OpenAICompatibleChatOptions) {
    this.id = opts.id;
    this.model = opts.model;
    this.capabilities = opts.capabilities;
    this.client = makeClient(opts.baseUrl, opts.apiKey, opts.timeoutMs ?? 30_000);
  }

  async chat(request: ChatRequest): Promise<ChatResult> {
    try {
      const res = await this.client.chat.completions.create(
        {
          model: this.model,
          messages: request.messages,
          temperature: request.temperature,
          max_tokens: request.maxTokens,
          stream: false,
        },
        { signal: request.signal },
      );

      const choice = res.choices[0];
      return {
        text: choice?.message?.content ?? '',
        usage: {
          promptTokens: res.usage?.prompt_tokens ?? 0,
          completionTokens: res.usage?.completion_tokens ?? 0,
          totalTokens: res.usage?.total_tokens ?? 0,
        },
        finishReason: mapFinishReason(choice?.finish_reason),
        provider: { id: this.id, model: this.model },
      };
    } catch (err) {
      throw toAiError(err, this.id);
    }
  }

  async *streamChat(request: ChatRequest): AsyncIterable<ChatStreamEvent> {
    if (!this.capabilities.streaming) {
      throw new AiProviderError(`[${this.id}] does not support streaming`, {
        code: 'unsupported',
        providerId: this.id,
        retryable: false,
      });
    }

    let finishReason: ChatResult['finishReason'] = 'unknown';
    try {
      const stream = await this.client.chat.completions.create(
        {
          model: this.model,
          messages: request.messages,
          temperature: request.temperature,
          max_tokens: request.maxTokens,
          stream: true,
          // Only where the provider reports it; asserted per provider by the live suite.
          ...(this.capabilities.streamingUsage ? { stream_options: { include_usage: true } } : {}),
        },
        { signal: request.signal },
      );

      for await (const part of stream) {
        const choice = part.choices[0];
        const delta = choice?.delta?.content;
        if (delta) yield { type: 'text', delta };
        if (choice?.finish_reason) finishReason = mapFinishReason(choice.finish_reason);

        if (part.usage) {
          yield {
            type: 'usage',
            usage: {
              promptTokens: part.usage.prompt_tokens ?? 0,
              completionTokens: part.usage.completion_tokens ?? 0,
              totalTokens: part.usage.total_tokens ?? 0,
            },
          };
        }
      }
      yield { type: 'done', finishReason };
    } catch (err) {
      throw toAiError(err, this.id);
    }
  }
}

export class OpenAICompatibleEmbeddingProvider implements EmbeddingProvider {
  readonly id: string;
  readonly model: string;
  readonly capabilities: EmbeddingCapabilities;
  private readonly client: OpenAI;
  private readonly dimensions?: number;

  constructor(opts: OpenAICompatibleEmbeddingOptions) {
    this.id = opts.id;
    this.model = opts.model;
    this.capabilities = opts.capabilities;
    this.dimensions = opts.dimensions;
    this.client = makeClient(opts.baseUrl, opts.apiKey, opts.timeoutMs ?? 30_000);
  }

  async embed(request: EmbedRequest): Promise<EmbedResult> {
    if (request.texts.length === 0) {
      return {
        embeddings: [],
        usage: { promptTokens: 0, totalTokens: 0 },
        provider: { id: this.id, model: this.model },
      };
    }

    // Respect the provider's batch ceiling rather than letting it 400.
    const batches = chunkArray(request.texts, this.capabilities.maxBatchSize);
    const embeddings: number[][] = [];
    let promptTokens = 0;
    let totalTokens = 0;

    try {
      for (const batch of batches) {
        const res = await this.client.embeddings.create(
          {
            model: this.model,
            input: batch,
            ...(this.dimensions && this.capabilities.configurableDimensions
              ? { dimensions: this.dimensions }
              : {}),
          },
          { signal: request.signal },
        );

        // The API does not guarantee ordering, and it returns an index.
        const sorted = [...res.data].sort((a, b) => a.index - b.index);
        for (const d of sorted) embeddings.push(d.embedding);

        promptTokens += res.usage?.prompt_tokens ?? 0;
        totalTokens += res.usage?.total_tokens ?? 0;
      }
    } catch (err) {
      throw toAiError(err, this.id);
    }

    const expected = this.dimensions ?? this.capabilities.dimensions;
    const actual = embeddings[0]?.length;
    if (actual !== undefined && actual !== expected) {
      // Caught here, not as an opaque pgvector error at insert time.
      throw new AiProviderError(
        `[${this.id}] model "${this.model}" returned ${actual}-dim vectors, expected ${expected}. ` +
          `The vector column and AI_EMBEDDING_DIMENSIONS must match the model.`,
        { code: 'bad_request', providerId: this.id, retryable: false },
      );
    }

    return {
      embeddings,
      usage: { promptTokens, totalTokens },
      provider: { id: this.id, model: this.model },
    };
  }
}

function mapFinishReason(reason?: string | null): ChatResult['finishReason'] {
  switch (reason) {
    case 'stop':
      return 'stop';
    case 'length':
      return 'length';
    case 'content_filter':
      return 'content_filter';
    default:
      return reason ? 'unknown' : 'stop';
  }
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
