'use client';

import type { DocumentSummary } from '@kb/contracts';
import { m } from 'motion/react';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { ChatIcon } from '@/components/icons';
import { EASE_OUT, SPRING } from '@/components/motion';

/**
 * First screen of a conversation. Suggestions come from the user's own ready
 * documents and only fill the box -- sending a canned question could easily hit
 * the relevance floor and make the first impression a refusal.
 */
export function ChatEmptyState({ onPick }: { onPick: (text: string) => void }) {
  const [docs, setDocs] = useState<DocumentSummary[]>([]);

  useEffect(() => {
    api.listDocuments().then(
      (res) => setDocs(res.items.filter((d) => d.status === 'ready').slice(0, 4)),
      () => undefined,
    );
  }, []);

  return (
    <div className="flex flex-1 flex-col items-center justify-center py-12 text-center">
      <m.div
        initial={{ opacity: 0, scale: 0.9 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={SPRING}
        className="flex size-12 items-center justify-center rounded-2xl border bg-[var(--color-surface)] text-[var(--color-accent)] shadow-sm"
      >
        <ChatIcon width={22} height={22} />
      </m.div>
      <h2 className="mt-5 text-xl font-semibold tracking-tight">Ask about your documents</h2>
      <p className="mt-1.5 max-w-md text-sm text-balance text-[var(--color-ink-muted)]">
        Answers are grounded in what you have written or uploaded, with a citation back to the exact
        passage behind each claim.
      </p>

      {docs.length > 0 && (
        <div className="mt-8 grid w-full max-w-xl gap-2 sm:grid-cols-2">
          {docs.map((d, i) => (
            <m.button
              key={d.id}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3, ease: EASE_OUT, delay: 0.1 + i * 0.05 }}
              onClick={() => onPick(`What does "${d.title}" say about `)}
              className="group rounded-xl border bg-[var(--color-surface)] px-3.5 py-3 text-left transition-[border-color,box-shadow] hover:border-[var(--color-border-strong)] hover:shadow-sm"
            >
              <span className="text-xs text-[var(--color-ink-muted)]">Ask about</span>
              <span className="mt-0.5 block truncate text-sm font-medium transition-colors group-hover:text-[var(--color-accent)]">
                {d.title}
              </span>
            </m.button>
          ))}
        </div>
      )}
    </div>
  );
}
