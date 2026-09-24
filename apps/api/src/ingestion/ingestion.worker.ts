import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { Job } from 'pg-boss';
import { AiService } from '../ai/ai.service.js';
import { ConfigService } from '../config/config.service.js';
import { SupabaseService } from '../supabase/supabase.service.js';
import { UsageService } from '../usage/usage.service.js';
import { IngestionService } from './ingestion.service.js';
import { INGEST_QUEUE, QueueService, type IngestJobData } from './queue.service.js';

/**
 * Subscribes to the ingest queue.
 *
 * Runs in-process by default so local setup is one command, and as its own
 * process when WORKER_MODE=standalone. Same code either way — the scaling story
 * is a deployment topology change, not a rewrite.
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

  async onModuleInit(): Promise<void> {
    const boss = this.queue.instance;
    if (!boss || this.config.env.WORKER_MODE === 'off') return;

    await boss.work<IngestJobData>(
      INGEST_QUEUE,
      { batchSize: 1, pollingIntervalSeconds: 1 },
      async (jobs: Job<IngestJobData>[]) => {
        for (const job of jobs) await this.handle(job);
      },
    );
    this.logger.log(`Worker listening (mode=${this.config.env.WORKER_MODE})`);

    await this.reconcile();
  }

  /**
   * Enqueues any document still sitting in `queued` on startup.
   *
   * A document reaches `queued` from three places: the API (which enqueues a
   * job), the seed script (which does not), and a crash between the database
   * write and the enqueue. Without this, seeded documents are never ingested
   * and a reviewer sees an empty knowledge base with no error anywhere --
   * which is exactly what happened before this existed.
   *
   * Safe to run on every boot because ingestion is idempotent: a document whose
   * content hash is unchanged short-circuits before any work.
   */
  private async reconcile(): Promise<void> {
    try {
      const { data, error } = await this.supabase
        .admin()
        .from('documents')
        .select('id, owner_id')
        .eq('status', 'queued')
        .limit(500);

      if (error) {
        this.logger.warn(`Reconcile skipped: ${error.message}`);
        return;
      }

      const pending = (data ?? []) as { id: string; owner_id: string }[];
      if (pending.length === 0) return;

      for (const doc of pending) {
        await this.queue.enqueueIngest({ documentId: doc.id, ownerId: doc.owner_id });
      }
      this.logger.log(`Reconciled ${pending.length} document(s) stuck in queued`);
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
      void this.usage.record(ownerId, this.ai.drainUsage());

      this.logger.log(
        outcome.skipped
          ? `Document ${documentId}: unchanged, skipped`
          : `Document ${documentId}: +${outcome.chunksCreated} new, ` +
              `${outcome.chunksReused} reused, -${outcome.chunksDeleted} removed`,
      );
    } catch (error) {
      const message = (error as Error).message;
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
