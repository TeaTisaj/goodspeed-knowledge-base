import { Module } from '@nestjs/common';
import { IngestionModule } from '../ingestion/ingestion.module.js';
import { DocumentsController } from './documents.controller.js';
import { DocumentsService } from './documents.service.js';
import { UploadController } from './upload.controller.js';

@Module({
  imports: [IngestionModule],
  controllers: [DocumentsController, UploadController],
  providers: [DocumentsService],
  exports: [DocumentsService],
})
export class DocumentsModule {}
