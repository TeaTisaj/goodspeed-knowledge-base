import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// SWC transforms with `decoratorMetadata` so Nest's DI container can read
// design:paramtypes. Without this, @Injectable classes resolve to undefined.
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.spec.ts', 'test/**/*.spec.ts'],
    root: './',
  },
  plugins: [
    swc.vite({
      module: { type: 'es6' },
      jsc: {
        target: 'es2023',
        parser: { syntax: 'typescript', decorators: true },
        transform: { legacyDecorator: true, decoratorMetadata: true },
      },
    }),
  ],
});
