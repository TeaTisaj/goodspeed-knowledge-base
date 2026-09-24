import { describe, expect, it } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { UsageEvent } from '@kb/ai';

/**
 * Guards usage attribution under concurrency.
 *
 * The regression: usage events were pushed into one array on the AiService
 * singleton and drained per request. With two users answering at the same time
 * their pushes interleave, and whichever request drained first took the other's
 * tokens -- silently, into billing-adjacent numbers.
 *
 * This mirrors `AiService`'s scoping rather than booting Nest, so it stays a
 * fast offline unit test. The behaviour under test is async-local propagation
 * across awaits and across an async generator's yields, which is exactly what
 * the real code relies on.
 */

class UsageScopeHarness {
  private readonly scope = new AsyncLocalStorage<UsageEvent[]>();
  orphaned = 0;

  /** Mirrors AiService.recordUsage. */
  record(event: UsageEvent): void {
    const bucket = this.scope.getStore();
    if (bucket) bucket.push(event);
    else this.orphaned += 1;
  }

  /** Mirrors AiService.beginUsageScope. */
  begin(): UsageEvent[] {
    const events: UsageEvent[] = [];
    this.scope.enterWith(events);
    return events;
  }
}

function event(model: string): UsageEvent {
  return {
    operation: 'embed',
    providerId: 'fake',
    model,
    promptTokens: 1,
    completionTokens: 0,
    totalTokens: 1,
    estimatedCostUsd: 0,
    latencyMs: 1,
  } as UsageEvent;
}

const tick = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('request-scoped usage attribution', () => {
  it('keeps two concurrent requests from stealing each other’s events', async () => {
    const harness = new UsageScopeHarness();

    // Deliberately interleaved: each request awaits between its two calls, so
    // the other request runs in between. A shared buffer fails this.
    async function request(model: string, delay: number): Promise<UsageEvent[]> {
      const events = harness.begin();
      harness.record(event(model));
      await tick(delay);
      harness.record(event(model));
      return events;
    }

    const [a, b] = await Promise.all([request('model-a', 20), request('model-b', 5)]);

    expect(a).toHaveLength(2);
    expect(b).toHaveLength(2);
    expect(a.every((e) => e.model === 'model-a')).toBe(true);
    expect(b.every((e) => e.model === 'model-b')).toBe(true);
    expect(harness.orphaned).toBe(0);
  });

  it('survives yields, so a streamed answer accumulates into its own bucket', async () => {
    const harness = new UsageScopeHarness();

    // Shaped like ChatService.ask: an async generator that opens a scope, then
    // records across several yields while the consumer drives it.
    async function* answer(model: string): AsyncGenerator<string, UsageEvent[]> {
      const events = harness.begin();
      harness.record(event(model));
      yield 'first';
      await tick(10);
      harness.record(event(model));
      yield 'second';
      harness.record(event(model));
      return events;
    }

    async function drain(model: string, delay: number): Promise<UsageEvent[]> {
      const gen = answer(model);
      let next = await gen.next();
      while (!next.done) {
        await tick(delay);
        next = await gen.next();
      }
      return next.value;
    }

    const [a, b] = await Promise.all([drain('model-a', 7), drain('model-b', 3)]);

    expect(a.map((e) => e.model)).toEqual(['model-a', 'model-a', 'model-a']);
    expect(b.map((e) => e.model)).toEqual(['model-b', 'model-b', 'model-b']);
    expect(harness.orphaned).toBe(0);
  });

  it('counts events emitted outside any scope instead of misattributing them', () => {
    const harness = new UsageScopeHarness();
    harness.record(event('stray'));
    expect(harness.orphaned).toBe(1);
  });
});
