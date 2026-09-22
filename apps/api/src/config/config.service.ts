import { Injectable } from '@nestjs/common';
import { type Env, parseEnv } from './env.schema.js';

/**
 * Typed access to validated configuration.
 *
 * Deliberately not `@nestjs/config`'s ConfigService: that returns
 * `string | undefined` and pushes casting onto every call site. Here the Zod
 * schema has already coerced and narrowed, so `config.env.PORT` is a number.
 */
@Injectable()
export class ConfigService {
  readonly env: Env;

  constructor(raw: NodeJS.ProcessEnv = process.env) {
    this.env = parseEnv(raw);
  }

  get isProduction(): boolean {
    return this.env.NODE_ENV === 'production';
  }

  /** True when no real credentials are configured — drives the zero-key demo path. */
  get isFullyFake(): boolean {
    return this.env.AI_CHAT_PROVIDER === 'fake' && this.env.AI_EMBEDDING_PROVIDER === 'fake';
  }
}
