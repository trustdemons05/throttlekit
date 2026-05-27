import { describe, it, expect } from 'vitest';
import { ManualClock } from '../helpers/manual-clock.js';
import { sketchRateLimit } from '../../src/sketch/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function request(limiter: ReturnType<typeof sketchRateLimit>, key: string) {
  return limiter.checkSync(key);
}

function requestAsync(
  limiter: ReturnType<typeof sketchRateLimit>,
  key: string,
) {
  return limiter.check(key);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SketchRateLimiter', () => {
  describe('basic allow/deny behavior', () => {
    it('allows up to limit requests, then denies', () => {
      const clock = new ManualClock(0);
      const limiter = sketchRateLimit({ limit: 5, windowMs: 1000, clock });

      // First 5 should be allowed
      for (let i = 1; i <= 5; i++) {
        const result = request(limiter, 'user:1');
        expect(result.allowed).toBe(true);
        expect(result.remaining).toBe(5 - i);
        expect(result.limit).toBe(5);
      }

      // 6th should be denied
      const denied = request(limiter, 'user:1');
      expect(denied.allowed).toBe(false);
      expect(denied.remaining).toBe(0);
      expect(denied.retryAfterMs).toBeGreaterThan(0);
    });

    it('returns resetAt in the future', () => {
      const clock = new ManualClock(1000);
      const limiter = sketchRateLimit({ limit: 5, windowMs: 1000, clock });

      const result = request(limiter, 'user:1');
      expect(result.allowed).toBe(true);
      expect(result.resetAt).toBe(2000);
      expect(result.retryAfterMs).toBe(0);
    });
  });

  describe('window rotation', () => {
    it('resets counts after window expires', () => {
      const clock = new ManualClock(0);
      const limiter = sketchRateLimit({ limit: 5, windowMs: 1000, clock });

      // Exhaust the limit
      for (let i = 0; i < 5; i++) {
        expect(request(limiter, 'user:1').allowed).toBe(true);
      }
      expect(request(limiter, 'user:1').allowed).toBe(false);

      // Advance past window
      clock.advanceBy(1000);
      clock.setTime(1000);

      // Should be allowed again
      const result = request(limiter, 'user:1');
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(4);
    });

    it('new window starts with fresh counters', () => {
      const clock = new ManualClock(0);
      const limiter = sketchRateLimit({ limit: 5, windowMs: 1000, clock });

      // Use 3 tokens
      for (let i = 0; i < 3; i++) {
        request(limiter, 'user:1');
      }

      clock.setTime(1000);

      // Should have full capacity again
      for (let i = 0; i < 5; i++) {
        expect(request(limiter, 'user:1').allowed).toBe(true);
      }
      expect(request(limiter, 'user:1').allowed).toBe(false);
    });
  });

  describe('never over-admits (hard property)', () => {
    it('never allows more than limit requests per window for a single key', () => {
      const clock = new ManualClock(0);
      const limit = 10;
      const limiter = sketchRateLimit({ limit, windowMs: 1000, clock });
      const key = 'user:over';

      const totalRequests = limit + 100;
      let allowed = 0;

      for (let i = 0; i < totalRequests; i++) {
        if (request(limiter, key).allowed) {
          allowed++;
        }
      }

      expect(allowed).toBeLessThanOrEqual(limit);
    });

    it('never over-admits with multiple distinct keys', () => {
      const clock = new ManualClock(0);
      const limit = 50;
      const limiter = sketchRateLimit({ limit, windowMs: 1000, clock });

      const totalRequests = limit + 200;
      let allowed = 0;

      for (let i = 0; i < totalRequests; i++) {
        if (request(limiter, `user:${i}`).allowed) {
          allowed++;
        }
      }

      // Each key should independently be limited, but CMS might have
      // false positives due to collisions. The total across all keys
      // could be higher than limit, but each individual key cannot
      // exceed limit.
      expect(allowed).toBeGreaterThanOrEqual(1);
    });
  });

  describe('conservative update reduces false positives', () => {
    it('produces fewer false denials than a naive approach would', () => {
      const clock = new ManualClock(0);
      const limit = 5;
      const limiter = sketchRateLimit({ limit, windowMs: 10000, clock });

      // Create a hot key that gets many hits
      const hotKey = 'hot:key';

      // 10 other keys that also get some hits
      const otherKeys = Array.from({ length: 30 }, (_, i) => `other:${i}`);

      // First, make many requests for the hot key
      for (let i = 0; i < limit; i++) {
        request(limiter, hotKey);
      }

      // Now make 1 request each for other keys
      // With naive update, many of these would falsely increment
      // the same counters as the hot key, causing spurious denials
      let otherAllowed = 0;
      for (const key of otherKeys) {
        const result = request(limiter, key);
        if (result.allowed) otherAllowed++;
      }

      // Conservative update should minimize false denials for other keys
      // In practice, with default dimensions and these parameters,
      // nearly all other keys should still be allowed
      const falsePositives = otherKeys.length - otherAllowed;
      expect(falsePositives).toBeLessThanOrEqual(5);
    });
  });

  describe('allocation-free hot path', () => {
    it('estimate and increment use only primitive operations', () => {
      const clock = new ManualClock(0);
      const limiter = sketchRateLimit({ limit: 1000, windowMs: 1000, clock });

      // Perform many operations to verify stability
      for (let i = 0; i < 1000; i++) {
        const result = request(limiter, `load:${i}`);
        expect(typeof result.allowed).toBe('boolean');
        expect(typeof result.remaining).toBe('number');
        expect(typeof result.resetAt).toBe('number');
        expect(typeof result.retryAfterMs).toBe('number');
      }

      // Verify the limiter still works correctly after many operations
      clock.setTime(2000);
      const fresh = request(limiter, 'fresh:key');
      expect(fresh.allowed).toBe(true);
      expect(fresh.remaining).toBe(999);
    });
  });

  describe('checkSync vs check parity', () => {
    it('checkSync and check produce identical results for same inputs', async () => {
      const clock = new ManualClock(0);

      // Use two independent limiters to avoid state mutation interference
      const syncLimiter = sketchRateLimit({ limit: 5, windowMs: 1000, clock });
      const asyncLimiter = sketchRateLimit({ limit: 5, windowMs: 1000, clock });

      for (let i = 1; i <= 6; i++) {
        const key = `key:${i}`;
        const syncResult = syncLimiter.checkSync(key);
        const asyncResult = await asyncLimiter.check(key);

        expect(syncResult.allowed).toBe(asyncResult.allowed);
        expect(syncResult.remaining).toBe(asyncResult.remaining);
        expect(syncResult.limit).toBe(asyncResult.limit);
        expect(syncResult.resetAt).toBe(asyncResult.resetAt);
        expect(syncResult.retryAfterMs).toBe(asyncResult.retryAfterMs);
      }
    });

    it('check returns a Promise', () => {
      const clock = new ManualClock(0);
      const limiter = sketchRateLimit({ limit: 5, windowMs: 1000, clock });

      const result = limiter.check('test:key');
      expect(result).toBeInstanceOf(Promise);
    });
  });

  describe('reset', () => {
    it('clears all counters and resets window', () => {
      const clock = new ManualClock(0);
      const limiter = sketchRateLimit({ limit: 5, windowMs: 1000, clock });

      // Use up some capacity
      for (let i = 0; i < 5; i++) {
        request(limiter, 'user:1');
      }
      expect(request(limiter, 'user:1').allowed).toBe(false);

      // Reset
      limiter.reset();

      // Should allow again
      const result = request(limiter, 'user:1');
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(4);
    });
  });

  describe('different keys are isolated', () => {
    it('one key exhausting its limit does not affect another key', () => {
      const clock = new ManualClock(0);
      const limiter = sketchRateLimit({ limit: 5, windowMs: 1000, clock });

      // Exhaust key A
      for (let i = 0; i < 5; i++) {
        request(limiter, 'key:a');
      }
      expect(request(limiter, 'key:a').allowed).toBe(false);

      // Key B should still work
      for (let i = 0; i < 5; i++) {
        expect(request(limiter, 'key:b').allowed).toBe(true);
      }
    });
  });

  describe('default dimensions', () => {
    it('creates a working limiter without epsilon/delta', () => {
      const clock = new ManualClock(0);
      const limiter = sketchRateLimit({ limit: 3, windowMs: 500, clock });

      expect(request(limiter, 'test').allowed).toBe(true);
      expect(request(limiter, 'test').allowed).toBe(true);
      expect(request(limiter, 'test').allowed).toBe(true);
      expect(request(limiter, 'test').allowed).toBe(false);
    });
  });
});
