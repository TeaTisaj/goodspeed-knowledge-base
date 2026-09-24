import 'reflect-metadata';
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
  // Enables the `schema` option on @Body/@Query/@Param across every controller.
  app.useGlobalPipes(new StandardSchemaValidationPipe({ transform: true }));
  app.enableShutdownHooks();

  await app.listen(config.env.PORT);
  new Logger('Bootstrap').log(`API listening on http://localhost:${config.env.PORT}`);
}

void bootstrap();
