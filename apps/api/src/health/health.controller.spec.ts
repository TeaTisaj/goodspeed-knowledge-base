import { Test } from '@nestjs/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { ConfigService } from '../config/config.service.js';
import { HealthController } from './health.controller.js';

/**
 * This is the M0 tooling spike as much as a unit test: it proves Nest's DI
 * container can read `design:paramtypes` from SWC-emitted decorator metadata
 * under Vitest. If this passes, the whole repo can use one test runner.
 */
describe('HealthController (DI under Vitest)', () => {
  let controller: HealthController;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        {
          provide: ConfigService,
          useValue: new ConfigService({
            SUPABASE_URL: 'http://127.0.0.1:54321',
            SUPABASE_PUBLISHABLE_KEY: 'pub',
            SUPABASE_SECRET_KEY: 'secret',
            DATABASE_URL: 'postgresql://postgres:postgres@127.0.0.1:54322/postgres',
          } as NodeJS.ProcessEnv),
        },
      ],
    }).compile();

    controller = moduleRef.get(HealthController);
  });

  it('resolves the controller through the DI container', () => {
    expect(controller).toBeInstanceOf(HealthController);
  });

  it('injects ConfigService rather than leaving it undefined', () => {
    const body = controller.check();
    expect(body.status).toBe('ok');
    expect(body.embeddingDimensions).toBe(1536);
  });

  /**
   * The UI renders a degraded-mode banner from these two flags. They are
   * computed here, not in the browser, so that "what counts as degraded" has
   * exactly one definition -- and so a second stub provider cannot appear
   * without this test being the thing that fails.
   */
  it('reports the zero-key default as degraded on both axes', () => {
    const body = controller.check();
    expect(body.answersGenerated).toBe(false);
    expect(body.retrievalSemantic).toBe(false);
  });

  it('reports a real provider as not degraded', async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        {
          provide: ConfigService,
          useValue: new ConfigService({
            SUPABASE_URL: 'http://127.0.0.1:54321',
            SUPABASE_PUBLISHABLE_KEY: 'pub',
            SUPABASE_SECRET_KEY: 'secret',
            DATABASE_URL: 'postgresql://postgres:postgres@127.0.0.1:54322/postgres',
            AI_CHAT_PROVIDER: 'groq',
            AI_CHAT_API_KEY: 'gsk_test',
            AI_EMBEDDING_PROVIDER: 'openai',
            AI_EMBEDDING_API_KEY: 'sk-test',
          } as NodeJS.ProcessEnv),
        },
      ],
    }).compile();

    const body = moduleRef.get(HealthController).check();
    expect(body.answersGenerated).toBe(true);
    expect(body.retrievalSemantic).toBe(true);
  });

  it('never reports a credential', () => {
    // The endpoint is unauthenticated, so this is the test that keeps it safe
    // to leave that way as fields are added.
    expect(JSON.stringify(controller.check())).not.toMatch(/secret|sk-|gsk_|key/i);
  });
});
