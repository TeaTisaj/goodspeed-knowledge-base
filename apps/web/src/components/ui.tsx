'use client';

import { AnimatePresence, m } from 'motion/react';
import { useEffect, useEffectEvent, useId, useRef, type ReactNode } from 'react';
import { AlertIcon, CheckIcon, XIcon } from './icons';
import { EASE_OUT } from './motion';

import { buttonClass, type Variant } from './button-class';

export { buttonClass };

export function Button({
  children,
  onClick,
  type = 'button',
  variant = 'primary',
  disabled,
  className = '',
  ...rest
}: {
  children: ReactNode;
  onClick?: () => void;
  type?: 'button' | 'submit';
  variant?: Variant;
  disabled?: boolean;
  className?: string;
  'aria-label'?: string;
  title?: string;
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={buttonClass(variant, className)}
      {...rest}
    >
      {children}
    </button>
  );
}

const STATUS: Record<string, { label: string; tone: string; hint: string }> = {
  queued: {
    label: 'Queued',
    tone: 'text-[var(--color-ink-muted)] bg-[var(--color-surface-muted)]',
    hint: 'Waiting for the indexer to pick it up. Not searchable yet.',
  },
  processing: {
    label: 'Processing',
    tone: 'text-[var(--color-accent)] bg-[var(--color-accent-soft)]',
    hint: 'Being split into chunks and embedded right now.',
  },
  ready: {
    label: 'Ready',
    tone: 'text-[var(--color-success)] bg-[var(--color-success-soft)]',
    hint: 'Indexed. Chat can cite this document.',
  },
  failed: {
    label: 'Failed',
    tone: 'text-[var(--color-danger)] bg-[var(--color-danger-soft)]',
    hint: 'Indexing failed. Saving the document again retries it.',
  },
};

/**
 * Ingestion status. Shown everywhere a document appears, because "why can't it
 * answer about this document yet" is the first question a user has.
 */
export function StatusBadge({ status }: { status: string }) {
  const s = STATUS[status] ?? STATUS.queued!;
  const busy = status === 'queued' || status === 'processing';

  return (
    <span
      title={s.hint}
      className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium transition-colors duration-300 ${s.tone}`}
    >
      <span className="relative flex size-1.5">
        {busy && (
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-current opacity-60 motion-reduce:hidden" />
        )}
        <span className="relative inline-flex size-1.5 rounded-full bg-current" />
      </span>
      {s.label}
    </span>
  );
}

export function EmptyState({
  title,
  description,
  action,
  icon,
}: {
  title: string;
  description: string;
  action?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <m.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease: EASE_OUT }}
      className="flex flex-col items-center justify-center rounded-2xl border border-dashed bg-[var(--color-surface)] px-6 py-14 text-center"
    >
      {icon && (
        <div className="mb-4 flex size-11 items-center justify-center rounded-xl border bg-[var(--color-surface-muted)] text-[var(--color-ink-muted)] shadow-xs">
          {icon}
        </div>
      )}
      <p className="text-sm font-semibold">{title}</p>
      <p className="mt-1 max-w-sm text-sm text-balance text-[var(--color-ink-muted)]">
        {description}
      </p>
      {action && <div className="mt-5">{action}</div>}
    </m.div>
  );
}

function Banner({
  tone,
  icon,
  message,
  action,
}: {
  tone: string;
  icon: ReactNode;
  message: string;
  action?: ReactNode;
}) {
  return (
    <m.div
      initial={{ opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, ease: EASE_OUT }}
      role={tone === 'danger' ? 'alert' : 'status'}
      className={`flex items-start gap-2.5 rounded-xl border px-3 py-2.5 text-sm ${
        tone === 'danger'
          ? 'border-[color-mix(in_oklab,var(--color-danger)_35%,transparent)] bg-[var(--color-danger-soft)] text-[var(--color-danger)]'
          : 'border-[color-mix(in_oklab,var(--color-success)_35%,transparent)] bg-[var(--color-success-soft)] text-[var(--color-success)]'
      }`}
    >
      <span className="mt-0.5 shrink-0">{icon}</span>
      <p className="flex-1">{message}</p>
      {action}
    </m.div>
  );
}

export function ErrorBanner({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <Banner
      tone="danger"
      icon={<AlertIcon />}
      message={message}
      action={
        onRetry && (
          <button onClick={onRetry} className="shrink-0 font-medium underline underline-offset-2">
            Retry
          </button>
        )
      }
    />
  );
}

export function SuccessBanner({ message, onDismiss }: { message: string; onDismiss?: () => void }) {
  return (
    <Banner
      tone="success"
      icon={<CheckIcon />}
      message={message}
      action={
        onDismiss && (
          <button onClick={onDismiss} className="shrink-0 font-medium underline underline-offset-2">
            Dismiss
          </button>
        )
      }
    />
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 text-sm text-[var(--color-ink-muted)]">
      <span className="size-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
      {label}
    </div>
  );
}

export function SkeletonRow() {
  return (
    <div className="flex items-center gap-3 rounded-xl border bg-[var(--color-surface)] p-3.5">
      <div className="shimmer size-9 rounded-lg" />
      <div className="flex-1">
        <div className="shimmer h-3.5 w-1/3 rounded" />
        <div className="shimmer mt-2 h-3 w-1/5 rounded" />
      </div>
    </div>
  );
}

/**
 * Modal dialog. Centred on desktop, a bottom sheet on phones. Traps focus,
 * closes on Escape and backdrop click, and hands focus back to whatever opened
 * it -- the parts a hand-rolled modal usually forgets.
 */
export function Dialog({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
}) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const close = useEffectEvent(onClose);

  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    panelRef.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus();

    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') close();
      if (e.key !== 'Tab' || !panelRef.current) return;
      const focusable = panelRef.current.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), textarea, input, [tabindex]:not([tabindex="-1"])',
      );
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last?.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first?.focus();
      }
    }
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
      opener?.focus?.();
    };
  }, [open]);

  return (
    <AnimatePresence>
      {open && (
        <m.div
          key="backdrop"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/35 p-3 backdrop-blur-[2px] sm:items-center sm:p-6"
          onClick={onClose}
          role="presentation"
        >
          <m.div
            ref={panelRef}
            initial={{ opacity: 0, y: 16, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.98 }}
            transition={{ duration: 0.22, ease: EASE_OUT }}
            className="w-full max-w-lg rounded-2xl border bg-[var(--color-surface)] shadow-2xl shadow-black/10"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
          >
            <div className="flex items-start gap-3 border-b px-4 py-3">
              <div id={titleId} className="min-w-0 flex-1 text-sm font-semibold">
                {title}
              </div>
              <button
                onClick={onClose}
                aria-label="Close"
                data-autofocus
                className="-mr-1 rounded-md p-1 text-[var(--color-ink-muted)] transition-colors hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-ink)]"
              >
                <XIcon />
              </button>
            </div>
            {children}
          </m.div>
        </m.div>
      )}
    </AnimatePresence>
  );
}
