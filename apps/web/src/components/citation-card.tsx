'use client';

import type { Citation } from '@kb/contracts';
import Link from 'next/link';

/**
 * Shows the exact chunk text that supported a claim.
 *
 * The quote is a snapshot taken at answer time, so a citation stays readable
 * even if the document has since been edited and re-chunked.
 */
export function CitationCard({ citation, onClose }: { citation: Citation; onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-4 sm:items-center"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="w-full max-w-lg rounded-lg border bg-[var(--color-surface)] p-4 shadow-lg"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="flex items-start gap-3">
          <span className="rounded-full border px-2 py-0.5 text-xs">[{citation.number}]</span>
          <p className="flex-1 text-sm font-medium">{citation.documentTitle || 'Source'}</p>
          <button onClick={onClose} className="text-sm text-[var(--color-ink-muted)]">
            Close
          </button>
        </div>

        <blockquote className="mt-3 max-h-64 overflow-auto whitespace-pre-wrap border-l-2 pl-3 text-sm leading-relaxed text-[var(--color-ink-muted)]">
          {citation.quote}
        </blockquote>

        {citation.documentId && (
          <Link
            href={`/documents/${citation.documentId}`}
            className="mt-3 inline-block text-sm underline"
          >
            Open document
          </Link>
        )}
      </div>
    </div>
  );
}
