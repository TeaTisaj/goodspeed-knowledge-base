import { Body, Controller, Get, Param, Post, Req, Res, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  askSchema,
  type AskInput,
  type ChatMessage,
  type Conversation,
  type StreamEvent,
} from '@kb/contracts';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { SupabaseAuthGuard, type AuthenticatedUser } from '../common/auth.guard.js';
import { CurrentUser } from '../common/current-user.decorator.js';
import { ChatService } from './chat.service.js';
import { ConversationsService } from './conversations.service.js';

const uuidParam = z.uuid('Invalid id');

@Controller('chat')
@UseGuards(SupabaseAuthGuard)
export class ChatController {
  constructor(
    private readonly chat: ChatService,
    private readonly conversations: ConversationsService,
  ) {}

  /**
   * Streams an answer as SSE on the raw response: `X-Accel-Buffering: no` for
   * proxies, no compression, and headers flushed immediately.
   */
  @Post('ask')
  // Chat is far more expensive than CRUD, so it gets its own tighter bucket.
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  async ask(
    @CurrentUser() user: AuthenticatedUser,
    @Body({ schema: askSchema }) body: AskInput,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    // Cancels the upstream provider call when the browser goes away, so an
    // abandoned tab does not keep burning tokens.
    const controller = new AbortController();
    req.on('close', () => controller.abort());

    const send = (event: StreamEvent): void => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    try {
      for await (const event of this.chat.ask({
        accessToken: user.accessToken,
        userId: user.id,
        question: body.question,
        conversationId: body.conversationId,
        tags: body.tags,
        documentIds: body.documentIds,
        signal: controller.signal,
      })) {
        if (res.writableEnded) break;
        send(event);
      }
    } catch {
      // The raw message is not forwarded: it can carry a provider response
      // body or a database error, neither of which the browser should see.
      // ChatService logs the detail before this point.
      if (!res.writableEnded) {
        send({ type: 'error', code: 'internal_error', message: 'Stream failed.' });
      }
    } finally {
      if (!res.writableEnded) res.end();
    }
  }

  @Get('conversations')
  listConversations(@CurrentUser() user: AuthenticatedUser): Promise<Conversation[]> {
    return this.conversations.list(user.accessToken);
  }

  @Get('conversations/:id/messages')
  listMessages(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', { schema: uuidParam }) id: string,
  ): Promise<ChatMessage[]> {
    return this.conversations.messages(user.accessToken, id);
  }
}
