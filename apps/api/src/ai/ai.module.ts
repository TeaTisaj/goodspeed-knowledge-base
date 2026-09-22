import { Global, Module } from '@nestjs/common';
import { AiService } from './ai.service.js';
import { PostgresEmbeddingCache } from './embedding-cache.store.js';

@Global()
@Module({
  providers: [PostgresEmbeddingCache, AiService],
  exports: [AiService],
})
export class AiModule {}
