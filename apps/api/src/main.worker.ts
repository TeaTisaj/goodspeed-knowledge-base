import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { loadDotEnv } from './main.js';

/**
 * Standalone worker entrypoint.
 *
 * Identical module graph, no HTTP listener. This is the whole scaling story:
 * moving ingestion off the API boxes is a deployment change (run this file
 * instead, set WORKER_MODE=standalone), not a rewrite.
 */
async function bootstrapWorker(): Promise<void> {
  loadDotEnv();
  const app = await NestFactory.createApplicationContext(AppModule, { bufferLogs: true });
  app.enableShutdownHooks();
  new Logger('Worker').log('Ingestion worker running (no HTTP listener)');
}

void bootstrapWorker();
