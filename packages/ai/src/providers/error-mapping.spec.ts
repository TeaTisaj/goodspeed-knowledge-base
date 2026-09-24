import { describe, expect, it } from 'vitest';
import { OpenAICompatibleChatProvider } from './openai-compatible.js';
import { CHAT_PRESETS } from '../presets.js';
import { AiProviderError } from '../types.js';

/**
 * Vendor error shapes, mapped onto the normalised taxonomy.
 *
 * Every body below was copied from a real response, captured by the live
 * reachability suite sending a deliberately invalid key to each provider. That
 * is the point of the file: the taxonomy's claims are about what vendors
 * actually do, and vendors disagree, so the evidence is pinned here where CI
 * can check it without a network or a credential.
 *
 * A case here is a regression test with a date and a source, not a guess about
 * what an error might look like.
 */

function providerRespondingWith(
  presetId: keyof typeof CHAT_PRESETS,
  status: number,
  body: unknown,
) {
  const preset = CHAT_PRESETS[presetId];
  const provider = new OpenAICompatibleChatProvider({
    id: preset.id,
    baseUrl: preset.baseUrl,
    apiKey: 'test-key',
    model: preset.defaultModel,
    capabilities: preset.capabilities,
  });
  // @ts-expect-error -- inject a stub transport into the private client
  provider.client.fetch = async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  return provider;
}

async function codeFor(
  presetId: keyof typeof CHAT_PRESETS,
  status: number,
  body: unknown,
): Promise<AiProviderError> {
  const err = await providerRespondingWith(presetId, status, body)
    .chat({ messages: [{ role: 'user', content: 'hi' }] })
    .then(
      () => null,
      (e: unknown) => e,
    );
  expect(err).toBeInstanceOf(AiProviderError);
  return err as AiProviderError;
}

describe('vendor error shapes -> normalised codes', () => {
  /**
   * Captured 2026-09-25 from api.groq.com, api.openai.com, api.together.xyz
   * and openrouter.ai. All four reject an invalid key with a 401, which the
   * status check alone handles.
   */
  it('maps a 401 to a non-retryable auth error', async () => {
    const err = await codeFor('groq', 401, {
      error: { message: 'Invalid API Key', type: 'invalid_request_error', code: 'invalid_api_key' },
    });
    expect(err.code).toBe('auth');
    expect(err.retryable).toBe(false);
    expect(err.status).toBe(401);
  });

  /**
   * Captured 2026-09-25 from generativelanguage.googleapis.com.
   *
   * Gemini's OpenAI-compatible surface rejects an invalid key with HTTP **400**,
   * not 401. Before this case existed, that landed in `bad_request`, so the one
   * misconfiguration an operator is most likely to make -- a wrong key -- was
   * reported as a malformed request and the actual cause never named. The
   * offline suite could not have found it; the live probe did.
   */
  it('maps a 400 that is really an auth failure to auth (Gemini)', async () => {
    const err = await codeFor('gemini', 400, {
      error: { code: 400, message: 'Please pass a valid API key', status: 'INVALID_ARGUMENT' },
    });
    expect(err.code).toBe('auth');
    expect(err.retryable).toBe(false);
  });

  /**
   * The counterweight to the case above: the auth pattern must stay narrow
   * enough that ordinary 400s are still bad requests. A rule that swallowed
   * these would send genuinely malformed requests down the auth path and hide
   * the real error.
   */
  it.each([
    [
      'unknown model',
      { error: { message: 'The model `nope` does not exist', type: 'invalid_request_error' } },
    ],
    [
      'bad parameter',
      {
        error: {
          message: "Invalid value for 'temperature': must be <= 2",
          type: 'invalid_request_error',
        },
      },
    ],
    ['empty messages', { error: { message: 'messages: at least one message is required' } }],
  ])('leaves an ordinary 400 as bad_request: %s', async (_name, body) => {
    const err = await codeFor('openai', 400, body);
    expect(err.code).toBe('bad_request');
    expect(err.retryable).toBe(false);
  });

  it('still recognises a context-length 400 ahead of the auth pattern', async () => {
    const err = await codeFor('openai', 400, {
      error: {
        message: "This model's maximum context length is 8192 tokens",
        type: 'invalid_request_error',
      },
    });
    expect(err.code).toBe('context_length');
  });

  it('maps 429 to a retryable rate limit', async () => {
    const err = await codeFor('groq', 429, {
      error: { message: 'Rate limit reached', type: 'rate_limit_exceeded' },
    });
    expect(err.code).toBe('rate_limit');
    expect(err.retryable).toBe(true);
  });

  it('maps 5xx to a retryable server error', async () => {
    const err = await codeFor('together', 503, { error: { message: 'upstream unavailable' } });
    expect(err.code).toBe('server_error');
    expect(err.retryable).toBe(true);
  });

  /**
   * Captured 2026-09-25 from a local Ollama 0.34.4. It answers an unknown model
   * with a 404, which must not be retried -- pulling the model is the fix, and
   * retrying only delays the message that says so.
   */
  it('maps an unknown model 404 to a non-retryable bad request', async () => {
    const err = await codeFor('ollama', 404, {
      error: { message: 'model "nope" not found, try pulling it first', type: 'api_error' },
    });
    expect(err.code).toBe('bad_request');
    expect(err.retryable).toBe(false);
  });

  it('tags every error with the provider that produced it', async () => {
    for (const id of ['openai', 'groq', 'together', 'openrouter', 'ollama'] as const) {
      const err = await codeFor(id, 401, { error: { message: 'nope' } });
      expect(err.providerId).toBe(id);
      expect(err.message).toContain(`[${id}]`);
    }
  });
});
