import { z } from 'zod';

/**
 * RFC 9457 problem details.
 *
 * `code` is ours and is the stable, machine-readable contract: the web app
 * switches on it, so error handling never depends on parsing prose.
 */
export const errorCodeSchema = z.enum([
  'validation_failed',
  'unauthorized',
  'forbidden',
  'not_found',
  'conflict',
  'rate_limited',
  'provider_unavailable',
  'provider_timeout',
  'ingestion_failed',
  'internal_error',
]);
export type ErrorCode = z.infer<typeof errorCodeSchema>;

export const problemDetailsSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number().int(),
  detail: z.string().optional(),
  code: errorCodeSchema,
  /** Field-level messages, keyed by path, for form display. */
  errors: z.record(z.string(), z.array(z.string())).optional(),
});
export type ProblemDetails = z.infer<typeof problemDetailsSchema>;
