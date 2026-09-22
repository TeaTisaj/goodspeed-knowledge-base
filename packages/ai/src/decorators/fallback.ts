import {
  AiProviderError,
  type ChatProvider,
  type ChatRequest,
  type ChatResult,
  type ChatStreamEvent,
} from '../types.js';

export interface FallbackOptions {
  onFallback?: (from: string, to: string, error: AiProviderError) => void;
}

/**
 * Falls back to a secondary provider when the primary fails unrecoverably.
 *
 * Note what is *not* retried here: `bad_request`, `context_length` and
 * `cancelled` are properties of the request, so a second provider would fail
 * identically. Falling back on those turns one fast failure into two slow ones.
 *
 * As with retry, streaming only falls back before the first token.
 */
export class FallbackChatProvider implements ChatProvider {
  readonly id: string;
  readonly model: string;
  readonly capabilities: ChatProvider['capabilities'];

  constructor(
    private readonly primary: ChatProvider,
    private readonly secondary: ChatProvider,
    private readonly opts: FallbackOptions = {},
  ) {
    this.id = primary.id;
    this.model = primary.model;
    // Advertise the intersection: a caller must not rely on a capability the
    // fallback path cannot honour.
    this.capabilities = {
      streaming: primary.capabilities.streaming && secondary.capabilities.streaming,
      toolCalls: primary.capabilities.toolCalls && secondary.capabilities.toolCalls,
      jsonMode: primary.capabilities.jsonMode && secondary.capabilities.jsonMode,
      streamingUsage: primary.capabilities.streamingUsage && secondary.capabilities.streamingUsage,
      maxContextTokens: Math.min(
        primary.capabilities.maxContextTokens,
        secondary.capabilities.maxContextTokens,
      ),
    };
  }

  private shouldFallback(err: unknown): err is AiProviderError {
    if (!(err instanceof AiProviderError)) return false;
    return !['bad_request', 'context_length', 'cancelled', 'unsupported'].includes(err.code);
  }

  async chat(request: ChatRequest): Promise<ChatResult> {
    try {
      return await this.primary.chat(request);
    } catch (err) {
      if (!this.shouldFallback(err)) throw err;
      this.opts.onFallback?.(this.primary.id, this.secondary.id, err);
      return this.secondary.chat(request);
    }
  }

  async *streamChat(request: ChatRequest): AsyncIterable<ChatStreamEvent> {
    let emitted = false;
    try {
      for await (const event of this.primary.streamChat(request)) {
        emitted = true;
        yield event;
      }
      return;
    } catch (err) {
      if (emitted || !this.shouldFallback(err)) throw err;
      this.opts.onFallback?.(this.primary.id, this.secondary.id, err);
    }
    yield* this.secondary.streamChat(request);
  }
}
