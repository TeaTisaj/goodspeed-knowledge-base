import { Injectable, Logger, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { PgBoss } from 'pg-boss';
import { ConfigService } from '../config/config.service.js';

export const INGEST_QUEUE = 'document-ingest';

export interface IngestJobData {
  documentId: string;
  ownerId: string;
}

/**
 * Postgres-backed job queue.
 *
 * pg-boss rather than BullMQ+Redis: the queue lives in the database we already
 * run, so there is no extra container in the setup and enqueueing is
 * transactional with the document write. Redis buys throughput this workload
 * cannot justify — SCALING.md names the threshold where that changes.
 *
 * Note the connection requirement: pg-boss uses LISTEN/NOTIFY, which is
 * session-scoped. It must connect on a direct or session-mode DSN. Behind a
 * transaction-mode pooler (Supabase port 6543) jobs are enqueued successfully
 * and then silently never picked up.
 */
@Injectable()
export class QueueService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(QueueService.name);
  private boss?: PgBoss;

  constructor(private readonly config: ConfigService) {}

  async onModuleInit(): Promise<void> {
    if (this.config.env.WORKER_MODE === 'off') {
      this.logger.log('WORKER_MODE=off; queue disabled');
      return;
    }

    this.boss = new PgBoss({
      connectionString: this.config.env.DATABASE_URL,
      schema: 'pgboss',
    });

    this.boss.on('error', (e: Error) => this.logger.error(`pg-boss: ${e.message}`));
    await this.boss.start();
    // Ingestion is idempotent, so retrying a failed job is always safe.
    await this.boss.createQueue(INGEST_QUEUE, {
      retryLimit: 3,
      retryBackoff: true,
      expireInSeconds: 600,
    });
    this.logger.log('Queue ready');
  }

  async onApplicationShutdown(): Promise<void> {
    await this.boss?.stop({ graceful: true });
  }

  get instance(): PgBoss | undefined {
    return this.boss;
  }

  /**
   * Enqueues an ingestion job.
   *
   * Deliberately no `singletonKey`. It was used here first, to debounce rapid
   * successive saves, and it silently broke re-ingestion: pg-boss enforces
   * uniqueness on the key across *all* job states including `completed`, so
   * after a document's first job finished, every later send returned null and
   * the document could never be re-ingested.
   *
   * Duplicate jobs are cheap instead: `ingest()` compares the document's
   * content hash first and returns immediately when nothing changed. Idempotent
   * work beats a debounce that can lose an update.
   */
  async enqueueIngest(data: IngestJobData): Promise<string | null> {
    if (!this.boss) {
      this.logger.warn('Queue disabled; ingestion not scheduled');
      return null;
    }

    const jobId = await this.boss.send(INGEST_QUEUE, data);
    if (!jobId) {
      // send() returning null means the job was not created. Silently ignoring
      // it is how a document sits in `queued` forever with no visible error.
      this.logger.error(
        `Failed to enqueue ingestion for document ${data.documentId}: send() returned null`,
      );
    }
    return jobId;
  }
}
