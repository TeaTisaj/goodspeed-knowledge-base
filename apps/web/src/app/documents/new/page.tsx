'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ApiError, api } from '@/lib/api';
import { Button, ErrorBanner } from '@/components/ui';
import { DocumentForm, parseTags, type DocumentFields } from '@/components/document-form';

/** Nothing is stored until the first save, so an abandoned draft leaves no empty document. */
export default function NewDocumentPage() {
  const router = useRouter();
  const [fields, setFields] = useState<DocumentFields>({ title: '', tagsText: '', content: '' });
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [saving, setSaving] = useState(false);

  const canSave = fields.title.trim() !== '' && fields.content.trim() !== '' && !saving;

  async function save() {
    setSaving(true);
    setError(null);
    setFieldErrors({});
    try {
      const doc = await api.createDocument({
        title: fields.title,
        content: fields.content,
        tags: parseTags(fields.tagsText),
      });
      router.replace(`/documents/${doc.id}`);
    } catch (e) {
      if (e instanceof ApiError) {
        setError(e.problem.title);
        setFieldErrors(e.fieldErrors);
      } else {
        setError('Could not create the document');
      }
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <button onClick={() => router.push('/documents')} className="text-sm underline">
          Back
        </button>
        <h1 className="text-base font-semibold">New document</h1>
        <div className="ml-auto">
          <Button onClick={save} disabled={!canSave}>
            {saving ? 'Saving...' : 'Save'}
          </Button>
        </div>
      </div>

      {error && <ErrorBanner message={error} />}

      <DocumentForm fields={fields} onChange={setFields} fieldErrors={fieldErrors} />
    </div>
  );
}
