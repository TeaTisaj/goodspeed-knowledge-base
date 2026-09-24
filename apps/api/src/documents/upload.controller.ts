import { Controller, Post, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Document } from '@kb/contracts';
import { ExtractionError, MAX_UPLOAD_BYTES, SUPPORTED_MIME_TYPES, extractText } from '@kb/rag';
import { SupabaseAuthGuard, type AuthenticatedUser } from '../common/auth.guard.js';
import { CurrentUser } from '../common/current-user.decorator.js';
import { AppError } from '../common/errors.js';
import { QueueService } from '../ingestion/queue.service.js';
import { DocumentsService } from './documents.service.js';

/**
 * File upload.
 *
 * Extraction happens here, in the request, rather than in the worker. That is
 * deliberate: a file that cannot be read should fail the upload with a message
 * the user can act on ("this PDF is scanned, OCR is not supported"), not create
 * a document that quietly ends up in `failed` a few seconds later.
 *
 * Everything after extraction is the normal path -- the document is created and
 * ingested by the same queue and worker as a typed one, so upload adds a source
 * of text rather than a parallel pipeline.
 */
@Controller('documents/upload')
@UseGuards(SupabaseAuthGuard)
export class UploadController {
  constructor(
    private readonly documents: DocumentsService,
    private readonly queue: QueueService,
  ) {}

  @Post()
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
    }),
  )
  async upload(
    @CurrentUser() user: AuthenticatedUser,
    @UploadedFile() file?: Express.Multer.File,
  ): Promise<Document> {
    if (!file) throw AppError.validation('No file was uploaded.');

    if (!SUPPORTED_MIME_TYPES.includes(file.mimetype as (typeof SUPPORTED_MIME_TYPES)[number])) {
      throw AppError.validation(
        `Unsupported file type "${file.mimetype}". Supported: PDF, plain text, markdown.`,
      );
    }

    let extracted;
    try {
      extracted = await extractText(new Uint8Array(file.buffer), {
        mimeType: file.mimetype,
        filename: file.originalname,
        // Imported lazily: unpdf pulls in a sizeable PDF.js build, and a
        // deployment that never receives a PDF should not pay for it at boot.
        pdfExtractor: async (buffer) => {
          const { extractText: unpdfExtract, getDocumentProxy } = await import('unpdf');
          const pdf = await getDocumentProxy(buffer);
          const { text, totalPages } = await unpdfExtract(pdf, { mergePages: true });
          return { text: Array.isArray(text) ? text.join('\n') : text, pageCount: totalPages };
        },
      });
    } catch (error) {
      if (error instanceof ExtractionError) throw AppError.validation(error.message);
      throw AppError.internal('Could not read that file.');
    }

    const doc = await this.documents.create(user.accessToken, user.id, {
      title: extracted.title ?? file.originalname,
      content: extracted.text,
      tags: [],
    });

    await this.queue.enqueueIngest({ documentId: doc.id, ownerId: user.id });
    return doc;
  }
}
