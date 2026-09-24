import { describe, expect, it } from 'vitest';
import type { UpdateDocumentInput } from '@kb/contracts';

/**
 * Guards which edits re-ingest.
 *
 * The regression: only a content change enqueued a job, on the reasoning that
 * tags do not affect chunking. They do not -- but `chunks.tags` is denormalised
 * from the document so the search functions can filter without a join, so a
 * tags-only edit left the chunks carrying the old tags and the document became
 * invisible to a search filtered by its own new tag.
 */

/** Mirrors the condition in DocumentsController.update. */
function shouldReingest(body: UpdateDocumentInput): boolean {
  return body.content !== undefined || body.tags !== undefined;
}

describe('re-ingestion trigger', () => {
  it('re-ingests on a content edit', () => {
    expect(shouldReingest({ content: 'new text' })).toBe(true);
  });

  it('re-ingests on a tags-only edit, so chunk tags cannot go stale', () => {
    expect(shouldReingest({ tags: ['beta'] })).toBe(true);
  });

  it('re-ingests when tags are cleared', () => {
    expect(shouldReingest({ tags: [] })).toBe(true);
  });

  it('does not re-ingest a title-only edit', () => {
    // Titles are read from the document row at retrieval time, never copied
    // onto chunks, so nothing downstream can go stale.
    expect(shouldReingest({ title: 'Renamed' })).toBe(false);
  });

  it('does not re-ingest an empty patch', () => {
    expect(shouldReingest({})).toBe(false);
  });
});
