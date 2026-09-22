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

  it('does not require a key for ollama, which is unauthenticated locally', () => {
    const env = parseEnv({ ...valid, AI_CHAT_PROVIDER: 'ollama' } as NodeJS.ProcessEnv);
    expect(env.AI_CHAT_PROVIDER).toBe('ollama');
  });

  it('rejects groq as an embedding provider: it has no embeddings endpoint', () => {
    expect(() =>
      parseEnv({ ...valid, AI_EMBEDDING_PROVIDER: 'groq' } as NodeJS.ProcessEnv),
    ).toThrow(/AI_EMBEDDING_PROVIDER/);
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
