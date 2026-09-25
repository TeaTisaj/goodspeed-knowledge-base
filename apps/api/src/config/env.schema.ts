import { CHAT_PRESETS, EMBEDDING_PRESETS } from '@kb/ai';
import { z } from 'zod';

/**
 * Every environment variable the API reads, validated once at boot.
 *
 * Failing here is deliberate: a missing key should stop the process with an
 * actionable message, not surface as a 500 on the first request that needs it.
 */

const nonEmpty = z.string().trim().min(1);

/**
 * Derived from the AI layer's presets, never restated. A provider in neither
 * list is still valid if it brings its own base URL.
 */
export const CHAT_PROVIDERS = [...Object.keys(CHAT_PRESETS), 'fake'] as const;

/** Providers exposing `/v1/embeddings`. Groq has no embeddings endpoint, so it is absent. */
export const EMBEDDING_PROVIDERS = [...Object.keys(EMBEDDING_PRESETS), 'fake'] as const;

/** A provider is configurable when it has a preset, or when it names its own endpoint. */
function resolvable(provider: string, known: readonly string[], baseUrl: string | undefined) {
  return known.includes(provider) || baseUrl !== undefined;
}

export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(3001),
    /** Comma-separated. Both hosts by default: browsers treat them as different origins. */
    CORS_ORIGIN: nonEmpty.default('http://localhost:3000,http://127.0.0.1:3000'),

    // Supabase. The service-role key is held by the worker only.
    SUPABASE_URL: z.url(),
    SUPABASE_PUBLISHABLE_KEY: nonEmpty,
    SUPABASE_SECRET_KEY: nonEmpty,

    // Direct Postgres connection for pg-boss. Must be a session-mode or direct
    // DSN: pg-boss uses LISTEN/NOTIFY, which transaction pooling does not support.
    DATABASE_URL: nonEmpty.refine((v) => v.startsWith('postgres'), {
      message: 'DATABASE_URL must be a postgres connection string',
    }),

    WORKER_MODE: z.enum(['inline', 'standalone', 'off']).default('inline'),

    // AI: chat and embeddings are configured independently, because a realistic
    // deployment mixes them (e.g. chat on Groq, embeddings on OpenAI).
    AI_CHAT_PROVIDER: nonEmpty.default('fake'),
    AI_CHAT_MODEL: nonEmpty.default('gpt-5.6'),
    AI_CHAT_BASE_URL: z.url().optional(),
    AI_CHAT_API_KEY: z.string().optional(),

    /** Optional secondary chat provider, used only after the primary exhausts its retries. */
    AI_CHAT_FALLBACK_PROVIDER: nonEmpty.optional(),
    AI_CHAT_FALLBACK_MODEL: nonEmpty.optional(),
    AI_CHAT_FALLBACK_BASE_URL: z.url().optional(),
    AI_CHAT_FALLBACK_API_KEY: z.string().optional(),

    AI_EMBEDDING_PROVIDER: nonEmpty.default('fake'),
    AI_EMBEDDING_MODEL: nonEmpty.default('text-embedding-3-small'),
    AI_EMBEDDING_BASE_URL: z.url().optional(),
    AI_EMBEDDING_API_KEY: z.string().optional(),
    /** Must match the `vector(N)` column dimension; changing it requires re-ingestion. */
    AI_EMBEDDING_DIMENSIONS: z.coerce.number().int().positive().max(2000).default(1536),

    AI_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
    /**
     * Per-answer completion cap, i.e. the per-request cost ceiling. Generous
     * because reasoning models spend it on hidden reasoning first.
     */
    AI_ANSWER_MAX_TOKENS: z.coerce.number().int().min(256).max(32_000).default(2048),
    AI_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(2),

    // Retrieval. The reranker is opt-in: it costs a model call per question.
    RETRIEVAL_CANDIDATES: z.coerce.number().int().min(1).max(100).default(12),
    RETRIEVAL_TOP_K: z.coerce.number().int().min(1).max(20).default(6),
    /** HyDE query expansion. Off by default: one extra model call per question. */
    RETRIEVAL_HYDE: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
    AI_RERANK_ENABLED: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
    MAX_CONTEXT_TOKENS: z.coerce.number().int().positive().default(8000),
    /**
     * Similarity floor for the out-of-scope refusal; 0 disables it. Unset, the
     * floor measured for the embedding model is used (see `pnpm eval`).
     */
    RETRIEVAL_MIN_SIMILARITY: z.coerce.number().min(0).max(1).optional(),
  })
  /** Reachability and key requirements both come from the preset table. */
  .superRefine((e, ctx) => {
    if (!resolvable(e.AI_CHAT_PROVIDER, CHAT_PROVIDERS, e.AI_CHAT_BASE_URL)) {
      ctx.addIssue({
        code: 'custom',
        path: ['AI_CHAT_PROVIDER'],
        message:
          `Unknown chat provider "${e.AI_CHAT_PROVIDER}". Providers with a preset: ` +
          `${CHAT_PROVIDERS.join(', ')}. Any other service following the OpenAI spec works ` +
          'by also setting AI_CHAT_BASE_URL to its /v1 endpoint.',
      });
    }
    const chatOnly = CHAT_PRESETS[e.AI_EMBEDDING_PROVIDER as keyof typeof CHAT_PRESETS];
    if (chatOnly && !chatOnly.embeddings) {
      ctx.addIssue({
        code: 'custom',
        path: ['AI_EMBEDDING_PROVIDER'],
        message:
          `"${e.AI_EMBEDDING_PROVIDER}" has no embeddings endpoint. Keep it for chat ` +
          `(AI_CHAT_PROVIDER=${e.AI_EMBEDDING_PROVIDER}) and pair it with an embedding provider: ` +
          `${EMBEDDING_PROVIDERS.join(', ')}.`,
      });
    } else if (!resolvable(e.AI_EMBEDDING_PROVIDER, EMBEDDING_PROVIDERS, e.AI_EMBEDDING_BASE_URL)) {
      ctx.addIssue({
        code: 'custom',
        path: ['AI_EMBEDDING_PROVIDER'],
        message:
          `Unknown embedding provider "${e.AI_EMBEDDING_PROVIDER}". Providers with a preset: ` +
          `${EMBEDDING_PROVIDERS.join(', ')}. Any other service following the OpenAI spec works ` +
          'by also setting AI_EMBEDDING_BASE_URL to its /v1 endpoint.',
      });
    }

    // `fake` needs nothing so the app boots with zero credentials; Ollama runs
    // unauthenticated; a self-hosted endpoint may or may not want a key, so it
    // is asked for only when a preset says the service requires one.
    const chatPreset = CHAT_PRESETS[e.AI_CHAT_PROVIDER as keyof typeof CHAT_PRESETS];
    if (chatPreset?.requiresApiKey && !e.AI_CHAT_API_KEY) {
      ctx.addIssue({
        code: 'custom',
        path: ['AI_CHAT_API_KEY'],
        message: `AI_CHAT_API_KEY is required for provider "${e.AI_CHAT_PROVIDER}".`,
      });
    }
    const embedPreset =
      EMBEDDING_PRESETS[e.AI_EMBEDDING_PROVIDER as keyof typeof EMBEDDING_PRESETS];
    if (embedPreset?.requiresApiKey && !e.AI_EMBEDDING_API_KEY) {
      ctx.addIssue({
        code: 'custom',
        path: ['AI_EMBEDDING_API_KEY'],
        message: `AI_EMBEDDING_API_KEY is required for provider "${e.AI_EMBEDDING_PROVIDER}".`,
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

/** Parses and formats failures as a readable, actionable list. */
export function parseEnv(raw: NodeJS.ProcessEnv): Env {
  const result = envSchema.safeParse(raw);
  if (!result.success) {
    const lines = result.error.issues.map(
      (i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`,
    );
    throw new Error(`Invalid environment configuration:\n${lines.join('\n')}`);
  }
  return result.data;
}
