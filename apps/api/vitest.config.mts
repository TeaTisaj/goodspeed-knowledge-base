import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// SWC transforms with `decoratorMetadata` so Nest's DI container can read
// design:paramtypes. Without it, @Injectable classes resolve to undefined.
const swcPlugin = swc.vite({
  module: { type: 'es6' },
  jsc: {
    target: 'es2023',
    parser: { syntax: 'typescript', decorators: true },
    transform: { legacyDecorator: true, decoratorMetadata: true },
  },
});

export default defineConfig({
  plugins: [swcPlugin],
  test: {
    globals: true,
    projects: [
      {
        test: {
          name: 'unit',
          environment: 'node',
          globals: true,
          include: ['src/**/*.spec.ts'],
        },
      },
      {
        // Integration tests need a running local Supabase. Kept out of the
        // default `test` run so unit tests stay fast and offline.
        test: {
          name: 'integration',
          environment: 'node',
          globals: true,
          include: ['test/**/*.integration.spec.ts'],
          testTimeout: 30_000,
          hookTimeout: 60_000,
          fileParallelism: false,
        },
      },
    ],
  },
});
