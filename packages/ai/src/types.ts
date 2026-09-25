/**
 * The provider-agnostic AI interface.
 *
 * Every target speaks `/v1/chat/completions`, so the wire format is not what
 * breaks on a swap -- capabilities are: Groq has no embeddings endpoint, Ollama
 * emits different vector sizes, not every provider streams usage. Providers
 * declare what they can do, and configuration is validated against that at boot.
 */

// --- shared ---------------------------------------------------------------

export type ChatRole = 'system' | 'user' | 'assistant';

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface ProviderInfo {
  /** Stable identifier, e.g. 'openai'. Recorded on messages for attribution. */
  readonly id: string;
  readonly model: string;
}

// --- capabilities ---------------------------------------------------------

export interface ChatCapabilities {
  /** Gates `streamChat`, which refuses rather than silently buffering. */
  streaming: boolean;
  /** Not read yet (the workflow calls no tools); declared so fallback can intersect them. */
  toolCalls: boolean;
  jsonMode: boolean;
  /** Reports token usage on streamed responses. Several providers do not. */
  streamingUsage: boolean;
  /** The prompt is fitted to `min(this, MAX_CONTEXT_TOKENS)`. */
  maxContextTokens: number;
}

export interface EmbeddingCapabilities {
  /** Fixed output dimensions. Must match the `vector(N)` column. */
  dimensions: number;
  /** Max inputs per request. Batching below this is the fast path. */
  maxBatchSize: number;
  maxInputTokens: number;
  /** Supports OpenAI's Matryoshka `dimensions` parameter for truncation. */
  configurableDimensions: boolean;
}

// --- chat -----------------------------------------------------------------

export interface ChatRequest {
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  /** Cancels the upstream HTTP request when the client disconnects. */
  signal?: AbortSignal;
}

export interface ChatResult {
  text: string;
  usage: TokenUsage;
  finishReason: 'stop' | 'length' | 'content_filter' | 'error' | 'unknown';
  provider: ProviderInfo;
}

/** Tokens, usage and completion as one typed stream, rather than strings plus side channels. */
export type ChatStreamEvent =
  | { type: 'text'; delta: string }
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'done'; finishReason: ChatResult['finishReason'] };

export interface ChatProvider {
  readonly id: string;
  readonly model: string;
  readonly capabilities: ChatCapabilities;

  chat(request: ChatRequest): Promise<ChatResult>;
  streamChat(request: ChatRequest): AsyncIterable<ChatStreamEvent>;
}

// --- embeddings -----------------------------------------------------------

export interface EmbedRequest {
  /** Batch-first, so one request per chunk is never the easy path. */
  texts: string[];
  signal?: AbortSignal;
}

export interface EmbedResult {
  embeddings: number[][];
  usage: Pick<TokenUsage, 'promptTokens' | 'totalTokens'>;
  provider: ProviderInfo;
}

export interface EmbeddingProvider {
  readonly id: string;
  readonly model: string;
  readonly capabilities: EmbeddingCapabilities;

  embed(request: EmbedRequest): Promise<EmbedResult>;
}

// --- errors ---------------------------------------------------------------

/** Vendor errors normalised to a category; `retryable` is decided once, here. */
export type AiErrorCode =
  | 'auth'
  | 'rate_limit'
  | 'timeout'
  | 'context_length'
  | 'bad_request'
  | 'server_error'
  | 'network'
  | 'cancelled'
  | 'unsupported'
  | 'unknown';

export class AiProviderError extends Error {
  readonly code: AiErrorCode;
  readonly providerId: string;
  readonly status?: number;
  readonly retryable: boolean;
  /** Seconds the provider asked us to wait, from Retry-After. */
  readonly retryAfterSeconds?: number;

  constructor(
    message: string,
    opts: {
      code: AiErrorCode;
      providerId: string;
      status?: number;
      retryable?: boolean;
      retryAfterSeconds?: number;
      cause?: unknown;
    },
  ) {
    super(message, { cause: opts.cause });
    this.name = 'AiProviderError';
    this.code = opts.code;
    this.providerId = opts.providerId;
    this.status = opts.status;
    this.retryAfterSeconds = opts.retryAfterSeconds;
    this.retryable =
      opts.retryable ?? ['rate_limit', 'timeout', 'server_error', 'network'].includes(opts.code);
  }
}
