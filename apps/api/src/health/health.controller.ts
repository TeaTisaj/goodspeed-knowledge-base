import { Controller, Get } from '@nestjs/common';
import { ConfigService } from '../config/config.service.js';

@Controller('health')
export class HealthController {
  constructor(private readonly config: ConfigService) {}

  @Get()
  check() {
    return {
      status: 'ok' as const,
      env: this.config.env.NODE_ENV,
      chatProvider: this.config.env.AI_CHAT_PROVIDER,
      embeddingProvider: this.config.env.AI_EMBEDDING_PROVIDER,
      embeddingDimensions: this.config.env.AI_EMBEDDING_DIMENSIONS,
    };
  }
}
