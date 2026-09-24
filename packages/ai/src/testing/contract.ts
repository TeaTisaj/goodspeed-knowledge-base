import { describe, expect, it, type TestContext } from 'vitest';
import { AiProviderError, type ChatProvider, type EmbeddingProvider } from '../types.js';

/**
 * The provider contract, written once.
 *
 * "Any OpenAI-spec provider can be swapped in via configuration" is a claim,
 * and a claim is only worth what tests it. The same assertions run twice:
 *
 *   - against a stubbed transport, for every preset, hermetically in CI
 *     (provider-contract.spec.ts)
 *   - against the real endpoints, for whichever providers have credentials
 *     (live/providers.spec.ts, `pnpm test:live`)
 *
 * They share this module on purpose. A contract that lives only in the stubbed
 * suite tests our own mock; a contract that lives only in the live suite cannot
 * run in CI. Sharing it means the offline suite is a real proxy for the online
 * one, and a provider that passes stubbed but fails live has a difference worth
 * naming rather than a difference in test code.
 */

/**
 * A 429 is not a contract violation.
 *
 * Free tiers are the realistic case for a live suite -- Gemini allows 20
 * requests a day on the model in its preset, Mistral throttles within a couple
 * of calls -- and a rate limit says nothing about whether the provider honours
 * the contract. Failing on one produces a suite that is red for reasons outside
 * the repository, which is how people learn to ignore a suite.
 *
 * So it is reported as a skip carrying the provider's own message, never as a
 * pass: the run says plainly that the provider was not actually exercised. The
 * retry decorator has already backed off and given up by the time this is
 * reached, so it means genuinely exhausted, not momentarily busy.
 */
function rateLimited(err: unknown): AiProviderError | undefined {
  if (err instanceof AiProviderError && err.code === 'rate_limit') return err;
  return undefined;
}

/**
 * `it`, with rate limits demoted to skips. Used only for the live contract --
 * the offline suite has no network and must never skip.
 */
function makeIt(live: boolean) {
  if (!live) return it;
  return (name: string, fn: (ctx: TestContext) => Promise<void> | void) =>
    it(name, async (ctx) => {
      try {
        await fn(ctx);
      } catch (err) {
        const limited = rateLimited(err);
        if (!limited) throw err;
        ctx.skip(`rate limited, not exercised: ${limited.message.slice(0, 160)}`);
      }
    });
}

export interface ChatContractOptions {
  /**
   * Live providers are non-deterministic and metered, so a live run makes
   * fewer, shorter calls. This is not a weaker contract -- the assertions are
   * identical -- it only drops the repeat calls that exist to prove
   * determinism, which is not a property of chat anyway.
   */
  live?: boolean;
}

const PROBE_MESSAGES = [
  {
    role: 'system' as const,
    content:
      'You answer only from the provided context. Context: the internal codename for the ' +
      'Q3 storage migration is "bluefin". Answer in one word.',
  },
  { role: 'user' as const, content: 'What is the codename for the Q3 storage migration?' },
];

/**
 * Headroom for a one-word answer, which sounds absurd until you meter a
 * reasoning model.
 *
 * This was 64, chosen as "obviously plenty" for a single word. Every Groq model
 * is now a reasoning model, and reasoning tokens come out of the *completion*
 * budget before any visible content: at 64 the entire allowance went to
 * reasoning and the call returned `content: ''` with finish_reason `length` --
 * an empty answer and no error anywhere. The contract was measuring the budget,
 * not the provider.
 *
 * 512 is enough for the reasoning models tested here and still small enough to
 * keep a live run cheap. The failure mode it papers over is real, though, and
 * belongs in the application's budget too, not just in this constant.
 */
const PROBE_MAX_TOKENS = 512;

export function runChatContract(
  name: string,
  make: () => ChatProvider,
  options: ChatContractOptions = {},
): void {
  const it = makeIt(options.live ?? false);

  describe(`ChatProvider contract: ${name}`, () => {
    it('exposes a stable identity', () => {
      const p = make();
      expect(typeof p.id).toBe('string');
      expect(p.id.length).toBeGreaterThan(0);
      expect(typeof p.model).toBe('string');
      expect(p.model.length).toBeGreaterThan(0);
    });

    it('declares its capabilities', () => {
      const c = make().capabilities;
      expect(typeof c.streaming).toBe('boolean');
      expect(typeof c.toolCalls).toBe('boolean');
      expect(typeof c.jsonMode).toBe('boolean');
      expect(typeof c.streamingUsage).toBe('boolean');
      expect(c.maxContextTokens).toBeGreaterThan(0);
    });

    it('returns text, usage and a finish reason from chat()', async () => {
      const p = make();
      const res = await p.chat({ messages: PROBE_MESSAGES, maxTokens: PROBE_MAX_TOKENS });
      expect(typeof res.text).toBe('string');
      // Named explicitly, because an empty answer with a `length` finish is the
      // confusing one: nothing errored, the call succeeded, and the user gets a
      // blank response. On a reasoning model it means the budget was consumed
      // before any visible token was produced.
      expect(
        res.text.length,
        res.finishReason === 'length'
          ? `${p.id}/${p.model} returned no content and finished on "length" — the token ` +
              'budget ran out before any visible output. On a reasoning model the budget is ' +
              'spent on reasoning first, so it needs more headroom than the answer suggests.'
          : `${p.id}/${p.model} returned empty text with finishReason "${res.finishReason}"`,
      ).toBeGreaterThan(0);
      expect(res.usage.totalTokens).toBeGreaterThan(0);
      expect(['stop', 'length', 'content_filter', 'error', 'unknown']).toContain(res.finishReason);
      expect(res.provider.id).toBe(p.id);
      expect(res.provider.model).toBe(p.model);
    });

    it('streams text deltas and terminates with exactly one done event', async () => {
      const p = make();
      const events = [];
      for await (const e of p.streamChat({
        messages: PROBE_MESSAGES,
        maxTokens: PROBE_MAX_TOKENS,
      })) {
        events.push(e);
      }

      expect(events.filter((e) => e.type === 'done')).toHaveLength(1);
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
        messages: PROBE_MESSAGES,
        maxTokens: PROBE_MAX_TOKENS,
      })) {
        events.push(e);
      }
      const usage = events.find((e) => e.type === 'usage');
      expect(usage, `${p.id} declares streamingUsage but emitted no usage event`).toBeDefined();
      expect((usage as { usage: { totalTokens: number } }).usage.totalTokens).toBeGreaterThan(0);
    });

    if (options.live) {
      /**
       * The only assertion that is live-only, because it is the only one a stub
       * cannot answer honestly: a mock returns whatever we told it to. Grounding
       * an answer in supplied context is the single thing this app asks a chat
       * provider to do, so a provider that streams perfectly but ignores its
       * context is not actually swappable here.
       */
      it('grounds its answer in the supplied context', async () => {
        const res = await make().chat({ messages: PROBE_MESSAGES, maxTokens: PROBE_MAX_TOKENS });
        expect(res.text.toLowerCase()).toContain('bluefin');
      });
    }
  });
}

export interface EmbeddingContractOptions {
  live?: boolean;
}

export function runEmbeddingContract(
  name: string,
  make: () => EmbeddingProvider,
  options: EmbeddingContractOptions = {},
): void {
  const it = makeIt(options.live ?? false);

  describe(`EmbeddingProvider contract: ${name}`, () => {
    it('declares dimensions and a batch ceiling', () => {
      const c = make().capabilities;
      expect(c.dimensions).toBeGreaterThan(0);
      expect(c.maxBatchSize).toBeGreaterThan(0);
      expect(c.maxInputTokens).toBeGreaterThan(0);
    });

    it('returns one vector per input, in input order', async () => {
      const p = make();
      const res = await p.embed({ texts: ['alpha text', 'beta text', 'gamma text'] });
      expect(res.embeddings).toHaveLength(3);
      for (const e of res.embeddings) {
        expect(e).toHaveLength(p.capabilities.dimensions);
      }
      // Distinct inputs must not collapse to the same vector: that would pass
      // the length check while making retrieval meaningless.
      expect(res.embeddings[0]).not.toEqual(res.embeddings[1]);
    });

    it('handles an empty batch without calling the provider', async () => {
      const res = await make().embed({ texts: [] });
      expect(res.embeddings).toEqual([]);
      expect(res.usage.totalTokens).toBe(0);
    });

    it('is deterministic: the same text yields the same vector', async () => {
      const p = make();
      const a = await p.embed({ texts: ['stability matters'] });
      const b = await p.embed({ texts: ['stability matters'] });
      // Live providers run in float32 on varying hardware, so exact equality is
      // the wrong bar; near-identity is the property retrieval actually needs.
      const dot = cosine(a.embeddings[0]!, b.embeddings[0]!);
      expect(dot).toBeGreaterThan(0.9999);
    });

    if (options.live) {
      /**
       * Live-only for the same reason as the chat grounding test: the fake
       * provider is a hashing vectoriser with no semantics, so it cannot pass
       * this and is not expected to. Against a real model this is the property
       * that makes the provider usable for retrieval at all -- a provider whose
       * vectors are the right width but semantically inert would satisfy every
       * other assertion here and return garbage in production.
       */
      it('places related text closer than unrelated text', async () => {
        const res = await make().embed({
          texts: [
            'The deployment pipeline runs database migrations before the rollout.',
            'Schema migrations are applied automatically during deploys.',
            'The office coffee machine is on the third floor near the stairs.',
          ],
        });
        const [a, b, c] = res.embeddings as [number[], number[], number[]];
        const related = cosine(a, b);
        const unrelated = cosine(a, c);
        expect(
          related,
          `related pair scored ${related.toFixed(3)}, unrelated ${unrelated.toFixed(3)}`,
        ).toBeGreaterThan(unrelated);
      });

      it('batches beyond one request without losing or reordering vectors', async () => {
        const p = make();
        // Deliberately crosses the declared ceiling where that is cheap, so the
        // chunking path in the adapter is exercised rather than assumed.
        const texts = Array.from({ length: 5 }, (_, i) => `document number ${i} about topic ${i}`);
        const res = await p.embed({ texts });
        expect(res.embeddings).toHaveLength(texts.length);

        const again = await p.embed({ texts: [texts[3]!] });
        expect(cosine(res.embeddings[3]!, again.embeddings[0]!)).toBeGreaterThan(0.9999);
      });
    }
  });
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}
