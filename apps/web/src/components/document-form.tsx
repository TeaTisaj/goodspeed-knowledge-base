'use client';

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

  return (
    <>
      <label className="flex flex-col gap-1 text-sm">
        Title
        <input
          value={fields.title}
          onChange={(e) => set({ title: e.target.value })}
          placeholder="Deployment runbook"
          className="rounded-md border bg-transparent px-3 py-2 text-sm"
        />
        <FieldErrors messages={fieldErrors.title} />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        Tags <span className="text-xs text-[var(--color-ink-muted)]">comma separated</span>
        <input
          value={fields.tagsText}
          onChange={(e) => set({ tagsText: e.target.value })}
          placeholder="ops, finance"
          className="rounded-md border bg-transparent px-3 py-2 text-sm"
        />
        <FieldErrors messages={fieldErrors.tags} />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        Content{' '}
        <span className="text-xs text-[var(--color-ink-muted)]">markdown or plain text</span>
        <textarea
          value={fields.content}
          onChange={(e) => set({ content: e.target.value })}
          rows={20}
          className="rounded-md border bg-transparent px-3 py-2 font-mono text-sm leading-relaxed"
        />
        <FieldErrors messages={fieldErrors.content} />
      </label>
    </>
  );
}

function FieldErrors({ messages }: { messages?: string[] }) {
  return messages?.map((m) => (
    <span key={m} className="text-xs text-[var(--color-danger)]">
      {m}
    </span>
  ));
}
