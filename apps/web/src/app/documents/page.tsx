'use client';

import type { DocumentSummary } from '@kb/contracts';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, api } from '@/lib/api';
import { EmptyState, ErrorBanner, SkeletonRow, StatusBadge, SuccessBanner } from '@/components/ui';
import { UploadButton } from '@/components/upload-button';

export default function DocumentsPage() {
  const [docs, setDocs] = useState<DocumentSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [tag, setTag] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api.listDocuments(tag ? { tag } : {});
      setDocs(res.items);
      setError(null);
      return res.items;
    } catch (e) {
      setError(e instanceof ApiError ? e.problem.title : 'Could not load documents');
      return [];
    }
  }, [tag]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Polls only while something is actually being ingested, and stops as soon as
   * everything settles. A permanent interval would keep a tab making requests
   * forever for no reason.
   */
  useEffect(() => {
    if (!docs) return;
    const pending = docs.some((d) => d.status === 'queued' || d.status === 'processing');
    if (!pending) return;

    pollRef.current = setTimeout(() => void load(), 1500);
    return () => {
      if (pollRef.current) clearTimeout(pollRef.current);
    };
  }, [docs, load]);

  const allTags = [...new Set((docs ?? []).flatMap((d) => d.tags))].sort();

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-base font-semibold">Documents</h1>
        <div className="ml-auto flex gap-2">
          <UploadButton
            /**
             * Stays on the list rather than opening the editor. An uploaded file
             * is not something you came here to edit -- you came to add it to the
             * knowledge base -- so the useful confirmation is seeing the row
             * appear and watch itself turn Ready.
             */
            onUploaded={(doc) => {
              setError(null);
              setNotice(
                `Uploaded "${doc.title}". Indexing now -- it can be asked about once Ready.`,
              );
              void load();
            }}
            onError={(message) => {
              setNotice(null);
              setError(message);
            }}
          />
          <Link
            href="/documents/new"
            className="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-white transition hover:opacity-90"
          >
            New document
          </Link>
        </div>
      </div>

      {allTags.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            onClick={() => setTag(null)}
            className={`rounded-full border px-2.5 py-0.5 text-xs ${
              tag === null ? 'bg-[var(--color-surface-muted)] font-medium' : ''
            }`}
          >
            All
          </button>
          {allTags.map((t) => (
            <button
              key={t}
              onClick={() => setTag(t === tag ? null : t)}
              className={`rounded-full border px-2.5 py-0.5 text-xs ${
                tag === t ? 'bg-[var(--color-surface-muted)] font-medium' : ''
              }`}
            >
              {t}
            </button>
          ))}
        </div>
      )}

      {notice && <SuccessBanner message={notice} onDismiss={() => setNotice(null)} />}

      {error && <ErrorBanner message={error} onRetry={() => void load()} />}

      {docs === null ? (
        <div className="flex flex-col gap-2">
          <SkeletonRow />
          <SkeletonRow />
          <SkeletonRow />
        </div>
      ) : docs.length === 0 ? (
        <EmptyState
          title={tag ? `No documents tagged "${tag}"` : 'No documents yet'}
          description={
            tag
              ? 'Try clearing the filter, or add this tag to a document.'
              : 'Create a document or upload a PDF. It is chunked and embedded automatically so you can ask questions about it.'
          }
          action={
            <Link
              href="/documents/new"
              className="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-white transition hover:opacity-90"
            >
              New document
            </Link>
          }
        />
      ) : (
        <ul className="flex flex-col gap-2">
          {docs.map((doc) => (
            <li key={doc.id}>
              <Link
                href={`/documents/${doc.id}`}
                className="flex flex-wrap items-center gap-3 rounded-md border p-3 transition hover:bg-[var(--color-surface-muted)]"
              >
                <span className="text-sm font-medium">{doc.title}</span>
                <StatusBadge status={doc.status} />
                {doc.status === 'ready' && (
                  <span className="text-xs text-[var(--color-ink-muted)]">
                    {doc.chunkCount} chunk{doc.chunkCount === 1 ? '' : 's'}
                  </span>
                )}
                {doc.status === 'failed' && doc.errorMessage && (
                  <span className="text-xs text-[var(--color-danger)]">{doc.errorMessage}</span>
                )}
                <span className="ml-auto flex gap-1">
                  {doc.tags.map((t) => (
                    <span key={t} className="rounded-full border px-2 py-0.5 text-xs">
                      {t}
                    </span>
                  ))}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
