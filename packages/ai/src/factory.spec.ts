import { describe, expect, it } from 'vitest';
import {
  AiConfigurationError,
  buildChatProvider,
  buildEmbeddingProvider,
  validateChatConfig,
  validateEmbeddingConfig,
} from './factory.js';
import { MemoryEmbeddingCache } from './decorators/caching.js';
import { CHAT_PRESETS, EMBEDDING_PRESETS, isEmbeddingProvider } from './presets.js';

/**
 * Configuration validation is where modelling capabilities pays off: an
 * impossible setup must fail at boot with a message that names the fix, not
 * during ingestion with a 404.
 */
describe('embedding configuration validation', () => {
  it('rejects Groq, which has no embeddings endpoint', () => {
    expect(() => validateEmbeddingConfig({ provider: 'groq', apiKey: 'k' })).toThrow(
      AiConfigurationError,
    );
    expect(() => validateEmbeddingConfig({ provider: 'groq', apiKey: 'k' })).toThrow(
      /no embeddings endpoint/,
    );
  });

  it('suggests a working pairing when Groq is misconfigured', () => {
    // The message has to tell the reader what to do, not just what is wrong.
    try {
      validateEmbeddingConfig({ provider: 'groq', apiKey: 'k' });
    } catch (e) {
      expect((e as Error).message).toMatch(/AI_CHAT_PROVIDER=groq/);
      expect((e as Error).message).toMatch(/OpenAI or Ollama/);
    }
  });

  it("rejects dimensions above pgvector's HNSW ceiling", () => {
    expect(() =>
      validateEmbeddingConfig({ provider: 'openai', apiKey: 'k', dimensions: 3072 }),
    ).toThrow(/2000-dimension limit/);
  });

  it('rejects a dimension override on a provider that cannot truncate', () => {
    expect(() => validateEmbeddingConfig({ provider: 'ollama', dimensions: 1536 })).toThrow(
      /does not support truncation/,
    );
  });

  it('allows a dimension override where the provider supports it', () => {
    expect(() =>
      validateEmbeddingConfig({ provider: 'openai', apiKey: 'k', dimensions: 512 }),
    ).not.toThrow();
  });

  it('requires an API key for providers that need one', () => {
    expect(() => validateEmbeddingConfig({ provider: 'openai' })).toThrow(/API_KEY is required/);
  });

  it('does not require a key for Ollama', () => {
    expect(() => validateEmbeddingConfig({ provider: 'ollama' })).not.toThrow();
  });

  it('requires nothing at all for the fake provider', () => {
    expect(() => validateEmbeddingConfig({ provider: 'fake' })).not.toThrow();
  });

  it('rejects unknown providers unless a base URL is given', () => {
    expect(() => validateEmbeddingConfig({ provider: 'mystery', apiKey: 'k' })).toThrow(/Unknown/);
    expect(() =>
      validateEmbeddingConfig({ provider: 'mystery', apiKey: 'k', baseUrl: 'https://x/v1' }),
    ).not.toThrow();
  });
});

describe('chat configuration validation', () => {
  it('accepts every chat preset when given a key', () => {
    for (const id of Object.keys(CHAT_PRESETS)) {
      expect(() => validateChatConfig({ provider: id, apiKey: 'k' })).not.toThrow();
    }
  });

  it('accepts an arbitrary OpenAI-compatible service via base URL', () => {
    expect(() =>
      validateChatConfig({ provider: 'self-hosted-vllm', apiKey: 'k', baseUrl: 'https://x/v1' }),
    ).not.toThrow();
  });
});

describe('preset registry', () => {
  it('lists Groq for chat but not for embeddings', () => {
    expect('groq' in CHAT_PRESETS).toBe(true);
    expect(isEmbeddingProvider('groq')).toBe(false);
  });

  it('keeps every embedding preset under the pgvector HNSW limit', () => {
    for (const [id, preset] of Object.entries(EMBEDDING_PRESETS)) {
      expect(preset.capabilities.dimensions, id).toBeLessThanOrEqual(2000);
    }
  });

  it('declares a batch ceiling for every embedding preset', () => {
    for (const [id, preset] of Object.entries(EMBEDDING_PRESETS)) {
      expect(preset.capabilities.maxBatchSize, id).toBeGreaterThan(0);
    }
  });
});

describe('provider composition', () => {
  it('builds a working fake stack with no credentials at all', async () => {
    const chat = buildChatProvider({ provider: 'fake' });
    const res = await chat.chat({
      messages: [
        {
          role: 'system',
          content:
            'Answer using only the numbered sources.\n\nSources:\n\n' +
            '[1] Deploy runbook\nA deploy takes eight minutes end to end from merge to live.',
        },
        { role: 'user', content: 'how long does a deploy take' },
      ],
    });
    expect(res.text).toMatch(/eight minutes/);
    expect(res.text).toMatch(/\[1\]/);
  });

  it('wires the embedding cache through the stack', async () => {
    const store = new MemoryEmbeddingCache();
    const embed = buildEmbeddingProvider(
      { provider: 'fake', dimensions: 64 },
      { cacheStore: store },
    );

    await embed.embed({ texts: ['alpha'] });
    await embed.embed({ texts: ['alpha'] });

    expect(store.size).toBe(1);
  });

  it('reports usage through the stack', async () => {
    const events: unknown[] = [];
    const chat = buildChatProvider({ provider: 'fake' }, { usageSink: (e) => events.push(e) });
    await chat.chat({ messages: [{ role: 'user', content: 'hi' }] });
    expect(events).toHaveLength(1);
  });

  it('surfaces configuration errors at build time, not request time', () => {
    expect(() => buildEmbeddingProvider({ provider: 'groq', apiKey: 'k' })).toThrow(
      AiConfigurationError,
    );
  });

  it('respects the configured embedding dimensions end to end', async () => {
    const embed = buildEmbeddingProvider({ provider: 'fake', dimensions: 256 });
    const res = await embed.embed({ texts: ['x'] });
    expect(res.embeddings[0]).toHaveLength(256);
  });
});
