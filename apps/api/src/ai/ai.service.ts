import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import {
  buildChatProvider,
  buildEmbeddingProvider,
  type ChatProvider,
  type EmbeddingProvider,
  type UsageEvent,
} from '@kb/ai';
import { ConfigService } from '../config/config.service.js';
import { PostgresEmbeddingCache } from './embedding-cache.store.js';

/**
 * Wires the framework-free AI package into Nest.
 *
 * Providers are constructed once at boot, so an invalid configuration fails
 * startup rather than the first request that happens to need embeddings.
 */
@Injectable()
export class AiService implements OnModuleInit {
  private readonly logger = new Logger(AiService.name);
  private chatProvider!: ChatProvider;
  private embeddingProvider!: EmbeddingProvider;
  private readonly usageBuffer: UsageEvent[] = [];

  constructor(
    private readonly config: ConfigService,
    private readonly cache: PostgresEmbeddingCache,
  ) {}

  onModuleInit(): void {
    const env = this.config.env;

    this.chatProvider = buildChatProvider(
      {
        provider: env.AI_CHAT_PROVIDER,
        model: env.AI_CHAT_MODEL,
        baseUrl: env.AI_CHAT_BASE_URL,
        apiKey: env.AI_CHAT_API_KEY,
        timeoutMs: env.AI_REQUEST_TIMEOUT_MS,
        maxRetries: env.AI_MAX_RETRIES,
      },
      {
        usageSink: (e) => this.usageBuffer.push(e),
        onFallback: (from, to, err) =>
          this.logger.warn(`Chat fell back from ${from} to ${to}: ${err.message}`),
      },
    );

    this.embeddingProvider = buildEmbeddingProvider(
      {
        provider: env.AI_EMBEDDING_PROVIDER,
        model: env.AI_EMBEDDING_MODEL,
        baseUrl: env.AI_EMBEDDING_BASE_URL,
        apiKey: env.AI_EMBEDDING_API_KEY,
        dimensions: env.AI_EMBEDDING_DIMENSIONS,
        timeoutMs: env.AI_REQUEST_TIMEOUT_MS,
        maxRetries: env.AI_MAX_RETRIES,
      },
      { cacheStore: this.cache, usageSink: (e) => this.usageBuffer.push(e) },
    );

    this.logger.log(
      `AI ready: chat=${this.chatProvider.id}/${this.chatProvider.model}, ` +
        `embeddings=${this.embeddingProvider.id}/${this.embeddingProvider.model} ` +
        `(${this.embeddingProvider.capabilities.dimensions}d)`,
    );

    if (this.config.isFullyFake) {
      this.logger.warn(
        'Running with the fake AI provider. Answers are extractive, not generated. ' +
          'Set AI_CHAT_PROVIDER and AI_EMBEDDING_PROVIDER to use a real provider.',
      );
    }
  }

  get chat(): ChatProvider {
    return this.chatProvider;
  }

  get embeddings(): EmbeddingProvider {
    return this.embeddingProvider;
  }

  /** Drains buffered usage events for persistence. */
  drainUsage(): UsageEvent[] {
    return this.usageBuffer.splice(0, this.usageBuffer.length);
  }
}
