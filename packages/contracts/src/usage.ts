import { z } from 'zod';

export const usageSummaryRowSchema = z.object({
  provider: z.string(),
  model: z.string(),
  operation: z.string(),
  calls: z.number().int(),
  promptTokens: z.number().int(),
  completionTokens: z.number().int(),
  totalTokens: z.number().int(),
  /** Null when the model has no published price: unknown, not free. */
  estimatedCostUsd: z.number().nullable(),
  avgLatencyMs: z.number().nullable(),
});
export type UsageSummaryRow = z.infer<typeof usageSummaryRowSchema>;

/**
 * How answers related to their sources, over the same window. The production
 * counterpart of the generation eval's headline numbers.
 */
export const answerQualitySchema = z.object({
  answers: z.number().int(),
  grounded: z.number().int(),
  refusals: z.number().int(),
  /** Refused by the relevance floor, with no model call. A subset of `refusals`. */
  refusedWithoutModel: z.number().int(),
  /** Neither cited nor refused: the answers most worth a second look. */
  ungrounded: z.number().int(),
  /** Answers built on at least one source that matched the injection heuristics. */
  flaggedAnswers: z.number().int(),
});
export type AnswerQuality = z.infer<typeof answerQualitySchema>;

export const usageSummarySchema = z.object({
  rows: z.array(usageSummaryRowSchema),
  quality: answerQualitySchema,
  pricedModels: z.array(z.string()),
  days: z.number().int(),
});
export type UsageSummary = z.infer<typeof usageSummarySchema>;
