import { describe, expect, it } from 'vitest';
import { buildChatProvider } from '../src/factory.js';
import { CHAT_PRESETS, EMBEDDING_PRESETS } from '../src/presets.js';
import { AiProviderError } from '../src/types.js';
import { loadEnvLocal, ollamaReachable } from './config.js';

/**
 * Every hosted provider, live, with no credentials.
 *
 * The contract suite needs a key, so without one a provider is skipped and the
 * two things most likely to be wrong in its preset row go unchecked:
 *
 *   1. the base URL. A typo, a missing `/v1`, a dropped trailing slash on
 *      Gemini's `/v1beta/openai/` — none of which the offline suite can catch,
 *      because it stubs the transport and the URL is never dialled.
 *   2. the auth branch of the error taxonomy. `toAiError` claims a rejected key
 *      becomes `code: 'auth'`, non-retryable, for every vendor. Vendors
 *      disagree about how to say "no": 401 and 403 both appear, bodies differ,
 *      and at least one wraps it differently.
 *
 * Both are testable by sending a deliberately invalid key and reading the
 * rejection, which costs nothing and needs no account. So this runs for all
 * providers on every live run, and is the only part of the live suite that
 * covers OpenAI, Groq, Together and OpenRouter on a machine with no keys at
 * all.
 *
 * What it does NOT prove: that a real key works, that the default model exists,
 * or that responses parse. Those need the contract suite and a credential.
 */

loadEnvLocal();

/** Opt out for a fully offline run: `LIVE_SKIP_REACHABILITY=1`. */
const offline = process.env.LIVE_SKIP_REACHABILITY === '1';

const hosted = Object.entries(CHAT_PRESETS).filter(([, p]) => p.requiresApiKey);

describe.skipIf(offline)('live reachability (no credentials required)', () => {
  for (const [id, preset] of hosted) {
    it(`${id}: ${preset.baseUrl} is reachable and rejects a bad key as auth`, async () => {
      const provider = buildChatProvider({
        provider: id,
        model: preset.defaultModel,
        apiKey: 'sk-invalid-key-for-reachability-probe-000000',
        timeoutMs: 30_000,
        maxRetries: 0,
      });

      const err = await provider
        .chat({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 4 })
        .then(
          () => null,
          (e: unknown) => e,
        );

      expect(err, `${id} accepted an obviously invalid API key`).toBeInstanceOf(AiProviderError);
      const aiErr = err as AiProviderError;

      // A network-level failure means the base URL is wrong or the host is
      // down, which is the finding this test exists for -- distinguish it from
      // a real auth rejection rather than letting both read as "errored".
      expect(
        aiErr.code,
        `${id} did not answer at ${preset.baseUrl} (code=${aiErr.code}: ${aiErr.message}). ` +
          'Either the preset base URL is wrong or the provider is unreachable.',
      ).not.toBe('network');

      expect(
        aiErr.code,
        `${id} returned HTTP ${aiErr.status}, which mapped to "${aiErr.code}" rather than ` +
          '"auth". toAiError needs to cover this vendor\'s way of rejecting a key.',
      ).toBe('auth');
      expect(aiErr.retryable, `${id}: a bad key must never be retried`).toBe(false);
      expect(aiErr.providerId).toBe(id);
    });
  }

  /**
   * Ollama is the inverse case: unauthenticated by design, so "rejects a bad
   * key" is not a property it has. What matters locally is that the documented
   * default URL is the one a fresh install actually listens on.
   */
  it('ollama: the preset base URL matches where a local install listens', async () => {
    const reachable = await ollamaReachable(CHAT_PRESETS.ollama.baseUrl);
    if (!reachable) {
      // eslint-disable-next-line no-console -- a skip needs to say why
      console.info(
        `  ollama not running at ${CHAT_PRESETS.ollama.baseUrl} — start it with \`ollama serve\``,
      );
      return;
    }
    expect(reachable).toBe(true);
  });
});

describe.skipIf(offline)('live reachability: embeddings endpoints', () => {
  for (const [id, preset] of Object.entries(EMBEDDING_PRESETS)) {
    if (!preset.requiresApiKey) continue;

    const endpoint = `${preset.baseUrl.replace(/\/$/, '')}/embeddings`;

    it(`${id}: ${endpoint} is reachable`, async () => {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer sk-invalid-key-for-reachability-probe-000000',
        },
        body: JSON.stringify({ model: preset.defaultModel, input: ['probe'] }),
        signal: AbortSignal.timeout(30_000),
      }).catch((e: Error) => e);

      expect(
        res,
        `${id} embeddings endpoint did not answer at ${endpoint} — check the preset URL`,
      ).not.toBeInstanceOf(Error);

      const status = (res as Response).status;
      // Any HTTP answer proves the route exists. A 404 would mean the path is
      // wrong, which is exactly the preset bug worth catching -- the rest of
      // the 4xx family is the endpoint correctly refusing an invalid key.
      expect(
        status,
        `${id} answered ${status} at ${endpoint}; 404 means the path is wrong`,
      ).not.toBe(404);
      expect(status).toBeGreaterThanOrEqual(400);
      expect(status).toBeLessThan(500);
    });
  }
});

/**
 * `CHAT_PRESETS.groq.embeddings = false` is the claim the whole capability
 * model exists to demonstrate, so it is worth checking against the real service
 * rather than trusting a comment written once.
 *
 * It needs a key, and the reason is itself a finding. The first version of this
 * test probed `/openai/v1/embeddings` with a deliberately bad key and expected
 * a 404. Groq returns **401**: it authenticates before it routes. A genuinely
 * unknown path (`/openai/v1/definitely-not-a-route`) does return 404 with the
 * same bad key, so 401 here means the route is registered -- but registered is
 * not the same as usable, and only a valid key can tell the difference.
 *
 * So this is gated on a credential instead of asserting something a keyless
 * probe cannot see. Without one it reports what it would have checked, which is
 * more honest than a green tick standing on a false premise.
 */
describe.skipIf(offline)('live capability claims: chat-only providers', () => {
  const groqKey = process.env.LIVE_GROQ_API_KEY?.trim();

  it.skipIf(!groqKey)('groq: /embeddings is registered but not usable', async () => {
    const res = await fetch(`${CHAT_PRESETS.groq.baseUrl}/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${groqKey}` },
      body: JSON.stringify({ model: 'nomic-embed-text-v1.5', input: ['probe'] }),
      signal: AbortSignal.timeout(30_000),
    }).catch((e: Error) => e);

    expect(res).not.toBeInstanceOf(Error);
    const response = res as Response;
    const body = await response.text();

    // A 2xx would mean Groq has added embeddings and the preset now understates
    // it: `embeddings: false` would be wrongly refusing a valid configuration
    // at boot, and EMBEDDING_PRESETS should gain a groq row.
    expect(
      response.ok,
      `Groq answered ${response.status} on /embeddings with a valid key: ${body.slice(0, 300)}. ` +
        'If this is a success, CHAT_PRESETS.groq.embeddings must become true and a groq row ' +
        'added to EMBEDDING_PRESETS.',
    ).toBe(false);
  });
});
