'use client';

import type { Citation } from '@kb/contracts';
import { AnimatePresence, m } from 'motion/react';
import Link from 'next/link';
import { useLayoutEffect, useRef, useState } from 'react';
import { ExternalIcon, FileIcon } from './icons';
import { EASE_OUT } from './motion';
import { Dialog } from './ui';

export function CitationNumber({ n, className = '' }: { n: number; className?: string }) {
  return (
    <span
      className={`inline-flex min-w-4.5 items-center justify-center rounded-md bg-[var(--color-accent-soft)] px-1 text-[11px] leading-[18px] font-semibold text-[var(--color-accent)] tabular-nums ${className}`}
    >
      {n}
    </span>
  );
}

/**
 * Shows the exact chunk text that supported a claim.
 *
 * The quote is a snapshot taken at answer time, so a citation stays readable
 * even if the document has since been edited and re-chunked.
 */
export function CitationCard({
  citation,
  onClose,
}: {
  citation: Citation | null;
  onClose: () => void;
}) {
  // Kept through the exit animation, which runs after `citation` is already null.
  const [shown, setShown] = useState(citation);
  if (citation && citation !== shown) setShown(citation);

  return (
    <Dialog
      open={citation !== null}
      onClose={onClose}
      title={
        shown && (
          <span className="flex items-center gap-2">
            <CitationNumber n={shown.number} />
            <span className="truncate">{shown.documentTitle || 'Source'}</span>
          </span>
        )
      }
    >
      {shown && (
        <div className="px-4 py-4">
          <p className="text-xs font-medium tracking-wide text-[var(--color-ink-muted)] uppercase">
            Supporting passage
          </p>
          <blockquote className="mt-2 max-h-72 overflow-auto rounded-lg border-l-2 border-[var(--color-accent)] bg-[var(--color-surface-muted)] py-2.5 pr-3 pl-3.5 text-sm leading-relaxed whitespace-pre-wrap">
            {shown.quote}
          </blockquote>

          {shown.documentId && (
            <Link
              href={`/documents/${shown.documentId}`}
              className="mt-4 inline-flex items-center gap-1.5 text-sm font-medium text-[var(--color-accent)] underline-offset-4 hover:underline"
            >
              <FileIcon />
              Open document
            </Link>
          )}
        </div>
      )}
    </Dialog>
  );
}

const PREVIEW_WIDTH = 320;

/**
 * Hover preview for an inline citation marker: title and the start of the
 * quote, so a claim can be checked without leaving the answer. Click still
 * opens the full passage. Pointer-only and never focusable -- keyboard users
 * get the same content from the dialog.
 */
export function CitationPreview({
  target,
}: {
  target: { citation: Citation; anchor: DOMRect } | null;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; below: boolean } | null>(null);

  useLayoutEffect(() => {
    if (!target) return;
    const { anchor } = target;
    const height = ref.current?.offsetHeight ?? 140;
    const left = Math.min(
      Math.max(8, anchor.left + anchor.width / 2 - PREVIEW_WIDTH / 2),
      window.innerWidth - PREVIEW_WIDTH - 8,
    );
    const below = anchor.top - height - 10 < 64; // keep clear of the sticky header
    setPos({ left, top: below ? anchor.bottom + 8 : anchor.top - height - 8, below });
  }, [target]);

  const quote = target?.citation.quote.replace(/\s+/g, ' ').trim() ?? '';

  return (
    <AnimatePresence>
      {target && (
        <m.div
          ref={ref}
          key={target.citation.chunkId}
          aria-hidden="true"
          initial={{ opacity: 0, scale: 0.97, y: pos?.below ? -4 : 4 }}
          animate={{ opacity: pos ? 1 : 0, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.97, transition: { duration: 0.1 } }}
          transition={{ duration: 0.15, ease: EASE_OUT }}
          style={{
            left: pos?.left ?? -9999,
            top: pos?.top ?? 0,
            width: PREVIEW_WIDTH,
            transformOrigin: pos?.below ? 'top center' : 'bottom center',
          }}
          className="pointer-events-none fixed z-50 rounded-xl border bg-[var(--color-surface)] p-3 shadow-xl shadow-black/10"
        >
          <div className="flex items-center gap-2 text-xs font-medium">
            <CitationNumber n={target.citation.number} />
            <span className="truncate">{target.citation.documentTitle || 'Source'}</span>
            <ExternalIcon className="ml-auto shrink-0 text-[var(--color-ink-muted)]" />
          </div>
          <p className="mt-2 line-clamp-4 text-xs leading-relaxed text-[var(--color-ink-muted)]">
            {quote}
          </p>
        </m.div>
      )}
    </AnimatePresence>
  );
}
