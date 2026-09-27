import nextVitals from 'eslint-config-next/core-web-vitals';
import tseslint from 'typescript-eslint';
import base from './base.js';

/** Next's own rules (React, hooks, a11y, Core Web Vitals) on top of the shared base. */
export default tseslint.config(...nextVitals, ...base, {
  // eslint-plugin-react's version detection calls an API ESLint 10 removed.
  settings: { react: { version: '19' } },
});
