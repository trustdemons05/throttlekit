/**
 * Benchmark: Strategy algorithm throughput.
 *
 * Tests raw strategy.apply() performance for all 4 strategies.
 * Uses ManualClock to avoid real time drift. Measures operations
 * per second and nanoseconds per operation using perf_hooks.
 */

import { performance } from 'node:perf_hooks';
import { createTokenBucketStrategy } from '../src/strategies/token-bucket.js';
import { createFixedWindowStrategy } from '../src/strategies/fixed-window.js';
import { createSlidingLogStrategy } from '../src/strategies/sliding-window-log.js';
import { createSlidingCounterStrategy } from '../src/strategies/sliding-window-counter.js';
import { ManualClock } from '../src/core/clock.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const WARMUP_ITERATIONS = 1000;
const MEASUREMENT_MS = 1000; // Run each strategy for 1 second
const KEY = 'benchmark-key';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Run a benchmark loop for a given function.
 * Returns average nanoseconds per operation.
 */
function benchmark(fn, durationMs = MEASUREMENT_MS) {
  // Warmup
  for (let i = 0; i < WARMUP_ITERATIONS; i++) {
    fn();
  }

  // Measure
  const start = performance.now();
  let ops = 0;
  let elapsed = 0;

  while (elapsed < durationMs) {
    fn();
    ops++;
    elapsed = performance.now() - start;
  }

  const totalNs = elapsed * 1e6;
  const nsPerOp = totalNs / ops;
  const opsPerSec = (ops / elapsed) * 1000;

  return { ops, elapsedMs: elapsed, opsPerSec, nsPerOp };
}

// ---------------------------------------------------------------------------
// Benchmark each strategy
// ---------------------------------------------------------------------------

console.log('\n=== Strategy Algorithm Benchmarks ===\n');
console.log(`${'Strategy'.padEnd(30)} ${'Ops/sec'.padStart(14)} ${'ns/op'.padStart(10)}`);
console.log('-'.repeat(56));

const strategies = [
  {
    name: 'token-bucket (capacity=100)',
    factory: () => {
      const clock = new ManualClock(1_000_000_000_000);
      return createTokenBucketStrategy({ capacity: 100, refillRate: 10, clock });
    },
  },
  {
    name: 'token-bucket (capacity=10000)',
    factory: () => {
      const clock = new ManualClock(1_000_000_000_000);
      return createTokenBucketStrategy({ capacity: 10000, refillRate: 1000, clock });
    },
  },
  {
    name: 'fixed-window (limit=100)',
    factory: () => {
      const clock = new ManualClock(1_000_000_000_000);
      return createFixedWindowStrategy({ limit: 100, windowMs: 60_000, clock });
    },
  },
  {
    name: 'sliding-window-log (limit=100)',
    factory: () => {
      const clock = new ManualClock(1_000_000_000_000);
      return createSlidingLogStrategy({ limit: 100, windowMs: 60_000, clock });
    },
  },
  {
    name: 'sliding-window-counter (limit=100)',
    factory: () => {
      const clock = new ManualClock(1_000_000_000_000);
      return createSlidingCounterStrategy({ limit: 100, windowMs: 60_000, clock });
    },
  },
];

for (const { name, factory } of strategies) {
  // Benchmark the apply() call
  const strategy = factory();

  // Warm up with a few different keys
  for (let i = 0; i < 100; i++) {
    strategy.apply(`warmup-key-${i}`, 1);
  }

  const result = benchmark(() => strategy.apply(KEY, 1));

  console.log(
    `${name.padEnd(30)} ${result.opsPerSec.toFixed(2).padStart(12)} ${result.nsPerOp.toFixed(2).padStart(10)}`,
  );
}

console.log('\n✅ Strategy benchmarks complete.\n');
