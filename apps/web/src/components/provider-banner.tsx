'use client';

import type { Health } from '@kb/contracts';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';

/**
 * Says out loud when the app is running without a real AI provider.
 *
 * The app ships with a `fake` provider so it boots with no credentials, which
 * is a genuine strength -- a reviewer can clone, run one command and click
 * through everything. The failure mode is that the zero-key path *looks* like
 * a broken product rather than a deliberate offline one: answers come back as
 * three sentences lifted from the sources, and the only explanation is a
 * warning in the API's terminal, which nobody reading the UI will ever see.
 *
 * That is not a hypothetical. It is the first thing that happened to someone
 * running this, and they concluded the retrieval was bad. So the degradation
 * is stated where the answers are, in the words that describe what is actually
 * different, next to the one line that fixes it.
 *
 * Not dismissible. A banner explaining why output looks wrong is worth least
 * at exactly the moment someone clicks it away and keeps reading the output.
 */
export function ProviderBanner() {
  const [health, setHealth] = useState<Health | null>(null);

  useEffect(() => {
    // A failed health check is not worth surfacing here: every authenticated
    // call is about to fail too, with a better message than this component
    // could give. Staying silent avoids two banners for one outage.
    api.health().then(setHealth, () => undefined);
  }, []);

  if (!health) return null;
  if (health.answersGenerated && health.retrievalSemantic) return null;

  return (
    <div
      role="status"
      className="mt-4 rounded-md border border-[var(--color-warning)] bg-[var(--color-warning-surface)] px-4 py-3 text-sm"
    >
      <p className="font-medium text-[var(--color-warning)]">
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
