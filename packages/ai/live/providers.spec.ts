import { describe, expect, it } from 'vitest';
import { buildChatProvider, buildEmbeddingProvider } from '../src/factory.js';
import { CHAT_PRESETS } from '../src/presets.js';
import { runChatContract, runEmbeddingContract } from '../src/testing/contract.js';
import { AiProviderError } from '../src/types.js';
import {
  liveChatTargets,
  liveEmbeddingTargets,
  loadEnvLocal,
  ollamaReachable,
  type LiveChatTarget,
} from './config.js';

/**
 * The contract, live.
 *
 * Same assertions as the offline suite (src/testing/contract.ts), run against
 * the real endpoints for whichever providers this machine has credentials for.
 * Not part of `pnpm test`: it needs network, it costs money on metered
 * providers, and a suite that fails because someone's free tier reset is not a
 * suite anyone keeps green. Run it deliberately with `pnpm test:live`.
 *
 * Every provider is built through `buildChatProvider` / `buildEmbeddingProvider`
 * from nothing but a config object -- the same call the API's boot path makes.
 * That is the point being tested: if any provider needed special handling, it
 * would have to appear here as a branch, and there are none.
 */

loadEnvLocal();

const chatTargets = liveChatTargets();
const embeddingTargets = liveEmbeddingTargets();

const ollamaChat = chatTargets.find((t) => t.id === 'ollama');

/**
 * Probed at module scope, with top-level await, and not in a `beforeAll`.
 *
 * `describe.skipIf` is evaluated while the file is being collected, which
 * happens before any hook runs -- so a flag set in `beforeAll` is still `false`
 * when the skip decision is made. The first version of this file did exactly
 * that: every Ollama suite silently skipped even with the server up, while the
 * summary cheerfully reported it as covered. Collection-time state has to be
 * resolved at collection time.
 */
const ollamaUp = ollamaChat ? await ollamaReachable(ollamaChat.baseUrl!) : false;

const skipUnreachable = (t: LiveChatTarget) => t.id === 'ollama' && !ollamaUp;

// --- what actually ran ----------------------------------------------------

describe('live provider coverage', () => {
  it('reports which providers this run covered', () => {
    // Counted *after* the reachability probe, not from the configured list.
    // Ollama needs no key, so it is always configured and was therefore always
    // counted -- which made a run with no keys and no Ollama report a green
    // "1 passed" while every real assertion skipped. A suite that passes by
    // testing nothing is worse than one that fails.
    const ran = [
      ...chatTargets.filter((t) => !skipUnreachable(t)).map((t) => `chat ${t.id}:${t.model}`),
      ...embeddingTargets
        .filter((t) => !(t.id === 'ollama' && !ollamaUp))
        .map((t) => `embed ${t.id}:${t.model}`),
    ];
    const noKey = Object.keys(CHAT_PRESETS).filter((id) => !chatTargets.some((t) => t.id === id));

    const lines = [
      '',
      `  live providers exercised (${ran.length}):`,
      ...ran.map((r) => `    - ${r}`),
    ];
    if (noKey.length > 0) {
      lines.push(
        `  skipped, no credential: ${noKey.join(', ')}`,
        '    set LIVE_<ID>_API_KEY in .env.local to include one, e.g. LIVE_GROQ_API_KEY=gsk_...',
      );
    }
    if (ollamaChat && !ollamaUp) {
      lines.push(`  skipped, unreachable: ollama at ${ollamaChat.baseUrl}  (run \`ollama serve\`)`);
    }
    // The point of a live run is knowing what it actually reached, and a
    // green tick does not say. `warn` would misfile it as a problem.
    // eslint-disable-next-line no-console
    console.info(lines.join('\n') + '\n');

    expect(
      ran.length,
      'no live provider was actually reachable -- set LIVE_<ID>_API_KEY in .env.local, ' +
        'or start Ollama with `ollama serve`',
    ).toBeGreaterThan(0);
  });
});

// --- the shared contract, against real endpoints --------------------------

for (const target of chatTargets) {
  const suite = describe.skipIf(skipUnreachable(target));
  suite(`live: ${target.id}`, () => {
    runChatContract(
      `${target.id} (live, ${target.model})`,
      () =>
        buildChatProvider({
          provider: target.id,
          model: target.model,
          apiKey: target.apiKey,
          baseUrl: target.baseUrl,
          // Live calls are slower than a stub and a cold Ollama model load can
          // take tens of seconds; retries stay on because the point is to
          // exercise the real stack, transient 429s included.
          timeoutMs: 120_000,
          maxRetries: 2,
        }),
      { live: true },
    );
  });
}

for (const target of embeddingTargets) {
  const suite = describe.skipIf(target.id === 'ollama' && !ollamaUp);
  suite(`live: ${target.id}`, () => {
    runEmbeddingContract(
      `${target.id} (live, ${target.model})`,
      () =>
        buildEmbeddingProvider({
          provider: target.id,
          model: target.model,
          apiKey: target.apiKey,
          baseUrl: target.baseUrl,
          dimensions: target.dimensions,
          timeoutMs: 120_000,
          maxRetries: 2,
        }),
      { live: true },
    );
  });
}

// --- are the declared capabilities actually true? -------------------------

/**
 * The preset table is a set of claims about each vendor, and claims rot.
 *
 * `streamingUsage` is the one that rots silently and expensively: declare it
 * `false` for a provider that does report usage, and every streamed answer is
 * recorded as zero tokens -- the usage page under-reports, and nothing ever
 * errors. Declare it `true` for one that does not, and older providers 400 the
 * request mid-answer.
 *
 * So the assertion is two-way rather than "declared true implies observed".
 * This already paid for itself: Ollama's row said `false` with a comment that
 * it rejects unknown stream options, which was true of older Ollama and is not
 * true of 0.34.x -- it accepts `stream_options` and returns a usage chunk. The
 * offline suite could never have caught that, because the stub returns
 * whatever the preset implies.
 */
describe('live capability claims', () => {
  for (const target of chatTargets) {
    it.skipIf(skipUnreachable(target))(
      `${target.id}: declared streamingUsage matches what the endpoint actually does`,
      async (ctx) => {
        const declared =
          CHAT_PRESETS[target.id as keyof typeof CHAT_PRESETS]?.capabilities.streamingUsage ??
          false;

        // Asked for directly rather than through the adapter, which suppresses
        // `stream_options` precisely when the capability says false -- going
        // through it would only confirm the preset agrees with itself.
        const res = await fetch(`${target.baseUrl!.replace(/\/$/, '')}/chat/completions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(target.apiKey ? { authorization: `Bearer ${target.apiKey}` } : {}),
          },
          body: JSON.stringify({
            model: target.model,
            messages: [{ role: 'user', content: 'say hi' }],
            max_tokens: 8,
            stream: true,
            stream_options: { include_usage: true },
          }),
          signal: AbortSignal.timeout(120_000),
        });

        // A rate limit says nothing about whether the option is supported. The
        // first version read any non-2xx as "the provider refused the option",
        // so an exhausted free tier asserted the preset must declare `false` --
        // which would have argued for reverting a row that live testing had
        // just proven correct.
        if (res.status === 429) {
          ctx.skip(`rate limited, capability not verified: ${(await res.text()).slice(0, 160)}`);
          return;
        }

        if (!res.ok) {
          // A provider that genuinely refuses the option must be declared `false`.
          expect(
            declared,
            `${target.id} rejected stream_options with ${res.status}, so the preset must ` +
              'declare streamingUsage: false',
          ).toBe(false);
          return;
        }

        const body = await res.text();
        const observed = body
          .split('\n')
          .filter((l) => l.startsWith('data: ') && !l.includes('[DONE]'))
          .some((l) => {
            try {
              return (JSON.parse(l.slice(6)) as { usage?: unknown }).usage != null;
            } catch {
              return false;
            }
          });

        expect(
          observed,
          observed
            ? `${target.id} DOES report usage on streams but the preset declares ` +
                'streamingUsage: false -- streamed answers are being recorded as zero tokens. ' +
                'Flip the row in presets.ts.'
            : `${target.id} does NOT report usage on streams but the preset declares ` +
                'streamingUsage: true -- the usage event will never arrive.',
        ).toBe(declared);
      },
    );
  }
});

// --- error normalisation, against real endpoints --------------------------

/**
 * The taxonomy in types.ts claims a 401 from any provider becomes
 * `code: 'auth'` and is not retried. That claim is only testable against real
 * vendors: each returns a different body, and some return 403, or 200 with an
 * error object. A stub can only confirm we parse what we already assumed.
 */
describe('live error normalisation', () => {
  const authTargets = chatTargets.filter((t) => t.apiKey);

  for (const target of authTargets) {
    it(`${target.id}: rejects a bad key as a non-retryable auth error`, async () => {
      const provider = buildChatProvider({
        provider: target.id,
        model: target.model,
        apiKey: 'sk-definitely-not-a-valid-key-000000000000',
        baseUrl: target.baseUrl,
        timeoutMs: 30_000,
        maxRetries: 0,
      });

      const err = await provider
        .chat({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 8 })
        .then(
          () => null,
          (e: unknown) => e,
        );

      expect(err, `${target.id} accepted an invalid API key`).toBeInstanceOf(AiProviderError);
      const aiErr = err as AiProviderError;
      expect(aiErr.providerId).toBe(target.id);
      expect(
        aiErr.code,
        `${target.id} returned status ${aiErr.status} mapped to "${aiErr.code}"`,
      ).toBe('auth');
      expect(aiErr.retryable).toBe(false);
    });
  }

  for (const target of chatTargets) {
    it.skipIf(skipUnreachable(target))(
      `${target.id}: rejects an unknown model as a non-retryable bad request`,
      async (ctx) => {
        const provider = buildChatProvider({
          provider: target.id,
          model: 'model-that-does-not-exist-9f3a2b',
          apiKey: target.apiKey,
          baseUrl: target.baseUrl,
          timeoutMs: 30_000,
          maxRetries: 0,
        });

        const err = await provider
          .chat({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 8 })
          .then(
            () => null,
            (e: unknown) => e,
          );

        expect(err, `${target.id} accepted a nonexistent model`).toBeInstanceOf(AiProviderError);
        const aiErr = err as AiProviderError;
        if (aiErr.code === 'rate_limit') {
          ctx.skip('rate limited before the model could be rejected');
          return;
        }
        expect(
          aiErr.code,
          `${target.id} returned status ${aiErr.status} mapped to "${aiErr.code}"`,
        ).toBe('bad_request');
        expect(aiErr.retryable).toBe(false);
      },
    );
  }
});

// --- cancellation ---------------------------------------------------------

/**
 * The API aborts the upstream request when a browser disconnects mid-stream.
 * Whether an abort actually propagates through the SDK to a real socket is not
 * something a stubbed `fetch` can answer.
 */
describe('live cancellation', () => {
  for (const target of chatTargets) {
    it.skipIf(skipUnreachable(target))(`${target.id}: aborts an in-flight stream`, async (ctx) => {
      const provider = buildChatProvider({
        provider: target.id,
        model: target.model,
        apiKey: target.apiKey,
        baseUrl: target.baseUrl,
        timeoutMs: 120_000,
        maxRetries: 0,
      });

      const controller = new AbortController();
      const stream = provider.streamChat({
        messages: [{ role: 'user', content: 'Count slowly from 1 to 200, one number per line.' }],
        maxTokens: 512,
        signal: controller.signal,
      });

      let received = 0;
      const err = await (async () => {
        try {
          for await (const e of stream) {
            if (e.type === 'text' && ++received >= 2) controller.abort();
          }
          return null;
        } catch (e) {
          return e;
        }
      })();

      // Either the iterator throws a cancellation, or it ends early. Both are
      // correct; what would be wrong is streaming all 200 lines after an abort.
      if (err) {
        expect(err).toBeInstanceOf(AiProviderError);
        const code = (err as AiProviderError).code;

        // The stream may die for reasons that have nothing to do with the
        // abort -- an exhausted free tier being the common one. That is not
        // evidence either way about cancellation, so it is reported as
        // unexercised rather than counted as a failure.
        if (code === 'rate_limit' || code === 'server_error') {
          ctx.skip(`stream failed before the abort could be observed (${code})`);
          return;
        }

        expect(code).toBe('cancelled');
        expect((err as AiProviderError).retryable).toBe(false);
      }
      expect(received).toBeLessThan(400);
    });
  }
});
