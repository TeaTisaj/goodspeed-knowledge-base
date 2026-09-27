import Link from 'next/link';
import { buttonClass } from '@/components/button-class';
import { EmptyState } from '@/components/ui';

export default function NotFound() {
  return (
    <div className="mx-auto max-w-5xl px-4 py-16">
      <EmptyState
        title="Page not found"
        description="This page doesn't exist, or the document was deleted."
        action={
          <Link href="/documents" className={buttonClass('secondary')}>
            Back to documents
          </Link>
        }
      />
    </div>
  );
}
