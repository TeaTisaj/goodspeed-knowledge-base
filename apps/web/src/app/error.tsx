'use client';

import { Button, EmptyState } from '@/components/ui';

/** Catches a render error anywhere below the root, so a bug shows a way out instead of a blank page. */
export default function ErrorPage({ reset }: { error: Error; reset: () => void }) {
  return (
    <div className="mx-auto max-w-5xl px-4 py-16">
      <EmptyState
        title="Something went wrong"
        description="This page hit an unexpected error. Your documents are safe."
        action={<Button onClick={reset}>Try again</Button>}
      />
    </div>
  );
}
