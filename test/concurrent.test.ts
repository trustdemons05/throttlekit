/**
 * End-to-end concurrency tests for ThrottleKit.
 *
 * Covers:
 *   1. Strategy-level concurrency (sync, same timestamp) for all 4 strategies
 *   2. Store-level concurrency (async, per-key mutex) via MemoryStore.apply()
 *   3. Integration concurrency (Limiter + Store)
 */

import { describe, it, expect } from 'vitest';
import { ManualClock } from './helpers/manual-clock.js';
import { runConcurrent, simulateConcurrentSync } from './helpers/concurrent.js';
import { createTokenBucketStrategy } from '../src/strategies/token-bucket.js';
import { createFixedWindowStrategy } from '../src/strategies/fixed-window.js';
import { createSlidingLogStrategy } from '../src/strategies/sliding-window-log.js';
import { createSlidingCounterStrategy } from '../src/strategies/sliding-window-counter.js';
import { MemoryStore } from '../src/stores/memory-store.js';
import { fixedWindow } from '../src/core/factories.js';

// ---------------------------------------------------------------------------
// Strategy-level concurrency (synchronous, same timestamp)
// ---------------------------------------------------------------------------

describe('strategy-level concurrency', () => {
  it.each([
    ['token-bucket', (l: number, c: ManualClock) =>
      createTokenBucketStrategy({ capacity: l, refillRate: 999_999, clock: c })],
    ['fixed-window', (l: number, c: ManualClock) =>
      createFixedWindowStrategy({ limit: l, windowMs: 60_000, clock: c })],
    ['sliding-window-log', (l: number, c: ManualClock) =>
      createSlidingLogStrategy({ limit: l, windowMs: 60_000, clock: c })],
    ['sliding-window-counter', (l: number, c: ManualClock) =>
      createSlidingCounterStrategy({ limit: l, windowMs: 60_000, clock: c })],
  ])('%s: exactly K of N concurrent requests allowed', (_name, factory) => {
    const clock = new ManualClock(1_000_000_000_000);
    const strategy = factory(50, clock);
    const results = simulateConcurrentSync(() => strategy.apply('key', 1), 100);
    expect(results.filter(r => r.allowed).length).toBe(50);
    expect(results.filter(r => !r.allowed).length).toBe(50);
  });
});

// ---------------------------------------------------------------------------
// Store-level concurrency (async, per-key mutex)
// ---------------------------------------------------------------------------

describe('MemoryStore per-key mutex', () => {
  it('exactly K of N concurrent apply() calls succeed', async () => {
    const clock = new ManualClock(1_000_000_000_000);
    const store = new MemoryStore({ clock });
    const LIMIT = 50;
    const results = await runConcurrent(() => store.apply('key', 60_000, (prev: { count: number } | null) => {
      const count = prev?.count ?? 0;
      if (count >= LIMIT) return { state: prev ?? { count }, result: { rejected: true } };
      return { state: { count: count + 1 }, result: { rejected: false } };
    }), 200);
    const succeeded = results.filter((r: any) => !r.rejected).length;
    expect(succeeded).toBe(LIMIT);
  });
});

// ---------------------------------------------------------------------------
// Integration concurrency (Limiter + Store)
// ---------------------------------------------------------------------------

describe('Limiter + Store integration', () => {
  it('200 concurrent requests → exactly 100 allowed', async () => {
    const clock = new ManualClock(1_000_000_000_000);
    const limiter = fixedWindow({ limit: 100, windowMs: 60_000, clock });
    const results = await runConcurrent(() => limiter.check('integration-key', 1), 200);
    expect(results.filter(r => r.allowed).length).toBe(100);
  });
});
