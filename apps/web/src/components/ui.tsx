'use client';

import type { ReactNode } from 'react';

export function Button({
  children,
  onClick,
  type = 'button',
  variant = 'primary',
  disabled,
  className = '',
}: {
  children: ReactNode;
  onClick?: () => void;
  type?: 'button' | 'submit';
  variant?: 'primary' | 'secondary' | 'danger';
  disabled?: boolean;
  className?: string;
}) {
  const styles = {
    primary: 'bg-[var(--color-accent)] text-white hover:opacity-90',
    secondary: 'bg-[var(--color-surface-muted)] text-[var(--color-ink)] hover:opacity-80 border',
    danger: 'text-[var(--color-danger)] hover:bg-[var(--color-surface-muted)] border',
  }[variant];

  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`rounded-md px-3 py-1.5 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50 ${styles} ${className}`}
    >
      {children}
    </button>
  );
}

/**
 * Ingestion status. Shown everywhere a document appears, because "why can't it
 * answer about this document yet" is the first question a user has.
 */
export function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; className: string }> = {
    queued: { label: 'Queued', className: 'text-[var(--color-ink-muted)]' },
    processing: { label: 'Processing', className: 'text-[var(--color-accent)]' },
    ready: { label: 'Ready', className: 'text-[var(--color-success)]' },
    failed: { label: 'Failed', className: 'text-[var(--color-danger)]' },
  };
  const s = map[status] ?? map.queued!;

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs ${s.className}`}
    >
      {(status === 'queued' || status === 'processing') && (
        <span className="size-1.5 animate-pulse rounded-full bg-current" />
      )}
      {s.label}
    </span>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed px-6 py-12 text-center">
      <p className="text-sm font-medium">{title}</p>
      <p className="mt-1 max-w-sm text-sm text-[var(--color-ink-muted)]">{description}</p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function ErrorBanner({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="flex items-start justify-between gap-3 rounded-md border border-[var(--color-danger)] bg-[var(--color-surface-muted)] px-3 py-2">
      <p className="text-sm text-[var(--color-danger)]">{message}</p>
      {onRetry && (
        <button onClick={onRetry} className="shrink-0 text-sm underline">
          Retry
        </button>
      )}
    </div>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 text-sm text-[var(--color-ink-muted)]">
      <span className="size-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
      {label}
    </div>
  );
}

export function SkeletonRow() {
  return (
    <div className="animate-pulse rounded-md border p-3">
      <div className="h-4 w-1/3 rounded bg-[var(--color-surface-muted)]" />
      <div className="mt-2 h-3 w-1/5 rounded bg-[var(--color-surface-muted)]" />
    </div>
  );
}
