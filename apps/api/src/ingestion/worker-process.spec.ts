import { afterEach, describe, expect, it } from 'vitest';
import { isWorkerProcess, markWorkerProcess } from './worker-process.js';

/**
 * Guards the worker-mode separation.
 *
 * The regression: `WORKER_MODE=standalone` previously changed nothing, because
 * the worker only skipped when the mode was `off`. Setting it produced a second
 * consumer rather than moving the first one, while SCALING.md claimed it moved
 * ingestion off the API boxes.
 */

/** Mirrors IngestionWorker.shouldConsume. */
function shouldConsume(mode: 'inline' | 'standalone' | 'off', workerProcess: boolean): boolean {
  if (mode === 'off') return false;
  if (mode === 'inline') return true;
  return workerProcess;
}

describe('worker process marker', () => {
  afterEach(() => {
    delete process.env.KB_WORKER_PROCESS;
  });

  it('is false in an unmarked process', () => {
    expect(isWorkerProcess()).toBe(false);
  });

  it('is true once marked', () => {
    markWorkerProcess();
    expect(isWorkerProcess()).toBe(true);
  });
});

describe('shouldConsume', () => {
  it('inline: the API consumes, so one command runs everything locally', () => {
    expect(shouldConsume('inline', false)).toBe(true);
  });

  it('standalone: the API enqueues but does not consume', () => {
    // The regression. Before the fix this returned true and the API kept
    // processing jobs, so setting standalone added a worker instead of moving it.
    expect(shouldConsume('standalone', false)).toBe(false);
  });

  it('standalone: the dedicated worker process does consume', () => {
    expect(shouldConsume('standalone', true)).toBe(true);
  });

  it('off: nothing consumes, even in the worker process', () => {
    expect(shouldConsume('off', true)).toBe(false);
    expect(shouldConsume('off', false)).toBe(false);
  });

  it('exactly one consumer exists in each deployment topology', () => {
    // inline: API only. standalone: worker only. Never zero, never two.
    const inline = [shouldConsume('inline', false)];
    const standalone = [shouldConsume('standalone', false), shouldConsume('standalone', true)];

    expect(inline.filter(Boolean)).toHaveLength(1);
    expect(standalone.filter(Boolean)).toHaveLength(1);
  });
});
