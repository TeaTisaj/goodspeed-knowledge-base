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

/** The SSE protocol. Failures after headers are sent are an `error` event, not a status. */
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
  /** What the model actually cited (a subset of `sources`); this is what gets persisted. */
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

/**
 * The sentence every refusal starts with. A contract, not a prompt detail: the
 * model, the API, the UI and the eval all recognise it.
 */
export const NO_ANSWER = "I couldn't find that in your documents.";

/** True when an answer opens with the refusal, tolerating typographic quotes and emphasis. */
export function isNoAnswer(text: string): boolean {
  const normalised = text.replace(/[‘’]/g, "'").replace(/[*_]/g, '').trim().toLowerCase();
  const at = normalised.indexOf(NO_ANSWER.toLowerCase().slice(0, -1));
  return at !== -1 && at <= 20;
}

/**
 * How an answer relates to the sources, derived from content and citations
 * alone so a reloaded conversation classifies exactly as the live one did.
 *
 *  - `grounded`: cites at least one source that was actually provided.
 *  - `refusal`:  says the documents do not cover it.
 *  - `ungrounded`: neither -- a claim with nothing behind it. The UI flags
 *    these; the eval counts them as failures.
 */
export type Grounding = 'grounded' | 'refusal' | 'ungrounded';

export function classifyGrounding(answer: string, citationCount: number): Grounding {
  if (isNoAnswer(answer)) return 'refusal';
  return citationCount > 0 ? 'grounded' : 'ungrounded';
}
