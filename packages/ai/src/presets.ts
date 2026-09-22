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
    defaultModel: 'llama-3.3-70b-versatile',
    requiresApiKey: true,
    capabilities: {
      streaming: true,
      toolCalls: true,
      jsonMode: true,
      streamingUsage: true,
      maxContextTokens: 128_000,
    },
    notes: 'Chat only. Groq exposes no embeddings endpoint — see EMBEDDING_PRESETS.',
  },
  together: {
    id: 'together',
    baseUrl: 'https://api.together.xyz/v1',
    defaultModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
    requiresApiKey: true,
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
    capabilities: {
      streaming: true,
      toolCalls: true,
      jsonMode: true,
      streamingUsage: true,
      maxContextTokens: 128_000,
    },
    notes: 'Routes to many upstreams; capabilities vary by selected model.',
  },
  ollama: {
    id: 'ollama',
    baseUrl: 'http://localhost:11434/v1',
    defaultModel: 'llama3.2',
    requiresApiKey: false,
    capabilities: {
      streaming: true,
      toolCalls: false,
      jsonMode: true,
      streamingUsage: false,
      maxContextTokens: 8_192,
    },
    notes:
      "Ollama's OpenAI compatibility is documented as experimental and subject to " +
      'breaking changes. Shipped as a preset, but see the README for what was actually tested.',
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
 * Groq is deliberately absent from EMBEDDING_PRESETS. This is the capability
 * mismatch the whole interface exists to catch: it is a perfectly good chat
 * provider with no embeddings endpoint, and configuring it for embeddings
 * should fail at boot rather than produce a confusing 404 during ingestion.
 */
export function isEmbeddingProvider(id: string): id is EmbeddingPresetId {
  return id in EMBEDDING_PRESETS;
}

export function isChatProvider(id: string): id is ChatPresetId {
  return id in CHAT_PRESETS;
}
