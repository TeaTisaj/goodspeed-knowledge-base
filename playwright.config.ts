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
    // `localhost`, not `127.0.0.1`. Next's dev client bootstraps over a
    // WebSocket whose handshake fails on the numeric host, and the page then
    // serves HTML that never hydrates -- so every click is silently a no-op and
    // the suite times out on an app that looks fine in a screenshot.
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:3000',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  /**
   * Starts the stack when it is not already up, so `pnpm test:e2e` works from a
   * clean clone instead of timing out against nothing.
   *
   * Two entries because the API compiles for several seconds after Next is
   * already serving; each is awaited at its own readiness URL.
   *
   * Both go through turbo so the shared workspace packages are built first.
   */
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : [
        {
          name: 'api',
          command: 'pnpm exec turbo run dev --filter=@kb/api',
          url: 'http://localhost:3001/health',
          reuseExistingServer: !process.env.CI,
          timeout: 180_000,
          stdout: 'pipe',
          stderr: 'pipe',
        },
        {
          name: 'web',
          command: 'pnpm exec turbo run dev --filter=@kb/web',
          url: 'http://localhost:3000/login',
          reuseExistingServer: !process.env.CI,
          timeout: 180_000,
          stdout: 'pipe',
          stderr: 'pipe',
        },
      ],
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
