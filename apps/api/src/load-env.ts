/**
 * Loads .env using Node's built-in loader.
 *
 * Deliberately its own module rather than an export from `main.ts`: importing
 * `main.ts` executes its top-level `bootstrap()`, so the worker entrypoint
 * importing a helper from it also started an HTTP server and crashed on
 * EADDRINUSE. A module with a side effect must never also be a utility module.
 *
 * `process.loadEnvFile` is native from Node 20.12 and this project pins Node 24,
 * so dotenv buys nothing. A missing file is normal: production injects real
 * environment variables.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

export function loadDotEnv(): void {
  for (const candidate of ['.env', '../../.env']) {
    const path = resolve(process.cwd(), candidate);
    if (existsSync(path)) {
      process.loadEnvFile(path);
      return;
    }
  }
}
