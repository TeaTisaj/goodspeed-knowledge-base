import type { ChatCapabilities, EmbeddingCapabilities } from './types.js';

/**
 * Provider presets: endpoint, default model and capabilities for common
 * OpenAI-spec providers. Data, not classes -- every provider speaks the same
 * protocol. A provider without a preset works from env vars alone.
 */

export interface ChatPreset {
  id: string;
  baseUrl: string;
  defaultModel: string;
  /** Whether an API key is required. Ollama runs unauthenticated locally. */
  requiresApiKey: boolean;
  capabilities: ChatCapabilities;
  /** Whether this provider also exposes an embeddings endpoint. */
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
    /** Groq serves reasoning models only; Llama defaults were retired. */
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
      /** Verified against the live endpoint (`pnpm test:live`). */
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
    /** Reachable on a free key; `mistral-medium-latest` is the paid option. */
    defaultModel: 'mistral-small-latest',
    requiresApiKey: true,
    embeddings: true,
    capabilities: {
      streaming: true,
      toolCalls: true,
      jsonMode: true,
      // Unverified: the free tier rate-limits every probe.
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
      /** Verified against Ollama 0.34.4; live/providers.spec.ts asserts it both ways. */
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
      // Truncated from the native 3072 (over pgvector's HNSW limit); Matryoshka-trained,
      // so the leading 1536 dimensions are a usable embedding.
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

/** Groq has no embeddings endpoint, so it is absent here and rejected at boot. */
export function isEmbeddingProvider(id: string): id is EmbeddingPresetId {
  return id in EMBEDDING_PRESETS;
}

export function isChatProvider(id: string): id is ChatPresetId {
  return id in CHAT_PRESETS;
}
