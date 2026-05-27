import { describe, it, expect } from 'vitest';
import { fixedWindow } from '../../src/core/factories.js';
import { ManualClock } from '../../src/core/clock.js';
import { MemoryStore } from '../../src/stores/memory-store.js';
import { withAnalytics } from '../../src/analytics/index.js';
import type { AnalyticsLimiter } from '../../src/analytics/types.js';

/**
 * Helper: create a fixed-window limiter with analytics.
 * Uses ManualClock + MemoryStore for deterministic testing.
 */
function createAnalyticsLimiter(
  limit: number,
  windowMs: number,
  topK?: number,
): { limiter: AnalyticsLimiter; clock: ManualClock } {
  const clock = new ManualClock(1000000);
  const store = new MemoryStore({ clock });

  const baseLimiter = fixedWindow({
    limit,
    windowMs,
    clock,
    store,
  });

  const limiter = withAnalytics(baseLimiter, topK !== undefined ? { topK } : undefined);
  return { limiter, clock };
}

describe('withAnalytics', () => {
  it('wraps a limiter and counts allow/deny', async () => {
    const { limiter, clock } = createAnalyticsLimiter(3, 1000);

    // All requests should be allowed initially
    const r1 = await limiter.check('key-a');
    expect(r1.allowed).toBe(true);
    const r2 = await limiter.check('key-a');
    expect(r2.allowed).toBe(true);
    const r3 = await limiter.check('key-a');
    expect(r3.allowed).toBe(true);

    // Fourth should be denied (limit=3)
    const r4 = await limiter.check('key-a');
    expect(r4.allowed).toBe(false);
    // But after window expires they should reset, so let's not test that here

    const snapshot = limiter.analytics();
    expect(snapshot.allowed).toBe(3);
    expect(snapshot.denied).toBe(1);
    expect(snapshot.total).toBe(4);
  });

  it('denyRate is accurate', async () => {
    const { limiter, clock } = createAnalyticsLimiter(2, 1000);

    // Allow 2, deny 2
    const r1 = await limiter.check('key-b');
    expect(r1.allowed).toBe(true);
    const r2 = await limiter.check('key-b');
    expect(r2.allowed).toBe(true);
    const r3 = await limiter.check('key-b');
    expect(r3.allowed).toBe(false);
    const r4 = await limiter.check('key-b');
    expect(r4.allowed).toBe(false);

    const snapshot = limiter.analytics();
    expect(snapshot.denyRate).toBe(0.5); // 2 denied / 4 total
  });

  it('topRequested tracks the most-checked keys', async () => {
    const { limiter, clock } = createAnalyticsLimiter(5, 1000);

    // Make many requests to different keys
    await limiter.check('key-a');
    await limiter.check('key-a');
    await limiter.check('key-a');
    await limiter.check('key-b');
    await limiter.check('key-b');
    await limiter.check('key-c');

    // Force a 4th request to key-b (denied) to have 2 deny entries
    await limiter.check('key-a');
    await limiter.check('key-a');
    await limiter.check('key-a');

    const snapshot = limiter.analytics();
    expect(snapshot.topRequested.length).toBeGreaterThan(0);

    // 'key-a' should be #1 most requested
    const top1 = snapshot.topRequested[0]!;
    expect(top1).toBeDefined();
    expect(top1.key).toBe('key-a');
  });

  it('topDenied tracks the most-denied keys', async () => {
    const { limiter } = createAnalyticsLimiter(2, 1000);

    // Exhaust capacity for key-a (2 requests), then deny
    await limiter.check('key-a');
    await limiter.check('key-a');
    await limiter.check('key-a'); // denied
    await limiter.check('key-a'); // denied

    // Also exhaust key-b
    await limiter.check('key-b');
    await limiter.check('key-b');
    await limiter.check('key-b'); // denied

    const snapshot = limiter.analytics();
    expect(snapshot.topDenied.length).toBeGreaterThan(0);

    // 'key-a' should be #1 in topDenied (2 denials)
    const top1 = snapshot.topDenied[0]!;
    expect(top1).toBeDefined();
    expect(top1.key).toBe('key-a');
  });

  it('resetAnalytics clears all state', async () => {
    const { limiter } = createAnalyticsLimiter(3, 1000);

    await limiter.check('key-a');
    await limiter.check('key-b');
    await limiter.check('key-a');

    expect(limiter.analytics().total).toBe(3);

    limiter.resetAnalytics();

    const snapshot = limiter.analytics();
    expect(snapshot.allowed).toBe(0);
    expect(snapshot.denied).toBe(0);
    expect(snapshot.total).toBe(0);
    expect(snapshot.topRequested).toHaveLength(0);
    expect(snapshot.topDenied).toHaveLength(0);
  });

  it('underlying limiter decisions are unchanged', async () => {
    const { limiter, clock } = createAnalyticsLimiter(1, 1000);

    // First request (limit=1): should be allowed
    const r1 = await limiter.check('key-c');
    expect(r1.allowed).toBe(true);

    // Second request: should be denied
    const r2 = await limiter.check('key-c');
    expect(r2.allowed).toBe(false);

    // Third request: still denied
    const r3 = await limiter.check('key-c');
    expect(r3.allowed).toBe(false);
  });

  it('peek does not count as a request', async () => {
    const { limiter } = createAnalyticsLimiter(5, 1000);

    // Peek should not count
    const result = await limiter.peek('key-d');
    expect(result).toBeDefined();

    const snapshot = limiter.analytics();
    expect(snapshot.total).toBe(0); // no checks counted
  });
});