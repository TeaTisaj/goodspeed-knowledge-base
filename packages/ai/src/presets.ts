import type { ChatCapabilities, EmbeddingCapabilities } from './types.js';

/**
 * Provider presets.
 *
 * Every provider here speaks the same wire protocol, so writing five classes
 * would produce five copies of the same request/response handling. What differs
 * is the endpoint and what the endpoint can do — which is data, so it lives in
 * a table rather than in a type hierarchy.
 *
 * Adding a provider that follows the OpenAI spec means adding a row here. No
 * application code changes, which is exactly what the requirement asks for.
 */

export interface ChatPreset {
  id: string;
  baseUrl: string;
  defaultModel: string;
  /** Whether an API key is required. Ollama runs unauthenticated locally. */
  requiresApiKey: boolean;
  capabilities: ChatCapabilities;
  /**
   * Whether this provider also exposes an embeddings endpoint.
   *
   * Data, not a name check. The factory used to reject Groq for embeddings with
   * `provider === 'groq'`, which made the one example the capability model
   * exists to demonstrate the one case that was hardcoded. A new chat-only
   * provider needs this flag, not another branch.
   */
  embeddings: boolean;
  notes?: string;
}

export interface EmbeddingPreset {
  id: string;
  baseUrl: string;
  defaultModel: string;
  requiresApiKey: boolean;
  capabilities: EmbeddingCapabilities;
  notes?: string;
}

export const CHAT_PRESETS = {
  openai: {
    id: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-5.6',
    requiresApiKey: true,
    embeddings: true,
    capabilities: {
      streaming: true,
      toolCalls: true,
      jsonMode: true,
      streamingUsage: true,
      maxContextTokens: 400_000,
    },
    notes:
      'Targets /v1/chat/completions, not the Responses API. Responses is OpenAI-only; ' +
      'Chat Completions is what every other provider here implements.',
  },
  groq: {
    id: 'groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    /**
     * Was `llama-3.3-70b-versatile`, which Groq has since retired — the live
     * suite found it returning 404 for every call. Groq's catalogue as of
     * 2026-09-25 is reasoning models only (`openai/gpt-oss-*`, `qwen/qwen3.8`);
     * there is no Llama chat model left to point at.
     *
     * A dead default is worse than no default: the provider looks configured,
     * boots cleanly, and fails on the first question. The weekly drift workflow
     * exists for exactly this, but only the credentialed contract suite can see
     * it — a keyless probe cannot tell a retired model from a rejected key.
     */
    defaultModel: 'openai/gpt-oss-20b',
    requiresApiKey: true,
    embeddings: false,
    capabilities: {
      streaming: true,
      toolCalls: true,
      jsonMode: true,
      streamingUsage: true,
      maxContextTokens: 128_000,
    },
    notes:
      'Chat only. Groq exposes no embeddings endpoint — see EMBEDDING_PRESETS, and the live ' +
      'suite confirms /models lists no embedding model. NOTE: every Groq chat model is now a ' +
      'reasoning model. Reasoning tokens are drawn from the *completion* budget before any ' +
      'visible content, so a small max_tokens returns `content: ""` with finish_reason ' +
      '"length" — a blank answer and no error. Budget at least a few hundred tokens for an ' +
      'answer here. The models also return a non-standard `reasoning` field, which this ' +
      'adapter ignores; only `content` is read.',
  },
  together: {
    id: 'together',
    baseUrl: 'https://api.together.xyz/v1',
    defaultModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
    requiresApiKey: true,
    embeddings: true,
    capabilities: {
      streaming: true,
      toolCalls: true,
      jsonMode: true,
      streamingUsage: true,
      maxContextTokens: 128_000,
    },
  },
  openrouter: {
    id: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'openai/gpt-5.6',
    requiresApiKey: true,
    embeddings: true,
    capabilities: {
      streaming: true,
      toolCalls: true,
      jsonMode: true,
      streamingUsage: true,
      maxContextTokens: 128_000,
    },
    notes: 'Routes to many upstreams; capabilities vary by selected model.',
  },
  gemini: {
    id: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    defaultModel: 'gemini-3.8-flash',
    requiresApiKey: true,
    embeddings: true,
    capabilities: {
      streaming: true,
      toolCalls: true,
      jsonMode: true,
      /**
       * Verified true against the live endpoint, 2026-09-25.
       *
       * This was `false` and the comment called it conservative: Google
       * documents the OpenAI surface as compatible but does not document
       * `stream_options.include_usage`, so the reasoning was that a missing
       * token count is cheaper than a 400 mid-answer. Sound reasoning, wrong
       * answer -- Gemini accepts the option and returns usage. The "cheap"
       * direction was not cheap either: it silently recorded every streamed
       * Gemini answer as zero tokens, exactly as Ollama's row did.
       *
       * Two presets made the same undocumented-so-assume-no call and both were
       * wrong, which is the argument for asserting capabilities against the
       * endpoint rather than reasoning about the vendor's docs.
       */
      streamingUsage: true,
      maxContextTokens: 1_000_000,
    },
    notes:
      'Google exposes an OpenAI-compatible surface at /v1beta/openai/. The trailing slash ' +
      'matters — the OpenAI SDK joins paths onto it.',
  },
  mistral: {
    id: 'mistral',
    baseUrl: 'https://api.mistral.ai/v1',
    /**
     * Was `mistral-large-latest`, which is no longer in Mistral's catalogue --
     * `GET /v1/models` does not list it, and calling it returns 403 "not
     * available in your subscription tier". The second dead default the live
     * suite found in one run, after Groq's; a preset's default model is the
     * field most likely to rot, because vendors retire models far faster than
     * they move endpoints.
     *
     * `mistral-small-latest` is the safer default: it is what a free key can
     * actually reach. `mistral-medium-latest` is the quality option for a paid
     * account and is a one-line AI_CHAT_MODEL override.
     */
    defaultModel: 'mistral-small-latest',
    requiresApiKey: true,
    embeddings: true,
    capabilities: {
      streaming: true,
      toolCalls: true,
      jsonMode: true,
      // Unverified: Mistral's free tier rate-limited every probe attempt, so
      // this is still an assumption rather than a measurement. Left false,
      // which is the direction that costs a token count rather than a failed
      // request. `pnpm test:live` with a paid key will settle it -- and given
      // that both other `false` rows here turned out to be wrong, expect it to
      // flip.
      streamingUsage: false,
      maxContextTokens: 128_000,
    },
    notes:
      'The free tier rate-limits aggressively (429 within a couple of requests), so a live ' +
      'run against it is flaky by nature rather than by defect.',
  },
  ollama: {
    id: 'ollama',
    baseUrl: 'http://localhost:11434/v1',
    defaultModel: 'llama3.2',
    requiresApiKey: false,
    embeddings: true,
    capabilities: {
      streaming: true,
      toolCalls: false,
      jsonMode: true,
      /**
       * Verified true against Ollama 0.34.4, not assumed.
       *
       * This row said `false`, on the grounds that Ollama rejects unknown
       * stream options. That was true of older builds and is not true now:
       * 0.34.4 accepts `stream_options` (it ignores even a bogus field inside
       * it) and emits a final chunk carrying `usage`. Leaving it false cost
       * nothing visible and quietly recorded every streamed answer as zero
       * tokens, so the usage page under-reported Ollama traffic to nil.
       *
       * The live capability test in live/providers.spec.ts asserts this both
       * ways, so an Ollama that stops honouring the option fails there rather
       * than mid-answer in production.
       */
      streamingUsage: true,
      maxContextTokens: 8_192,
    },
    notes:
      "Ollama's OpenAI compatibility is documented as experimental and subject to " +
      'breaking changes, so its capabilities are asserted against a running instance by ' +
      '`pnpm test:live` rather than taken on faith. Verified against 0.34.4: chat, streaming, ' +
      'streamed usage, embeddings (nomic-embed-text, 768d, L2-normalised), abort propagation, ' +
      'and 404-on-unknown-model.',
  },
} as const satisfies Record<string, ChatPreset>;

export const EMBEDDING_PRESETS = {
  openai: {
    id: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'text-embedding-3-small',
    requiresApiKey: true,
    capabilities: {
      dimensions: 1536,
      maxBatchSize: 2048,
      maxInputTokens: 8192,
      configurableDimensions: true,
    },
    notes:
      'text-embedding-3-large emits 3072 dims, which exceeds pgvector’s 2000-dim ' +
      'ceiling for HNSW on the `vector` type. 3-small fits and costs 6.5x less.',
  },
  together: {
    id: 'together',
    baseUrl: 'https://api.together.xyz/v1',
    defaultModel: 'BAAI/bge-base-en-v1.5',
    requiresApiKey: true,
    capabilities: {
      dimensions: 768,
      maxBatchSize: 100,
      maxInputTokens: 512,
      configurableDimensions: false,
    },
  },
  openrouter: {
    id: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'openai/text-embedding-3-small',
    requiresApiKey: true,
    capabilities: {
      dimensions: 1536,
      maxBatchSize: 2048,
      maxInputTokens: 8192,
      configurableDimensions: true,
    },
  },
  gemini: {
    id: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    defaultModel: 'gemini-embedding-001',
    requiresApiKey: true,
    capabilities: {
      // NOT the model's default. gemini-embedding-001 emits 3072 dimensions
      // unless asked otherwise, which exceeds pgvector's 2000-dim ceiling for
      // HNSW on the `vector` type. The model is trained with Matryoshka
      // representation learning, so the leading 1536 dimensions are a usable
      // embedding on their own -- and 1536 is exactly what chunks.embedding
      // already is, so this provider drops in without a migration.
      dimensions: 1536,
      maxBatchSize: 100,
      maxInputTokens: 2048,
      configurableDimensions: true,
    },
    notes:
      'Google says a truncated gemini-embedding-001 vector must be L2-normalised by the caller. ' +
      'Retrieval here is unaffected: the schema compares with cosine distance (`<=>`, ' +
      'vector_cosine_ops), which is magnitude-invariant. It would matter under inner product.',
  },
  mistral: {
    id: 'mistral',
    baseUrl: 'https://api.mistral.ai/v1',
    defaultModel: 'mistral-embed',
    requiresApiKey: true,
    capabilities: {
      dimensions: 1024,
      maxBatchSize: 128,
      maxInputTokens: 8192,
      configurableDimensions: false,
    },
    notes:
      'Fixed at 1024 dimensions with no truncation parameter, so this one needs a migration ' +
      'altering chunks.embedding to vector(1024) and a full re-ingest. The boot check refuses ' +
      'to start until both are done.',
  },
  ollama: {
    id: 'ollama',
    baseUrl: 'http://localhost:11434/v1',
    defaultModel: 'nomic-embed-text',
    requiresApiKey: false,
    capabilities: {
      dimensions: 768,
      maxBatchSize: 64,
      maxInputTokens: 8192,
      configurableDimensions: false,
    },
    notes: 'nomic-embed-text emits 768 dims, so the vector column must match.',
  },
} as const satisfies Record<string, EmbeddingPreset>;

export type ChatPresetId = keyof typeof CHAT_PRESETS;
export type EmbeddingPresetId = keyof typeof EMBEDDING_PRESETS;

/**
 * Groq is deliberately absent from EMBEDDING_PRESETS, and carries
 * `embeddings: false` in CHAT_PRESETS. This is the capability mismatch the
 * whole interface exists to catch: a perfectly good chat provider with no
 * embeddings endpoint, which should fail at boot rather than produce a
 * confusing 404 during ingestion.
 */
export function isEmbeddingProvider(id: string): id is EmbeddingPresetId {
  return id in EMBEDDING_PRESETS;
}

export function isChatProvider(id: string): id is ChatPresetId {
  return id in CHAT_PRESETS;
}
