import { describe, expect, it } from 'vitest';
import { OpenAICompatibleChatProvider } from './openai-compatible.js';
import { CHAT_PRESETS } from '../presets.js';
import { AiProviderError } from '../types.js';

/**
 * OpenAI's reasoning models (o-series, GPT-5) refuse two fields every other
 * preset accepts: `max_tokens` and a custom `temperature`. Unhandled, that is a
 * 400 on every question the moment someone configures an OpenAI key.
 */

const OK = {
  id: 'x',
  object: 'chat.completion',
  created: 0,
  model: 'm',
  choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
};

/** OpenAI's error for a field the model does not take. */
const refusal = (param: string, message: string) => ({
  error: { message, type: 'invalid_request_error', param, code: 'unsupported_parameter' },
});

const TEMPERATURE = refusal(
  'temperature',
  "Unsupported value: 'temperature' does not support 0.2 with this model. Only the default (1) value is supported.",
);
const MAX_TOKENS = refusal(
  'max_tokens',
  "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.",
);

/** A JSON reply as `[status, body]`, or a ready-made Response (for a stream). */
type Reply = [number, unknown] | Response;

/** A provider whose transport answers from `replies` in order and records every request body. */
function scripted(presetId: keyof typeof CHAT_PRESETS, replies: Reply[]) {
  const preset = CHAT_PRESETS[presetId];
  const provider = new OpenAICompatibleChatProvider({
    id: preset.id,
    baseUrl: preset.baseUrl,
    apiKey: 'test-key',
    model: preset.defaultModel,
    capabilities: preset.capabilities,
  });
  const bodies: Array<Record<string, unknown>> = [];
  // @ts-expect-error -- inject a stub transport into the private client
  provider.client.fetch = async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    const reply = replies[Math.min(bodies.length - 1, replies.length - 1)]!;
    if (reply instanceof Response) return reply;
    const [status, body] = reply;
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { provider, bodies };
}

const ask = {
  messages: [{ role: 'user' as const, content: 'hi' }],
  temperature: 0.2,
  maxTokens: 64,
};

describe('request fields a model refuses', () => {
  it('sends max_completion_tokens to OpenAI, never max_tokens', async () => {
    const { provider, bodies } = scripted('openai', [[200, OK]]);
    await provider.chat(ask);
    expect(bodies[0]).toMatchObject({ max_completion_tokens: 64 });
    expect(bodies[0]).not.toHaveProperty('max_tokens');
  });

  it('keeps max_tokens for providers that only know that field', async () => {
    const { provider, bodies } = scripted('groq', [[200, OK]]);
    await provider.chat(ask);
    expect(bodies[0]).toMatchObject({ max_tokens: 64, temperature: 0.2 });
  });

  it('drops a refused temperature, retries once, and remembers', async () => {
    const { provider, bodies } = scripted('openai', [
      [400, TEMPERATURE],
      [200, OK],
    ]);
    await expect(provider.chat(ask)).resolves.toMatchObject({ text: 'ok' });
    await provider.chat(ask);

    expect(bodies).toHaveLength(3);
    expect(bodies[0]).toHaveProperty('temperature', 0.2);
    expect(bodies[1]).not.toHaveProperty('temperature');
    expect(bodies[2]).not.toHaveProperty('temperature');
  });

  it('renames a refused max_tokens on any provider', async () => {
    const { provider, bodies } = scripted('openrouter', [
      [400, MAX_TOKENS],
      [200, OK],
    ]);
    await provider.chat(ask);
    expect(bodies[1]).toMatchObject({ max_completion_tokens: 64 });
    expect(bodies[1]).not.toHaveProperty('max_tokens');
  });

  it('recovers when streaming, before any token is sent', async () => {
    const sse =
      `data: ${JSON.stringify({ ...OK, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] })}\n\n` +
      'data: [DONE]\n\n';
    const { provider, bodies } = scripted('openai', [
      [400, TEMPERATURE],
      new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    ]);

    let text = '';
    for await (const e of provider.streamChat(ask)) if (e.type === 'text') text += e.delta;

    expect(text).toBe('ok');
    expect(bodies[1]).not.toHaveProperty('temperature');
  });

  it('still fails on a 400 it cannot fix', async () => {
    const { provider, bodies } = scripted('openai', [
      [400, { error: { message: 'messages must be non-empty', type: 'invalid_request_error' } }],
    ]);
    await expect(provider.chat(ask)).rejects.toBeInstanceOf(AiProviderError);
    expect(bodies).toHaveLength(1);
  });

  it('gives up rather than looping when the same field is refused twice', async () => {
    const { provider, bodies } = scripted('openai', [[400, TEMPERATURE]]);
    await expect(provider.chat(ask)).rejects.toMatchObject({ code: 'bad_request' });
    expect(bodies).toHaveLength(2);
  });
});
