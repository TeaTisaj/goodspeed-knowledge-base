'use client';

import type { Document } from '@kb/contracts';
import { useRouter } from 'next/navigation';
import { use, useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, api } from '@/lib/api';
import { Button, ErrorBanner, Spinner, StatusBadge } from '@/components/ui';
import { DocumentForm, parseTags, type DocumentFields } from '@/components/document-form';

export default function DocumentPage({ params }: { params: Promise<{ id: string }> }) {
  // Next 16: params is a Promise.
  const { id } = use(params);
  const router = useRouter();

  const [doc, setDoc] = useState<Document | null>(null);
  const [fields, setFields] = useState<DocumentFields | null>(null);
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
      setFields(
        (prev) => prev ?? { title: d.title, content: d.content, tagsText: d.tags.join(', ') },
      );
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
    fields !== null &&
    (fields.title !== doc.title ||
      fields.content !== doc.content ||
      fields.tagsText !== doc.tags.join(', '));

  async function save() {
    if (!fields) return;
    setSaving(true);
    setError(null);
    setFieldErrors({});
    try {
      const updated = await api.updateDocument(id, {
        title: fields.title,
        content: fields.content,
        tags: parseTags(fields.tagsText),
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

      {fields && <DocumentForm fields={fields} onChange={setFields} fieldErrors={fieldErrors} />}
    </div>
  );
}
