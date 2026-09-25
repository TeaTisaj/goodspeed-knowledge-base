import { Injectable, Logger, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { PgBoss } from 'pg-boss';
import { ConfigService } from '../config/config.service.js';

export const INGEST_QUEUE = 'document-ingest';

export interface IngestJobData {
  documentId: string;
  ownerId: string;
}

/**
 * Postgres-backed job queue (pg-boss): no Redis to run, and SCALING.md names
 * when that changes. Needs a direct or session-mode DSN -- LISTEN/NOTIFY does
 * not work behind a transaction pooler.
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
   * Enqueues an ingestion job. No `singletonKey`: pg-boss applies it across
   * completed jobs too, which blocks re-ingestion. Duplicates are cheap because
   * `ingest()` skips unchanged content.
   */
  async enqueueIngest(data: IngestJobData): Promise<string | null> {
    if (!this.boss) {
      this.logger.warn('Queue disabled; ingestion not scheduled');
      return null;
    }

    const jobId = await this.boss.send(INGEST_QUEUE, data);
    if (!jobId) {
      // null means no job was created; never ignore it.
      this.logger.error(
        `Failed to enqueue ingestion for document ${data.documentId}: send() returned null`,
      );
    }
    return jobId;
  }
}
