import { CachingEmbeddingProvider, type EmbeddingCacheStore } from './decorators/caching.js';
import { FallbackChatProvider } from './decorators/fallback.js';
import { RetryingChatProvider, RetryingEmbeddingProvider } from './decorators/retry.js';
import {
  UsageTrackingChatProvider,
  UsageTrackingEmbeddingProvider,
  type UsageSink,
} from './decorators/usage-tracking.js';
import { FakeChatProvider, FakeEmbeddingProvider } from './providers/fake.js';
import {
  OpenAICompatibleChatProvider,
  OpenAICompatibleEmbeddingProvider,
} from './providers/openai-compatible.js';
import { CHAT_PRESETS, EMBEDDING_PRESETS } from './presets.js';
import type { AiProviderError, ChatProvider, EmbeddingProvider } from './types.js';

export interface ChatProviderConfig {
  provider: string;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  timeoutMs?: number;
  maxRetries?: number;
}

export interface EmbeddingProviderConfig extends ChatProviderConfig {
  dimensions?: number;
}

export class AiConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AiConfigurationError';
  }
}

/**
 * Validates configuration against declared capabilities at boot, so an
 * impossible combination fails with a message naming the fix.
 */
export function validateEmbeddingConfig(config: EmbeddingProviderConfig): void {
  const { provider } = config;

  if (provider === 'fake') return;

  const chatPreset = CHAT_PRESETS[provider as keyof typeof CHAT_PRESETS];
  if (chatPreset && !chatPreset.embeddings) {
    throw new AiConfigurationError(
      `AI_EMBEDDING_PROVIDER="${provider}" is not valid: ${provider} exposes no embeddings ` +
        `endpoint. It works for chat (AI_CHAT_PROVIDER=${provider}); pair it with a provider ` +
        `that does embeddings, such as OpenAI or Ollama. Known embedding providers: ` +
        `${Object.keys(EMBEDDING_PRESETS).join(', ')}.`,
    );
  }

  const preset = EMBEDDING_PRESETS[provider as keyof typeof EMBEDDING_PRESETS];
  if (!preset && !config.baseUrl) {
    throw new AiConfigurationError(
      `Unknown embedding provider "${provider}". Known: ${Object.keys(EMBEDDING_PRESETS).join(', ')}. ` +
        'For any other OpenAI-compatible service, set AI_EMBEDDING_BASE_URL explicitly.',
    );
  }

  if (preset?.requiresApiKey && !config.apiKey) {
    throw new AiConfigurationError(`AI_EMBEDDING_API_KEY is required for provider "${provider}".`);
  }

  const declared = config.dimensions ?? preset?.capabilities.dimensions;
  if (declared && declared > 2000) {
    throw new AiConfigurationError(
      `Embedding dimensions ${declared} exceed pgvector's 2000-dimension limit for HNSW ` +
        'indexes on the `vector` type. Use a smaller model, OpenAI’s `dimensions` ' +
        'parameter, or migrate the column to `halfvec`.',
    );
  }

  if (preset && config.dimensions && config.dimensions !== preset.capabilities.dimensions) {
    if (!preset.capabilities.configurableDimensions) {
      throw new AiConfigurationError(
        `Provider "${provider}" emits ${preset.capabilities.dimensions}-dim vectors and does not ` +
          `support truncation, but AI_EMBEDDING_DIMENSIONS is ${config.dimensions}. ` +
          'These must match, or retrieval silently compares vectors from different spaces.',
      );
    }
  }
}

export function validateChatConfig(config: ChatProviderConfig): void {
  if (config.provider === 'fake') return;

  const preset = CHAT_PRESETS[config.provider as keyof typeof CHAT_PRESETS];
  if (!preset && !config.baseUrl) {
    throw new AiConfigurationError(
      `Unknown chat provider "${config.provider}". Known: ${Object.keys(CHAT_PRESETS).join(', ')}. ` +
        'For any other OpenAI-compatible service, set AI_CHAT_BASE_URL explicitly.',
    );
  }
  if (preset?.requiresApiKey && !config.apiKey) {
    throw new AiConfigurationError(
      `AI_CHAT_API_KEY is required for provider "${config.provider}".`,
    );
  }
}

export interface BuildOptions {
  usageSink?: UsageSink;
  cacheStore?: EmbeddingCacheStore;
  /** Used when the primary chat provider fails unrecoverably. */
  fallback?: ChatProviderConfig;
  onFallback?: (from: string, to: string, error: AiProviderError) => void;
}

function buildBareChat(config: ChatProviderConfig): ChatProvider {
  if (config.provider === 'fake') {
    return new FakeChatProvider({ model: config.model });
  }
  const preset = CHAT_PRESETS[config.provider as keyof typeof CHAT_PRESETS];
  return new OpenAICompatibleChatProvider({
    id: config.provider,
    baseUrl: config.baseUrl ?? preset!.baseUrl,
    apiKey: config.apiKey,
    model: config.model ?? preset?.defaultModel ?? 'unknown',
    capabilities: preset?.capabilities ?? {
      streaming: true,
      toolCalls: false,
      jsonMode: false,
      streamingUsage: false,
      maxContextTokens: 8192,
    },
    timeoutMs: config.timeoutMs,
  });
}

/**
 * usage-tracking( fallback( retry( provider ) ) ). Retry is innermost so a
 * retried call is one request; fallback runs only after retries are exhausted;
 * usage records what the caller actually received.
 */
export function buildChatProvider(
  config: ChatProviderConfig,
  options: BuildOptions = {},
): ChatProvider {
  validateChatConfig(config);

  let provider: ChatProvider = new RetryingChatProvider(buildBareChat(config), {
    maxRetries: config.maxRetries,
  });

  if (options.fallback) {
    validateChatConfig(options.fallback);
    const secondary = new RetryingChatProvider(buildBareChat(options.fallback), {
      maxRetries: options.fallback.maxRetries,
    });
    provider = new FallbackChatProvider(provider, secondary, { onFallback: options.onFallback });
  }

  if (options.usageSink) {
    provider = new UsageTrackingChatProvider(provider, options.usageSink);
  }
  return provider;
}

export function buildEmbeddingProvider(
  config: EmbeddingProviderConfig,
  options: BuildOptions = {},
): EmbeddingProvider {
  validateEmbeddingConfig(config);

  const preset = EMBEDDING_PRESETS[config.provider as keyof typeof EMBEDDING_PRESETS];
  const bare: EmbeddingProvider =
    config.provider === 'fake'
      ? new FakeEmbeddingProvider({ model: config.model, dimensions: config.dimensions })
      : new OpenAICompatibleEmbeddingProvider({
          id: config.provider,
          baseUrl: config.baseUrl ?? preset!.baseUrl,
          apiKey: config.apiKey,
          model: config.model ?? preset?.defaultModel ?? 'unknown',
          capabilities: preset?.capabilities ?? {
            dimensions: config.dimensions ?? 1536,
            maxBatchSize: 64,
            maxInputTokens: 8192,
            // An explicit size is sent as the spec's `dimensions` parameter; a provider
            // that ignores it is caught by the response width check.
            configurableDimensions: config.dimensions !== undefined,
          },
          timeoutMs: config.timeoutMs,
          dimensions: config.dimensions,
        });

  let provider: EmbeddingProvider = new RetryingEmbeddingProvider(bare, {
    maxRetries: config.maxRetries,
  });

  // Cache outside retry: a cache hit should never consume a retry budget.
  if (options.cacheStore) {
    provider = new CachingEmbeddingProvider(provider, options.cacheStore);
  }
  if (options.usageSink) {
    provider = new UsageTrackingEmbeddingProvider(provider, options.usageSink);
  }
  return provider;
}
