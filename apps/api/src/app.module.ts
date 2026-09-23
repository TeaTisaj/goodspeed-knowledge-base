import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { AiModule } from './ai/ai.module.js';
import { ChatModule } from './chat/chat.module.js';
import { AllExceptionsFilter } from './common/all-exceptions.filter.js';
import { UserThrottlerGuard } from './common/user-throttler.guard.js';
import { ConfigModule } from './config/config.module.js';
import { DocumentsModule } from './documents/documents.module.js';
import { HealthController } from './health/health.controller.js';
import { IngestionModule } from './ingestion/ingestion.module.js';
import { SupabaseModule } from './supabase/supabase.module.js';

@Module({
  imports: [
    ConfigModule,
    SupabaseModule,
    AiModule,
    ThrottlerModule.forRoot({
      throttlers: [
        // Generous for CRUD; chat gets its own tighter limit at the route.
        { name: 'default', ttl: 60_000, limit: 120 },
      ],
    }),
    DocumentsModule,
    IngestionModule,
    ChatModule,
  ],
  controllers: [HealthController],
  providers: [
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_GUARD, useClass: UserThrottlerGuard },
  ],
})
export class AppModule {}
