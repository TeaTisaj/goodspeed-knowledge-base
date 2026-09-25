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

  /**
   * Sized to the contract, not to Express's default.
   *
   * The default JSON limit is 100 kB, while the document contract allows a
   * million characters -- so every document between the two failed, and as a
   * 500, because body-parser's error is not an HttpException. The contract's
   * limit counts characters; in UTF-8 with JSON escaping a million of them can
   * approach 4 MB, so the byte limit sits there and Zod enforces the real,
   * user-facing limit with a message that says what it is.
   */
  app.useBodyParser('json', { limit: '4mb' });

  app.enableCors({
    origin: config.env.CORS_ORIGIN.split(',').map((o) => o.trim()),
    credentials: true,
  });

  /**
   * Security headers, set directly rather than via helmet.
   *
   * This is a JSON API with no HTML responses and no cookies, so most of
   * helmet's defaults are inert here and its CSP would need disabling anyway.
   * Four headers actually earn their place; a dependency to set four headers is
   * a dependency to audit for no benefit.
   */
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
