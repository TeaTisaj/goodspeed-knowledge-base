'use client';

import { useEffect } from 'react';
import { ArrowUpIcon, StopIcon } from '@/components/icons';
import { Button } from '@/components/ui';

export function Composer({
  inputRef,
  value,
  onChange,
  onSubmit,
  onStop,
  busy,
}: {
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
  value: string;
  onChange: (v: string) => void;
  onSubmit: (e?: React.FormEvent) => void;
  onStop: () => void;
  busy: boolean;
}) {
  // Grows with the text up to a cap, then scrolls.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [value, inputRef]);

  return (
    <form
      onSubmit={onSubmit}
      className="flex items-end gap-2 rounded-2xl border bg-[var(--color-surface)] p-2 shadow-lg shadow-black/[0.04] transition-[border-color,box-shadow] focus-within:border-[var(--color-accent)] focus-within:shadow-[0_0_0_3px_color-mix(in_oklab,var(--color-accent)_15%,transparent)]"
    >
      <textarea
        ref={inputRef}
        value={value}
        rows={1}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          // Enter sends, Shift+Enter is a newline; never while an IME is composing.
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            onSubmit();
          }
        }}
        placeholder="Ask a question about your documents..."
        aria-label="Question"
        className="max-h-[200px] min-h-9 flex-1 resize-none bg-transparent px-2 py-1.5 text-sm leading-6 outline-none placeholder:text-[var(--color-ink-muted)] focus-visible:outline-none"
      />
      {busy ? (
        <Button variant="secondary" onClick={onStop} className="h-9 rounded-xl">
          <StopIcon />
          Stop
        </Button>
      ) : (
        <Button type="submit" disabled={!value.trim()} className="h-9 rounded-xl">
          <ArrowUpIcon />
          Ask
        </Button>
      )}
    </form>
  );
}
