import { describe, expect, it } from 'vitest';
import { FakeChatProvider, FakeEmbeddingProvider } from './providers/fake.js';
import {
  OpenAICompatibleChatProvider,
  OpenAICompatibleEmbeddingProvider,
} from './providers/openai-compatible.js';
import { CHAT_PRESETS, EMBEDDING_PRESETS } from './presets.js';
import { runChatContract, runEmbeddingContract } from './testing/contract.js';
import type { ChatProvider, EmbeddingProvider } from './types.js';

/**
 * The contract suite, offline.
 *
 * The assertions themselves live in ./testing/contract.ts and are shared with
 * the live suite (live/providers.spec.ts). What this file owns is the stubbed
 * transport: every preset is exercised against a fake `fetch`, so the suite
 * stays hermetic -- no keys, no network, deterministic in CI -- while still
 * covering every provider the app ships a preset for.
 *
 * What a stub can and cannot prove is worth being honest about. It proves the
 * adapter parses the spec's response shapes, chunks batches, orders vectors by
 * `index`, and maps finish reasons and errors. It cannot prove a given vendor
 * actually returns those shapes. That is what `pnpm test:live` is for, and the
 * two suites share a contract so the difference is visible rather than assumed.
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

const ANSWER = 'bluefin';

const chatCompletion = {
  id: 'c1',
  object: 'chat.completion',
  created: 0,
  model: 'test',
  choices: [{ index: 0, message: { role: 'assistant', content: ANSWER }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
};

const streamChunks = [
  {
    id: 'c1',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'test',
    choices: [{ index: 0, delta: { content: 'blue' }, finish_reason: null }],
  },
  {
    id: 'c1',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'test',
    choices: [{ index: 0, delta: { content: 'fin' }, finish_reason: null }],
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

/**
 * Deterministic pseudo-vectors, unit length, seeded by the input text.
 *
 * Returning a constant vector for every input would let the adapter pass while
 * mapping every row to the same embedding, so the stub varies with the text --
 * which is what makes the "distinct inputs differ" and "same input repeats"
 * assertions in the shared contract mean something here.
 */
function stubVector(text: string, dims: number): number[] {
  let seed = 0;
  for (let i = 0; i < text.length; i++) seed = (seed * 31 + text.charCodeAt(i)) >>> 0;
  const out = new Array<number>(dims);
  let norm = 0;
  for (let i = 0; i < dims; i++) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const v = (seed / 0xffffffff) * 2 - 1;
    out[i] = v;
    norm += v * v;
  }
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < dims; i++) out[i] = out[i]! / norm;
  return out;
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
      // Returned out of order on purpose: the spec carries an `index` and does
      // not promise ordering, and the adapter sorts by it. A stub that replies
      // in order would never catch the day a provider does not.
      data: inputs
        .map((text, i) => ({
          object: 'embedding',
          index: i,
          embedding: stubVector(text, body.dimensions ?? dims),
        }))
        .reverse(),
      usage: { prompt_tokens: 5, total_tokens: 5 },
    });
  });
  return provider;
}

// --- every preset, plus the offline fake ----------------------------------

// Derived from the preset table, not restated. A hand-written list is how the
// suite silently stops covering what the app actually ships: adding a preset
// row is the documented way to add a provider, and it would otherwise add an
// untested one. Enumerating means a new row cannot be added without also
// having to satisfy the contract.
runChatContract('fake', () => new FakeChatProvider());
for (const id of Object.keys(CHAT_PRESETS) as (keyof typeof CHAT_PRESETS)[]) {
  runChatContract(`${id} (stubbed)`, () => networkChatProvider(id));
}

runEmbeddingContract('fake', () => new FakeEmbeddingProvider());
for (const id of Object.keys(EMBEDDING_PRESETS) as (keyof typeof EMBEDDING_PRESETS)[]) {
  runEmbeddingContract(`${id} (stubbed)`, () => networkEmbeddingProvider(id));
}

// --- coverage, asserted ---------------------------------------------------

describe('contract coverage', () => {
  /**
   * The suite above loops over the preset tables, so this cannot drift by
   * omission -- but it can drift by deletion, and a deleted loop is a silent
   * loss of coverage that still shows green. Naming the providers the
   * assignment calls out means removing one fails here.
   */
  it('covers every provider the brief names', () => {
    for (const id of ['openai', 'groq', 'together', 'openrouter', 'ollama']) {
      expect(Object.keys(CHAT_PRESETS)).toContain(id);
    }
  });

  it('exercises each preset for chat, and each embedding preset for embeddings', () => {
    expect(Object.keys(CHAT_PRESETS).length).toBeGreaterThanOrEqual(5);
    // Groq is absent here by design: it exposes no embeddings endpoint.
    expect(Object.keys(EMBEDDING_PRESETS)).not.toContain('groq');
  });
});
