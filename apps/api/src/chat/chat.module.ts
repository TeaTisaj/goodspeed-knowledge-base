import { Module } from '@nestjs/common';
import { RetrievalModule } from '../retrieval/retrieval.module.js';
import { ChatController } from './chat.controller.js';
import { ChatService } from './chat.service.js';
import { ConversationsService } from './conversations.service.js';

@Module({
  imports: [RetrievalModule],
  controllers: [ChatController],
  providers: [ChatService, ConversationsService],
})
export class ChatModule {}
