/** Plain module (no 'use client') so server components can style links as buttons too. */
export type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';

const VARIANTS: Record<Variant, string> = {
  primary:
    'bg-[var(--color-accent)] text-[var(--color-accent-ink)] shadow-sm hover:brightness-110 dark:hover:brightness-110',
  secondary:
    'border bg-[var(--color-surface)] text-[var(--color-ink)] shadow-xs hover:bg-[var(--color-surface-muted)]',
  ghost:
    'text-[var(--color-ink-muted)] hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-ink)]',
  danger:
    'border text-[var(--color-danger)] hover:border-[var(--color-danger)] hover:bg-[var(--color-danger-soft)]',
};

/**
 * Shared by `<Button>` and links styled as buttons. The press scale is plain
 * CSS: it has to feel instant, and a transition on `transform` is interruptible
 * where a JS animation would queue.
 */
export function buttonClass(variant: Variant = 'primary', className = '') {
  return `inline-flex h-8 select-none items-center justify-center gap-1.5 rounded-lg px-3 text-sm font-medium whitespace-nowrap transition-[transform,background-color,border-color,filter,color] duration-150 active:scale-[0.97] disabled:pointer-events-none disabled:opacity-50 ${VARIANTS[variant]} ${className}`;
}
