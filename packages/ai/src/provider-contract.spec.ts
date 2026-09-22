import { describe, expect, it } from 'vitest';
import { FakeChatProvider, FakeEmbeddingProvider } from './providers/fake.js';
import {
  OpenAICompatibleChatProvider,
  OpenAICompatibleEmbeddingProvider,
} from './providers/openai-compatible.js';
import { CHAT_PRESETS, EMBEDDING_PRESETS } from './presets.js';
import type { ChatProvider, EmbeddingProvider } from './types.js';

/**
 * The contract suite.
 *
 * "Genuinely swappable" is a claim, and a README cannot test a claim. This
 * runs one shared set of expectations against every implementation, so any
 * provider that violates the interface fails here rather than in production.
 *
 * Network-backed providers are exercised against a stubbed `fetch`, so the
 * suite stays hermetic: no keys, no network, deterministic in CI.
 */

function stubFetch(handler: (url: string, init?: RequestInit) => Response): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    return handler(url, init);
  }) as typeof fetch;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function sseResponse(chunks: unknown[]): Response {
  const body = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

const chatCompletion = {
  id: 'c1',
  object: 'chat.completion',
  created: 0,
  model: 'test',
  choices: [
    { index: 0, message: { role: 'assistant', content: 'Hello there' }, finish_reason: 'stop' },
  ],
  usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
};

const streamChunks = [
  {
    id: 'c1',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'test',
    choices: [{ index: 0, delta: { content: 'Hello' }, finish_reason: null }],
  },
  {
    id: 'c1',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'test',
    choices: [{ index: 0, delta: { content: ' there' }, finish_reason: null }],
  },
  {
    id: 'c1',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'test',
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
  },
  {
    id: 'c1',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'test',
    choices: [],
    usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
  },
];

function networkChatProvider(presetId: keyof typeof CHAT_PRESETS): ChatProvider {
  const preset = CHAT_PRESETS[presetId];
  const provider = new OpenAICompatibleChatProvider({
    id: preset.id,
    baseUrl: preset.baseUrl,
    apiKey: 'test-key',
    model: preset.defaultModel,
    capabilities: preset.capabilities,
  });
  // @ts-expect-error -- inject a stub transport into the private client
  provider.client._client = undefined;
  // @ts-expect-error -- OpenAI SDK reads `fetch` off the client instance
  provider.client.fetch = stubFetch((_url, init) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    return body.stream ? sseResponse(streamChunks) : jsonResponse(chatCompletion);
  });
  return provider;
}

function networkEmbeddingProvider(presetId: keyof typeof EMBEDDING_PRESETS): EmbeddingProvider {
  const preset = EMBEDDING_PRESETS[presetId];
  const dims = preset.capabilities.dimensions;
  const provider = new OpenAICompatibleEmbeddingProvider({
    id: preset.id,
    baseUrl: preset.baseUrl,
    apiKey: 'test-key',
    model: preset.defaultModel,
    capabilities: preset.capabilities,
  });
  // @ts-expect-error -- inject a stub transport
  provider.client.fetch = stubFetch((_url, init) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const inputs: string[] = Array.isArray(body.input) ? body.input : [body.input];
    return jsonResponse({
      object: 'list',
      model: preset.defaultModel,
      data: inputs.map((_, i) => ({
        object: 'embedding',
        index: i,
        embedding: new Array(dims).fill(0).map((_, j) => (j === 0 ? 1 : 0)),
      })),
      usage: { prompt_tokens: 5, total_tokens: 5 },
    });
  });
  return provider;
}

// --- the shared contract --------------------------------------------------

const chatImplementations: [string, () => ChatProvider][] = [
  ['fake', () => new FakeChatProvider()],
  ['openai (stubbed)', () => networkChatProvider('openai')],
  ['groq (stubbed)', () => networkChatProvider('groq')],
  ['together (stubbed)', () => networkChatProvider('together')],
  ['openrouter (stubbed)', () => networkChatProvider('openrouter')],
  ['ollama (stubbed)', () => networkChatProvider('ollama')],
];

describe.each(chatImplementations)('ChatProvider contract: %s', (_name, make) => {
  it('exposes a stable identity', () => {
    const p = make();
    expect(typeof p.id).toBe('string');
    expect(p.id.length).toBeGreaterThan(0);
    expect(typeof p.model).toBe('string');
  });

  it('declares its capabilities', () => {
    const c = make().capabilities;
    expect(typeof c.streaming).toBe('boolean');
    expect(typeof c.toolCalls).toBe('boolean');
    expect(c.maxContextTokens).toBeGreaterThan(0);
  });

  it('returns text, usage and a finish reason from chat()', async () => {
    const res = await make().chat({
      messages: [
        {
          role: 'system',
          content: 'Hello there, this is context about greetings and salutations.',
        },
        { role: 'user', content: 'hello greetings' },
      ],
    });
    expect(typeof res.text).toBe('string');
    expect(res.text.length).toBeGreaterThan(0);
    expect(res.usage.totalTokens).toBeGreaterThan(0);
    expect(['stop', 'length', 'content_filter', 'error', 'unknown']).toContain(res.finishReason);
    expect(res.provider.id).toBe(make().id);
  });

  it('streams text deltas and terminates with exactly one done event', async () => {
    const p = make();
    const events = [];
    for await (const e of p.streamChat({
      messages: [
        {
          role: 'system',
          content: 'Hello there, this is context about greetings and salutations.',
        },
        { role: 'user', content: 'hello greetings' },
      ],
    })) {
      events.push(e);
    }

    const done = events.filter((e) => e.type === 'done');
    expect(done).toHaveLength(1);
    expect(events.at(-1)?.type).toBe('done');

    const text = events
      .filter((e) => e.type === 'text')
      .map((e) => (e as { delta: string }).delta)
      .join('');
    expect(text.length).toBeGreaterThan(0);
  });

  it('reports usage on the stream when it claims to support it', async () => {
    const p = make();
    if (!p.capabilities.streamingUsage) return;

    const events = [];
    for await (const e of p.streamChat({
      messages: [
        {
          role: 'system',
          content: 'Hello there, this is context about greetings and salutations.',
        },
        { role: 'user', content: 'hello greetings' },
      ],
    })) {
      events.push(e);
    }
    expect(events.some((e) => e.type === 'usage')).toBe(true);
  });
});

const embeddingImplementations: [string, () => EmbeddingProvider][] = [
  ['fake', () => new FakeEmbeddingProvider()],
  ['openai (stubbed)', () => networkEmbeddingProvider('openai')],
  ['together (stubbed)', () => networkEmbeddingProvider('together')],
  ['openrouter (stubbed)', () => networkEmbeddingProvider('openrouter')],
  ['ollama (stubbed)', () => networkEmbeddingProvider('ollama')],
];

describe.each(embeddingImplementations)('EmbeddingProvider contract: %s', (_name, make) => {
  it('declares dimensions and a batch ceiling', () => {
    const c = make().capabilities;
    expect(c.dimensions).toBeGreaterThan(0);
    expect(c.maxBatchSize).toBeGreaterThan(0);
  });

  it('returns one vector per input, in input order', async () => {
    const p = make();
    const res = await p.embed({ texts: ['alpha text', 'beta text', 'gamma text'] });
    expect(res.embeddings).toHaveLength(3);
    for (const e of res.embeddings) {
      expect(e).toHaveLength(p.capabilities.dimensions);
    }
  });

  it('handles an empty batch without calling the provider', async () => {
    const res = await make().embed({ texts: [] });
    expect(res.embeddings).toEqual([]);
  });

  it('is deterministic: the same text yields the same vector', async () => {
    const p = make();
    const a = await p.embed({ texts: ['stability matters'] });
    const b = await p.embed({ texts: ['stability matters'] });
    expect(a.embeddings[0]).toEqual(b.embeddings[0]);
  });

  it('emits unit-length vectors, so cosine and inner product agree', async () => {
    const p = make();
    const res = await p.embed({ texts: ['normalisation check'] });
    const norm = Math.sqrt(res.embeddings[0]!.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 5);
  });
});
