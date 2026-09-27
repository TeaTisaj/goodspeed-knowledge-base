import { describe, expect, it } from 'vitest';
import type { AiService } from '../ai/ai.service.js';
import type { ConfigService } from '../config/config.service.js';
import type { SupabaseService } from '../supabase/supabase.service.js';
import type { UsageService } from '../usage/usage.service.js';
import type { IngestionService } from './ingestion.service.js';
import { IngestionWorker } from './ingestion.worker.js';
import type { IngestJobData, QueueService } from './queue.service.js';

/**
 * The startup sweep. A model switch requeues every document at once, so the
 * sweep must reach all of them, not the first page.
 */

interface Doc {
  id: string;
  owner_id: string;
  status: string;
}

/** Answers the sweep's `documents` query the way PostgREST would. */
function fakeSupabase(docs: Doc[], calls: string[]): SupabaseService {
  const from = () => {
    let after: string | undefined;
    let limit = Infinity;
    const builder = {
      select: () => builder,
      eq: () => builder,
      order: () => builder,
      limit: (n: number) => ((limit = n), builder),
      gt: (_: string, id: string) => ((after = id), builder),
      then: (resolve: (v: unknown) => unknown) => {
        const data = docs
          .filter((d) => d.status === 'queued' && (after === undefined || d.id > after))
          .sort((a, b) => a.id.localeCompare(b.id))
          .slice(0, limit)
          .map(({ id, owner_id }) => ({ id, owner_id }));
        return Promise.resolve({ data, error: null }).then(resolve);
      },
    };
    return builder;
  };
  const rpc = (name: string) => {
    calls.push(name);
    return Promise.resolve({ data: 0, error: null });
  };
  return { admin: () => ({ from, rpc }) } as unknown as SupabaseService;
}

function workerFor(docs: Doc[], calls: string[] = []) {
  const enqueued: string[] = [];
  const queue = {
    instance: { work: () => Promise.resolve() },
    enqueueIngest: (job: IngestJobData) => {
      calls.push('enqueue');
      enqueued.push(job.documentId);
      // A fast worker takes the document out of `queued` mid-sweep.
      docs.find((d) => d.id === job.documentId)!.status = 'processing';
      return Promise.resolve();
    },
  } as unknown as QueueService;
  const config = { env: { WORKER_MODE: 'inline' } } as unknown as ConfigService;
  const ai = { embeddings: { model: 'test-model' } } as unknown as AiService;

  const worker = new IngestionWorker(
    queue,
    {} as IngestionService,
    fakeSupabase(docs, calls),
    config,
    ai,
    {} as UsageService,
  );
  return { worker, enqueued };
}

const queuedDocs = (n: number): Doc[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `doc-${String(i).padStart(5, '0')}`,
    owner_id: 'user-1',
    status: 'queued',
  }));

describe('startup reconcile', () => {
  it('enqueues every queued document, past the first page', async () => {
    const docs = queuedDocs(1234);
    const { worker, enqueued } = workerFor(docs);

    await worker.onModuleInit();

    expect(enqueued).toHaveLength(1234);
    expect(new Set(enqueued).size).toBe(1234);
  });

  it('stops on an exactly full last page', async () => {
    const { worker, enqueued } = workerFor(queuedDocs(1000));

    await worker.onModuleInit();

    expect(enqueued).toHaveLength(1000);
  });

  it('requeues stale embeddings before sweeping, so the sweep picks them up', async () => {
    const calls: string[] = [];
    const { worker } = workerFor(queuedDocs(1), calls);

    await worker.onModuleInit();

    expect(calls).toEqual(['requeue_stale_embeddings', 'enqueue']);
  });
});
