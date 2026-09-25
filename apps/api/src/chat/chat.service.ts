import { Injectable, Logger } from '@nestjs/common';
import {
  classifyGrounding,
  isNoAnswer,
  NO_ANSWER,
  type Citation,
  type Grounding,
  type StreamEvent,
} from '@kb/contracts';
import {
  acceptCondensed,
  acceptHypothetical,
  buildChatMessages,
  buildCondensePrompt,
  buildHypotheticalAnswerPrompt,
  calibratedRelevanceFloor,
  citationQuote,
  CONDENSE_MAX_TOKENS,
  countTokens,
  detectInjectionSignals,
  fuseExpansion,
  HYDE_MAX_TOKENS,
  resolveCitations,
  selectRelevant,
  type RetrievedChunk,
} from '@kb/rag';
import type { ChatMessage } from '@kb/ai';
import { randomUUID } from 'node:crypto';
import { AiService } from '../ai/ai.service.js';
import { ConfigService } from '../config/config.service.js';
import { RetrievalService } from '../retrieval/retrieval.service.js';
import { UsageService } from '../usage/usage.service.js';
import { SupabaseService } from '../supabase/supabase.service.js';

/** Most recent messages carried into the prompt and the condenser. */
const HISTORY_TURNS = 10;

/** Sent when nothing retrieved is relevant. No model call, so it costs nothing and cannot be argued with. */
const NOTHING_RELEVANT = `${NO_ANSWER} None of your documents look related to this question — try rephrasing it, or check the document you expect has finished indexing.`;

type HistoryMessage = { role: 'user' | 'assistant'; content: string };
type UsageEvents = Parameters<UsageService['record']>[1];

export interface AskParams {
  accessToken: string;
  userId: string;
  question: string;
  conversationId?: string;
  tags?: string[];
  documentIds?: string[];
  signal?: AbortSignal;
}

/** State shared by the steps of one turn. */
interface Turn {
  params: AskParams;
  conversationId: string;
  messageId: string;
  startedAt: number;
  usageEvents: UsageEvents;
}

interface Answer {
  text: string;
  promptTokens: number;
  completionTokens: number;
  finishReason?: string;
}

/**
 * The RAG workflow: [follow-ups only] condense -> retrieve -> relevance floor
 * -> [optional HyDE, rerank] -> build prompt -> stream -> persist.
 *
 * A workflow rather than an agent: the steps are fixed and the model never
 * chooses control flow, so cost and latency are bounded. See DECISIONS.md.
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
    const startedAt = Date.now();
    // Opened before any provider call so this turn's tokens land in its own bucket.
    const usageEvents = this.ai.beginUsageScope();

    try {
      const conversationId = await this.ensureConversation(params);
      const history = await this.loadHistory(params.accessToken, conversationId);
      await this.saveMessage(params.accessToken, {
        conversationId,
        ownerId: params.userId,
        role: 'user',
        content: params.question,
      });

      const turn: Turn = {
        params,
        conversationId,
        messageId: randomUUID(),
        startedAt,
        usageEvents,
      };
      yield { type: 'start', conversationId, messageId: turn.messageId };

      const searchQuery = yield* this.searchQuery(history, params);
      const chunks = yield* this.retrieveContext(searchQuery, params);
      if (chunks.length === 0) {
        yield* this.refuseWithoutModel(turn);
        return;
      }

      const { messages, used } = this.buildPrompt(chunks, history, params.question);
      const flaggedSources = this.logInjectionSignals(used);
      // Candidates first, so the UI can show them while the answer streams.
      yield { type: 'sources', sources: this.toCitations(used) };

      const answer = yield* this.streamAnswer(messages, params.signal);
      if (answer.text.trim() === '') {
        this.logger.error(
          `Empty answer from ${this.ai.chat.id}/${this.ai.chat.model} (finish_reason=${answer.finishReason ?? 'unknown'}). ` +
            'If this is a reasoning model, raise AI_ANSWER_MAX_TOKENS.',
        );
        this.recordUsage(turn);
        yield {
          type: 'error',
          code: 'empty_answer',
          message: 'The model returned no answer. Please try again.',
        };
        return;
      }

      yield* this.finishAnswer(turn, answer, used, flaggedSources);
    } catch (error) {
      // Headers are already sent, so a failure has to be an event in the stream.
      this.logger.error(`Chat failed: ${(error as Error).message}`);
      void this.usage.record(params.userId, usageEvents.splice(0));
      yield {
        type: 'error',
        code: 'internal_error',
        message: 'Something went wrong generating the answer.',
      };
    }
  }

  // --- steps ----------------------------------------------------------------

  /** Follow-ups are rewritten into a standalone question; first turns are searched as-is. */
  private async *searchQuery(
    history: HistoryMessage[],
    params: AskParams,
  ): AsyncGenerator<StreamEvent, string> {
    if (history.length === 0) return params.question;
    yield { type: 'status', stage: 'condensing' };
    return this.condense(history, params.question, params.signal);
  }

  /** Hybrid search, the relevance floor, then optional expansion and rerank. Empty means refuse. */
  private async *retrieveContext(
    searchQuery: string,
    params: AskParams,
  ): AsyncGenerator<StreamEvent, RetrievedChunk[]> {
    yield { type: 'status', stage: 'retrieving' };
    const { RETRIEVAL_CANDIDATES, RETRIEVAL_TOP_K, RETRIEVAL_HYDE } = this.config.env;
    const filters = { tags: params.tags, documentIds: params.documentIds };

    const candidates = await this.retrieval.retrieve(params.accessToken, searchQuery, {
      ...filters,
      limit: RETRIEVAL_CANDIDATES,
    });
    let chunks = selectRelevant(candidates, this.relevanceFloor);
    if (chunks.length === 0) return chunks;

    // After the floor, so expansion can improve an answer but never create one.
    if (RETRIEVAL_HYDE) {
      const hypothesis = await this.hypothesise(searchQuery, params.signal);
      if (hypothesis) {
        const expansion = await this.retrieval.retrieve(params.accessToken, hypothesis, {
          ...filters,
          limit: RETRIEVAL_CANDIDATES,
        });
        chunks = fuseExpansion(chunks, expansion, RETRIEVAL_CANDIDATES);
      }
    }

    return this.retrieval.rerankEnabled
      ? this.retrieval.rerank(searchQuery, chunks, RETRIEVAL_TOP_K)
      : chunks.slice(0, RETRIEVAL_TOP_K);
  }

  /** Fits sources into the smaller of the configured budget and the provider's window. */
  private buildPrompt(chunks: RetrievedChunk[], history: HistoryMessage[], question: string) {
    const maxContextTokens = Math.min(
      this.config.env.MAX_CONTEXT_TOKENS,
      this.ai.chat.capabilities.maxContextTokens,
    );
    return buildChatMessages({ chunks, history, question }, { maxContextTokens, countTokens });
  }

  private async *streamAnswer(
    messages: ChatMessage[],
    signal?: AbortSignal,
  ): AsyncGenerator<StreamEvent, Answer> {
    yield { type: 'status', stage: 'generating' };
    const answer: Answer = { text: '', promptTokens: 0, completionTokens: 0 };

    for await (const event of this.ai.chat.streamChat({
      messages,
      temperature: 0.2,
      maxTokens: this.config.env.AI_ANSWER_MAX_TOKENS,
      signal,
    })) {
      if (event.type === 'text') {
        answer.text += event.delta;
        yield { type: 'token', delta: event.delta };
      } else if (event.type === 'usage') {
        answer.promptTokens = event.usage.promptTokens;
        answer.completionTokens = event.usage.completionTokens;
      } else if (event.type === 'done') {
        answer.finishReason = event.finishReason;
      }
    }

    if (answer.finishReason === 'length') {
      this.logger.warn(
        `Answer truncated at AI_ANSWER_MAX_TOKENS=${this.config.env.AI_ANSWER_MAX_TOKENS}.`,
      );
    }
    return answer;
  }

  /** Emits usage and the cited sources, then persists the answer. */
  private async *finishAnswer(
    turn: Turn,
    answer: Answer,
    used: RetrievedChunk[],
    flaggedSources: number,
  ): AsyncGenerator<StreamEvent> {
    const { params } = turn;
    yield {
      type: 'usage',
      promptTokens: answer.promptTokens,
      completionTokens: answer.completionTokens,
      provider: this.ai.chat.id,
      model: this.ai.chat.model,
    };

    // Only what the model actually cited, replacing the candidate list in the UI.
    const resolved = resolveCitations(answer.text, used);
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

    const grounding = classifyGrounding(answer.text, resolved.length);
    await this.saveMessage(params.accessToken, {
      id: turn.messageId,
      conversationId: turn.conversationId,
      ownerId: params.userId,
      role: 'assistant',
      content: answer.text,
      provider: this.ai.chat.id,
      model: this.ai.chat.model,
      promptTokens: answer.promptTokens,
      completionTokens: answer.completionTokens,
      latencyMs: Date.now() - turn.startedAt,
      citations: resolved,
      grounding,
      flaggedSources,
    });
    this.logTurn(turn, {
      grounding,
      refusedWithoutModel: false,
      flaggedSources,
      sources: used.length,
    });
    await this.touchConversation(params.accessToken, turn.conversationId);
    this.recordUsage(turn);

    yield { type: 'done', messageId: turn.messageId };
  }

  /** The same events a model answer produces, so the client needs no special case. */
  private async *refuseWithoutModel(turn: Turn): AsyncGenerator<StreamEvent> {
    const { params } = turn;
    yield { type: 'sources', sources: [] };
    yield { type: 'token', delta: NOTHING_RELEVANT };
    yield {
      type: 'usage',
      promptTokens: 0,
      completionTokens: 0,
      provider: this.ai.chat.id,
      model: this.ai.chat.model,
    };
    yield { type: 'citations', citations: [] };

    await this.saveMessage(params.accessToken, {
      id: turn.messageId,
      conversationId: turn.conversationId,
      ownerId: params.userId,
      role: 'assistant',
      content: NOTHING_RELEVANT,
      provider: this.ai.chat.id,
      model: this.ai.chat.model,
      promptTokens: 0,
      completionTokens: 0,
      latencyMs: Date.now() - turn.startedAt,
      grounding: 'refusal',
      refusedWithoutModel: true,
    });
    this.logTurn(turn, {
      grounding: 'refusal',
      refusedWithoutModel: true,
      flaggedSources: 0,
      sources: 0,
    });
    await this.touchConversation(params.accessToken, turn.conversationId);
    // The query embedding (and any condense call) was still spent.
    this.recordUsage(turn);

    yield { type: 'done', messageId: turn.messageId };
  }

  // --- model calls that must never fail the turn ------------------------------

  private async condense(
    history: HistoryMessage[],
    question: string,
    signal?: AbortSignal,
  ): Promise<string> {
    try {
      const result = await this.ai.chat.chat({
        messages: [{ role: 'user', content: buildCondensePrompt(history, question) }],
        temperature: 0,
        maxTokens: CONDENSE_MAX_TOKENS,
        signal,
      });
      const condensed = result.text.trim();
      return acceptCondensed(condensed, isNoAnswer) ? condensed : question;
    } catch (error) {
      this.logger.warn(`Condense failed, using raw question: ${(error as Error).message}`);
      return question;
    }
  }

  private async hypothesise(question: string, signal?: AbortSignal): Promise<string | null> {
    try {
      const result = await this.ai.chat.chat({
        messages: [{ role: 'user', content: buildHypotheticalAnswerPrompt(question) }],
        temperature: 0,
        maxTokens: HYDE_MAX_TOKENS,
        signal,
      });
      return acceptHypothetical(result.text, isNoAnswer) ? result.text.trim() : null;
    } catch (error) {
      this.logger.warn(
        `Expansion failed, searching the question alone: ${(error as Error).message}`,
      );
      return null;
    }
  }

  // --- helpers ----------------------------------------------------------------

  /** The configured floor, else the one measured for this embedding model, else none. */
  private get relevanceFloor(): number {
    return (
      this.config.env.RETRIEVAL_MIN_SIMILARITY ??
      calibratedRelevanceFloor(this.ai.embeddings.model) ??
      0
    );
  }

  /** Fire-and-forget: analytics must never delay or fail an answer. */
  private recordUsage(turn: Turn): void {
    void this.usage.record(turn.params.userId, turn.usageEvents.splice(0));
  }

  /**
   * Logged, not blocked: a document about prompt injection is legitimate
   * content, and it reaches the model as data under rules that say so.
   */
  private logInjectionSignals(chunks: RetrievedChunk[]): number {
    let flagged = 0;
    for (const chunk of chunks) {
      const signals = detectInjectionSignals(chunk.content);
      if (signals.length > 0) {
        this.logger.warn(
          `Source chunk ${chunk.id} (document ${chunk.documentId}) matches injection ` +
            `heuristics: ${signals.join(', ')}. Passed to the model as data.`,
        );
        flagged++;
      }
    }
    return flagged;
  }

  /** One structured line per turn for dashboards. No user text. */
  private logTurn(
    turn: Turn,
    fields: {
      grounding: Grounding;
      refusedWithoutModel: boolean;
      flaggedSources: number;
      sources: number;
    },
  ): void {
    this.logger.log(
      `chat_turn ${JSON.stringify({ ...fields, latencyMs: Date.now() - turn.startedAt })}`,
    );
  }

  private toCitations(chunks: RetrievedChunk[]): Citation[] {
    return chunks.map((c, i) => ({
      number: i + 1,
      chunkId: c.id,
      documentId: c.documentId,
      documentTitle: c.documentTitle,
      quote: citationQuote(c.content),
    }));
  }

  // --- persistence ------------------------------------------------------------

  private async ensureConversation(params: AskParams): Promise<string> {
    const db = this.supabase.forUser(params.accessToken);
    if (params.conversationId) {
      const { data } = await db
        .from('conversations')
        .select('id')
        .eq('id', params.conversationId)
        .maybeSingle();
      if (data) return params.conversationId;
    }

    const { question } = params;
    const title = question.length > 60 ? `${question.slice(0, 57)}...` : question;
    const { data, error } = await db
      .from('conversations')
      .insert({ owner_id: params.userId, title })
      .select('id')
      .single();
    if (error) throw new Error(`Failed to create conversation: ${error.message}`);
    return (data as { id: string }).id;
  }

  /** The newest HISTORY_TURNS messages, returned oldest first. */
  private async loadHistory(
    accessToken: string,
    conversationId: string,
  ): Promise<HistoryMessage[]> {
    const { data } = await this.supabase
      .forUser(accessToken)
      .from('messages')
      .select('role, content, created_at')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: false })
      .limit(HISTORY_TURNS);

    return ((data ?? []) as HistoryMessage[]).reverse();
  }

  private async touchConversation(accessToken: string, conversationId: string): Promise<void> {
    await this.supabase
      .forUser(accessToken)
      .from('conversations')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', conversationId);
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
      grounding?: Grounding;
      refusedWithoutModel?: boolean;
      flaggedSources?: number;
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
        grounding: msg.grounding ?? null,
        refused_without_model: msg.refusedWithoutModel ?? false,
        flagged_sources: msg.flaggedSources ?? 0,
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
      // Logged, not thrown: the answer has already streamed.
      if (citationError) {
        this.logger.error(`Failed to persist citations: ${citationError.message}`);
      }
    }
  }
}
