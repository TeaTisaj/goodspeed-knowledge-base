'use client';

import type { Document } from '@kb/contracts';
import { useRef, useState } from 'react';
import { ApiError, api } from '@/lib/api';
import { Button } from './ui';

const ACCEPT = '.pdf,.txt,.md,application/pdf,text/plain,text/markdown';

/**
 * File upload.
 *
 * Errors are shown inline rather than swallowed, because the interesting
 * failures here are ones the user can act on: a scanned PDF needs OCR, an
 * encrypted one needs a password removed, and a 20MB file needs splitting.
 */
export function UploadButton({
  onUploaded,
  onError,
}: {
  onUploaded: (doc: Document) => void;
  onError: (message: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  async function handle(file: File) {
    setBusy(true);
    try {
      const doc = await api.uploadDocument(file);
      onUploaded(doc);
    } catch (e) {
      onError(e instanceof ApiError ? e.problem.title : 'Could not upload that file');
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  }

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void handle(file);
        }}
      />
      <Button variant="secondary" disabled={busy} onClick={() => inputRef.current?.click()}>
        {busy ? 'Reading file...' : 'Upload file'}
      </Button>
    </>
  );
}
