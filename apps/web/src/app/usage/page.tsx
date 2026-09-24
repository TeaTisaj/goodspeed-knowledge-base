'use client';

import { useCallback, useEffect, useState } from 'react';
import { ApiError, api } from '@/lib/api';
import { EmptyState, ErrorBanner, SkeletonRow } from '@/components/ui';
import type { UsageSummary } from '@kb/contracts';

const DAY_OPTIONS = [7, 30, 90];

export default function UsagePage() {
  const [data, setData] = useState<UsageSummary | null>(null);
  const [days, setDays] = useState(30);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await api.usage(days));
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.problem.title : 'Could not load usage');
    }
  }, [days]);

  useEffect(() => {
    void load();
  }, [load]);

  const rows = data?.rows ?? [];
  const totals = rows.reduce(
    (acc, r) => ({
      calls: acc.calls + r.calls,
      tokens: acc.tokens + r.totalTokens,
      cost: acc.cost + (r.estimatedCostUsd ?? 0),
      anyUnpriced: acc.anyUnpriced || r.estimatedCostUsd === null,
    }),
    { calls: 0, tokens: 0, cost: 0, anyUnpriced: false },
  );

  const money = (n: number) => (n < 0.01 && n > 0 ? '<$0.01' : `$${n.toFixed(2)}`);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-base font-semibold">Usage</h1>
        <div className="ml-auto flex gap-1">
          {DAY_OPTIONS.map((d) => (
            <button
              key={d}
              onClick={() => setDays(d)}
              className={`rounded-md border px-2.5 py-1 text-xs ${
                d === days ? 'bg-[var(--color-surface-muted)] font-medium' : ''
              }`}
            >
              {d}d
            </button>
          ))}
        </div>
      </div>

      {error && <ErrorBanner message={error} onRetry={() => void load()} />}

      {data === null ? (
        <div className="flex flex-col gap-2">
          <SkeletonRow />
          <SkeletonRow />
        </div>
      ) : rows.length === 0 ? (
        <EmptyState
          title="No usage yet"
          description="Ask a question or upload a document, and token usage will appear here broken down by provider and model."
        />
      ) : (
        <>
          <div className="grid grid-cols-3 gap-2">
            {[
              { label: 'Calls', value: totals.calls.toLocaleString() },
              { label: 'Tokens', value: totals.tokens.toLocaleString() },
              {
                label: 'Estimated cost',
                value: totals.anyUnpriced ? `${money(totals.cost)}+` : money(totals.cost),
              },
            ].map((s) => (
              <div key={s.label} className="rounded-md border p-3">
                <p className="text-xs text-[var(--color-ink-muted)]">{s.label}</p>
                <p className="mt-1 text-lg font-semibold tabular-nums">{s.value}</p>
              </div>
            ))}
          </div>

          <div className="overflow-x-auto rounded-md border">
            <table className="w-full text-sm">
              <thead className="border-b text-left text-xs text-[var(--color-ink-muted)]">
                <tr>
                  <th className="p-2 font-medium">Provider / model</th>
                  <th className="p-2 font-medium">Operation</th>
                  <th className="p-2 text-right font-medium">Calls</th>
                  <th className="p-2 text-right font-medium">Tokens</th>
                  <th className="p-2 text-right font-medium">Avg latency</th>
                  <th className="p-2 text-right font-medium">Cost</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr
                    key={`${r.provider}-${r.model}-${r.operation}`}
                    className="border-b last:border-0"
                  >
                    <td className="p-2">
                      <span className="font-medium">{r.provider}</span>
                      <span className="text-[var(--color-ink-muted)]"> / {r.model}</span>
                    </td>
                    <td className="p-2 text-[var(--color-ink-muted)]">{r.operation}</td>
                    <td className="p-2 text-right tabular-nums">{r.calls.toLocaleString()}</td>
                    <td className="p-2 text-right tabular-nums">
                      {r.totalTokens.toLocaleString()}
                    </td>
                    <td className="p-2 text-right tabular-nums">
                      {r.avgLatencyMs === null ? '—' : `${r.avgLatencyMs}ms`}
                    </td>
                    <td className="p-2 text-right tabular-nums">
                      {r.estimatedCostUsd === null ? (
                        <span
                          className="text-[var(--color-ink-muted)]"
                          title="No published price for this model"
                        >
                          n/a
                        </span>
                      ) : (
                        money(r.estimatedCostUsd)
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {totals.anyUnpriced && (
            <p className="text-xs text-[var(--color-ink-muted)]">
              Rows marked <span className="font-medium">n/a</span> use a model with no published
              price in the pricing table, so their cost is unknown rather than zero. Token counts
              for non-OpenAI models are approximate — they are measured with OpenAI&apos;s
              tokenizer.
            </p>
          )}
        </>
      )}
    </div>
  );
}
