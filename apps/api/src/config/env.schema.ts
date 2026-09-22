import { z } from 'zod';

/**
 * Every environment variable the API reads, validated once at boot.
 *
 * Failing here is deliberate: a missing key should stop the process with an
 * actionable message, not surface as a 500 on the first request that needs it.
 */

const nonEmpty = z.string().trim().min(1);

/** Providers that speak the OpenAI `/v1/chat/completions` wire protocol. */
export const CHAT_PROVIDERS = [
  'openai',
  'groq',
  'together',
  'openrouter',
  'ollama',
  'fake',
] as const;

/** Providers exposing `/v1/embeddings`. Groq has no embeddings endpoint, so it is absent. */
export const EMBEDDING_PROVIDERS = ['openai', 'together', 'openrouter', 'ollama', 'fake'] as const;

export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(3001),
    CORS_ORIGIN: nonEmpty.default('http://localhost:3000'),

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
    AI_CHAT_PROVIDER: z.enum(CHAT_PROVIDERS).default('fake'),
    AI_CHAT_MODEL: nonEmpty.default('gpt-5.6'),
    AI_CHAT_BASE_URL: z.url().optional(),
    AI_CHAT_API_KEY: z.string().optional(),

    AI_EMBEDDING_PROVIDER: z.enum(EMBEDDING_PROVIDERS).default('fake'),
    AI_EMBEDDING_MODEL: nonEmpty.default('text-embedding-3-small'),
    AI_EMBEDDING_BASE_URL: z.url().optional(),
    AI_EMBEDDING_API_KEY: z.string().optional(),
    /** Must match the `vector(N)` column dimension; changing it requires re-ingestion. */
    AI_EMBEDDING_DIMENSIONS: z.coerce.number().int().positive().max(2000).default(1536),

    AI_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
    AI_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(2),
  })
  // A real provider needs a key; `fake` deliberately needs nothing so the app
  // boots with zero credentials.
  .refine(
    (e) => e.AI_CHAT_PROVIDER === 'fake' || e.AI_CHAT_PROVIDER === 'ollama' || !!e.AI_CHAT_API_KEY,
    {
      message: 'AI_CHAT_API_KEY is required unless AI_CHAT_PROVIDER is "fake" or "ollama"',
      path: ['AI_CHAT_API_KEY'],
    },
  )
  .refine(
    (e) =>
      e.AI_EMBEDDING_PROVIDER === 'fake' ||
      e.AI_EMBEDDING_PROVIDER === 'ollama' ||
      !!e.AI_EMBEDDING_API_KEY,
    {
      message:
        'AI_EMBEDDING_API_KEY is required unless AI_EMBEDDING_PROVIDER is "fake" or "ollama"',
      path: ['AI_EMBEDDING_API_KEY'],
    },
  );

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
