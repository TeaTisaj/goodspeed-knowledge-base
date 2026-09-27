'use client';

import { m } from 'motion/react';
import { useCallback, useEffect, useState } from 'react';
import { ApiError, api } from '@/lib/api';
import { ChartIcon } from '@/components/icons';
import { EASE_OUT, SPRING } from '@/components/motion';
import { EmptyState, ErrorBanner, SkeletonRow } from '@/components/ui';
import type { AnswerQuality, UsageSummary } from '@kb/contracts';

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
    // eslint-disable-next-line react-hooks/set-state-in-effect -- load() sets state only after its await
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
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Usage</h1>
          <p className="mt-0.5 text-sm text-[var(--color-ink-muted)]">
            Every model call made on your behalf, and how trustworthy the answers were.
          </p>
        </div>
        <div
          className="ml-auto flex gap-0.5 rounded-lg border bg-[var(--color-surface)] p-0.5"
          role="group"
          aria-label="Time range"
        >
          {DAY_OPTIONS.map((d) => (
            <button
              key={d}
              onClick={() => setDays(d)}
              aria-pressed={d === days}
              className={`relative rounded-md px-3 py-1 text-xs transition-colors ${
                d === days
                  ? 'font-medium text-[var(--color-ink)]'
                  : 'text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]'
              }`}
            >
              {d === days && (
                <m.span
                  layoutId="days-pill"
                  transition={SPRING}
                  className="absolute inset-0 rounded-md bg-[var(--color-surface-muted)]"
                />
              )}
              <span className="relative">{d}d</span>
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
          icon={<ChartIcon width={20} height={20} />}
          title="No usage yet"
          description="Ask a question or upload a document, and token usage will appear here broken down by provider and model."
        />
      ) : (
        <>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            {[
              { label: 'Calls', value: totals.calls.toLocaleString() },
              { label: 'Tokens', value: totals.tokens.toLocaleString() },
              {
                label: 'Estimated cost',
                value: totals.anyUnpriced ? `${money(totals.cost)}+` : money(totals.cost),
              },
            ].map((s, i) => (
              <m.div
                key={s.label}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.3, ease: EASE_OUT, delay: i * 0.05 }}
                className="rounded-xl border bg-[var(--color-surface)] p-4"
              >
                <p className="text-xs font-medium text-[var(--color-ink-muted)]">{s.label}</p>
                <p className="mt-1.5 text-2xl font-semibold tracking-tight tabular-nums">
                  {s.value}
                </p>
              </m.div>
            ))}
          </div>

          {data.quality.answers > 0 && <AnswerQualityPanel quality={data.quality} />}

          <div className="overflow-x-auto rounded-xl border bg-[var(--color-surface)]">
            <table className="w-full text-sm">
              <thead className="border-b bg-[var(--color-surface-muted)] text-left text-xs text-[var(--color-ink-muted)]">
                <tr>
                  <th className="px-3 py-2.5 font-medium">Provider / model</th>
                  <th className="px-3 py-2.5 font-medium">Operation</th>
                  <th className="px-3 py-2.5 text-right font-medium">Calls</th>
                  <th className="px-3 py-2.5 text-right font-medium">Tokens</th>
                  <th className="px-3 py-2.5 text-right font-medium">Avg latency</th>
                  <th className="px-3 py-2.5 text-right font-medium">Cost</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr
                    key={`${r.provider}-${r.model}-${r.operation}`}
                    className="border-b transition-colors last:border-0 hover:bg-[var(--color-surface-muted)]"
                  >
                    <td className="px-3 py-2.5">
                      <span className="font-medium">{r.provider}</span>
                      <span className="text-[var(--color-ink-muted)]"> / {r.model}</span>
                    </td>
                    <td className="px-3 py-2.5 text-[var(--color-ink-muted)]">{r.operation}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">
                      {r.calls.toLocaleString()}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums">
                      {r.totalTokens.toLocaleString()}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums">
                      {r.avgLatencyMs === null ? '—' : `${r.avgLatencyMs}ms`}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums">
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

/**
 * The production counterpart of the generation eval's headline numbers. An
 * ungrounded share that creeps up, or refusals that jump, after a model or
 * prompt change is the regression signal -- visible here before a user files
 * it.
 */
function AnswerQualityPanel({ quality }: { quality: AnswerQuality }) {
  const share = (n: number) => `${Math.round((n / quality.answers) * 100)}%`;
  const stats = [
    {
      label: 'Grounded',
      value: share(quality.grounded),
      hint: 'cite a source they were given',
      dot: 'bg-[var(--color-success)]',
    },
    {
      label: 'Refused',
      dot: 'bg-[var(--color-ink-muted)]',
      value: share(quality.refusals),
      hint: `${quality.refusedWithoutModel} with no model call`,
    },
    {
      label: 'Ungrounded',
      dot: 'bg-[var(--color-warning)]',
      value: share(quality.ungrounded),
      hint: 'neither cite nor refuse',
      warn: quality.ungrounded > 0,
    },
    {
      label: 'Suspicious sources',
      dot: undefined,
      value: quality.flaggedAnswers.toLocaleString(),
      hint: 'answers built on a source that looked like an injection',
      warn: quality.flaggedAnswers > 0,
    },
  ];
  return (
    <section aria-label="Answer quality" className="flex flex-col gap-2">
      <h2 className="text-sm font-medium">
        Answer quality{' '}
        <span className="font-normal text-[var(--color-ink-muted)]">
          · {quality.answers.toLocaleString()} answers
        </span>
      </h2>
      <QualityBar quality={quality} />
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {stats.map((s) => (
          <div key={s.label} className="rounded-xl border bg-[var(--color-surface)] p-4">
            <p className="flex items-center gap-1.5 text-xs font-medium text-[var(--color-ink-muted)]">
              {s.dot && <span className={`size-2 rounded-full ${s.dot}`} aria-hidden="true" />}
              {s.label}
            </p>
            <p
              className={`mt-1.5 text-2xl font-semibold tracking-tight tabular-nums ${s.warn ? 'text-[var(--color-warning)]' : ''}`}
            >
              {s.value}
            </p>
            <p className="mt-0.5 text-xs text-[var(--color-ink-muted)]">{s.hint}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

/** Grounded, refused and ungrounded as one bar: the proportions are the point. */
function QualityBar({ quality }: { quality: AnswerQuality }) {
  const parts = [
    { n: quality.grounded, className: 'bg-[var(--color-success)]' },
    { n: quality.refusals, className: 'bg-[var(--color-ink-muted)]' },
    { n: quality.ungrounded, className: 'bg-[var(--color-warning)]' },
  ].filter((p) => p.n > 0);

  return (
    <div
      className="flex h-2 overflow-hidden rounded-full bg-[var(--color-surface-muted)]"
      aria-hidden="true"
    >
      {parts.map((p, i) => (
        <m.div
          key={i}
          initial={{ scaleX: 0 }}
          animate={{ scaleX: 1 }}
          transition={{ duration: 0.6, ease: EASE_OUT, delay: 0.1 + i * 0.08 }}
          style={{ flexGrow: p.n, transformOrigin: 'left' }}
          className={`${p.className} border-r-2 border-[var(--color-canvas)] last:border-0`}
        />
      ))}
    </div>
  );
}
