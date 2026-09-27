'use client';

import { useEffect, useEffectEvent } from 'react';

export interface DocumentFields {
  title: string;
  tagsText: string;
  content: string;
}

export function parseTags(tagsText: string): string[] {
  return tagsText
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
}

/** Title, tags and content, shared by the new-document and edit pages. */
export function DocumentForm({
  fields,
  onChange,
  fieldErrors,
}: {
  fields: DocumentFields;
  onChange: (fields: DocumentFields) => void;
  fieldErrors: Record<string, string[]>;
}) {
  const set = (patch: Partial<DocumentFields>) => onChange({ ...fields, ...patch });
  const words = fields.content.trim() ? fields.content.trim().split(/\s+/).length : 0;
  const tags = parseTags(fields.tagsText);

  return (
    <div className="flex flex-col gap-4 rounded-2xl border bg-[var(--color-surface)] p-4 sm:p-5">
      <label className="flex flex-col gap-1.5 text-sm font-medium">
        Title
        <input
          value={fields.title}
          onChange={(e) => set({ title: e.target.value })}
          placeholder="Deployment runbook"
          className="field text-base font-semibold"
        />
        <FieldErrors messages={fieldErrors.title} />
      </label>

      <label className="flex flex-col gap-1.5 text-sm font-medium">
        <span>
          Tags{' '}
          <span className="text-xs font-normal text-[var(--color-ink-muted)]">comma separated</span>
        </span>
        <input
          value={fields.tagsText}
          onChange={(e) => set({ tagsText: e.target.value })}
          placeholder="ops, finance"
          className="field font-normal"
        />
        {tags.length > 0 && (
          <span className="flex flex-wrap gap-1" aria-hidden="true">
            {tags.map((t, i) => (
              <span
                key={`${t}-${i}`}
                className="rounded-full bg-[var(--color-accent-soft)] px-2 py-0.5 text-xs font-normal text-[var(--color-accent)]"
              >
                {t}
              </span>
            ))}
          </span>
        )}
        <FieldErrors messages={fieldErrors.tags} />
      </label>

      <label className="flex flex-col gap-1.5 text-sm font-medium">
        <span className="flex items-baseline">
          <span>
            Content{' '}
            <span className="text-xs font-normal text-[var(--color-ink-muted)]">
              markdown or plain text
            </span>
          </span>
          <span className="ml-auto text-xs font-normal text-[var(--color-ink-muted)] tabular-nums">
            {words.toLocaleString()} word{words === 1 ? '' : 's'}
          </span>
        </span>
        <textarea
          value={fields.content}
          onChange={(e) => set({ content: e.target.value })}
          rows={20}
          className="field resize-y font-mono leading-relaxed font-normal"
        />
        <FieldErrors messages={fieldErrors.content} />
      </label>
    </div>
  );
}

function FieldErrors({ messages }: { messages?: string[] }) {
  return messages?.map((m) => (
    <span key={m} className="text-xs font-normal text-[var(--color-danger)]">
      {m}
    </span>
  ));
}

/** Cmd/Ctrl+S saves instead of opening the browser's "save page" dialog. */
export function useSaveShortcut(save: () => void, enabled: boolean) {
  const onSave = useEffectEvent(save);
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key.toLowerCase() !== 's' || !(e.metaKey || e.ctrlKey)) return;
      e.preventDefault();
      if (enabled) onSave();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [enabled]);
}
