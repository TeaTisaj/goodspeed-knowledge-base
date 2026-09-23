import { Injectable } from '@nestjs/common';
import type { ChatMessage, Citation, Conversation } from '@kb/contracts';
import { AppError } from '../common/errors.js';
import { SupabaseService } from '../supabase/supabase.service.js';

@Injectable()
export class ConversationsService {
  constructor(private readonly supabase: SupabaseService) {}

  async list(accessToken: string): Promise<Conversation[]> {
    const { data, error } = await this.supabase
      .forUser(accessToken)
      .from('conversations')
      .select('id, title, created_at, updated_at')
      .order('updated_at', { ascending: false })
      .limit(50);

    if (error) throw AppError.internal(`Failed to list conversations: ${error.message}`);
    return (data ?? []).map((r) => ({
      id: r.id as string,
      title: r.title as string,
      createdAt: r.created_at as string,
      updatedAt: r.updated_at as string,
    }));
  }

  async messages(accessToken: string, conversationId: string): Promise<ChatMessage[]> {
    const db = this.supabase.forUser(accessToken);

    const { data: convo } = await db
      .from('conversations')
      .select('id')
      .eq('id', conversationId)
      .maybeSingle();
    if (!convo) throw AppError.notFound('Conversation');

    const { data, error } = await db
      .from('messages')
      .select(
        'id, role, content, provider, model, prompt_tokens, completion_tokens, latency_ms, created_at, ' +
          'message_citations(rank, chunk_id, document_id, quote)',
      )
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: true });

    if (error) throw AppError.internal(`Failed to load messages: ${error.message}`);

    return (data ?? []).map((row) => {
      const r = row as unknown as Record<string, unknown>;
      const rawCitations = (r.message_citations ?? []) as Record<string, unknown>[];

      const citations: Citation[] = rawCitations
        .map((c) => ({
          number: c.rank as number,
          chunkId: (c.chunk_id as string) ?? '',
          documentId: (c.document_id as string) ?? '',
          documentTitle: '',
          quote: (c.quote as string) ?? '',
        }))
        .sort((a, b) => a.number - b.number);

      return {
        id: r.id as string,
        role: r.role as 'user' | 'assistant',
        content: r.content as string,
        citations,
        provider: (r.provider as string) ?? null,
        model: (r.model as string) ?? null,
        promptTokens: (r.prompt_tokens as number) ?? null,
        completionTokens: (r.completion_tokens as number) ?? null,
        latencyMs: (r.latency_ms as number) ?? null,
        createdAt: r.created_at as string,
      };
    });
  }
}
