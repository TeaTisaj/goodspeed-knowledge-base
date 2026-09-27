'use client';

import type { Health } from '@kb/contracts';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { AlertIcon } from './icons';

/**
 * Explains, where the answers are, when the app runs on the offline `fake`
 * provider. Without it the zero-key demo looks like poor retrieval rather than
 * a deliberate offline mode. Not dismissible: it matters most while someone is
 * reading the output it explains.
 */
export function ProviderBanner() {
  const [health, setHealth] = useState<Health | null>(null);

  useEffect(() => {
    // Silent on failure: the page's own requests will fail with a better message.
    api.health().then(setHealth, () => undefined);
  }, []);

  if (!health) return null;
  if (health.answersGenerated && health.retrievalSemantic) return null;

  return (
    <div
      role="status"
      className="mt-4 rounded-xl border border-[color-mix(in_oklab,var(--color-warning)_40%,transparent)] bg-[var(--color-warning-surface)] px-4 py-3 text-sm"
    >
      <p className="flex items-center gap-2 font-medium text-[var(--color-warning)]">
        <AlertIcon />
        Offline demo mode — no AI provider is configured
      </p>
      <ul className="mt-1.5 list-disc space-y-0.5 pl-5 text-[var(--color-ink-muted)]">
        {!health.answersGenerated && (
          <li>
            Answers are stitched together from sentences already in your documents, not written by a
            model. Expect them to read like quotes, because they are.
          </li>
        )}
        {!health.retrievalSemantic && (
          <li>
            Search matches shared words rather than meaning, so a question phrased differently from
            the document may find nothing.
          </li>
        )}
      </ul>
      <p className="mt-2 text-[var(--color-ink-muted)]">
        Everything else — auth, ingestion, chunking, citations, streaming — is real. Set{' '}
        <code className="rounded bg-[var(--color-surface-muted)] px-1 py-0.5 text-xs">
          AI_CHAT_PROVIDER
        </code>{' '}
        and{' '}
        <code className="rounded bg-[var(--color-surface-muted)] px-1 py-0.5 text-xs">
          AI_EMBEDDING_PROVIDER
        </code>{' '}
        in <code className="text-xs">.env</code> to use a real one; see the README.
      </p>
    </div>
  );
}
