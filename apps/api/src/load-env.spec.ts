import { describe, expect, it } from 'vitest';

/**
 * Guards a side-effect-on-import regression.
 *
 * `loadDotEnv` used to live in `main.ts`, so the worker entrypoint importing it
 * also executed `main.ts`'s top-level `bootstrap()` -- starting an HTTP server
 * and crashing on EADDRINUSE. The "worker with no HTTP listener" claim was
 * false, and only importing it in a real process revealed that.
 */
describe('load-env module', () => {
  it('can be imported without starting a server or any other side effect', async () => {
    const before = process.env.PORT;
    const mod = await import('./load-env.js');

    expect(typeof mod.loadDotEnv).toBe('function');
    // Importing must not have run anything: no listener, no env mutation.
    expect(process.env.PORT).toBe(before);
  });

  it('exports only the loader, so it cannot grow a bootstrap', async () => {
    const mod = await import('./load-env.js');
    expect(Object.keys(mod)).toEqual(['loadDotEnv']);
  });
});
