import type {
  ChatProvider,
  ChatRequest,
  ChatResult,
  ChatStreamEvent,
  EmbedRequest,
  EmbedResult,
  EmbeddingProvider,
  TokenUsage,
} from '../types.js';

export interface UsageEvent {
  operation: 'chat' | 'embed';
  providerId: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  latencyMs: number;
  estimatedCostUsd: number;
}

export type UsageSink = (event: UsageEvent) => void;

/**
 * USD per million tokens. Pricing is provider configuration, not application
 * logic, which is why it lives beside the provider abstraction. Unknown models
 * cost 0 rather than guessing — an invented number in a cost view is worse than
 * a visible zero.
 */
export const PRICING: Record<string, { inputPerMillion: number; outputPerMillion: number }> = {
  'text-embedding-3-small': { inputPerMillion: 0.02, outputPerMillion: 0 },
  'text-embedding-3-large': { inputPerMillion: 0.13, outputPerMillion: 0 },
};

export function estimateCostUsd(model: string, usage: TokenUsage): number {
  const p = PRICING[model];
  if (!p) return 0;
  return (
    (usage.promptTokens / 1_000_000) * p.inputPerMillion +
    (usage.completionTokens / 1_000_000) * p.outputPerMillion
  );
}

export class UsageTrackingChatProvider implements ChatProvider {
  readonly id: string;
  readonly model: string;
  readonly capabilities: ChatProvider['capabilities'];

  constructor(
    private readonly inner: ChatProvider,
    private readonly sink: UsageSink,
  ) {
    this.id = inner.id;
    this.model = inner.model;
    this.capabilities = inner.capabilities;
  }

  async chat(request: ChatRequest): Promise<ChatResult> {
    const started = Date.now();
    const result = await this.inner.chat(request);
    this.sink({
      operation: 'chat',
      providerId: this.id,
      model: this.model,
      ...result.usage,
      latencyMs: Date.now() - started,
      estimatedCostUsd: estimateCostUsd(this.model, result.usage),
    });
    return result;
  }

  async *streamChat(request: ChatRequest): AsyncIterable<ChatStreamEvent> {
    const started = Date.now();
    let usage: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

    for await (const event of this.inner.streamChat(request)) {
      if (event.type === 'usage') usage = event.usage;
      yield event;
    }

    this.sink({
      operation: 'chat',
      providerId: this.id,
      model: this.model,
      ...usage,
      latencyMs: Date.now() - started,
      estimatedCostUsd: estimateCostUsd(this.model, usage),
    });
  }
}

export class UsageTrackingEmbeddingProvider implements EmbeddingProvider {
  readonly id: string;
  readonly model: string;
  readonly capabilities: EmbeddingProvider['capabilities'];

  constructor(
    private readonly inner: EmbeddingProvider,
    private readonly sink: UsageSink,
  ) {
    this.id = inner.id;
    this.model = inner.model;
    this.capabilities = inner.capabilities;
  }

  async embed(request: EmbedRequest): Promise<EmbedResult> {
    const started = Date.now();
    const result = await this.inner.embed(request);
    const usage: TokenUsage = {
      promptTokens: result.usage.promptTokens,
      completionTokens: 0,
      totalTokens: result.usage.totalTokens,
    };
    this.sink({
      operation: 'embed',
      providerId: this.id,
      model: this.model,
      ...usage,
      latencyMs: Date.now() - started,
      estimatedCostUsd: estimateCostUsd(this.model, usage),
    });
    return result;
  }
}
