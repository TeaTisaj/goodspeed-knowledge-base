import { Module } from '@nestjs/common';
import { IngestionService } from './ingestion.service.js';
import { IngestionWorker } from './ingestion.worker.js';
import { QueueService } from './queue.service.js';

@Module({
  providers: [QueueService, IngestionService, IngestionWorker],
  exports: [QueueService, IngestionService],
})
export class IngestionModule {}
