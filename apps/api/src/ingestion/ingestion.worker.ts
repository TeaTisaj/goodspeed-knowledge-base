import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { Job } from 'pg-boss';
import { AiService } from '../ai/ai.service.js';
import { ConfigService } from '../config/config.service.js';
import { SupabaseService } from '../supabase/supabase.service.js';
import { UsageService } from '../usage/usage.service.js';
import { IngestionService } from './ingestion.service.js';
import { INGEST_QUEUE, QueueService, type IngestJobData } from './queue.service.js';
import { isWorkerProcess } from './worker-process.js';

const RECONCILE_PAGE_SIZE = 500;

/**
 * Subscribes to the ingest queue: in-process by default, or its own process
 * with WORKER_MODE=standalone. Same code either way.
 */
@Injectable()
export class IngestionWorker implements OnModuleInit {
  private readonly logger = new Logger(IngestionWorker.name);

  constructor(
    private readonly queue: QueueService,
    private readonly ingestion: IngestionService,
    private readonly supabase: SupabaseService,
    private readonly config: ConfigService,
    private readonly ai: AiService,
    private readonly usage: UsageService,
  ) {}

  /** inline: this process consumes. standalone: only the worker process does. off: nothing does. */
  private get shouldConsume(): boolean {
    const mode = this.config.env.WORKER_MODE;
    if (mode === 'off') return false;
    if (mode === 'inline') return true;
    return isWorkerProcess();
  }

  async onModuleInit(): Promise<void> {
    const boss = this.queue.instance;
    if (!boss) return;

    if (!this.shouldConsume) {
      this.logger.log(
        `WORKER_MODE=${this.config.env.WORKER_MODE}: this process enqueues but does not consume. ` +
          'Run `node dist/main.worker.js` to process jobs.',
      );
      return;
    }

    await boss.work<IngestJobData>(
      INGEST_QUEUE,
      { batchSize: 1, pollingIntervalSeconds: 1 },
      async (jobs: Job<IngestJobData>[]) => {
        for (const job of jobs) await this.handle(job);
      },
    );
    this.logger.log(`Worker listening (mode=${this.config.env.WORKER_MODE})`);

    await this.requeueStaleEmbeddings();
    await this.reconcile();
  }

  /**
   * Requeues documents embedded by a different model, so changing the embedding
   * provider is a restart. A model of a different width is caught earlier: the
   * API refuses to boot and points at `pnpm reembed`.
   */
  private async requeueStaleEmbeddings(): Promise<void> {
    const model = this.ai.embeddings.model;
    try {
      const { data, error } = await this.supabase
        .admin()
        .rpc('requeue_stale_embeddings', { p_model: model });

      if (error) {
        this.logger.warn(`Stale embedding check skipped: ${error.message}`);
        return;
      }

      const count = data as number;
      if (count > 0) {
        this.logger.warn(
          `Embedding model is now "${model}": re-embedding ${count} document(s) ` +
            'made with a different model. They are not searchable until it finishes.',
        );
      }
    } catch (e) {
      this.logger.warn(`Stale embedding check failed: ${(e as Error).message}`);
    }
  }

  /**
   * Enqueues anything left in `queued` at startup (seeded documents, or a crash
   * between write and enqueue). Safe on every boot: unchanged content is skipped.
   *
   * Paged by id, not offset: documents leave `queued` while this runs, and an
   * offset would skip past the ones that shifted into earlier pages.
   */
  private async reconcile(): Promise<void> {
    try {
      let enqueued = 0;
      let after: string | undefined;

      for (;;) {
        let query = this.supabase
          .admin()
          .from('documents')
          .select('id, owner_id')
          .eq('status', 'queued')
          .order('id')
          .limit(RECONCILE_PAGE_SIZE);
        if (after) query = query.gt('id', after);

        const { data, error } = await query;
        if (error) {
          this.logger.warn(`Reconcile stopped after ${enqueued} document(s): ${error.message}`);
          return;
        }

        const page = (data ?? []) as { id: string; owner_id: string }[];
        for (const doc of page) {
          await this.queue.enqueueIngest({ documentId: doc.id, ownerId: doc.owner_id });
        }
        enqueued += page.length;

        if (page.length < RECONCILE_PAGE_SIZE) break;
        after = page[page.length - 1]!.id;
      }

      if (enqueued > 0) this.logger.log(`Reconciled ${enqueued} document(s) stuck in queued`);
    } catch (e) {
      // Reconciliation is best-effort; never block startup on it.
      this.logger.warn(`Reconcile failed: ${(e as Error).message}`);
    }
  }

  private async handle(job: Job<IngestJobData>): Promise<void> {
    const { documentId, ownerId } = job.data;
    const db = this.supabase.admin();

    const { data: jobRow } = await db
      .from('ingestion_jobs')
      .insert({
        document_id: documentId,
        owner_id: ownerId,
        status: 'processing',
        started_at: new Date().toISOString(),
      })
      .select('id')
      .single();

    const jobId = (jobRow as { id: string } | null)?.id;

    // Each job gets its own usage bucket, so one owner is never billed for
    // another's embeddings.
    const usageEvents = this.ai.beginUsageScope();

    try {
      const outcome = await this.ingestion.ingest(documentId);

      if (jobId) {
        await db
          .from('ingestion_jobs')
          .update({
            status: 'ready',
            chunks_created: outcome.chunksCreated,
            chunks_reused: outcome.chunksReused,
            finished_at: new Date().toISOString(),
          })
          .eq('id', jobId);
      }

      // Embedding cost belongs to the document's owner, not the worker.
      void this.usage.record(ownerId, usageEvents.splice(0));

      this.logger.log(
        outcome.skipped
          ? `Document ${documentId}: unchanged, skipped`
          : `Document ${documentId}: +${outcome.chunksCreated} new, ` +
              `${outcome.chunksReused} reused, -${outcome.chunksDeleted} removed`,
      );
    } catch (error) {
      const message = (error as Error).message;
      // A failed job still embedded whatever it got through before failing.
      void this.usage.record(ownerId, usageEvents.splice(0));
      if (jobId) {
        await db
          .from('ingestion_jobs')
          .update({
            status: 'failed',
            error_message: message,
            finished_at: new Date().toISOString(),
          })
          .eq('id', jobId);
      }
      // Rethrow so pg-boss records the failure and applies its retry policy.
      throw error;
    }
  }
}
