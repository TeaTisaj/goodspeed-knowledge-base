import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { Job } from 'pg-boss';
import { ConfigService } from '../config/config.service.js';
import { SupabaseService } from '../supabase/supabase.service.js';
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
