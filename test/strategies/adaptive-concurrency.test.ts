/**
 * Adaptive Concurrency Guard tests.
 */

import { describe, it, expect } from 'vitest';
import { createAdaptiveConcurrency } from '../../src/strategies/adaptive-concurrency.js';

describe('Adaptive Concurrency', () => {
  // -----------------------------------------------------------------------
  // Basic acquire/release
  // -----------------------------------------------------------------------
  describe('acquire / release', () => {
    it('acquires a lease with ok=true', () => {
      const guard = createAdaptiveConcurrency({ minLimit: 4, maxLimit: 512 });
      const lease = guard.acquire();
      expect(lease.ok).toBe(true);
      expect(lease.inflight).toBe(1);
      expect(lease.limit).toBe(512);
      expect(typeof lease.release).toBe('function');
    });

    it('tracks inflight count', () => {
      const guard = createAdaptiveConcurrency({ minLimit: 4, maxLimit: 512 });
      const lease1 = guard.acquire();
      expect(guard.inflight).toBe(1);
      expect(lease1.inflight).toBe(1);

      const lease2 = guard.acquire();
      expect(guard.inflight).toBe(2);
      expect(lease2.inflight).toBe(2);

      lease1.release();
      expect(guard.inflight).toBe(1);
    });

    it('decrements inflight on release', () => {
      const guard = createAdaptiveConcurrency({ minLimit: 4, maxLimit: 512 });
      const lease = guard.acquire();
      expect(guard.inflight).toBe(1);
      lease.release();
      expect(guard.inflight).toBe(0);
    });

    it('maintains inflight >= 0 on multiple releases', () => {
      const guard = createAdaptiveConcurrency({ minLimit: 4, maxLimit: 512 });
      const lease = guard.acquire();
      lease.release();
      lease.release(); // Double release
      expect(guard.inflight).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // Concurrency limit enforcement
  // -----------------------------------------------------------------------
  describe('limit enforcement', () => {
    it('starts at maxLimit', () => {
      const guard = createAdaptiveConcurrency({ minLimit: 4, maxLimit: 100 });
      expect(guard.limit).toBe(100);
    });

    it('returns ok=false when at maxLimit', () => {
      const guard = createAdaptiveConcurrency({ minLimit: 4, maxLimit: 2 });
      const lease1 = guard.acquire();
      expect(lease1.ok).toBe(true);
      const lease2 = guard.acquire();
      expect(lease2.ok).toBe(true);
      const lease3 = guard.acquire();
      expect(lease3.ok).toBe(false);
    });

    it('no-op release on rejected lease', () => {
      const guard = createAdaptiveConcurrency({ minLimit: 4, maxLimit: 1 });
      guard.acquire(); // ok=true, inflight=1
      const lease2 = guard.acquire(); // ok=false, inflight=1

      // Release should not decrement (never acquired)
      lease2.release();
      expect(guard.inflight).toBe(1);

      guard.acquire(); // still at limit
    });
  });

  // -----------------------------------------------------------------------
  // Gradient2 algorithm adjustment
  // -----------------------------------------------------------------------
  describe('limit adjustment (gradient2)', () => {
    it('adjusts limit within bounds after acquire/release', () => {
      const guard = createAdaptiveConcurrency({ minLimit: 4, maxLimit: 100 });

      for (let i = 0; i < 10; i++) {
        const lease = guard.acquire();
        lease.release();
      }

      // Limit should always be within [minLimit, maxLimit]
      expect(guard.limit).toBeGreaterThanOrEqual(4);
      expect(guard.limit).toBeLessThanOrEqual(100);
    });

    it('clamps limit to minLimit', () => {
      const guard = createAdaptiveConcurrency({ minLimit: 10, maxLimit: 100 });

      // Force many high-latency releases to drive limit down
      for (let i = 0; i < 50; i++) {
        const lease = guard.acquire();
        // Busy-wait to create high RTT
        const start = performance.now();
        while (performance.now() - start < 2) {
          // Busy-wait
        }
        lease.release();
      }

      expect(guard.limit).toBeGreaterThanOrEqual(10);
    });

    it('clamps limit to maxLimit', () => {
      const guard = createAdaptiveConcurrency({ minLimit: 4, maxLimit: 50 });

      // Force low-latency releases to drive limit up
      for (let i = 0; i < 30; i++) {
        const lease = guard.acquire();
        lease.release(); // near-zero RTT
      }

      expect(guard.limit).toBeLessThanOrEqual(50);
    });

    it('multiplicative decrease on dropped requests', () => {
      const guard = createAdaptiveConcurrency({ minLimit: 4, maxLimit: 100 });

      const lease = guard.acquire();
      // Record the limit before release
      const beforeLimit = guard.limit;
      lease.release({ dropped: true });

      // With dropped=true, newLimit = current * 0.75
      expect(guard.limit).toBe(Math.max(4, Math.floor(beforeLimit * 0.75)));
    });

    it('multiple acquires and releases adjust limit', () => {
      const guard = createAdaptiveConcurrency({ minLimit: 4, maxLimit: 200 });

      // First batch: simulate fast requests (low RTT)
      for (let i = 0; i < 20; i++) {
        const lease = guard.acquire();
        // No delay — very low RTT
        lease.release();
      }

      const afterFast = guard.limit;
      expect(afterFast).toBeGreaterThan(4);

      // Second batch: simulate dropped requests
      for (let i = 0; i < 10; i++) {
        const lease = guard.acquire();
        const start = performance.now();
        while (performance.now() - start < 3) {
          // Busy-wait to create some RTT
        }
        lease.release({ dropped: true });
      }

      const afterDrops = guard.limit;
      expect(afterDrops).toBeLessThan(afterFast);
    });
  });

  // -----------------------------------------------------------------------
  // Stats
  // -----------------------------------------------------------------------
  describe('stats()', () => {
    it('returns initial stats', () => {
      const guard = createAdaptiveConcurrency({ minLimit: 4, maxLimit: 512 });
      const stats = guard.stats();
      expect(stats).toHaveProperty('p50Rtt');
      expect(stats).toHaveProperty('p99Rtt');
      expect(stats).toHaveProperty('noloadRtt');
      expect(stats.p50Rtt).toBe(0);
      expect(stats.p99Rtt).toBe(0);
      expect(stats.noloadRtt).toBe(0);
    });

    it('updates after releases', () => {
      const guard = createAdaptiveConcurrency({ minLimit: 4, maxLimit: 512 });

      for (let i = 0; i < 10; i++) {
        const lease = guard.acquire();
        lease.release();
      }

      const stats = guard.stats();
      // RTT should be measurable (even near-zero)
      expect(stats.p50Rtt).toBeGreaterThanOrEqual(0);
      expect(stats.noloadRtt).toBeLessThanOrEqual(stats.p99Rtt);
    });
  });

  // -----------------------------------------------------------------------
  // Default options
  // -----------------------------------------------------------------------
  describe('default options', () => {
    it('uses defaults when no options provided', () => {
      const guard = createAdaptiveConcurrency();
      expect(guard.limit).toBe(512);
      expect(guard.inflight).toBe(0);

      const lease = guard.acquire();
      expect(lease.ok).toBe(true);
      lease.release();
    });

    it('uses defaults when empty options provided', () => {
      const guard = createAdaptiveConcurrency({});
      expect(guard.limit).toBe(512);
    });
  });

  // -----------------------------------------------------------------------
  // ConcurrencyGuard interface compliance
  // -----------------------------------------------------------------------
  describe('ConcurrencyGuard interface', () => {
    it('exposes limit property', () => {
      const guard = createAdaptiveConcurrency();
      expect(guard.limit).toBeTypeOf('number');
    });

    it('exposes inflight property', () => {
      const guard = createAdaptiveConcurrency();
      expect(guard.inflight).toBeTypeOf('number');
      expect(guard.inflight).toBe(0);
    });

    it('stats() returns correct shape', () => {
      const guard = createAdaptiveConcurrency();
      const stats = guard.stats();
      expect(typeof stats.p50Rtt).toBe('number');
      expect(typeof stats.p99Rtt).toBe('number');
      expect(typeof stats.noloadRtt).toBe('number');
    });
  });
});
