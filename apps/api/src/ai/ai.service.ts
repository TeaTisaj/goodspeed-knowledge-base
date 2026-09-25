import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  buildChatProvider,
  buildEmbeddingProvider,
  type ChatProvider,
  type EmbeddingProvider,
  type UsageEvent,
} from '@kb/ai';
import { calibratedRelevanceFloor } from '@kb/rag';
import { ConfigService } from '../config/config.service.js';
import { SupabaseService } from '../supabase/supabase.service.js';
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
  /** Per-request usage buckets, so concurrent users' tokens are never mixed. */
  private readonly usageScope = new AsyncLocalStorage<UsageEvent[]>();

  /** Events emitted outside any scope -- a bug if it grows, so it is counted. */
  private orphanedUsage = 0;

  constructor(
    private readonly config: ConfigService,
    private readonly cache: PostgresEmbeddingCache,
    private readonly supabase: SupabaseService,
  ) {}

  async onModuleInit(): Promise<void> {
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
        usageSink: (e) => this.recordUsage(e),
        fallback: env.AI_CHAT_FALLBACK_PROVIDER
          ? {
              provider: env.AI_CHAT_FALLBACK_PROVIDER,
              model: env.AI_CHAT_FALLBACK_MODEL,
              baseUrl: env.AI_CHAT_FALLBACK_BASE_URL,
              apiKey: env.AI_CHAT_FALLBACK_API_KEY,
              timeoutMs: env.AI_REQUEST_TIMEOUT_MS,
              maxRetries: env.AI_MAX_RETRIES,
            }
          : undefined,
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
      { cacheStore: this.cache, usageSink: (e) => this.recordUsage(e) },
    );

    await this.assertDimensionsMatchSchema();

    this.logger.log(
      `AI ready: chat=${this.chatProvider.id}/${this.chatProvider.model}, ` +
        `embeddings=${this.embeddingProvider.id}/${this.embeddingProvider.model} ` +
        `(${this.embeddingProvider.capabilities.dimensions}d)`,
    );

    // The out-of-scope guard is only as good as its floor, and a floor is only
    // valid for the model it was measured on -- so say which one is in force.
    const floor =
      env.RETRIEVAL_MIN_SIMILARITY ?? calibratedRelevanceFloor(this.embeddingProvider.model);
    if (floor === undefined) {
      this.logger.warn(
        `No relevance floor for embedding model "${this.embeddingProvider.model}": off-topic ` +
          'questions will reach the chat model, whose instructions are then the only guard. ' +
          'Run `pnpm eval --embed=<provider>:<model>` and set RETRIEVAL_MIN_SIMILARITY from its calibration table.',
      );
    } else {
      this.logger.log(
        `Relevance floor: ${floor} (${env.RETRIEVAL_MIN_SIMILARITY === undefined ? 'calibrated' : 'configured'})`,
      );
    }

    if (this.config.isFullyFake) {
      this.logger.warn(
        'Running with the fake AI provider. Answers are extractive, not generated. ' +
          'Set AI_CHAT_PROVIDER and AI_EMBEDDING_PROVIDER to use a real provider.',
      );
    }
  }

  /**
   * Fails startup when AI_EMBEDDING_DIMENSIONS disagrees with the
   * `chunks.embedding` column. A database that cannot answer only warns.
   */
  private async assertDimensionsMatchSchema(): Promise<void> {
    const configured = this.embeddingProvider.capabilities.dimensions;

    const { data, error } = await this.supabase.admin().rpc('embedding_dimensions');
    if (error) {
      this.logger.warn(
        `Could not read the schema's embedding dimension (${error.message}); ` +
          'skipping the startup consistency check.',
      );
      return;
    }

    const schemaDimensions = data as number | null;
    if (schemaDimensions === null) return; // unconstrained column, nothing to check

    if (schemaDimensions !== configured) {
      throw new Error(
        `Embedding dimension mismatch: provider "${this.embeddingProvider.id}" ` +
          `model "${this.embeddingProvider.model}" produces ${configured}-dimension vectors, ` +
          `but chunks.embedding is vector(${schemaDimensions}).\n` +
          `  Fix by one of:\n` +
          `    - set AI_EMBEDDING_DIMENSIONS=${schemaDimensions} and use a model of that size\n` +
          `    - add a migration altering chunks.embedding and embedding_cache.embedding to ` +
          `vector(${configured}), then re-ingest every document\n` +
          `  Vectors from different models are not comparable, so retrieval would return ` +
          `meaningless results rather than failing loudly.`,
      );
    }
  }

  get chat(): ChatProvider {
    return this.chatProvider;
  }

  get embeddings(): EmbeddingProvider {
    return this.embeddingProvider;
  }

  private recordUsage(event: UsageEvent): void {
    const bucket = this.usageScope.getStore();
    if (bucket) {
      bucket.push(event);
      return;
    }
    // Dropped, not parked: a parked event would be charged to the next request.
    this.orphanedUsage += 1;
    this.logger.debug(`Usage event outside any scope (${this.orphanedUsage} total)`);
  }

  /**
   * Opens a usage bucket for the current request. `enterWith`, not `run`, so it
   * survives every resumption of a streaming generator.
   */
  beginUsageScope(): UsageEvent[] {
    const events: UsageEvent[] = [];
    this.usageScope.enterWith(events);
    return events;
  }

  /** Runs `fn` with its own usage bucket. For ordinary non-streaming callers. */
  async collectUsage<T>(fn: () => Promise<T>): Promise<{ value: T; events: UsageEvent[] }> {
    const events: UsageEvent[] = [];
    const value = await this.usageScope.run(events, fn);
    return { value, events };
  }
}
