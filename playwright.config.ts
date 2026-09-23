import { defineConfig, devices } from '@playwright/test';

/**
 * One happy-path smoke test.
 *
 * Deliberately not a broad suite: unit and integration tests already cover
 * chunking, retrieval, permissions and the provider interface. What they cannot
 * prove is that the whole loop works in a real browser -- sign in, create a
 * document, wait for ingestion, ask a question, see a streamed answer with a
 * clickable citation. That is what this covers.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 90_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3000',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
