import { Injectable, Logger } from '@nestjs/common';
import { estimateCostUsd, PRICING, type UsageEvent } from '@kb/ai';
import type { AnswerQuality } from '@kb/contracts';
import { AppError } from '../common/errors.js';
import { SupabaseService } from '../supabase/supabase.service.js';

export interface UsageSummaryRow {
  provider: string;
  model: string;
  operation: string;
  calls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedCostUsd: number | null;
  avgLatencyMs: number | null;
}

/** Writes use the service role (users cannot insert their own usage); reads are RLS-scoped. */
@Injectable()
export class UsageService {
  private readonly logger = new Logger(UsageService.name);

  constructor(private readonly supabase: SupabaseService) {}

  /** Never throws: an answer must not be lost to an analytics failure. */
  async record(ownerId: string, events: UsageEvent[]): Promise<void> {
    if (events.length === 0) return;

    try {
      const { error } = await this.supabase
        .admin()
        .from('usage_events')
        .insert(
          events.map((e) => ({
            owner_id: ownerId,
            operation: e.operation,
            provider: e.providerId,
            model: e.model,
            prompt_tokens: e.promptTokens,
            completion_tokens: e.completionTokens,
            total_tokens: e.totalTokens,
            // null, not 0, when the model has no published price: "unknown"
            // and "free" are different claims.
            estimated_cost_usd: PRICING[e.model] ? e.estimatedCostUsd : null,
            latency_ms: e.latencyMs,
          })),
        );
      if (error) this.logger.warn(`Usage write failed: ${error.message}`);
    } catch (e) {
      this.logger.warn(`Usage write threw: ${(e as Error).message}`);
    }
  }

  async summary(accessToken: string, days: number): Promise<UsageSummaryRow[]> {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    const { data, error } = await this.supabase
      .forUser(accessToken)
      .rpc('usage_summary', { since });

    if (error) throw AppError.internal(`Failed to load usage: ${error.message}`);

    return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
      provider: r.provider as string,
      model: r.model as string,
      operation: r.operation as string,
      calls: Number(r.calls),
      promptTokens: Number(r.prompt_tokens),
      completionTokens: Number(r.completion_tokens),
      totalTokens: Number(r.total_tokens),
      estimatedCostUsd: r.estimated_cost_usd === null ? null : Number(r.estimated_cost_usd),
      avgLatencyMs: r.avg_latency_ms === null ? null : Number(r.avg_latency_ms),
    }));
  }

  async quality(accessToken: string, days: number): Promise<AnswerQuality> {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const { data, error } = await this.supabase
      .forUser(accessToken)
      .rpc('answer_quality_summary', { since });
    if (error) throw AppError.internal(`Failed to load answer quality: ${error.message}`);

    const r = ((data ?? []) as Record<string, unknown>[])[0] ?? {};
    return {
      answers: Number(r.answers ?? 0),
      grounded: Number(r.grounded ?? 0),
      refusals: Number(r.refusals ?? 0),
      refusedWithoutModel: Number(r.refused_without_model ?? 0),
      ungrounded: Number(r.ungrounded ?? 0),
      flaggedAnswers: Number(r.flagged_answers ?? 0),
    };
  }

  /** Exposed so the UI can explain why some rows show no cost. */
  get pricedModels(): string[] {
    return Object.keys(PRICING);
  }

  estimate(model: string, promptTokens: number, completionTokens: number): number {
    return estimateCostUsd(model, {
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
    });
  }
}
