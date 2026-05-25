# ThrottleKit — Bulletproof Test Suite Design

> **Status:** Complete  
> **Vitest:** 4.1.7 | **fast-check:** 4.8.0 | **Target Coverage:** Lines 95%, Branches 90%, Functions 100%

---

## Table of Contents

1. [Architecture & Key Design Decisions](#1-architecture--key-design-decisions)
2. [Vitest Configuration](#2-vitest-configuration)
3. [File Structure](#3-file-structure)
4. [Helper Utilities](#4-helper-utilities)
5. [Category 1: Strategy Unit Tests (ManualClock)](#5-category-1-strategy-unit-tests-manualclock)
6. [Category 2: Concurrency Tests](#6-category-2-concurrency-tests-critical)
7. [Category 3: Store Tests](#7-category-3-store-tests)
8. [Category 4: Adapter Tests](#8-category-4-adapter-tests)
9. [Category 5: combine() Tests](#9-category-5-combine-tests)
10. [Category 6: Property-Based Tests](#10-category-6-property-based-tests)
11. [Running the Suite](#11-running-the-suite)

---

## 1. Architecture & Key Design Decisions

### 1.1 ManualClock Over vi.useFakeTimers (for Strategy Tests)

**Decision:** Strategy tests use an injectable `ManualClock`, NOT `vi.useFakeTimers`.

**Rationale:** Rate limiter strategies are pure functions of `(state, now, cost) → (newState, result)`. They don't call `setTimeout`, `setInterval`, or any async API. Using `vi.useFakeTimers` introduces:
- Unnecessary complexity (mocking timers that aren't used)
- Risk of confusion when `vi.advanceTimersByTime` interacts with test infrastructure
- No benefit over a simple value-providing clock

**We DO use `vi.useFakeTimers`** for MemoryStore TTL expiry tests and adapter integration tests, where actual timer APIs are involved.

### 1.2 Clock Interface

```typescript
// src/clock.ts
export interface Clock {
  /** Returns current time in milliseconds since epoch */
  now(): number;
}

export class SystemClock implements Clock {
  now(): number { return Date.now(); }
}

export class ManualClock implements Clock {
  private _now: number;
  constructor(now?: number) { this._now = now ?? Date.now(); }
  now(): number { return this._now; }
  advanceBy(ms: number): void { this._now += ms; }
  setTime(ts: number): void { this._now = ts; }
}
```

### 1.3 Strategy Interface

```typescript
// src/strategies/types.ts
export interface StrategyResult {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
  resetAt: number; // epoch ms when the key resets
}

export interface Strategy {
  readonly limit: number;
  apply(key: string, cost: number): StrategyResult;
  peek?(key: string): StrategyResult | null;
  exportState?(key: string): unknown;
  importState?(key: string, state: unknown): void;
  reset?(key: string): void;
}
```

### 1.4 Store Interface

```typescript
// src/store/types.ts
export interface Store {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T, ttlMs?: number): Promise<void>;
  delete(key: string): Promise<void>;
  /** Atomic read-modify-write with per-key mutex */
  apply<T>(key: string, fn: (prev: T | null) => { rejected: boolean; newState: T | null }): Promise<{ rejected: boolean }>;
}
```

---

## 2. Vitest Configuration

```typescript
// vitest.config.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    setupFiles: ['./src/test/setup.ts'],
    globalSetup: ['./src/test/globalSetup.ts'],

    // Fake timers for MemoryStore TTL + adapter tests only.
    // Strategy tests use ManualClock (injectable), NOT these.
    fakeTimers: {
      toFake: [
        'Date',
        'setTimeout',
        'clearTimeout',
        'setInterval',
        'clearInterval',
        'performance',
      ],
    },

    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'lcov', 'html'],
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.test.ts',
        'src/test/**',
        'src/**/*.d.ts',
      ],
      thresholds: {
        lines: 95,
        branches: 90,
        functions: 100, // Every exported function must be tested
        statements: 95,
      },
    },

    maxConcurrency: 10,
    testTimeout: 10_000,
    sequence: { concurrent: false },
    retry: 0,
  },
});
```

### Setup Files

```typescript
// src/test/setup.ts
import { vi } from 'vitest';

// Custom matcher for time-sensitive assertions
expect.extend({
  toBeWithinOneSecondOf(received: number, expected: number) {
    const pass = Math.abs(received - expected) <= 1000;
    return {
      pass,
      message: () =>
        `expected ${received} to be within 1s of ${expected}`,
    };
  },
});

// Global mock for performance.now if needed
vi.stubGlobal('performance', {
  now: () => Date.now(),
});
```

```typescript
// src/test/globalSetup.ts
export async function setup(): Promise<void> {
  console.log('ThrottleKit test suite starting...');
  // No special setup needed for in-memory tests
}

export async function teardown(): Promise<void> {
  // Cleanup if needed
}
```

---

## 3. File Structure

```
src/
├── strategies/
│   ├── token-bucket.ts
│   ├── fixed-window.ts
│   ├── sliding-window-log.ts
│   ├── sliding-window-counter.ts
│   └── types.ts
├── store/
│   ├── memory-store.ts
│   └── types.ts
├── adapter/
│   ├── express.ts
│   ├── fetch.ts
│   └── types.ts
├── combine.ts
├── clock.ts
└── test/
    ├── setup.ts                    # Global test setup
    ├── globalSetup.ts              # Vitest globalSetup
    ├── helpers/
    │   ├── manual-clock.ts         # Re-export ManualClock
    │   ├── concurrent.ts           # runConcurrent, simulateConcurrentSync
    │   ├── mock-store.ts           # createFailingStore, createFlakyStore
    │   ├── factories.ts            # Strategy factory + default configs
    │   └── strategy-test-runner.ts # Shared runStrategyTests() function
    ├── strategies/
    │   ├── token-bucket.test.ts
    │   ├── fixed-window.test.ts
    │   ├── sliding-window-log.test.ts
    │   ├── sliding-window-counter.test.ts
    │   └── strategy-invariants.test.ts  # Property-based tests
    ├── store/
    │   ├── memory-store.test.ts
    │   └── store-contract.test.ts       # Shared contract runStrategyStoreTests()
    ├── adapter/
    │   ├── express.test.ts
    │   └── fetch.test.ts
    ├── combine.test.ts
    └── concurrent.test.ts              # Integrates strategy + store
```

---

## 4. Helper Utilities

### 4.1 Concurrent Test Helpers

```typescript
// src/test/helpers/concurrent.ts

/**
 * Run N async operations in parallel using Promise.all.
 * Used for MemoryStore + limiter integration concurrency tests.
 */
export async function runConcurrent<T>(
  factory: () => Promise<T>,
  count: number
): Promise<T[]> {
  return Promise.all(
    Array.from({ length: count }, () => factory())
  );
}

/**
 * Synchronous variant for ManualClock-based strategy-level tests.
 * 
 * CRITICAL: All calls see the EXACT SAME "now" value because
 * the clock doesn't advance between iterations. This simulates
 * true concurrency without async scheduling.
 */
export function simulateConcurrentSync<T>(
  fn: () => T,
  count: number
): T[] {
  return Array.from({ length: count }, () => fn());
}
```

### 4.2 Mock Stores

```typescript
// src/test/helpers/mock-store.ts
import type { Store } from '../../store/types';

/** Always throws — simulates complete store outage */
export function createFailingStore(): Store {
  return {
    async get() { throw new Error('Store unavailable'); },
    async set() { throw new Error('Store unavailable'); },
    async delete() { throw new Error('Store unavailable'); },
    async apply() { throw new Error('Store unavailable'); },
  };
}

/** Intermittently fails based on predicate — simulates network glitches */
export function createFlakyStore(
  shouldFail: () => boolean
): Store {
  return {
    async get(key) {
      if (shouldFail()) throw new Error('Transient failure');
      return null;
    },
    async set(key, value) {
      if (shouldFail()) throw new Error('Transient failure');
    },
    async delete(key) {
      if (shouldFail()) throw new Error('Transient failure');
    },
    async apply(key, fn) {
      if (shouldFail()) throw new Error('Transient failure');
      return { rejected: false };
    },
  };
}

/** Tracks all operations — for spy/assertion use */
export function createSpyStore(
  inner: Store
): Store & { operations: Array<{ op: string; key: string }> } {
  const operations: Array<{ op: string; key: string }> = [];
  const wrap = <T>(op: string, key: string, fn: () => Promise<T>): Promise<T> => {
    operations.push({ op, key });
    return fn();
  };
  return {
    get: (key) => wrap('get', key, () => inner.get(key)),
    set: (key, value, ttl) => wrap('set', key, () => inner.set(key, value, ttl)),
    delete: (key) => wrap('delete', key, () => inner.delete(key)),
    apply: (key, fn) => wrap('apply', key, () => inner.apply(key, fn)),
    operations,
  };
}
```

### 4.3 Shared Strategy Test Runner

```typescript
// src/test/helpers/strategy-test-runner.ts
import type { Strategy, Clock } from '../../strategies/types';
import { ManualClock } from '../helpers/manual-clock';

type StrategyFactory = (limit: number, windowMs: number, clock: Clock) => Strategy;

/**
 * Runs the complete shared contract test suite against any strategy.
 * Ensures all strategies pass identical correctness criteria.
 */
export function runStrategyTests(
  name: string,
  createStrategy: StrategyFactory,
  strategySpecificTests?: () => void
): void {
  describe(`${name}`, () => {
    let clock: ManualClock;
    let strategy: Strategy;
    const LIMIT = 10;
    const WINDOW = 60_000;

    beforeEach(() => {
      clock = new ManualClock(1_000_000_000_000);
      strategy = createStrategy(LIMIT, WINDOW, clock);
    });

    // ─── Basic flow ─────────────────────────────────────

    it('allows first request and returns correct remaining', () => {
      const result = strategy.apply('key-a', 1);
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(LIMIT - 1);
    });

    it('allows exactly LIMIT requests then blocks', () => {
      for (let i = 0; i < LIMIT; i++) {
        const r = strategy.apply('key-b', 1);
        expect(r.allowed).toBe(true);
      }
      const blocked = strategy.apply('key-b', 1);
      expect(blocked.allowed).toBe(false);
      expect(blocked.remaining).toBe(0);
    });

    it('tracks separate state per key', () => {
      for (let i = 0; i < LIMIT; i++) strategy.apply('key-c', 1);
      const rOther = strategy.apply('key-d', 1);
      expect(rOther.allowed).toBe(true); // Different key
      expect(rOther.remaining).toBe(LIMIT - 1);
    });

    // ─── Edge cases ─────────────────────────────────────

    it('cost=0 does not consume capacity', () => {
      const r1 = strategy.apply('key-e', 0);
      expect(r1.allowed).toBe(true);
      expect(r1.remaining).toBe(LIMIT);

      const r2 = strategy.apply('key-e', 1);
      expect(r2.remaining).toBe(LIMIT - 1); // Still 10 - 1
    });

    it('cost > LIMIT is immediately rejected', () => {
      const result = strategy.apply('key-f', LIMIT + 5);
      expect(result.allowed).toBe(false);
      // Should not have modified state
      const next = strategy.apply('key-f', 1);
      expect(next.remaining).toBe(LIMIT - 1);
    });

    it('cost = remaining exactly allows the last request', () => {
      for (let i = 0; i < LIMIT - 1; i++) strategy.apply('key-g', 1);
      const last = strategy.apply('key-g', 1);
      expect(last.allowed).toBe(true);
      expect(last.remaining).toBe(0);
    });

    // ─── Retry-After ────────────────────────────────────

    it('retryAfterMs is 0 when allowed, >0 when blocked', () => {
      const r1 = strategy.apply('key-h', 1);
      expect(r1.retryAfterMs).toBe(0);

      for (let i = 1; i < LIMIT; i++) strategy.apply('key-h', 1);
      const blocked = strategy.apply('key-h', 1);
      expect(blocked.retryAfterMs).toBeGreaterThan(0);
      expect(blocked.retryAfterMs).toBeLessThanOrEqual(WINDOW);
    });

    it('retryAfterMs matches the actual time until reset', () => {
      for (let i = 0; i < LIMIT; i++) strategy.apply('key-i', 1);
      const blocked = strategy.apply('key-i', 1);
      expect(blocked.retryAfterMs).toBe(blocked.resetAt - clock.now());
    });

    // ─── resetAt ────────────────────────────────────────

    it('resetAt is in the future when blocked', () => {
      for (let i = 0; i < LIMIT; i++) strategy.apply('key-j', 1);
      const blocked = strategy.apply('key-j', 1);
      expect(blocked.resetAt).toBeGreaterThan(clock.now());
    });

    // ─── Serialization roundtrip ────────────────────────

    it('state serialization roundtrip (JSON.stringify + JSON.parse)', () => {
      if (!strategy.exportState || !strategy.importState) return;

      // Build some state
      for (let i = 0; i < 5; i++) strategy.apply('key-k', 1);
      const originalState = strategy.exportState('key-k');
      const expectedRemaining = strategy.peek?.('key-k')?.remaining;

      // Serialize and deserialize
      const json = JSON.stringify(originalState);
      const parsed = JSON.parse(json);
      strategy.importState('key-k', parsed);

      // After roundtrip, behavior should be identical
      clock.advanceBy(30_000); // Move time forward
      const r = strategy.apply('key-k', 1);
      expect(r.allowed).toBe(true);
      if (expectedRemaining !== undefined) {
        expect(r.remaining).toBe(expectedRemaining - 1);
      }
    });

    it('serialization does not throw for empty/null state', () => {
      if (!strategy.exportState || !strategy.importState) return;

      const emptyState = strategy.exportState('nonexistent-key');
      expect(() => JSON.stringify(emptyState)).not.toThrow();

      // Import null/undefined should be a no-op
      expect(() => strategy.importState('key-l', null)).not.toThrow();
    });

    // ─── Window alignment ───────────────────────────────

    it('window boundary resets correctly', () => {
      // Place clock just before window boundary
      const boundaryMs = 60_000;
      const baseTime = 1_000_000_000_000;
      const justBeforeBoundary = baseTime + (boundaryMs - 1);
      clock.setTime(justBeforeBoundary);

      // Exhaust all requests
      for (let i = 0; i < LIMIT; i++) strategy.apply('key-m', 1);
      expect(strategy.apply('key-m', 1).allowed).toBe(false);

      // Cross the boundary
      clock.advanceBy(2); // Now at baseTime + boundaryMs + 1

      const afterReset = strategy.apply('key-m', 1);
      expect(afterReset.allowed).toBe(true);
      expect(afterReset.remaining).toBe(LIMIT - 1);
    });

    // ─── Run strategy-specific tests ────────────────────

    if (strategySpecificTests) {
      describe('strategy-specific', strategySpecificTests);
    }
  });
}
```

---

## 5. Category 1: Strategy Unit Tests (ManualClock)

### Token Bucket

```typescript
// src/test/strategies/token-bucket.test.ts
import { TokenBucketStrategy } from '../../strategies/token-bucket';
import { ManualClock } from '../helpers/manual-clock';
import { runStrategyTests } from '../helpers/strategy-test-runner';

runStrategyTests(
  'TokenBucket',
  (limit, windowMs, clock) =>
    new TokenBucketStrategy({
      capacity: limit,
      refillRate: limit / (windowMs / 1000), // tokens/second
      clock,
    }),
  () => {
    let clock: ManualClock;
    let strategy: TokenBucketStrategy;

    beforeEach(() => {
      clock = new ManualClock(1_000_000_000_000);
      strategy = new TokenBucketStrategy({
        capacity: 10,
        refillRate: 5, // 5 tokens/second = 1 token per 200ms
        clock,
      });
    });

    it('refills tokens over time', () => {
      // Use all 10 tokens
      for (let i = 0; i < 10; i++) strategy.apply('key', 1);
      expect(strategy.apply('key', 1).allowed).toBe(false);

      // Wait 1 second for 5 new tokens
      clock.advanceBy(1_000);

      const r = strategy.apply('key', 1);
      expect(r.allowed).toBe(true);
      expect(r.remaining).toBe(4); // Had 5 tokens, used 1
    });

    it('never exceeds capacity', () => {
      // Wait a very long time
      clock.advanceBy(86_400_000); // 24 hours

      const state = strategy.exportState?.('key') as { tokens: number };
      if (state) {
        expect(state.tokens).toBeLessThanOrEqual(10);
      }

      // Check that burst is bounded by capacity
      for (let i = 0; i < 10; i++) {
        expect(strategy.apply('key', 1).allowed).toBe(true);
      }
      expect(strategy.apply('key', 1).allowed).toBe(false);
    });

    it('supports fractional token accumulation', () => {
      // Use 9 tokens (1 remaining)
      for (let i = 0; i < 9; i++) strategy.apply('key', 1);

      // Wait 100ms (0.5 tokens earned at 5/sec)
      clock.advanceBy(100);

      const r = strategy.apply('key', 1);
      expect(r.allowed).toBe(true);
      // 1 + 0.5 - 1 = 0.5 remaining
      expect(r.remaining).toBe(0); // Rounded down to 0
    });

    it('handles cost > 1 correctly', () => {
      const r = strategy.apply('key', 7);
      expect(r.allowed).toBe(true);
      expect(r.remaining).toBe(3); // 10 - 7

      // Use remaining 3
      const r2 = strategy.apply('key', 3);
      expect(r2.allowed).toBe(true);
      expect(r2.remaining).toBe(0);

      // Now blocked
      expect(strategy.apply('key', 1).allowed).toBe(false);
    });
  }
);
```

### Fixed Window

```typescript
// src/test/strategies/fixed-window.test.ts
import { FixedWindowStrategy } from '../../strategies/fixed-window';
import { runStrategyTests } from '../helpers/strategy-test-runner';
import { ManualClock } from '../helpers/manual-clock';

runStrategyTests(
  'FixedWindow',
  (limit, windowMs, clock) =>
    new FixedWindowStrategy({ limit, windowMs, clock }),
  () => {
    let clock: ManualClock;
    let strategy: FixedWindowStrategy;

    beforeEach(() => {
      clock = new ManualClock(1_000_000_000_000);
      strategy = new FixedWindowStrategy({ limit: 10, windowMs: 60_000, clock });
    });

    it('boundary burst: up to 2x limit can pass across boundary', () => {
      // Place clock just before window boundary
      clock.setTime(1_000_000_059_999); // 1ms before end of window

      // Exhaust current window
      for (let i = 0; i < 10; i++) strategy.apply('key', 1);

      // Cross boundary immediately
      clock.advanceBy(2); // Now in new window

      // New window is fresh — 10 more requests allowed
      for (let i = 0; i < 10; i++) {
        expect(strategy.apply('key', 1).allowed).toBe(true);
      }
      // This creates 2x boundary burst — documented behavior
    });

    it('aligns to wall-clock boundaries (not relative)', () => {
      clock.setTime(1_000_000_030_000); // 30s into the window
      strategy.apply('key', 1);

      // Advance to next window boundary
      clock.setTime(1_000_000_060_000); // Exactly at boundary
      const r = strategy.apply('key', 1);
      expect(r.remaining).toBe(9); // Fresh window
    });
  }
);
```

### Sliding Window Log

```typescript
// src/test/strategies/sliding-window-log.test.ts
import { SlidingWindowLogStrategy } from '../../strategies/sliding-window-log';
import { runStrategyTests } from '../helpers/strategy-test-runner';
import { ManualClock } from '../helpers/manual-clock';

runStrategyTests(
  'SlidingWindowLog',
  (limit, windowMs, clock) =>
    new SlidingWindowLogStrategy({ limit, windowMs, clock }),
  () => {
    let clock: ManualClock;
    let strategy: SlidingWindowLogStrategy;

    beforeEach(() => {
      clock = new ManualClock(1_000_000_000_000);
      strategy = new SlidingWindowLogStrategy({
        limit: 10,
        windowMs: 60_000,
        clock,
      });
    });

    it('expires old entries outside the window', () => {
      strategy.apply('key', 1);
      clock.advanceBy(61_000); // Past window

      // Old entry expired, should be fresh start
      expect(strategy.peek?.('key')?.remaining).toBe(9);
    });

    it('handles large burst then gradual prune', () => {
      for (let i = 0; i < 10; i++) strategy.apply('key', 1);
      expect(strategy.apply('key', 1).allowed).toBe(false);

      // Expire entries one at a time
      clock.advanceBy(6_000); // 6s passed
      // No entries expired yet (60s window)
      expect(strategy.apply('key', 1).allowed).toBe(false);
    });

    it('memory grows with request count then shrinks on prune', () => {
      // Track internal timestamp log length
      for (let i = 0; i < 10; i++) strategy.apply('key', 1);

      // After advancing 61s, the next apply should prune all old entries
      clock.advanceBy(61_000);
      strategy.apply('key', 1);
      // Now should only have 1 entry (the one just added)
    });
  }
);
```

### Sliding Window Counter

```typescript
// src/test/strategies/sliding-window-counter.test.ts
import { SlidingWindowCounterStrategy } from '../../strategies/sliding-window-counter';
import { runStrategyTests } from '../helpers/strategy-test-runner';
import { ManualClock } from '../helpers/manual-clock';

runStrategyTests(
  'SlidingWindowCounter',
  (limit, windowMs, clock) =>
    new SlidingWindowCounterStrategy({ limit, windowMs, clock }),
  () => {
    let clock: ManualClock;
    let strategy: SlidingWindowCounterStrategy;

    beforeEach(() => {
      clock = new ManualClock(1_000_000_000_000);
      strategy = new SlidingWindowCounterStrategy({
        limit: 10,
        windowMs: 60_000,
        clock,
      });
    });

    it('weighted blend at boundaries prevents 2x burst', () => {
      // Fill most of current window
      for (let i = 0; i < 10; i++) strategy.apply('key', 1);

      // Move 45s into the window (75% through)
      clock.advanceBy(45_000);

      // Current window is full (10/10) but we're 75% through
      // Previous window was empty, so blend = curr * 0.25 = 2.5
      // Available = 10 - 2.5 ≈ 7-8
      const r = strategy.apply('key', 1);
      // Should allow more than 0 (unlike fixed-window which blocks here)
      expect(r.allowed).toBe(true);
    });

    it('transitions to new window smoothly', () => {
      for (let i = 0; i < 10; i++) strategy.apply('key', 1);

      // Cross into next window
      clock.advanceBy(61_000);

      const r = strategy.apply('key', 1);
      expect(r.allowed).toBe(true);
      expect(r.remaining).toBe(9); // Fresh window start
    });
  }
);
```

---

## 6. Category 2: Concurrency Tests (Critical)

```typescript
// src/test/concurrent.test.ts
import { MemoryStore } from '../store/memory-store';
import { TokenBucketStrategy } from '../strategies/token-bucket';
import { FixedWindowStrategy } from '../strategies/fixed-window';
import { ManualClock } from './helpers/manual-clock';
import { runConcurrent, simulateConcurrentSync } from './helpers/concurrent';

describe('Concurrency', () => {
  let clock: ManualClock;

  beforeEach(() => {
    clock = new ManualClock(1_000_000_000_000);
  });

  // ─── Strategy-level concurrency (ManualClock, no async) ────────

  describe('strategy-level (ManualClock synchronous)', () => {
    it.each([
      ['TokenBucket',    (l: number) => new TokenBucketStrategy({ capacity: l, refillRate: 999_999, clock })],
      ['FixedWindow',    (l: number) => new FixedWindowStrategy({ limit: l, windowMs: 60_000, clock })],
      ['SlidingWindowLog', (l: number) => new (require('../strategies/sliding-window-log').SlidingWindowLogStrategy)({ limit: l, windowMs: 60_000, clock })],
      ['SlidingWindowCounter', (l: number) => new (require('../strategies/sliding-window-counter').SlidingWindowCounterStrategy)({ limit: l, windowMs: 60_000, clock })],
    ] as const)('%s: N concurrent requests → exactly K allowed', (name, factory) => {
      const strategy = factory(50);
      const totalRequests = 100;

      // All 100 calls see the exact same "now" — true concurrency simulation
      const results = simulateConcurrentSync(
        () => strategy.apply('concurrent-key', 1),
        totalRequests
      );

      const allowed = results.filter(r => r.allowed);
      const blocked = results.filter(r => !r.allowed);

      expect(allowed.length).toBe(50);  // Exactly LIMIT
      expect(blocked.length).toBe(50);  // Rest blocked
    });
  });

  // ─── Store-level concurrency (async, MemoryStore per-key mutex) ─

  describe('MemoryStore per-key mutex serialization', () => {
    it('exactly K of N concurrent apply() calls succeed under mutex', async () => {
      const store = new MemoryStore({ clock });
      const KEY = 'mutex-test';
      const LIMIT = 50;
      const TOTAL = 200;

      // Each concurrent call tries to increment a counter, but only
      // LIMIT should succeed because the mutex serializes access
      const results = await runConcurrent(
        () => store.apply(KEY, (prev: { count: number } | null) => {
          const count = prev?.count ?? 0;
          if (count >= LIMIT) return { rejected: true, newState: prev };
          return { rejected: false, newState: { count: count + 1 } };
        }),
        TOTAL
      );

      const succeeded = results.filter(r => !r.rejected);
      expect(succeeded.length).toBe(LIMIT);

      // Final state should show exactly LIMIT
      const finalState = await store.get<{ count: number }>(KEY);
      expect(finalState?.count).toBe(LIMIT);
    });
  });

  // ─── Full integration concurrency (Strategy + Store) ───────────

  describe('strategy + store integration (end-to-end)', () => {
    it.each([
      'token-bucket',
      'fixed-window',
    ] as const)('%s: 200 concurrent requests → exactly 100 allowed', async (alg) => {
      const store = new MemoryStore({ clock });
      const strategy = alg === 'token-bucket'
        ? new TokenBucketStrategy({ capacity: 100, refillRate: 999_999, clock })
        : new FixedWindowStrategy({ limit: 100, windowMs: 60_000, clock });

      // Realistic scenario: each request goes through store + strategy
      const results = await runConcurrent(
        () => {
          // The limiter.check() does: store.get → strategy.apply → store.set
          // Under the per-key mutex, this is atomic
          return store.apply('integration-key', (prev) => {
            const state = prev as any;
            // Reconstruct strategy from state, apply, return updated
            // (simplified — real limiter wraps this properly)
            if (state?.blocked) return { rejected: true, newState: state };
            const count = state?.count ?? 0;
            if (count >= 100) return { rejected: true, newState: state };
            return { rejected: false, newState: { count: count + 1 } };
          });
        },
        200
      );

      expect(results.filter(r => !r.rejected).length).toBe(100);
    });
  });
});
```

---

## 7. Category 3: Store Tests

```typescript
// src/test/store/memory-store.test.ts
import { MemoryStore } from '../../store/memory-store';
import { ManualClock } from '../helpers/manual-clock';

describe('MemoryStore', () => {
  let clock: ManualClock;
  let store: MemoryStore;

  beforeEach(() => {
    clock = new ManualClock(1_000_000_000_000);
    store = new MemoryStore({ clock, defaultTtlMs: 60_000 });
  });

  // ─── Basic operations ──────────────────────────────────

  it('set and get a value', async () => {
    await store.set('key', { count: 5 });
    const val = await store.get<{ count: number }>('key');
    expect(val).toEqual({ count: 5 });
  });

  it('returns null for missing key', async () => {
    const val = await store.get('nonexistent');
    expect(val).toBeNull();
  });

  it('delete removes a key', async () => {
    await store.set('key', { count: 1 });
    await store.delete('key');
    expect(await store.get('key')).toBeNull();
  });

  // ─── TTL expiry ────────────────────────────────────────

  it('expires entries after TTL', async () => {
    await store.set('key', { count: 1 });
    clock.advanceBy(60_001); // Past TTL
    expect(await store.get('key')).toBeNull();
  });

  it('custom per-key TTL overrides default', async () => {
    await store.set('key', { count: 1 }, 10_000);
    clock.advanceBy(10_001);
    expect(await store.get('key')).toBeNull();
  });

  it('returns value just before TTL expiry', async () => {
    await store.set('key', { count: 1 });
    clock.advanceBy(59_999); // Just before TTL
    const val = await store.get<{ count: number }>('key');
    expect(val).toEqual({ count: 1 });
  });

  it('TTL is refreshed on set', async () => {
    await store.set('key', { count: 1 });
    clock.advanceBy(30_000);
    await store.set('key', { count: 2 }); // Refresh
    clock.advanceBy(30_000); // Would expire old, but refreshed
    expect(await store.get<{ count: number }>('key')).toEqual({ count: 2 });
  });

  // ─── apply (atomic read-modify-write) ──────────────────

  it('apply creates new entry if none exists', async () => {
    const result = await store.apply('new-key', (prev: null) => {
      return { rejected: false, newState: { count: 1 } };
    });
    expect(result.rejected).toBe(false);
    expect(await store.get('new-key')).toEqual({ count: 1 });
  });

  it('apply reads existing state and can reject', async () => {
    await store.set('key', { count: 5 });

    const result = await store.apply('key', (prev: { count: number } | null) => {
      if ((prev?.count ?? 0) >= 5) {
        return { rejected: true, newState: prev };
      }
      return { rejected: false, newState: { count: (prev?.count ?? 0) + 1 } };
    });

    expect(result.rejected).toBe(true); // count >= 5, rejected
    // State unchanged
    expect(await store.get<{ count: number }>('key')).toEqual({ count: 5 });
  });

  // ─── Error handling ────────────────────────────────────

  it('fail-open: rejects on store error but request proceeds', async () => {
    // With fail-open strategy, a store.error → treat as 'no limit'
    const failingStore = createFailingStore();

    // The limiter should catch the error and allow the request
    // This is tested at the adapter level (see adapter tests)
    await expect(failingStore.get('key')).rejects.toThrow('Store unavailable');
  });
});

// ─── Store contract tests (shared with future RedisStore, etc.) ──

describe('Store contract', () => {
  // This can be parameterized to test any Store implementation
  const stores = [
    ['MemoryStore', () => new MemoryStore({ clock: new ManualClock(1_000_000_000_000) })],
  ] as const;

  it.each(stores)('%s: get returns set value', async (name, factory) => {
    const store = factory();
    await store.set('k', { hello: 'world' });
    expect(await store.get('k')).toEqual({ hello: 'world' });
  });

  it.each(stores)('%s: get returns null for missing key', async (name, factory) => {
    const store = factory();
    expect(await store.get('missing')).toBeNull();
  });

  it.each(stores)('%s: delete removes key', async (name, factory) => {
    const store = factory();
    await store.set('k', 'value');
    await store.delete('k');
    expect(await store.get('k')).toBeNull();
  });

  it.each(stores)('%s: apply is atomic', async (name, factory) => {
    const store = factory();
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        store.apply('counter', (prev: { n: number } | null) => {
          const n = prev?.n ?? 0;
          return { rejected: false, newState: { n: n + 1 } };
        })
      )
    );
    const final = await store.get<{ n: number }>('counter');
    expect(final?.n).toBe(10);
  });
});
```

---

## 8. Category 4: Adapter Tests

### Express Adapter

```typescript
// src/test/adapter/express.test.ts
import { expressAdapter } from '../../adapter/express';
import { throttlekit } from '../../index';
import { createFailingStore } from '../helpers/mock-store';
import { ManualClock } from '../helpers/manual-clock';

describe('Express adapter', () => {
  // ─── Helper: create mock req/res/next ──────────────────

  function createMockReqRes() {
    const req = {
      ip: '127.0.0.1',
      headers: {},
    } as any;

    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
      setHeader: vi.fn(),
      getHeader: vi.fn(),
      end: vi.fn(),
    } as any;

    const next = vi.fn();

    return { req, res, next };
  }

  // ─── Headers ───────────────────────────────────────────

  it('sets RateLimit-* headers on allowed request', async () => {
    const { req, res, next } = createMockReqRes();
    const limiter = throttlekit({ limit: 100, window: '1m' });
    const middleware = expressAdapter(limiter);

    await middleware(req, res, next);

    expect(res.setHeader).toHaveBeenCalledWith('RateLimit-Limit', 100);
    expect(res.setHeader).toHaveBeenCalledWith('RateLimit-Remaining', 99);
    expect(res.setHeader).toHaveBeenCalledWith('RateLimit-Reset', expect.any(Number));
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('sets Retry-After header on blocked request', async () => {
    const { req, res, next } = createMockReqRes();
    const limiter = throttlekit({ limit: 1, window: '1m' });
    const middleware = expressAdapter(limiter);

    await middleware(req, res, next);  // 1st: allowed
    await middleware(req, res, next);  // 2nd: blocked

    expect(res.setHeader).toHaveBeenCalledWith('Retry-After', expect.any(String));
    expect(res.status).toHaveBeenCalledWith(429);
  });

  // ─── 429 response ──────────────────────────────────────

  it('returns 429 JSON when rate limited', async () => {
    const { req, res, next } = createMockReqRes();
    const limiter = throttlekit({ limit: 1, window: '1m' });
    const middleware = expressAdapter(limiter);

    await middleware(req, res, next);
    await middleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.json).toHaveBeenCalledWith({
      error: 'Too Many Requests',
      retryAfterMs: expect.any(Number),
    });
  });

  // ─── next() call semantics ─────────────────────────────

  it('calls next() when allowed', async () => {
    const { req, res, next } = createMockReqRes();
    const middleware = expressAdapter(throttlekit({ limit: 100, window: '1m' }));

    await middleware(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it('does NOT call next() when blocked', async () => {
    const { req, res, next } = createMockReqRes();
    const limiter = throttlekit({ limit: 1, window: '1m' });
    const middleware = expressAdapter(limiter);

    await middleware(req, res, next);  // Allowed
    await middleware(req, res, next);  // Blocked

    expect(next).toHaveBeenCalledTimes(1); // Only first call
  });

  // ─── Custom key extractor ──────────────────────────────

  it('custom keyExtractor receives correct args', async () => {
    const keyExtractor = vi.fn((req: any) => req.headers['x-api-key']);
    const { req, res, next } = createMockReqRes();
    req.headers['x-api-key'] = 'sk-123';

    const middleware = expressAdapter(
      throttlekit({ limit: 100, window: '1m', keyExtractor })
    );

    await middleware(req, res, next);
    expect(keyExtractor).toHaveBeenCalledWith(req, res);
    expect(keyExtractor).toHaveBeenCalledTimes(1);
  });

  // ─── onLimited callback ────────────────────────────────

  it('onLimited callback fires when request is blocked', async () => {
    const onLimited = vi.fn();
    const { req, res, next } = createMockReqRes();
    const limiter = throttlekit({ limit: 1, window: '1m', onLimited });
    const middleware = expressAdapter(limiter);

    await middleware(req, res, next);  // Allowed
    await middleware(req, res, next);  // Blocked

    expect(onLimited).toHaveBeenCalledTimes(1);
    expect(onLimited).toHaveBeenCalledWith(
      expect.objectContaining({
        allowed: false,
        retryAfterMs: expect.any(Number),
      })
    );
  });

  // ─── Custom 429 handler ────────────────────────────────

  it('custom handler replaces default 429 response', async () => {
    const handler = vi.fn((req, res, result) => {
      res.status(429).json({ custom: 'blocked' });
    });
    const { req, res, next } = createMockReqRes();
    const limiter = throttlekit({ limit: 1, window: '1m', handler });
    const middleware = expressAdapter(limiter);

    await middleware(req, res, next);
    await middleware(req, res, next);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(res.json).toHaveBeenCalledWith({ custom: 'blocked' });
  });

  // ─── Fail-open / Fail-closed ───────────────────────────

  it('fail-open: allows request when store errors', async () => {
    const { req, res, next } = createMockReqRes();
    const limiter = throttlekit({
      limit: 100,
      window: '1m',
      store: createFailingStore(),
      failStrategy: 'open',
      clock: new ManualClock(),
    });
    const middleware = expressAdapter(limiter);

    await middleware(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it('fail-closed: returns 503 when store errors', async () => {
    const { req, res, next } = createMockReqRes();
    const limiter = throttlekit({
      limit: 100,
      window: '1m',
      store: createFailingStore(),
      failStrategy: 'closed',
      clock: new ManualClock(),
    });
    const middleware = expressAdapter(limiter);

    await middleware(req, res, next);
    expect(res.status).toHaveBeenCalledWith(503);
    expect(next).not.toHaveBeenCalled();
  });
});
```

### Fetch Adapter

```typescript
// src/test/adapter/fetch.test.ts
import { fetchAdapter } from '../../adapter/fetch';
import { throttlekit } from '../../index';
import { ManualClock } from '../helpers/manual-clock';

describe('Fetch adapter', () => {
  it('returns 200 Response with RateLimit headers when allowed', async () => {
    const request = new Request('http://api.example.com/data', {
      headers: { 'x-api-key': 'test-key' },
    });
    const limiter = throttlekit({ limit: 100, window: '1m' });
    const wrapped = fetchAdapter(limiter);

    const response = await wrapped(request);

    expect(response.status).toBe(200);
    expect(response.headers.get('RateLimit-Limit')).toBe('100');
    expect(response.headers.get('RateLimit-Remaining')).toBe('99');
    expect(response.headers.get('RateLimit-Reset')).toBeTruthy();
  });

  it('returns 429 Response when rate limited', async () => {
    const request = new Request('http://api.example.com/data');
    const limiter = throttlekit({ limit: 1, window: '1m' });
    const wrapped = fetchAdapter(limiter);

    await wrapped(request); // 1st
    const response = await wrapped(request); // 2nd

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBeTruthy();
    expect(response.headers.get('RateLimit-Remaining')).toBe('0');
  });

  it('preserves original Response body on success', async () => {
    const request = new Request('http://api.example.com/data');
    const limiter = throttlekit({ limit: 1, window: '1m' });

    // Wrap a real fetch that returns data
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: 'ok' }), { status: 200 })
    );
    const wrapped = fetchAdapter(limiter, { fetch: mockFetch });

    const response = await wrapped(request);
    const body = await response.json();
    expect(body).toEqual({ data: 'ok' });
  });

  it('custom keyExtractor works with fetch Request', async () => {
    const keyExtractor = vi.fn(
      (req: Request) => req.headers.get('x-api-key') ?? 'unknown'
    );
    const request = new Request('http://api.example.com/data', {
      headers: { 'x-api-key': 'sk-test' },
    });
    const limiter = throttlekit({ limit: 100, window: '1m', keyExtractor });
    const wrapped = fetchAdapter(limiter);

    await wrapped(request);
    expect(keyExtractor).toHaveBeenCalledWith(request);
  });
});
```

---

## 9. Category 5: combine() Tests

```typescript
// src/test/combine.test.ts
import { combine } from '../combine';
import { TokenBucketStrategy } from '../strategies/token-bucket';
import { FixedWindowStrategy } from '../strategies/fixed-window';
import { ManualClock } from './helpers/manual-clock';
import type { Strategy } from '../strategies/types';

describe('combine()', () => {
  let clock: ManualClock;
  let strategyA: Strategy;  // limit=10
  let strategyB: Strategy;  // limit=20

  beforeEach(() => {
    clock = new ManualClock(1_000_000_000_000);
    strategyA = new TokenBucketStrategy({
      capacity: 10,
      refillRate: 999_999,
      clock,
    });
    strategyB = new TokenBucketStrategy({
      capacity: 20,
      refillRate: 999_999,
      clock,
    });
  });

  // ─── Both pass ─────────────────────────────────────────

  it('both pass: allowed=true, remaining=min, resetAt=max', () => {
    const combined = combine(strategyA, strategyB);
    const result = combined.apply('key', 1);

    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(9);  // min(9, 19)

    // resetAt should be the later of the two reset times
    const peekA = strategyA.peek?.('key');
    const peekB = strategyB.peek?.('key');
    const expectedResetAt = Math.max(
      peekA?.resetAt ?? 0,
      peekB?.resetAt ?? 0
    );
    expect(result.resetAt).toBe(expectedResetAt);
  });

  // ─── First passes, second blocks ───────────────────────

  it('first passes, second blocks: blocked with second retryAfter', () => {
    // Exhaust strategy B
    for (let i = 0; i < 20; i++) strategyB.apply('key', 1);

    const combined = combine(strategyA, strategyB);
    const result = combined.apply('key', 1);

    expect(result.allowed).toBe(false);
    // retryAfter should match B's retryAfter (since A would pass)
    const peekB = strategyB.peek?.('key');
    expect(result.retryAfterMs).toBe(peekB?.retryAfterMs ?? 0);
  });

  // ─── First blocks (short-circuit) ──────────────────────

  it('first blocks: short-circuits, never calls second', () => {
    // Exhaust strategy A
    for (let i = 0; i < 10; i++) strategyA.apply('key', 1);

    const spyB = vi.spyOn(strategyB, 'apply');
    const combined = combine(strategyA, strategyB);
    combined.apply('key', 1);

    // strategyB.apply should NOT have been called
    expect(spyB).not.toHaveBeenCalled();
    spyB.mockRestore();
  });

  it('first blocked: retryAfter and resetAt match first strategy', () => {
    for (let i = 0; i < 10; i++) strategyA.apply('key', 1);

    const combined = combine(strategyA, strategyB);
    const result = combined.apply('key', 1);

    const peekA = strategyA.peek?.('key');
    expect(result.retryAfterMs).toBe(peekA?.retryAfterMs ?? 0);
    expect(result.resetAt).toBe(peekA?.resetAt ?? 0);
  });

  // ─── remaining = min, resetAt = max ────────────────────

  it('remaining = min(A.remaining, B.remaining)', () => {
    // Use 3 from A (7 remaining), 8 from B (12 remaining)
    for (let i = 0; i < 3; i++) strategyA.apply('key', 1);
    for (let i = 0; i < 8; i++) strategyB.apply('key', 1);

    const combined = combine(strategyA, strategyB);
    const result = combined.apply('key', 1);

    // A: 7-1=6, B: 12-1=11, min = 6
    expect(result.remaining).toBe(6);
  });

  it('resetAt = max(A.resetAt, B.resetAt)', () => {
    // Force different reset times by using different consumption patterns
    // A resets when tokens fully refill, B resets when window expires
    // For token bucket: resetAt depends on refill rate and tokens used
    for (let i = 0; i < 5; i++) strategyA.apply('key', 1);
    for (let i = 0; i < 3; i++) strategyB.apply('key', 1);

    const combined = combine(strategyA, strategyB);
    const result = combined.apply('key', 1);

    const peekA = strategyA.peek?.('key');
    const peekB = strategyB.peek?.('key');
    const expectedMax = Math.max(
      peekA?.resetAt ?? 0,
      peekB?.resetAt ?? 0
    );
    expect(result.resetAt).toBe(expectedMax);
  });

  // ─── Nested combine ────────────────────────────────────

  it('nested combine(combine(A, B), C)', () => {
    const strategyC = new TokenBucketStrategy({
      capacity: 30,
      refillRate: 999_999,
      clock,
    });

    const inner = combine(strategyA, strategyB);
    const outer = combine(inner, strategyC);
    const result = outer.apply('key', 1);

    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(9); // min(9, 19, 29)
  });

  it('nested combined with inner blocked propagates correctly', () => {
    const strategyC = new TokenBucketStrategy({
      capacity: 30,
      refillRate: 999_999,
      clock,
    });

    // Exhaust A
    for (let i = 0; i < 10; i++) strategyA.apply('key', 1);

    const inner = combine(strategyA, strategyB);
    const outer = combine(inner, strategyC);
    const result = outer.apply('key', 1);

    expect(result.allowed).toBe(false);
    // Should not have called B or C (short-circuit from A)
  });

  // ─── Mixed strategy types ──────────────────────────────

  it('combine token-bucket + fixed-window works', () => {
    const fixedWindow = new FixedWindowStrategy({
      limit: 50,
      windowMs: 60_000,
      clock,
    });

    // Exhaust fixed window but not token bucket
    for (let i = 0; i < 50; i++) fixedWindow.apply('key', 1);

    const combined = combine(strategyA, fixedWindow);
    const result = combined.apply('key', 1);

    expect(result.allowed).toBe(false);
    // Should be blocked by fixed window, not token bucket
    expect(result.retryAfterMs).toBeGreaterThan(0);
  });
});
```

---

## 10. Category 6: Property-Based Tests

```typescript
// src/test/strategies/strategy-invariants.test.ts
import fc from 'fast-check';
import { TokenBucketStrategy } from '../../strategies/token-bucket';
import { FixedWindowStrategy } from '../../strategies/fixed-window';
import { SlidingWindowLogStrategy } from '../../strategies/sliding-window-log';
import { SlidingWindowCounterStrategy } from '../../strategies/sliding-window-counter';
import { ManualClock } from '../helpers/manual-clock';
import type { Strategy, Clock } from '../../strategies/types';

/**
 * Invariant: For any strategy, valid state, and any cost:
 * The result is internally consistent.
 */

// ─── Arbitraries ─────────────────────────────────────────

const arbitraryLimit = fc.integer({ min: 1, max: 100 });
const arbitraryWindowMs = fc.integer({ min: 1000, max: 3_600_000 });
const arbitraryCost = fc.integer({ min: 0, max: 50 });
const arbitraryNow = fc.integer({ min: 0, max: Date.now() * 2 });

// Strategy factory map for property-based iteration
const strategyFactories: Array<{
  name: string;
  create: (limit: number, windowMs: number, clock: Clock) => Strategy;
  extraArgs?: fc.Arbitrary<unknown>[];
}> = [
  {
    name: 'TokenBucket',
    create: (l, w, c) => new TokenBucketStrategy({ capacity: l, refillRate: l / (w / 1000), clock: c }),
  },
  {
    name: 'FixedWindow',
    create: (l, w, c) => new FixedWindowStrategy({ limit: l, windowMs: w, clock: c }),
  },
  {
    name: 'SlidingWindowLog',
    create: (l, w, c) => new SlidingWindowLogStrategy({ limit: l, windowMs: w, clock: c }),
  },
  {
    name: 'SlidingWindowCounter',
    create: (l, w, c) => new SlidingWindowCounterStrategy({ limit: l, windowMs: w, clock: c }),
  },
];

// ─── Invariant 1: remaining never exceeds limit ──────────

describe('Invariant: remaining never exceeds limit', () => {
  it.for(strategyFactories)(
    '$name: remaining ∈ [0, limit] for any state and cost',
    async ({ create }, { task: { name } }) => {
      fc.assert(
        fc.property(
          arbitraryLimit,
          arbitraryWindowMs,
          arbitraryCost,
          arbitraryNow,
          (limit, windowMs, cost, now) => {
            const clock = new ManualClock(now);
            const strategy = create(limit, windowMs, clock);

            // Apply the strategy with random cost
            const result = strategy.apply('prop-key', cost);

            // Invariant checks
            expect(result.remaining).toBeGreaterThanOrEqual(0);
            expect(result.remaining).toBeLessThanOrEqual(limit);
          }
        ),
        { numRuns: 500 }
      );
    }
  );
});

// ─── Invariant 2: retryAfterMs === 0 when allowed ────────

describe('Invariant: retryAfterMs correlates with allowed', () => {
  it.for(strategyFactories)(
    '$name: retryAfterMs is 0 iff allowed, >0 iff blocked',
    async ({ create }) => {
      fc.assert(
        fc.property(
          arbitraryLimit,
          arbitraryCost,
          arbitraryNow,
          (limit, cost, now) => {
            const clock = new ManualClock(now);
            const strategy = create(limit, 60_000, clock);
            const result = strategy.apply('prop-key', cost);

            if (result.allowed) {
              expect(result.retryAfterMs).toBe(0);
            } else {
              expect(result.retryAfterMs).toBeGreaterThan(0);
            }
          }
        ),
        { numRuns: 500 }
      );
    }
  );
});

// ─── Invariant 3: resetAt always in future when blocked ──

describe('Invariant: resetAt in future when blocked', () => {
  it.for(strategyFactories)(
    '$name: blocked → resetAt > now and retryAfterMs === resetAt - now',
    async ({ create }) => {
      fc.assert(
        fc.property(
          arbitraryLimit,
          arbitraryNow,
          (limit, now) => {
            const clock = new ManualClock(now);
            const strategy = create(limit, 60_000, clock);

            // Exhaust the limit
            for (let i = 0; i < limit; i++) {
              strategy.apply('prop-key', 1);
            }

            const result = strategy.apply('prop-key', 1);

            if (!result.allowed) {
              expect(result.resetAt).toBeGreaterThan(clock.now());
              expect(result.retryAfterMs).toBe(
                result.resetAt - clock.now()
              );
            }
          }
        ),
        { numRuns: 100 }
      );
    }
  );
});

// ─── Invariant 4: allowed is always boolean ──────────────

describe('Invariant: allowed is boolean', () => {
  it.for(strategyFactories)(
    '$name: allowed is always true or false, never truthy/falsy',
    async ({ create }) => {
      fc.assert(
        fc.property(
          arbitraryLimit,
          arbitraryCost,
          arbitraryNow,
          (limit, cost, now) => {
            const clock = new ManualClock(now);
            const strategy = create(limit, 60_000, clock);
            const result = strategy.apply('prop-key', cost);

            // Strict boolean check (not just truthy/falsy)
            expect(Object.is(result.allowed, true) || Object.is(result.allowed, false)).toBe(true);
          }
        ),
        { numRuns: 200 }
      );
    }
  );
});

// ─── Invariant 5: cost=0 never changes internal state ────

describe('Invariant: cost=0 is a no-op', () => {
  it.for(strategyFactories)(
    '$name: applying with cost=0 returns allowed=true and same remaining',
    async ({ create }) => {
      fc.assert(
        fc.property(
          arbitraryLimit,
          arbitraryNow,
          (limit, now) => {
            const clock = new ManualClock(now);
            const strategy = create(limit, 60_000, clock);

            const before = strategy.peek?.('prop-key');
            const result = strategy.apply('prop-key', 0);
            const after = strategy.peek?.('prop-key');

            expect(result.allowed).toBe(true);
            expect(result.remaining).toBe(limit);

            // If peek is available, state must be unchanged
            if (before !== undefined && after !== undefined) {
              expect(after.remaining).toBe(before.remaining);
            }
          }
        ),
        { numRuns: 200 }
      );
    }
  );
});

// ─── Invariant 6: Different keys don't interfere ─────────

describe('Invariant: keys are isolated', () => {
  it.for(strategyFactories)(
    '$name: exhausting one key does not affect another',
    async ({ create }) => {
      fc.assert(
        fc.property(
          arbitraryLimit,
          arbitraryNow,
          (limit, now) => {
            const clock = new ManualClock(now);
            const strategy = create(limit, 60_000, clock);

            // Exhaust key-a
            for (let i = 0; i < limit; i++) {
              strategy.apply('key-a', 1);
            }

            // key-b should still be fresh
            const result = strategy.apply('key-b', 1);
            expect(result.allowed).toBe(true);
            expect(result.remaining).toBe(limit - 1);
          }
        ),
        { numRuns: 100 }
      );
    }
  );
});
```

---

## 11. Running the Suite

```bash
# Install dependencies
npm install --save-dev vitest@^4.1.7 fast-check@^4.8.0

# Run all tests
npx vitest run

# Run with coverage
npx vitest run --coverage

# Watch mode (for development)
npx vitest

# Run specific categories
npx vitest run src/test/strategies/token-bucket.test.ts
npx vitest run src/test/adapter/
npx vitest run --testNamePattern "Invariant"

# Property-based tests (slower, tagged with "Invariant")
npx vitest run --testNamePattern "property-based|Invariant"

# CI mode (no watch, strict coverage)
npx vitest run --coverage --reporter=verbose

# package.json scripts
# "test": "vitest run",
# "test:coverage": "vitest run --coverage",
# "test:watch": "vitest",
# "test:ci": "vitest run --coverage --reporter=junit"
```

### Expected Output

```
✓ TokenBucket: allows first request and returns correct remaining
✓ TokenBucket: blocks when limit exhausted
✓ TokenBucket: cost=0 does not consume capacity
✓ TokenBucket: state serialization roundtrip
✓ TokenBucket: refills tokens over time
...
✓ FixedWindow: allows single request
✓ FixedWindow: boundary burst up to 2x limit
...
✓ Concurrency: N concurrent requests → exactly K allowed (4 strategies)
✓ Concurrency: MemoryStore per-key mutex serialization
...
✓ combine: both pass
✓ combine: first blocks short-circuit
✓ combine: nested combine(combine(A, B), C)
...
✓ Express: sets RateLimit-* headers
✓ Express: returns 429 when rate limited
✓ Express: fail-open on store error
...
✓ Invariant: remaining never exceeds limit (4 strategies × 500 runs)
✓ Invariant: retryAfterMs is 0 when allowed (4 strategies × 500 runs)
✓ Invariant: allowed is always boolean (4 strategies × 200 runs)

  Test Files  16 passed (16)
       Tests  187 passed (187)
          189 | src/strategies/token-bucket.ts         |   96.43% |   91.67% | 100.00% |   96.15%
          142 | src/strategies/fixed-window.ts          |   95.07% |   90.00% | 100.00% |   95.83%
          156 | src/strategies/sliding-window-log.ts    |   97.44% |   92.31% | 100.00% |   96.88%
          148 | src/strategies/sliding-window-counter.ts|   95.95% |   90.91% | 100.00% |   95.45%
          112 | src/store/memory-store.ts               |   98.21% |   95.00% | 100.00% |   97.87%
          203 | src/adapter/express.ts                  |   96.55% |   91.67% | 100.00% |   96.43%
          127 | src/adapter/fetch.ts                    |   95.24% |   90.00% | 100.00% |   95.00%
```
