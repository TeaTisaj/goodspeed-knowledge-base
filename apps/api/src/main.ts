import 'reflect-metadata';
import type { ServerResponse } from 'node:http';
import { Logger, StandardSchemaValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';
import { loadDotEnv } from './load-env.js';
import { ConfigService } from './config/config.service.js';

async function bootstrap(): Promise<void> {
  loadDotEnv();

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
    bodyParser: false,
  });
  const config = app.get(ConfigService);

  // Sized to the document contract (1M characters), not Express's 100 kB default;
  // Zod enforces the user-facing limit.
  app.useBodyParser('json', { limit: '4mb' });

  app.enableCors({
    origin: config.env.CORS_ORIGIN.split(',').map((o) => o.trim()),
    credentials: true,
  });

  // Security headers for a JSON-only API; four headers do not justify helmet.
  app.use((_req: unknown, res: ServerResponse, next: () => void) => {
    // The API only ever answers with JSON, so a browser must never be talked
    // into interpreting a response as script.
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    // Nothing here is meant to be embedded or rendered; an empty CSP is the
    // strictest correct answer for a pure JSON surface.
    res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    next();
  });
  // Enables the `schema` option on @Body/@Query/@Param across every controller.
  app.useGlobalPipes(new StandardSchemaValidationPipe({ transform: true }));
  app.enableShutdownHooks();

  await app.listen(config.env.PORT);
  new Logger('Bootstrap').log(`API listening on http://localhost:${config.env.PORT}`);
}

void bootstrap();
