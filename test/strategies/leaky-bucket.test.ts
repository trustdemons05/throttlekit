/**
 * Leaky Bucket shaper strategy tests.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createLeakyBucket, QueueFullError } from '../../src/strategies/leaky-bucket.js';
import { ManualClock } from '../helpers/manual-clock.js';

describe('Leaky Bucket shaper', () => {
  // -----------------------------------------------------------------------
  // QueueFullError
  // -----------------------------------------------------------------------
  describe('QueueFullError', () => {
    it('is an Error with retryAfterMs', () => {
      const err = new QueueFullError('too full', 500);
      expect(err).toBeInstanceOf(Error);
      expect(err.message).toBe('too full');
      expect(err.retryAfterMs).toBe(500);
    });
  });

  // -----------------------------------------------------------------------
  // reserveSync
  // -----------------------------------------------------------------------
  describe('reserveSync', () => {
    let clock: ManualClock;
    let shaper: ReturnType<typeof createLeakyBucket>;

    beforeEach(() => {
      clock = new ManualClock(1000);
      shaper = createLeakyBucket({ ratePerSec: 2, maxQueueMs: 1000, clock });
    });

    it('accepts first request immediately', () => {
      const result = shaper.reserveSync('key', 1);
      expect(result.accepted).toBe(true);
      expect(result.delayMs).toBe(0);
    });

    it('calculates delay for subsequent requests', () => {
      // First request: no delay
      shaper.reserveSync('key', 1);
      // Second request: should have delay = 500ms (1/2 sec * 1000)
      const result = shaper.reserveSync('key', 1);
      expect(result.accepted).toBe(true);
      expect(result.delayMs).toBe(500);
    });

    it('rejects when queue is full', () => {
      // Fill queue with requests at maxQueueMs
      // At ratePerSec=2, each request adds 500ms drain time
      // So after 3 requests, delay = 1000ms — equals maxQueueMs (still accepted)
      // After 4 requests, delay = 1500ms > maxQueueMs = 1000 → rejected
      shaper.reserveSync('key', 1); // delay=0, next=1500
      shaper.reserveSync('key', 1); // delay=500, next=2000
      shaper.reserveSync('key', 1); // delay=1000, next=2500 — equals maxQueueMs, still accepted
      const r4 = shaper.reserveSync('key', 1); // delay=1500 > maxQueueMs
      expect(r4.accepted).toBe(false);
      expect(r4.retryAfterMs).toBeGreaterThan(0);
    });

    it('handles cost > 1 correctly', () => {
      // cost=2 at ratePerSec=2 => each request adds 1000ms drain time
      const r1 = shaper.reserveSync('key', 2);
      expect(r1.accepted).toBe(true);
      expect(r1.delayMs).toBe(0);

      const r2 = shaper.reserveSync('key', 2);
      expect(r2.accepted).toBe(true);
      expect(r2.delayMs).toBe(1000); // 2 / 2 * 1000 = 1000ms
    });

    it('tracks queue depth', () => {
      shaper.reserveSync('key', 1);
      const r = shaper.reserveSync('key', 1);
      expect(r.queueDepth).toBeGreaterThan(0);
    });

    it('tracks separate state per key', () => {
      // Fill up key-a; key-c should be completely fresh (never used)
      shaper.reserveSync('key-a', 1); // delay=0
      shaper.reserveSync('key-a', 1); // delay=500

      // key-c has never been used — should be fresh
      const fresh = shaper.reserveSync('key-c', 1);
      expect(fresh.delayMs).toBe(0);

      // key-a continues to be delayed
      const keyADelayed = shaper.reserveSync('key-a', 1);
      expect(keyADelayed.delayMs).toBeGreaterThan(0);
    });
  });

  // -----------------------------------------------------------------------
  // reserve (async)
  // -----------------------------------------------------------------------
  describe('reserve', () => {
    let clock: ManualClock;
    let shaper: ReturnType<typeof createLeakyBucket>;

    beforeEach(() => {
      clock = new ManualClock(1000);
      shaper = createLeakyBucket({ ratePerSec: 2, maxQueueMs: 1000, clock });
    });

    it('returns ShaperResult asynchronously', async () => {
      const result = await shaper.reserve('key', 1);
      expect(result.accepted).toBe(true);
    });

    it('returns accepted=false for queued requests beyond maxQueueMs', async () => {
      shaper.reserveSync('key', 1); // delay=0
      shaper.reserveSync('key', 1); // delay=500 
      shaper.reserveSync('key', 1); // delay=1000
      const result = await shaper.reserve('key', 1); // delay=1500 > maxQueueMs
      expect(result.accepted).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // schedule
  // -----------------------------------------------------------------------
  describe('schedule', () => {
    let clock: ManualClock;
    let shaper: ReturnType<typeof createLeakyBucket>;

    beforeEach(() => {
      clock = new ManualClock(1000);
      shaper = createLeakyBucket({ ratePerSec: 10, maxQueueMs: 500, clock });
    });

    it('resolves immediately for first request', async () => {
      vi.useFakeTimers();
      const start = Date.now();
      const promise = shaper.schedule('key', 1);
      await vi.advanceTimersByTimeAsync(0);
      await promise;
      expect(Date.now() - start).toBe(0);
      vi.useRealTimers();
    });

    it('throws QueueFullError when queue is full', async () => {
      // Fill up: at ratePerSec=10, each request = 100ms
      // maxQueueMs=500, so need 6 requests for delay>500ms
      shaper.reserveSync('key', 1); // delay=0
      shaper.reserveSync('key', 1); // delay=100
      shaper.reserveSync('key', 1); // delay=200
      shaper.reserveSync('key', 1); // delay=300
      shaper.reserveSync('key', 1); // delay=400
      shaper.reserveSync('key', 1); // delay=500, equals maxQueueMs, still accepted
      const r7 = shaper.reserveSync('key', 1); // delay=600 > maxQueueMs
      expect(r7.accepted).toBe(false);

      await expect(shaper.schedule('key', 1)).rejects.toThrow(QueueFullError);
    });

    it('delays by the correct amount', async () => {
      vi.useFakeTimers();

      shaper.reserveSync('key', 1); // delay=0
      const schedulePromise = shaper.schedule('key', 1); // should delay 100ms

      await vi.advanceTimersByTimeAsync(100);
      await expect(schedulePromise).resolves.toBeUndefined();

      vi.useRealTimers();
    });
  });

  // -----------------------------------------------------------------------
  // reset
  // -----------------------------------------------------------------------
  describe('reset', () => {
    it('clears state for a key', async () => {
      const clock = new ManualClock(1000);
      const shaper = createLeakyBucket({ ratePerSec: 2, maxQueueMs: 1000, clock });

      shaper.reserveSync('key', 1);
      shaper.reserveSync('key', 1);
      const beforeReset = shaper.reserveSync('key', 1);
      expect(beforeReset.delayMs).toBeGreaterThan(0);

      await shaper.reset('key');
      const afterReset = shaper.reserveSync('key', 1);
      expect(afterReset.delayMs).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // Edge cases
  // -----------------------------------------------------------------------
  describe('edge cases', () => {
    it('handles zero cost', () => {
      const clock = new ManualClock(1000);
      const shaper = createLeakyBucket({ ratePerSec: 2, maxQueueMs: 1000, clock });

      const result = shaper.reserveSync('key', 0);
      expect(result.accepted).toBe(true);
      expect(result.delayMs).toBe(0);
    });

    it('works with high rate', () => {
      const clock = new ManualClock(1000);
      const fast = createLeakyBucket({ ratePerSec: 1000, maxQueueMs: 100, clock });

      // 1000 requests/sec = 1ms per request. 
      // After 100 requests: delay = 100ms (equals maxQueueMs, still accepted)
      // After 101 requests: delay = 101ms > maxQueueMs (rejected)
      for (let i = 0; i < 101; i++) {
        const r = fast.reserveSync('key', 1);
        expect(r.accepted).toBe(true);
      }

      const overflow = fast.reserveSync('key', 1);
      expect(overflow.accepted).toBe(false);
    });
  });
});
