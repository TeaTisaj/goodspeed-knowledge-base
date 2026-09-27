'use client';

import type { DocumentSummary } from '@kb/contracts';
import { AnimatePresence, m } from 'motion/react';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, api } from '@/lib/api';
import { timeAgo } from '@/lib/format';
import { FileIcon, PlusIcon, SearchIcon, UploadIcon } from '@/components/icons';
import { EASE_OUT, SPRING } from '@/components/motion';
import {
  EmptyState,
  ErrorBanner,
  SkeletonRow,
  StatusBadge,
  SuccessBanner,
  buttonClass,
} from '@/components/ui';
import { UploadButton, useUpload } from '@/components/upload-button';

export default function DocumentsPage() {
  const [docs, setDocs] = useState<DocumentSummary[] | null>(null);
  const [allTags, setAllTags] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [tag, setTag] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api.listDocuments({
        ...(tag ? { tag } : {}),
        ...(search ? { search } : {}),
      });
      setDocs(res.items);
      // Tags come from the unfiltered list, so picking one does not hide the others.
      if (!tag && !search) setAllTags([...new Set(res.items.flatMap((d) => d.tags))].sort());
      setError(null);
      return res.items;
    } catch (e) {
      setError(e instanceof ApiError ? e.problem.title : 'Could not load documents');
      return [];
    }
  }, [tag, search]);

  useEffect(() => {
    void load();
  }, [load]);

  // Title search runs on the server; debounced so typing is not a request per key.
  useEffect(() => {
    const t = setTimeout(() => setSearch(query.trim()), 250);
    return () => clearTimeout(t);
  }, [query]);

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

  /**
   * Stays on the list rather than opening the editor. An uploaded file is not
   * something you came here to edit -- you came to add it to the knowledge base
   * -- so the useful confirmation is seeing the row appear and turn Ready.
   */
  const onUploaded = (doc: { title: string }) => {
    setError(null);
    setNotice(`Uploaded "${doc.title}". Indexing now -- it can be asked about once Ready.`);
    void load();
  };
  const onUploadError = (message: string) => {
    setNotice(null);
    setError(message);
  };
  const drop = useUpload(onUploaded, onUploadError);
  const dragging = useFileDrag((file) => void drop.upload(file));

  const filtered = Boolean(tag || search);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Documents</h1>
          <p className="mt-0.5 text-sm text-[var(--color-ink-muted)]">
            Everything the assistant can answer from.
            <span className="hidden sm:inline"> Drop a file anywhere to add it.</span>
          </p>
        </div>
        <div className="ml-auto flex gap-2">
          <UploadButton onUploaded={onUploaded} onError={onUploadError} />
          <Link href="/documents/new" className={buttonClass('primary')}>
            <PlusIcon />
            New document
          </Link>
        </div>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <label className="relative sm:w-72">
          <span className="sr-only">Search documents by title</span>
          <SearchIcon className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-[var(--color-ink-muted)]" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by title"
            className="field w-full pl-9"
          />
        </label>

        {allTags.length > 0 && (
          <div
            className="flex flex-wrap items-center gap-1"
            role="group"
            aria-label="Filter by tag"
          >
            {[null, ...allTags].map((t) => {
              const active = tag === t;
              return (
                <button
                  key={t ?? '__all'}
                  onClick={() => setTag(t === tag ? null : t)}
                  aria-pressed={active}
                  className={`relative rounded-full px-3 py-1 text-xs transition-colors ${
                    active
                      ? 'font-medium text-[var(--color-accent-ink)]'
                      : 'text-[var(--color-ink-muted)] hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-ink)]'
                  }`}
                >
                  {active && (
                    <m.span
                      layoutId="tag-pill"
                      transition={SPRING}
                      className="absolute inset-0 rounded-full bg-[var(--color-accent)]"
                    />
                  )}
                  <span className="relative">{t ?? 'All'}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {notice && <SuccessBanner message={notice} onDismiss={() => setNotice(null)} />}
      {drop.busy && <SuccessBanner message="Reading the dropped file..." />}
      {error && <ErrorBanner message={error} onRetry={() => void load()} />}

      {docs === null ? (
        <div className="flex flex-col gap-2">
          <SkeletonRow />
          <SkeletonRow />
          <SkeletonRow />
        </div>
      ) : docs.length === 0 ? (
        <EmptyState
          icon={<FileIcon width={20} height={20} />}
          title={
            search
              ? `Nothing titled like "${search}"`
              : tag
                ? `No documents tagged "${tag}"`
                : 'No documents yet'
          }
          description={
            filtered
              ? 'Try clearing the search or tag filter.'
              : 'Create a document or upload a PDF. It is chunked and embedded automatically so you can ask questions about it.'
          }
          action={
            !filtered && (
              <Link href="/documents/new" className={buttonClass('primary')}>
                <PlusIcon />
                New document
              </Link>
            )
          }
        />
      ) : (
        <ul className="flex flex-col gap-2">
          <AnimatePresence initial={true}>
            {docs.map((doc, i) => (
              <m.li
                key={doc.id}
                layout="position"
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.25, ease: EASE_OUT, delay: Math.min(i, 8) * 0.03 }}
              >
                <DocumentRow doc={doc} />
              </m.li>
            ))}
          </AnimatePresence>
        </ul>
      )}

      <AnimatePresence>
        {dragging && (
          <m.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-[color-mix(in_oklab,var(--color-canvas)_75%,transparent)] p-6 backdrop-blur-sm"
          >
            <m.div
              initial={{ scale: 0.96 }}
              animate={{ scale: 1 }}
              exit={{ scale: 0.96 }}
              className="flex w-full max-w-md flex-col items-center rounded-3xl border-2 border-dashed border-[var(--color-accent)] bg-[var(--color-surface)] px-8 py-14 text-center shadow-2xl"
            >
              <div className="flex size-12 items-center justify-center rounded-2xl bg-[var(--color-accent-soft)] text-[var(--color-accent)]">
                <UploadIcon width={22} height={22} />
              </div>
              <p className="mt-4 text-sm font-semibold">Drop to add to your knowledge base</p>
              <p className="mt-1 text-sm text-[var(--color-ink-muted)]">
                PDF, Markdown or plain text
              </p>
            </m.div>
          </m.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function DocumentRow({ doc }: { doc: DocumentSummary }) {
  return (
    <Link
      href={`/documents/${doc.id}`}
      className="group flex items-center gap-3 rounded-xl border bg-[var(--color-surface)] p-3 transition-[border-color,box-shadow] duration-150 hover:border-[var(--color-border-strong)] hover:shadow-sm"
    >
      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border bg-[var(--color-surface-muted)] text-[var(--color-ink-muted)] transition-colors group-hover:text-[var(--color-accent)]">
        {doc.sourceType === 'upload' ? <UploadIcon /> : <FileIcon />}
      </span>

      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-sm font-medium">{doc.title}</span>
        <span className="flex flex-wrap items-center gap-x-2 text-xs text-[var(--color-ink-muted)]">
          <span>Updated {timeAgo(doc.updatedAt)}</span>
          {doc.status === 'ready' && (
            <span>
              · {doc.chunkCount} chunk{doc.chunkCount === 1 ? '' : 's'}
            </span>
          )}
          {doc.status === 'failed' && doc.errorMessage && (
            <span className="text-[var(--color-danger)]">· {doc.errorMessage}</span>
          )}
        </span>
      </span>

      <span className="hidden flex-wrap justify-end gap-1 sm:flex">
        {doc.tags.map((t) => (
          <span
            key={t}
            className="rounded-full border px-2 py-0.5 text-xs text-[var(--color-ink-muted)]"
          >
            {t}
          </span>
        ))}
      </span>
      <StatusBadge status={doc.status} />
    </Link>
  );
}

/**
 * True while files are dragged over the window. Counts enter/leave pairs
 * because every child element fires its own, and a plain boolean flickers.
 */
function useFileDrag(onDrop: (file: File) => void) {
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);
  const dropRef = useRef(onDrop);
  useEffect(() => {
    dropRef.current = onDrop;
  });

  useEffect(() => {
    const hasFiles = (e: DragEvent) => e.dataTransfer?.types.includes('Files') ?? false;
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth.current += 1;
      setDragging(true);
    };
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setDragging(false);
    };
    const over = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault();
    };
    const dropped = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth.current = 0;
      setDragging(false);
      const file = e.dataTransfer?.files[0];
      if (file) dropRef.current(file);
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragleave', leave);
    window.addEventListener('dragover', over);
    window.addEventListener('drop', dropped);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('dragover', over);
      window.removeEventListener('drop', dropped);
    };
  }, []);

  return dragging;
}
