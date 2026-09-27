'use client';

import type { Document } from '@kb/contracts';
import { AnimatePresence, m } from 'motion/react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { use, useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, api } from '@/lib/api';
import { timeAgo } from '@/lib/format';
import { ArrowLeftIcon, CheckIcon, TrashIcon } from '@/components/icons';
import { EASE_OUT } from '@/components/motion';
import { Button, Dialog, ErrorBanner, Spinner, StatusBadge } from '@/components/ui';
import {
  DocumentForm,
  parseTags,
  useSaveShortcut,
  type DocumentFields,
} from '@/components/document-form';

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
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
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
    // eslint-disable-next-line react-hooks/set-state-in-effect -- load() sets state only after its await
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

  useSaveShortcut(() => void save(), dirty && !saving);

  async function remove() {
    setDeleting(true);
    try {
      await api.deleteDocument(id);
      router.push('/documents');
    } catch (e) {
      setConfirmDelete(false);
      setDeleting(false);
      setError(e instanceof ApiError ? e.problem.title : 'Could not delete');
    }
  }

  if (!doc && !error) return <Spinner label="Loading document..." />;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <Link
          href="/documents"
          className="flex items-center gap-1 text-sm text-[var(--color-ink-muted)] transition-colors hover:text-[var(--color-ink)]"
        >
          <ArrowLeftIcon />
          Back
        </Link>
        {doc && <StatusBadge status={doc.status} />}
        {doc?.status === 'ready' && (
          <span className="text-xs text-[var(--color-ink-muted)]">
            {doc.chunkCount} chunk{doc.chunkCount === 1 ? '' : 's'} indexed
          </span>
        )}
        {doc && (
          <span className="hidden text-xs text-[var(--color-ink-muted)] sm:inline">
            · updated {timeAgo(doc.updatedAt)}
          </span>
        )}
        <div className="ml-auto flex gap-2">
          <Button
            variant="danger"
            onClick={() => setConfirmDelete(true)}
            aria-label="Delete"
            title="Delete document"
          >
            <TrashIcon />
            <span className="hidden sm:inline">Delete</span>
          </Button>
          <Button onClick={save} disabled={!dirty || saving} title="Save (⌘S)">
            <AnimatePresence mode="popLayout" initial={false}>
              <m.span
                key={saving ? 'saving' : dirty ? 'save' : savedAt ? 'saved' : 'save'}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -6 }}
                transition={{ duration: 0.15, ease: EASE_OUT }}
                className="flex items-center gap-1.5"
              >
                {!saving && !dirty && savedAt && <CheckIcon />}
                {saving ? 'Saving...' : dirty ? 'Save' : savedAt ? 'Saved' : 'Save'}
              </m.span>
            </AnimatePresence>
          </Button>
        </div>
      </div>

      {error && <ErrorBanner message={error} />}

      {doc?.status === 'failed' && doc.errorMessage && (
        <ErrorBanner message={`Ingestion failed: ${doc.errorMessage}`} onRetry={save} />
      )}

      <AnimatePresence initial={false}>
        {dirty && doc?.status === 'ready' && (
          <m.p
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            className="rounded-xl border border-dashed px-3 py-2 text-xs text-[var(--color-ink-muted)]"
          >
            Unsaved changes. Saving re-indexes only the parts of the document that actually changed.
          </m.p>
        )}
      </AnimatePresence>

      {fields && <DocumentForm fields={fields} onChange={setFields} fieldErrors={fieldErrors} />}

      <Dialog
        open={confirmDelete}
        onClose={() => !deleting && setConfirmDelete(false)}
        title="Delete this document?"
      >
        <div className="px-4 py-4 text-sm text-[var(--color-ink-muted)]">
          <span className="font-medium text-[var(--color-ink)]">{doc?.title}</span> and its indexed
          chunks will be removed. Past answers keep their quoted citations.
        </div>
        <div className="flex justify-end gap-2 border-t px-4 py-3">
          <Button variant="secondary" onClick={() => setConfirmDelete(false)} disabled={deleting}>
            Cancel
          </Button>
          <Button
            onClick={remove}
            disabled={deleting}
            className="!bg-[var(--color-danger)] !text-white"
          >
            {deleting ? 'Deleting...' : 'Delete document'}
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
