import 'reflect-metadata';
import type { ServerResponse } from 'node:http';
import { Logger, StandardSchemaValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { loadDotEnv } from './load-env.js';
import { ConfigService } from './config/config.service.js';

async function bootstrap(): Promise<void> {
  loadDotEnv();

  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  const config = app.get(ConfigService);

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
