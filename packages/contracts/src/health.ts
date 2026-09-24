import { z } from 'zod';

/**
 * Health, and — more usefully — what the running configuration can actually do.
 *
 * The two booleans exist so the *server* decides what degraded means. The
 * obvious alternative is to ship the provider names and let the client compare
 * them to `'fake'`, which puts a policy decision ("fake answers are extractive")
 * in the UI layer, where it silently rots the moment another stub provider
 * appears. The client should render a claim, not derive one.
 */
export const healthSchema = z.object({
  status: z.literal('ok'),
  env: z.string(),
  chatProvider: z.string(),
  embeddingProvider: z.string(),
  embeddingDimensions: z.number().int(),
  /**
   * False when answers are assembled from retrieved sentences rather than
   * written by a model. True for every real provider.
   */
  answersGenerated: z.boolean(),
  /**
   * False when "similarity" is lexical overlap rather than meaning — the
   * hashing vectorizer the zero-key demo falls back to.
   */
  retrievalSemantic: z.boolean(),
});
export type Health = z.infer<typeof healthSchema>;
