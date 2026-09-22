import 'reflect-metadata';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Logger, StandardSchemaValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { ConfigService } from './config/config.service.js';

/**
 * Loads .env with Node's built-in loader rather than dotenv. Native since Node
 * 20.12, and this project pins Node 24, so the dependency buys nothing.
 * A missing file is normal: production injects real environment variables.
 */
export function loadDotEnv(): void {
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

  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  const config = app.get(ConfigService);

  app.enableCors({
    origin: config.env.CORS_ORIGIN.split(',').map((o) => o.trim()),
    credentials: true,
  });
  // Enables the `schema` option on @Body/@Query/@Param across every controller.
  app.useGlobalPipes(new StandardSchemaValidationPipe({ transform: true }));
  app.enableShutdownHooks();

  await app.listen(config.env.PORT);
  new Logger('Bootstrap').log(`API listening on http://localhost:${config.env.PORT}`);
}

void bootstrap();
