/**
 * Provider selection for the evals: `--chat=openrouter:openai/gpt-5.6`.
 *
 * Keys follow the live test suite's rule: only `LIVE_`-prefixed variables are
 * imported from the gitignored env files, so a key kept for evaluation can never
 * point the running app at a metered provider. An explicit `AI_CHAT_API_KEY` /
 * `AI_EMBEDDING_API_KEY` in the real environment is honoured too, for CI.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export function loadEvalEnv() {
  for (const name of ['.env.local', '.env.live', '.env']) {
    let raw;
    try {
      raw = readFileSync(resolve(ROOT, name), 'utf8');
    } catch {
      continue;
    }
    for (const line of raw.split('\n')) {
      const m = /^\s*(LIVE_[A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
      if (!m || process.env[m[1]] !== undefined) continue;
      process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
    }
  }
}

/**
 * `provider[:model]` -> factory config. The model is everything after the first
 * colon, because model ids contain slashes and, on some routers, colons.
 */
export function resolveTarget(spec, kind) {
  const at = spec.indexOf(':');
  const provider = at === -1 ? spec : spec.slice(0, at);
  const model = at === -1 ? undefined : spec.slice(at + 1);
  if (provider === 'fake') return { provider, model };

  const generic =
    kind === 'embedding' ? process.env.AI_EMBEDDING_API_KEY : process.env.AI_CHAT_API_KEY;
  const apiKey = process.env[`LIVE_${provider.toUpperCase()}_API_KEY`] ?? generic;
  if (!apiKey && provider !== 'ollama') {
    throw new Error(
      `No API key for "${provider}". Set LIVE_${provider.toUpperCase()}_API_KEY in .env (gitignored), ` +
        `or run with --${kind === 'embedding' ? 'embed' : 'chat'}=fake for the offline pipeline check.`,
    );
  }
  return { provider, model, apiKey, maxRetries: 4, timeoutMs: 90_000 };
}

export const describeTarget = (p) => `${p.id}/${p.model}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Waits out rate limits, timeouts and network blips instead of reporting them as results.
 *
 * The provider's own retry caps each wait at a few seconds, which is right for
 * a user-facing request and wrong for a batch run against a free tier whose
 * per-minute token budget needs twenty. A limit that still will not clear is
 * rethrown and scored as *not exercised* -- never as a pass or a failure, the
 * same rule the live provider suite follows. A 429 says nothing about the
 * model.
 */
export async function withPatience(fn, { attempts = 8 } = {}) {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (error) {
      if (!isTransient(error) || i >= attempts) throw error;
      const hinted = Number(error?.retryAfterSeconds);
      const fromMessage = Number(/try again in ([\d.]+)s/i.exec(String(error?.message))?.[1]);
      const seconds = Number.isFinite(hinted)
        ? hinted
        : Number.isFinite(fromMessage)
          ? fromMessage
          : 15;
      await sleep(Math.min(60, seconds + 1) * 1000);
    }
  }
}

/**
 * Failures that say nothing about the model: rate limits and timeouts. A case
 * that ends on one is *not exercised* rather than failed. The first real run
 * scored Groq timeouts as wrong answers, which is measuring the network.
 */
export const isTransient = (error) =>
  ['rate_limit', 'timeout', 'network'].includes(error?.code) ||
  /\b429\b|rate limit|timed out|timeout|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|fetch failed|Connection error/i.test(
    `${error?.message ?? error} ${error?.cause?.message ?? ''} ${error?.cause?.cause?.code ?? ''}`,
  );
