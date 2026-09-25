import { z } from 'zod';

/**
 * Shared API contracts.
 *
 * One Zod schema per shape, used by NestJS for runtime validation *and* by the
 * web app for its types. This is what makes `packages/` a real shared package
 * rather than a folder: changing a response shape here breaks compilation on
 * both sides immediately.
 *
 * It is also why validation is Standard Schema (Zod) rather than
 * class-validator: a class-validator DTO validates on the server and gives the
 * frontend nothing, so the two sides drift.
 */

export const ingestionStatusSchema = z.enum(['queued', 'processing', 'ready', 'failed']);
export type IngestionStatus = z.infer<typeof ingestionStatusSchema>;

const titleSchema = z.string().trim().min(1, 'Title is required').max(500);
/** Blank content would ingest to "Ready" with nothing searchable; delete the document instead. */
const contentSchema = z
  .string()
  .max(1_000_000, 'Document is too large (1MB limit)')
  .refine((s) => s.trim().length > 0, 'Add some content before saving');
const tagsArray = z.array(z.string().trim().min(1).max(50)).max(20, 'At most 20 tags');

/** Create defaults to no tags; update must not, or an empty PATCH clears them. */
const tagsSchema = tagsArray.default([]);

export const createDocumentSchema = z.object({
  title: titleSchema,
  content: contentSchema,
  tags: tagsSchema,
});
export type CreateDocumentInput = z.infer<typeof createDocumentSchema>;

export const updateDocumentSchema = z
  .object({
    title: titleSchema.optional(),
    content: contentSchema.optional(),
    // Deliberately `tagsArray`, not `tagsSchema`: a defaulted field is always
    // present after parsing, so `{}` would satisfy the "some field" check below
    // and then write an empty array, silently clearing the document's tags.
    tags: tagsArray.optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: 'No fields to update',
  });
export type UpdateDocumentInput = z.infer<typeof updateDocumentSchema>;

export const documentSchema = z.object({
  id: z.uuid(),
  title: z.string(),
  content: z.string(),
  tags: z.array(z.string()),
  sourceType: z.enum(['text', 'upload']),
  status: ingestionStatusSchema,
  chunkCount: z.number().int().nonnegative(),
  errorMessage: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Document = z.infer<typeof documentSchema>;

/** List view omits content: a list of 50 documents should not ship 50 bodies. */
export const documentSummarySchema = documentSchema.omit({ content: true });
export type DocumentSummary = z.infer<typeof documentSummarySchema>;

export const listDocumentsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  tag: z.string().trim().min(1).optional(),
  search: z.string().trim().min(1).max(200).optional(),
});
export type ListDocumentsQuery = z.infer<typeof listDocumentsQuerySchema>;

export const listDocumentsResponseSchema = z.object({
  items: z.array(documentSummarySchema),
  total: z.number().int().nonnegative(),
  limit: z.number().int(),
  offset: z.number().int(),
});
export type ListDocumentsResponse = z.infer<typeof listDocumentsResponseSchema>;

export const ingestionJobSchema = z.object({
  id: z.uuid(),
  documentId: z.uuid(),
  status: ingestionStatusSchema,
  attempt: z.number().int(),
  chunksCreated: z.number().int(),
  chunksReused: z.number().int(),
  errorMessage: z.string().nullable(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  createdAt: z.string(),
});
export type IngestionJob = z.infer<typeof ingestionJobSchema>;
