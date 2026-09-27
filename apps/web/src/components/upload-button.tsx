'use client';

import type { Document } from '@kb/contracts';
import { useRef, useState } from 'react';
import { ApiError, api } from '@/lib/api';
import { UploadIcon } from './icons';
import { Button } from './ui';

export const ACCEPT = '.pdf,.txt,.md,application/pdf,text/plain,text/markdown';

/**
 * File upload, shared by the button and the documents page's drop zone.
 *
 * Errors are shown inline rather than swallowed, because the interesting
 * failures here are ones the user can act on: a scanned PDF needs OCR, an
 * encrypted one needs a password removed, and a 20MB file needs splitting.
 */
export function useUpload(onUploaded: (doc: Document) => void, onError: (message: string) => void) {
  const [busy, setBusy] = useState(false);

  async function upload(file: File) {
    setBusy(true);
    try {
      onUploaded(await api.uploadDocument(file));
    } catch (e) {
      onError(e instanceof ApiError ? e.problem.title : 'Could not upload that file');
    } finally {
      setBusy(false);
    }
  }

  return { busy, upload };
}

export function UploadButton({
  onUploaded,
  onError,
}: {
  onUploaded: (doc: Document) => void;
  onError: (message: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const { busy, upload } = useUpload(onUploaded, onError);

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        className="hidden"
        onChange={async (e) => {
          const file = e.target.files?.[0];
          if (!file) return;
          await upload(file);
          if (inputRef.current) inputRef.current.value = '';
        }}
      />
      <Button variant="secondary" disabled={busy} onClick={() => inputRef.current?.click()}>
        <UploadIcon />
        {busy ? 'Reading file...' : 'Upload file'}
      </Button>
    </>
  );
}
