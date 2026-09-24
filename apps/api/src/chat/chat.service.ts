import { Injectable, Logger } from '@nestjs/common';
import type { Citation, StreamEvent } from '@kb/contracts';
import {
  buildCondensePrompt,
  buildPrompt,
  countTokens,
  resolveCitations,
  type RetrievedChunk,
} from '@kb/rag';
import { randomUUID } from 'node:crypto';
import { AiService } from '../ai/ai.service.js';
import { ConfigService } from '../config/config.service.js';
import { RetrievalService } from '../retrieval/retrieval.service.js';
import { UsageService } from '../usage/usage.service.js';
import { SupabaseService } from '../supabase/supabase.service.js';

/** Most recent messages carried into the prompt and the condenser. */
const HISTORY_TURNS = 10;

export interface AskParams {
  accessToken: string;
  userId: string;
  question: string;
  conversationId?: string;
  tags?: string[];
  documentIds?: string[];
  signal?: AbortSignal;
}

/**
 * The RAG workflow.
 *
 *   [multi-turn only] condense -> embed -> hybrid retrieve -> [optional rerank]
 *   -> build prompt -> stream -> persist
 *
 * This is a workflow, not an agent: the steps are fixed, the model never
 * chooses control flow, and cost and latency are bounded. The only model call
 * beyond the answer is query condensation, and it runs only when there is
 * history to condense -- without it, "what about the second one?" embeds to
 * nothing useful and retrieval returns noise.
 *
 * Agentic retrieval was considered and rejected: it needs iteration budgets and
 * stop conditions to avoid running away on cost, and on single-corpus Q&A it
 * does not pay for itself.
 */
@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly retrieval: RetrievalService,
    private readonly ai: AiService,
    private readonly config: ConfigService,
    private readonly usage: UsageService,
  ) {}

  async *ask(params: AskParams): AsyncGenerator<StreamEvent> {
    const db = this.supabase.forUser(params.accessToken);
    const startedAt = Date.now();
    // Opened before any provider call, so every embedding, condense and chat
    // token emitted during this turn lands in this request's own bucket rather
    // than a buffer shared with whoever else is mid-answer.
    const usageEvents = this.ai.beginUsageScope();

    try {
      const conversationId = await this.ensureConversation(
        params.accessToken,
        params.userId,
        params.conversationId,
        params.question,
      );

      const history = await this.loadHistory(params.accessToken, conversationId);

      await this.saveMessage(params.accessToken, {
        conversationId,
        ownerId: params.userId,
        role: 'user',
        content: params.question,
      });

      const assistantMessageId = randomUUID();
      yield { type: 'start', conversationId, messageId: assistantMessageId };

      // --- 1. condense, only when there is history ---------------------------
      let searchQuery = params.question;
      if (history.length > 0) {
        yield { type: 'status', stage: 'condensing' };
        searchQuery = await this.condense(history, params.question, params.signal);
      }

      // --- 2. retrieve -------------------------------------------------------
      yield { type: 'status', stage: 'retrieving' };
      let chunks = await this.retrieval.retrieve(params.accessToken, searchQuery, {
        tags: params.tags,
        documentIds: params.documentIds,
        limit: this.config.env.RETRIEVAL_CANDIDATES,
      });

      if (this.retrieval.rerankEnabled && chunks.length > 0) {
        chunks = await this.retrieval.rerank(searchQuery, chunks, this.config.env.RETRIEVAL_TOP_K);
      } else {
        chunks = chunks.slice(0, this.config.env.RETRIEVAL_TOP_K);
      }

      // --- 3. build the prompt ----------------------------------------------
      // The ceiling comes from the provider that will actually serve the
      // request, not from a constant: swapping a 400k-window model for an 8k
      // one must move this number, or the first swap overflows the window.
      // MAX_CONTEXT_TOKENS is the override, and the lower of the two wins.
      const providerWindow = this.ai.chat.capabilities.maxContextTokens;
      const maxContextTokens = Math.min(this.config.env.MAX_CONTEXT_TOKENS, providerWindow);

      // History and the question are already committed, so they come out of the
      // budget before the sources are fitted to what is left.
      const reservedTokens =
        history.reduce((n, h) => n + countTokens(h.content), 0) + countTokens(params.question);

      const { system, used } = buildPrompt(chunks, {
        maxContextTokens,
        reservedTokens,
        countTokens,
      });

      // Sources are emitted before the answer so the UI can render them while
      // the text is still streaming. These are the candidates the model was
      // given, which is not the same set as the ones it ended up citing -- the
      // narrowed set is sent again as `citations` once the answer is complete.
      yield { type: 'sources', sources: this.toCitations(used) };

      // --- 4. stream the answer ---------------------------------------------
      yield { type: 'status', stage: 'generating' };

      let answer = '';
      let promptTokens = 0;
      let completionTokens = 0;

      for await (const event of this.ai.chat.streamChat({
        messages: [
          { role: 'system', content: system },
          ...history.map((h) => ({ role: h.role, content: h.content })),
          { role: 'user', content: params.question },
        ],
        temperature: 0.2,
        signal: params.signal,
      })) {
        if (event.type === 'text') {
          answer += event.delta;
          yield { type: 'token', delta: event.delta };
        } else if (event.type === 'usage') {
          promptTokens = event.usage.promptTokens;
          completionTokens = event.usage.completionTokens;
        }
      }

      yield {
        type: 'usage',
        promptTokens,
        completionTokens,
        provider: this.ai.chat.id,
        model: this.ai.chat.model,
      };

      // --- 5. persist --------------------------------------------------------
      // Citations are resolved from what the model actually emitted, so an
      // uncited answer records no citations rather than implying support.
      const resolved = resolveCitations(answer, used);

      // Replaces the candidate list in the UI with what was actually cited.
      // Without this the live view showed every retrieved chunk while the
      // stored message kept only the cited ones, so reloading a conversation
      // silently changed its citations.
      yield {
        type: 'citations',
        citations: resolved.map((c) => ({
          number: c.number,
          chunkId: c.chunkId,
          documentId: c.documentId,
          documentTitle: c.documentTitle,
          quote: c.quote,
        })),
      };

      await this.saveMessage(params.accessToken, {
        id: assistantMessageId,
        conversationId,
        ownerId: params.userId,
        role: 'assistant',
        content: answer,
        provider: this.ai.chat.id,
        model: this.ai.chat.model,
        promptTokens,
        completionTokens,
        latencyMs: Date.now() - startedAt,
        citations: resolved,
      });

      await db
        .from('conversations')
        .update({ updated_at: new Date().toISOString() })
        .eq('id', conversationId);

      // Everything this turn consumed -- chat, the condense call, every
      // embedding -- attributed to the user who caused it. Never awaited before
      // `done`: the answer is already complete, and analytics must not delay it.
      void this.usage.record(params.userId, usageEvents.splice(0));

      yield { type: 'done', messageId: assistantMessageId };
    } catch (error) {
      // Once the response has started there is no status code left to set, so
      // a failure is an event in the stream. The alternative -- throwing --
      // leaves the client hanging on a half-written response.
      this.logger.error(`Chat failed: ${(error as Error).message}`);
      // A turn that failed halfway still spent tokens. Recording them here is
      // what stops the failure path leaking usage that would otherwise be
      // attributed to whoever asked next.
      void this.usage.record(params.userId, usageEvents.splice(0));
      yield {
        type: 'error',
        code: 'internal_error',
        message: 'Something went wrong generating the answer.',
      };
    }
  }

  private async condense(
    history: { role: 'user' | 'assistant'; content: string }[],
    question: string,
    signal?: AbortSignal,
  ): Promise<string> {
    try {
      const result = await this.ai.chat.chat({
        messages: [{ role: 'user', content: buildCondensePrompt(history, question) }],
        temperature: 0,
        maxTokens: 120,
        signal,
      });
      const condensed = result.text.trim();
      // A condense call that returns junk must not replace a usable question.
      return condensed.length > 3 ? condensed : question;
    } catch (error) {
      this.logger.warn(`Condense failed, using raw question: ${(error as Error).message}`);
      return question;
    }
  }

  private toCitations(chunks: RetrievedChunk[]): Citation[] {
    return chunks.map((c, i) => ({
      number: i + 1,
      chunkId: c.id,
      documentId: c.documentId,
      documentTitle: c.documentTitle,
      quote: c.content.slice(0, 300),
    }));
  }

  private async ensureConversation(
    accessToken: string,
    ownerId: string,
    conversationId: string | undefined,
    question: string,
  ): Promise<string> {
    const db = this.supabase.forUser(accessToken);
    if (conversationId) {
      const { data } = await db
        .from('conversations')
        .select('id')
        .eq('id', conversationId)
        .maybeSingle();
      if (data) return conversationId;
    }

    const title = question.length > 60 ? `${question.slice(0, 57)}...` : question;
    const { data, error } = await db
      .from('conversations')
      .insert({ owner_id: ownerId, title })
      .select('id')
      .single();
    if (error) throw new Error(`Failed to create conversation: ${error.message}`);
    return (data as { id: string }).id;
  }

  private async loadHistory(
    accessToken: string,
    conversationId: string,
  ): Promise<{ role: 'user' | 'assistant'; content: string }[]> {
    // Newest first, then reversed back into chronological order. Ordering
    // ascending with a limit takes the *oldest* ten messages, which freezes the
    // context at the start of the conversation: past turn ten the model and the
    // condenser never see anything recent.
    const { data } = await this.supabase
      .forUser(accessToken)
      .from('messages')
      .select('role, content, created_at')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: false })
      .limit(HISTORY_TURNS);

    const rows = (data ?? []) as { role: 'user' | 'assistant'; content: string }[];
    return rows.reverse();
  }

  private async saveMessage(
    accessToken: string,
    msg: {
      id?: string;
      conversationId: string;
      ownerId: string;
      role: 'user' | 'assistant';
      content: string;
      provider?: string;
      model?: string;
      promptTokens?: number;
      completionTokens?: number;
      latencyMs?: number;
      citations?: { number: number; chunkId: string; documentId: string; quote: string }[];
    },
  ): Promise<void> {
    const db = this.supabase.forUser(accessToken);
    const { data, error } = await db
      .from('messages')
      .insert({
        ...(msg.id ? { id: msg.id } : {}),
        conversation_id: msg.conversationId,
        owner_id: msg.ownerId,
        role: msg.role,
        content: msg.content,
        provider: msg.provider ?? null,
        model: msg.model ?? null,
        prompt_tokens: msg.promptTokens ?? null,
        completion_tokens: msg.completionTokens ?? null,
        latency_ms: msg.latencyMs ?? null,
      })
      .select('id')
      .single();

    if (error) throw new Error(`Failed to save message: ${error.message}`);

    if (msg.citations?.length) {
      const { error: citationError } = await db.from('message_citations').insert(
        msg.citations.map((c) => ({
          message_id: (data as { id: string }).id,
          chunk_id: c.chunkId,
          document_id: c.documentId,
          owner_id: msg.ownerId,
          rank: c.number,
          quote: c.quote,
        })),
      );
      // Checked deliberately: an unchecked insert here failed silently under
      // RLS and every answer was stored with zero citations. Logged rather than
      // thrown -- the answer has already been streamed, and losing its
      // citations should not fail the request retroactively.
      if (citationError) {
        this.logger.error(`Failed to persist citations: ${citationError.message}`);
      }
    }
  }
}
