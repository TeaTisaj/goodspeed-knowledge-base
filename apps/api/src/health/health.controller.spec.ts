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
});
