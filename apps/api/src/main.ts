import 'reflect-metadata';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { ConfigService } from './config/config.service.js';

/**
 * Load .env using Node's built-in loader rather than dotenv.
 *
 * `process.loadEnvFile` is native from Node 20.12/21.7, and this project already
 * pins Node 24 — so a dependency (and its transitive surface) buys nothing here.
 * Absent file is normal: in production the platform injects real env vars.
 */
function loadDotEnv(): void {
  for (const candidate of ['.env', '../../.env']) {
    const path = resolve(process.cwd(), candidate);
    if (existsSync(path)) {
      process.loadEnvFile(path);
      return;
    }
  }
}

async function bootstrap(): Promise<void> {
  loadDotEnv();

  const app = await NestFactory.create(AppModule);
  const config = app.get(ConfigService);

  app.enableCors({ origin: config.env.CORS_ORIGIN, credentials: true });
  app.enableShutdownHooks();

  await app.listen(config.env.PORT);
  console.warn(`API listening on http://localhost:${config.env.PORT}`);
}

void bootstrap();
