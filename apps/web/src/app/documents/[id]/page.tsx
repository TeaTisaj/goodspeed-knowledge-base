'use client';

import type { Document } from '@kb/contracts';
import { useRouter } from 'next/navigation';
import { use, useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, api } from '@/lib/api';
import { Button, ErrorBanner, Spinner, StatusBadge } from '@/components/ui';

export default function DocumentPage({ params }: { params: Promise<{ id: string }> }) {
  // Next 16: params is a Promise.
  const { id } = use(params);
  const router = useRouter();

  const [doc, setDoc] = useState<Document | null>(null);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [tagsText, setTagsText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await api.getDocument(id);
      setDoc(d);
      // Only seed the editor on first load, so polling cannot clobber edits in
      // progress.
      setTitle((prev) => (prev === '' ? d.title : prev));
      setContent((prev) => (prev === '' ? d.content : prev));
      setTagsText((prev) => (prev === '' ? d.tags.join(', ') : prev));
      setError(null);
      return d;
    } catch (e) {
      setError(e instanceof ApiError ? e.problem.title : 'Could not load this document');
      return null;
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!doc) return;
    if (doc.status !== 'queued' && doc.status !== 'processing') return;
    pollRef.current = setTimeout(() => void load(), 1200);
    return () => {
      if (pollRef.current) clearTimeout(pollRef.current);
    };
  }, [doc, load]);

  const dirty =
    doc !== null &&
    (title !== doc.title || content !== doc.content || tagsText !== doc.tags.join(', '));

  async function save() {
    setSaving(true);
    setError(null);
    setFieldErrors({});
    try {
      const updated = await api.updateDocument(id, {
        title,
        content,
        tags: tagsText
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean),
      });
      setDoc(updated);
      setSavedAt(Date.now());
    } catch (e) {
      if (e instanceof ApiError) {
        setError(e.problem.title);
        setFieldErrors(e.fieldErrors);
      } else {
        setError('Could not save');
      }
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!confirm('Delete this document? Its chunks are removed too.')) return;
    try {
      await api.deleteDocument(id);
      router.push('/documents');
    } catch (e) {
      setError(e instanceof ApiError ? e.problem.title : 'Could not delete');
    }
  }

  if (!doc && !error) return <Spinner label="Loading document..." />;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <button onClick={() => router.push('/documents')} className="text-sm underline">
          Back
        </button>
        {doc && <StatusBadge status={doc.status} />}
        {doc?.status === 'ready' && (
          <span className="text-xs text-[var(--color-ink-muted)]">
            {doc.chunkCount} chunk{doc.chunkCount === 1 ? '' : 's'} indexed
          </span>
        )}
        <div className="ml-auto flex gap-2">
          <Button onClick={save} disabled={!dirty || saving}>
            {saving ? 'Saving...' : dirty ? 'Save' : savedAt ? 'Saved' : 'Save'}
          </Button>
          <Button variant="danger" onClick={remove}>
            Delete
          </Button>
        </div>
      </div>

      {error && <ErrorBanner message={error} />}

      {doc?.status === 'failed' && doc.errorMessage && (
        <ErrorBanner message={`Ingestion failed: ${doc.errorMessage}`} onRetry={save} />
      )}

      {dirty && doc?.status === 'ready' && (
        <p className="rounded-md border border-dashed px-3 py-2 text-xs text-[var(--color-ink-muted)]">
          Unsaved changes. Saving re-indexes only the parts of the document that actually changed.
        </p>
      )}

      <label className="flex flex-col gap-1 text-sm">
        Title
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="rounded-md border bg-transparent px-3 py-2 text-sm"
        />
        {fieldErrors.title?.map((m) => (
          <span key={m} className="text-xs text-[var(--color-danger)]">
            {m}
          </span>
        ))}
      </label>

      <label className="flex flex-col gap-1 text-sm">
        Tags <span className="text-xs text-[var(--color-ink-muted)]">comma separated</span>
        <input
          value={tagsText}
          onChange={(e) => setTagsText(e.target.value)}
          placeholder="ops, finance"
          className="rounded-md border bg-transparent px-3 py-2 text-sm"
        />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        Content <span className="text-xs text-[var(--color-ink-muted)]">markdown or plain text</span>
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          rows={20}
          className="rounded-md border bg-transparent px-3 py-2 font-mono text-sm leading-relaxed"
        />
        {fieldErrors.content?.map((m) => (
          <span key={m} className="text-xs text-[var(--color-danger)]">
            {m}
          </span>
        ))}
      </label>
    </div>
  );
}
