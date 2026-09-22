import tseslint from 'typescript-eslint';
import { base } from './base.js';

/**
 * NestJS overrides.
 *
 * `consistent-type-imports` is disabled deliberately, and this is not a style
 * preference. With `emitDecoratorMetadata`, Nest reads constructor parameter
 * types at runtime via `design:paramtypes`. A class that appears only in a type
 * position still has to be a *value* import, because rewriting it to
 * `import type` erases the reference and the DI container then resolves the
 * dependency to `undefined` — at runtime, with no compile error. Running
 * `eslint --fix` with this rule on would silently break every injected service.
 */
export default tseslint.config(...base, {
  files: ['**/*.ts'],
  rules: {
    '@typescript-eslint/consistent-type-imports': 'off',
    '@typescript-eslint/no-useless-constructor': 'off',
    '@typescript-eslint/no-extraneous-class': 'off',
  },
});
