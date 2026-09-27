/**
 * Loads .env with Node's built-in loader. Its own module, not an export of
 * `main.ts`, because importing `main.ts` starts the HTTP server.
 *
 * A missing file is normal: production injects real environment variables.
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
