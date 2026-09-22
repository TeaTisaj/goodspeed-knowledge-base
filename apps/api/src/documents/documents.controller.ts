import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  createDocumentSchema,
  listDocumentsQuerySchema,
  updateDocumentSchema,
  type CreateDocumentInput,
  type Document,
  type ListDocumentsQuery,
  type ListDocumentsResponse,
  type UpdateDocumentInput,
} from '@kb/contracts';
import { z } from 'zod';
import { SupabaseAuthGuard, type AuthenticatedUser } from '../common/auth.guard.js';
import { CurrentUser } from '../common/current-user.decorator.js';
import { QueueService } from '../ingestion/queue.service.js';
import { DocumentsService } from './documents.service.js';

const uuidParam = z.uuid('Invalid document id');

/**
 * Validation uses the shared Zod schemas directly, via Nest 12's
 * StandardSchemaValidationPipe. The same schema types the web client, so a
 * contract change breaks both sides at compile time instead of at runtime.
 */
@Controller('documents')
@UseGuards(SupabaseAuthGuard)
export class DocumentsController {
  constructor(
    private readonly documents: DocumentsService,
    private readonly queue: QueueService,
  ) {}

  @Get()
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query({ schema: listDocumentsQuerySchema })
    query: ListDocumentsQuery,
  ): Promise<ListDocumentsResponse> {
    return this.documents.list(user.accessToken, query);
  }

  @Get(':id')
  get(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', { schema: uuidParam }) id: string,
  ): Promise<Document> {
    return this.documents.get(user.accessToken, id);
  }

  @Post()
  async create(
    @CurrentUser() user: AuthenticatedUser,
    @Body({ schema: createDocumentSchema })
    body: CreateDocumentInput,
  ): Promise<Document> {
    const doc = await this.documents.create(user.accessToken, user.id, body);
    // Ingestion is queued, never awaited: embedding a long document can take
    // many seconds and has no business blocking an HTTP response.
    await this.queue.enqueueIngest({ documentId: doc.id, ownerId: user.id });
    return doc;
  }

  @Patch(':id')
  async update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', { schema: uuidParam }) id: string,
    @Body({ schema: updateDocumentSchema })
    body: UpdateDocumentInput,
  ): Promise<Document> {
    const doc = await this.documents.update(user.accessToken, id, body);
    // Only content affects chunks; a title or tag edit needs no re-embedding.
    if (body.content !== undefined) {
      await this.queue.enqueueIngest({ documentId: doc.id, ownerId: user.id });
    }
    return doc;
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', { schema: uuidParam }) id: string,
  ): Promise<void> {
    return this.documents.remove(user.accessToken, id);
  }
}
