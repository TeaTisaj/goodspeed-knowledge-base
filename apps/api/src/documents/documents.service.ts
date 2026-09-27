import { Injectable } from '@nestjs/common';
import type {
  CreateDocumentInput,
  Document,
  DocumentSummary,
  ListDocumentsQuery,
  ListDocumentsResponse,
  UpdateDocumentInput,
} from '@kb/contracts';
import type { SupabaseClient } from '@supabase/supabase-js';
import { AppError } from '../common/errors.js';
import { SupabaseService } from '../supabase/supabase.service.js';

/** Shape of a `documents` row, kept local so the mapper is explicit. */
interface DocumentRow {
  id: string;
  title: string;
  content: string;
  tags: string[];
  source_type: 'text' | 'upload';
  status: Document['status'];
  chunk_count: number;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

const SUMMARY_COLUMNS =
  'id, title, tags, source_type, status, chunk_count, error_message, created_at, updated_at';
const FULL_COLUMNS = `${SUMMARY_COLUMNS}, content`;

function toSummary(row: Omit<DocumentRow, 'content'>): DocumentSummary {
  return {
    id: row.id,
    title: row.title,
    tags: row.tags ?? [],
    sourceType: row.source_type,
    status: row.status,
    chunkCount: row.chunk_count,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toDocument(row: DocumentRow): Document {
  return { ...toSummary(row), content: row.content ?? '' };
}

@Injectable()
export class DocumentsService {
  constructor(private readonly supabase: SupabaseService) {}

  /**
   * All reads and writes go through the caller's RLS-scoped client, so
   * ownership is enforced by Postgres. Note the absence of any
   * `.eq('owner_id', ...)` filter below: adding one would imply the policies
   * are not trusted, and would be the thing that rots when a new query is added.
   */
  private client(accessToken: string): SupabaseClient {
    return this.supabase.forUser(accessToken);
  }

  async list(accessToken: string, query: ListDocumentsQuery): Promise<ListDocumentsResponse> {
    let q = this.client(accessToken)
      .from('documents')
      .select(SUMMARY_COLUMNS, { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(query.offset, query.offset + query.limit - 1);

    if (query.tag) q = q.contains('tags', [query.tag]);
    if (query.search) q = q.ilike('title', `%${query.search}%`);

    const { data, error, count } = await q;
    if (error) throw AppError.internal(`Failed to list documents: ${error.message}`);

    return {
      items: (data ?? []).map((r) => toSummary(r as Omit<DocumentRow, 'content'>)),
      total: count ?? 0,
      limit: query.limit,
      offset: query.offset,
    };
  }

  async get(accessToken: string, id: string): Promise<Document> {
    const { data, error } = await this.client(accessToken)
      .from('documents')
      .select(FULL_COLUMNS)
      .eq('id', id)
      .maybeSingle();

    if (error) throw AppError.internal(`Failed to load document: ${error.message}`);
    if (!data) throw AppError.notFound('Document');
    return toDocument(data as DocumentRow);
  }

  async create(
    accessToken: string,
    ownerId: string,
    input: CreateDocumentInput,
  ): Promise<Document> {
    const { data, error } = await this.client(accessToken)
      .from('documents')
      .insert({
        owner_id: ownerId,
        title: input.title,
        content: input.content,
        tags: input.tags,
        status: 'queued',
      })
      .select(FULL_COLUMNS)
      .single();

    if (error) throw AppError.internal(`Failed to create document: ${error.message}`);
    return toDocument(data as DocumentRow);
  }

  async update(accessToken: string, id: string, input: UpdateDocumentInput): Promise<Document> {
    const patch: Record<string, unknown> = {};
    if (input.title !== undefined) patch.title = input.title;
    if (input.tags !== undefined) patch.tags = input.tags;
    if (input.content !== undefined) {
      patch.content = input.content;
      // Content changed, so existing chunks are stale until re-ingested.
      patch.status = 'queued';
    }

    const { data, error } = await this.client(accessToken)
      .from('documents')
      .update(patch)
      .eq('id', id)
      .select(FULL_COLUMNS)
      .maybeSingle();

    if (error) throw AppError.internal(`Failed to update document: ${error.message}`);
    if (!data) throw AppError.notFound('Document');
    return toDocument(data as DocumentRow);
  }

  async remove(accessToken: string, id: string): Promise<void> {
    const { data, error } = await this.client(accessToken)
      .from('documents')
      .delete()
      .eq('id', id)
      .select('id')
      .maybeSingle();

    if (error) throw AppError.internal(`Failed to delete document: ${error.message}`);
    // RLS makes another user's row invisible, so a no-op delete is a 404.
    if (!data) throw AppError.notFound('Document');
  }
}
