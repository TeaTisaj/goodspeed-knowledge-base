import tseslint from 'typescript-eslint';
import { base } from './base.js';

export default tseslint.config(...base, {
  files: ['**/*.{ts,tsx}'],
  rules: {
    // Next's App Router uses default exports for pages/layouts.
    'import/no-default-export': 'off',
  },
});
