/**
 * The provider-agnostic AI interface.
 *
 * Design note, because this is the part worth arguing about:
 *
 * "Swappable via config" is easy to satisfy badly. The OpenAI SDK already
 * accepts a `baseURL`, so pointing it at Groq is a config field, not an
 * abstraction. What actually breaks when you swap providers is not the wire
 * format — they all implement `/v1/chat/completions` — it is the *capability*
 * surface: Groq has no embeddings endpoint at all, Ollama's models emit
 * different vector dimensions, and not every provider streams usage data.
 *
 * So capability is what this interface models. Providers declare what they can
 * do, configuration is validated against those declarations at boot, and an
 * impossible combination fails on startup with an actionable message instead of
 * at 2am on the first request that needs it.
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
  /**
   * Declared but not yet branched on: this workflow makes no tool calls and
   * requests no JSON, so nothing reads these two today. They are here because
   * the fallback decorator has to intersect capabilities across two providers,
   * and a capability absent from the type cannot be intersected -- the moment
   * a tool-using path is added, the answer for every provider is already
   * recorded rather than rediscovered. Called out so a reader does not mistake
   * unused for unconsidered.
   */
  toolCalls: boolean;
  jsonMode: boolean;
  /** Reports token usage on streamed responses. Several providers do not. */
  streamingUsage: boolean;
  /**
   * Upper bound on the request. Read by the chat workflow, which fits the
   * prompt to `min(this, MAX_CONTEXT_TOKENS)` -- so swapping a 400k model for
   * an 8k one moves the budget without touching configuration.
   */
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

/**
 * A discriminated union rather than a bare string stream: callers need to
 * distinguish a token from usage data from a terminal error, and a stream that
 * yields only strings forces that distinction into out-of-band state.
 */
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
  /**
   * Batch-first on purpose. Embedding endpoints accept arrays, and embedding
   * one string per HTTP round trip is the single most common ingestion
   * performance bug. An interface should make the fast path the obvious one.
   */
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

/**
 * Provider failures are normalised so callers can act on a category rather
 * than parsing vendor-specific error shapes. `retryable` is decided here, at
 * the point where the provider's semantics are known, instead of being
 * re-derived by every retry policy.
 */
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
