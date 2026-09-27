import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHAT_PRESETS, EMBEDDING_PRESETS } from '../src/presets.js';

/**
 * Which live providers this machine is credentialed for.
 *
 * The live suite is opt-in by credential rather than by flag: a provider with a
 * key is tested, a provider without one is skipped by name. That is the only
 * arrangement that works for both a laptop with one free key and CI with
 * several, without anyone maintaining a list of which is which.
 */

/**
 * Credentials for the live suite, read from any gitignored env file.
 *
 * **Only `LIVE_`-prefixed keys are imported.** That prefix, not the filename, is
 * what keeps the two concerns apart: the app reads `AI_CHAT_PROVIDER` and
 * `AI_CHAT_API_KEY`, so a `LIVE_GROQ_API_KEY` sitting anywhere cannot silently
 * point the running app at a metered provider, whichever file it is in.
 *
 * Restricting the import also keeps the test process clean: loading a whole
 * `.env` would inject `DATABASE_URL`, `SUPABASE_*` and the app's own AI
 * settings into a run that has no business reading them.
 */
export function loadEnvLocal(): void {
  // Anchored to this file rather than to cwd: vitest runs from packages/ai, a
  // root `pnpm test:live` runs from the repo root, and an IDE runner from
  // somewhere else again. Both locations are searched so keys can sit next to
  // the app's own env or next to the package, whichever the reader expects.
  const here = dirname(fileURLToPath(import.meta.url));
  const roots = [resolve(here, '..'), resolve(here, '..', '..', '..')];

  // First file to define a key wins, so the more specific name takes precedence
  // over the general `.env` an operator shares with the running app.
  const names = ['.env.local', '.env.live', '.env'];

  for (const [dir, name] of roots.flatMap((d) => names.map((n) => [d, n] as const))) {
    let raw: string;
    try {
      raw = readFileSync(resolve(dir, name), 'utf8');
    } catch {
      continue;
    }
    for (const line of raw.split('\n')) {
      const m = /^\s*(LIVE_[A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
      if (!m) continue;
      const [, key, rawValue] = m;
      if (process.env[key!] !== undefined) continue; // a real env var wins
      process.env[key!] = rawValue!.trim().replace(/^["']|["']$/g, '');
    }
  }
}

export interface LiveChatTarget {
  id: string;
  model: string;
  apiKey?: string;
  baseUrl?: string;
}

export interface LiveEmbeddingTarget extends LiveChatTarget {
  dimensions?: number;
}

/** `LIVE_<ID>_API_KEY`, e.g. LIVE_GROQ_API_KEY. */
function key(id: string): string | undefined {
  const v = process.env[`LIVE_${id.toUpperCase()}_API_KEY`];
  return v && v.trim().length > 0 ? v.trim() : undefined;
}

function override(id: string, kind: 'CHAT' | 'EMBEDDING', field: 'MODEL'): string | undefined {
  return process.env[`LIVE_${id.toUpperCase()}_${kind}_${field}`]?.trim() || undefined;
}

/**
 * Chat providers to exercise live.
 *
 * Read off the preset table, exactly like the stubbed suite, so the two cover
 * the same set and a new preset row is live-testable the moment someone adds a
 * key for it -- no second list to update.
 */
export function liveChatTargets(): LiveChatTarget[] {
  const out: LiveChatTarget[] = [];
  for (const [id, preset] of Object.entries(CHAT_PRESETS)) {
    const apiKey = key(id);
    // Ollama needs no key, so its presence is decided by reachability instead;
    // that probe is async and lives in the spec.
    if (preset.requiresApiKey && !apiKey) continue;
    out.push({
      id,
      model: override(id, 'CHAT', 'MODEL') ?? preset.defaultModel,
      apiKey,
      baseUrl: process.env[`LIVE_${id.toUpperCase()}_BASE_URL`]?.trim() || preset.baseUrl,
    });
  }
  return out;
}

export function liveEmbeddingTargets(): LiveEmbeddingTarget[] {
  const out: LiveEmbeddingTarget[] = [];
  for (const [id, preset] of Object.entries(EMBEDDING_PRESETS)) {
    const apiKey = key(id);
    if (preset.requiresApiKey && !apiKey) continue;
    out.push({
      id,
      model: override(id, 'EMBEDDING', 'MODEL') ?? preset.defaultModel,
      apiKey,
      baseUrl: process.env[`LIVE_${id.toUpperCase()}_BASE_URL`]?.trim() || preset.baseUrl,
      // Only ask for truncation where the provider declares it; requesting
      // `dimensions` from a model that ignores the field is how you get vectors
      // of the wrong width with no error.
      dimensions: preset.capabilities.configurableDimensions
        ? preset.capabilities.dimensions
        : undefined,
    });
  }
  return out;
}

/** Ollama is local and unauthenticated, so availability is a reachable port. */
export async function ollamaReachable(baseUrl: string): Promise<boolean> {
  const root = baseUrl.replace(/\/v1\/?$/, '');
  try {
    const res = await fetch(`${root}/api/tags`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}
