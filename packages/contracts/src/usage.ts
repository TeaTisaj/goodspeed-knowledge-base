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

export const usageSummarySchema = z.object({
  rows: z.array(usageSummaryRowSchema),
  pricedModels: z.array(z.string()),
  days: z.number().int(),
});
export type UsageSummary = z.infer<typeof usageSummarySchema>;
