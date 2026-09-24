import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { markWorkerProcess } from './ingestion/worker-process.js';
import { loadDotEnv } from './load-env.js';

/**
 * Standalone worker entrypoint.
 *
 * Identical module graph, no HTTP listener. This is the whole scaling story:
 * moving ingestion off the API boxes is a deployment change (run this file
 * instead, set WORKER_MODE=standalone), not a rewrite.
 */
async function bootstrapWorker(): Promise<void> {
  // Must happen before the module graph is built, so IngestionWorker sees it.
  markWorkerProcess();
  loadDotEnv();
  const app = await NestFactory.createApplicationContext(AppModule, { bufferLogs: true });
  app.enableShutdownHooks();
  new Logger('Worker').log('Ingestion worker running (no HTTP listener)');
  // Keeps the process alive: there is no server holding the event loop open.
  await new Promise(() => {});
}

void bootstrapWorker();
