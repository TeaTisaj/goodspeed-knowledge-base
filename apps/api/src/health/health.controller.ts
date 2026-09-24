import { Controller, Get } from '@nestjs/common';
import type { Health } from '@kb/contracts';
import { ConfigService } from '../config/config.service.js';

@Controller('health')
export class HealthController {
  constructor(private readonly config: ConfigService) {}

  /**
   * Unauthenticated on purpose: the web app reads this before anyone signs in,
   * and it reports configuration shape, never configuration secrets.
   */
  @Get()
  check(): Health {
    return {
      status: 'ok' as const,
      env: this.config.env.NODE_ENV,
      chatProvider: this.config.env.AI_CHAT_PROVIDER,
      embeddingProvider: this.config.env.AI_EMBEDDING_PROVIDER,
      embeddingDimensions: this.config.env.AI_EMBEDDING_DIMENSIONS,
      // Decided here rather than in the browser. The UI should render a claim
      // the server made, not re-derive it by string-matching on 'fake'.
      answersGenerated: this.config.env.AI_CHAT_PROVIDER !== 'fake',
      retrievalSemantic: this.config.env.AI_EMBEDDING_PROVIDER !== 'fake',
    };
  }
}
