import { defineConfig } from 'vitest/config';

// Node environment and server rendering: the tests assert on the markup a
// component produces, which needs no DOM.
export default defineConfig({
  // tsconfig says `jsx: preserve` because Next compiles JSX itself; Vitest has to.
  oxc: { jsx: { runtime: 'automatic' } },
  resolve: { alias: { '@': new URL('./src', import.meta.url).pathname } },
  test: { globals: true, environment: 'node', include: ['src/**/*.spec.{ts,tsx}'] },
});
