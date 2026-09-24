import { z } from 'zod';

export const citationSchema = z.object({
  number: z.number().int().positive(),
  chunkId: z.uuid(),
  documentId: z.uuid(),
  documentTitle: z.string(),
  quote: z.string(),
});
export type Citation = z.infer<typeof citationSchema>;

export const chatMessageSchema = z.object({
  id: z.uuid(),
  role: z.enum(['user', 'assistant']),
  content: z.string(),
  citations: z.array(citationSchema).default([]),
  provider: z.string().nullable(),
  model: z.string().nullable(),
  promptTokens: z.number().int().nullable(),
  completionTokens: z.number().int().nullable(),
  latencyMs: z.number().int().nullable(),
  createdAt: z.string(),
});
export type ChatMessage = z.infer<typeof chatMessageSchema>;

export const conversationSchema = z.object({
  id: z.uuid(),
  title: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Conversation = z.infer<typeof conversationSchema>;

export const askSchema = z.object({
  question: z.string().trim().min(1, 'Question is required').max(2000),
  conversationId: z.uuid().optional(),
  /** Restrict retrieval to these tags. */
  tags: z.array(z.string().trim().min(1)).max(20).optional(),
  documentIds: z.array(z.uuid()).max(50).optional(),
});
export type AskInput = z.infer<typeof askSchema>;

/**
 * The streaming protocol, defined once and shared.
 *
 * A discriminated union rather than raw text chunks: the client must tell a
 * token from a citation payload from a terminal error, and SSE gives no way to
 * signal failure once headers are flushed — so `error` is an event, not a
 * status code.
 */
export const streamEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('start'), conversationId: z.uuid(), messageId: z.uuid() }),
  z.object({
    type: z.literal('status'),
    stage: z.enum(['condensing', 'retrieving', 'generating']),
  }),
  /**
   * Candidate sources placed in the prompt, sent before the answer so the UI
   * can show them while text streams.
   */
  z.object({ type: z.literal('sources'), sources: z.array(citationSchema) }),
  /**
   * The sources the model actually cited, sent once the answer is complete.
   * Always a subset of `sources`, and it is what gets persisted -- the two are
   * separate events so the live view and a reloaded conversation agree.
   */
  z.object({ type: z.literal('citations'), citations: z.array(citationSchema) }),
  z.object({ type: z.literal('token'), delta: z.string() }),
  z.object({
    type: z.literal('usage'),
    promptTokens: z.number().int(),
    completionTokens: z.number().int(),
    provider: z.string(),
    model: z.string(),
  }),
  z.object({ type: z.literal('done'), messageId: z.uuid() }),
  z.object({ type: z.literal('error'), code: z.string(), message: z.string() }),
]);
export type StreamEvent = z.infer<typeof streamEventSchema>;
