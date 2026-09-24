import { defineConfig } from 'vitest/config';

/**
 * The live suite is a separate project on purpose.
 *
 * `pnpm test` must stay hermetic -- no network, no keys, no spend -- so the
 * live specs live outside `src/**` and are unreachable from the default
 * include. Running them is an explicit `pnpm test:live`.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['live/**/*.spec.ts'],
    // Real endpoints, cold model loads and rate limits: the default 5s would
    // fail on latency rather than on behaviour.
    testTimeout: 180_000,
    hookTimeout: 60_000,
    // Providers are independent, but free tiers are per-account rate limits and
    // parallel files turn one slow provider into everyone's 429.
    fileParallelism: false,
    sequence: { concurrent: false },
    retry: 0,
  },
});
