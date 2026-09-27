import { describe, expect, it } from 'vitest';
import { parseEnv } from './env.schema.js';

const valid = {
  SUPABASE_URL: 'http://127.0.0.1:54321',
  SUPABASE_PUBLISHABLE_KEY: 'pub',
  SUPABASE_SECRET_KEY: 'secret',
  DATABASE_URL: 'postgresql://postgres:postgres@127.0.0.1:54322/postgres',
};

describe('parseEnv', () => {
  it('applies defaults so the app boots with zero AI credentials', () => {
    const env = parseEnv({ ...valid } as NodeJS.ProcessEnv);
    expect(env.AI_CHAT_PROVIDER).toBe('fake');
    expect(env.AI_EMBEDDING_PROVIDER).toBe('fake');
    expect(env.PORT).toBe(3001);
  });

  it('coerces numeric vars rather than leaving them as strings', () => {
    const env = parseEnv({
      ...valid,
      PORT: '4000',
      AI_EMBEDDING_DIMENSIONS: '768',
    } as NodeJS.ProcessEnv);
    expect(env.PORT).toBe(4000);
    expect(env.AI_EMBEDDING_DIMENSIONS).toBe(768);
  });

  it('rejects embedding dimensions above pgvector’s 2000-dim HNSW ceiling', () => {
    expect(() =>
      parseEnv({ ...valid, AI_EMBEDDING_DIMENSIONS: '3072' } as NodeJS.ProcessEnv),
    ).toThrow(/AI_EMBEDDING_DIMENSIONS/);
  });

  it('requires an API key for a real chat provider', () => {
    expect(() => parseEnv({ ...valid, AI_CHAT_PROVIDER: 'openai' } as NodeJS.ProcessEnv)).toThrow(
      /AI_CHAT_API_KEY is required/,
    );
  });

  // Any OpenAI-spec provider must work through configuration alone, not only
  // the ones with presets.
  it('accepts a provider with no preset when it brings its own base URL', () => {
    const env = parseEnv({
      ...valid,
      AI_CHAT_PROVIDER: 'acme-llm',
      AI_CHAT_BASE_URL: 'https://api.acme.example/v1',
      AI_CHAT_MODEL: 'acme-large',
      AI_CHAT_API_KEY: 'acme-key',
      AI_EMBEDDING_PROVIDER: 'acme-llm',
      AI_EMBEDDING_BASE_URL: 'https://api.acme.example/v1',
      AI_EMBEDDING_MODEL: 'acme-embed',
      AI_EMBEDDING_API_KEY: 'acme-key',
    } as NodeJS.ProcessEnv);
    expect(env.AI_CHAT_PROVIDER).toBe('acme-llm');
    expect(env.AI_EMBEDDING_PROVIDER).toBe('acme-llm');
  });

  it('does not demand a key from a self-hosted endpoint', () => {
    const env = parseEnv({
      ...valid,
      AI_CHAT_PROVIDER: 'internal-gateway',
      AI_CHAT_BASE_URL: 'http://gateway.internal:8080/v1',
      AI_CHAT_MODEL: 'llama',
    } as NodeJS.ProcessEnv);
    expect(env.AI_CHAT_PROVIDER).toBe('internal-gateway');
  });

  it('requires a model for a provider with no preset default', () => {
    expect(() =>
      parseEnv({
        ...valid,
        AI_CHAT_PROVIDER: 'internal-gateway',
        AI_CHAT_BASE_URL: 'http://gateway.internal:8080/v1',
      } as NodeJS.ProcessEnv),
    ).toThrow(/AI_CHAT_MODEL is required/);
  });

  it('leaves the model to the preset when unset, so the fake embedder keeps its own name', () => {
    const env = parseEnv({ ...valid } as NodeJS.ProcessEnv);
    expect(env.AI_CHAT_MODEL).toBeUndefined();
    expect(env.AI_EMBEDDING_MODEL).toBeUndefined();
  });

  // Openness must not cost the typo check: a name with no preset and no base URL
  // is still a mistake, and the message has to name the fix.
  it('rejects an unknown provider that brings no base URL, and says how to fix it', () => {
    expect(() => parseEnv({ ...valid, AI_CHAT_PROVIDER: 'opemai' } as NodeJS.ProcessEnv)).toThrow(
      /Unknown chat provider "opemai".*AI_CHAT_BASE_URL/s,
    );
  });

  it('rejects an unknown embedding provider that brings no base URL', () => {
    expect(() =>
      parseEnv({ ...valid, AI_EMBEDDING_PROVIDER: 'gorq' } as NodeJS.ProcessEnv),
    ).toThrow(/Unknown embedding provider "gorq".*AI_EMBEDDING_BASE_URL/s);
  });

  // The provider list is derived from the preset table rather than restated, so
  // a preset added to the AI layer is configurable without touching this file.
  it('accepts every provider the AI layer ships a preset for', () => {
    for (const provider of ['openai', 'groq', 'together', 'openrouter', 'ollama']) {
      const env = parseEnv({
        ...valid,
        AI_CHAT_PROVIDER: provider,
        AI_CHAT_API_KEY: 'key',
      } as NodeJS.ProcessEnv);
      expect(env.AI_CHAT_PROVIDER).toBe(provider);
    }
  });

  it('does not require a key for ollama, which is unauthenticated locally', () => {
    const env = parseEnv({ ...valid, AI_CHAT_PROVIDER: 'ollama' } as NodeJS.ProcessEnv);
    expect(env.AI_CHAT_PROVIDER).toBe('ollama');
  });

  it('rejects groq as an embedding provider: it has no embeddings endpoint', () => {
    expect(() =>
      parseEnv({ ...valid, AI_EMBEDDING_PROVIDER: 'groq' } as NodeJS.ProcessEnv),
    ).toThrow(/"groq" has no embeddings endpoint.*AI_CHAT_PROVIDER=groq/s);
  });

  it('rejects a non-postgres DATABASE_URL', () => {
    expect(() =>
      parseEnv({ ...valid, DATABASE_URL: 'mysql://localhost/db' } as NodeJS.ProcessEnv),
    ).toThrow(/postgres connection string/);
  });

  it('reports every missing variable at once, not just the first', () => {
    let message = '';
    try {
      parseEnv({} as NodeJS.ProcessEnv);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain('SUPABASE_URL');
    expect(message).toContain('DATABASE_URL');
  });
});
