/**
 * Benchmark: MemoryStore.apply() throughput.
 *
 * Tests concurrent store operations with multiple keys.
 * Uses ManualClock for deterministic timing.
 */

import { performance } from 'node:perf_hooks';
import { MemoryStore } from '../src/stores/memory-store.js';
import { ManualClock } from '../src/core/clock.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const WARMUP_ITERATIONS = 1000;
const MEASUREMENT_MS = 1000;
const KEY_COUNTS = [1, 10, 100, 1000];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createStore() {
  const clock = new ManualClock(1_000_000_000_000);
  return { store: new MemoryStore({ clock }), clock };
}

/**
 * Creates a transform function that counts up to a limit.
 */
function createCounterTransform(limit) {
  return (prev) => {
    const count = (prev?.count ?? 0) + 1;
    if (count > limit) {
      return { state: prev ?? { count: 0 }, result: { allowed: false, remaining: 0 } };
    }
    return { state: { count }, result: { allowed: true, remaining: limit - count } };
  };
}

/**
 * Run the benchmark for a given number of concurrent keys.
 * Returns the average nanoseconds per operation across all keys.
 */
async function benchmarkStore(keyCount, durationMs = MEASUREMENT_MS) {
  const { store } = createStore();
  const keys = Array.from({ length: keyCount }, (_, i) => `key-${i}`);
  const transform = createCounterTransform(Number.MAX_SAFE_INTEGER);

  // Warmup: run 100 apply() calls with each key
  for (let i = 0; i < WARMUP_ITERATIONS; i++) {
    const key = keys[i % keyCount];
    await store.apply(key, 60_000, transform);
  }

  // Measure: round-robin across keys
  const start = performance.now();
  let ops = 0;
  let elapsed = 0;

  while (elapsed < durationMs) {
    const key = keys[ops % keyCount];
    await store.apply(key, 60_000, transform);
    ops++;
    elapsed = performance.now() - start;
  }

  const totalNs = elapsed * 1e6;
  const nsPerOp = totalNs / ops;
  const opsPerSec = (ops / elapsed) * 1000;

  return { ops, elapsedMs: elapsed, opsPerSec, nsPerOp, keyCount };
}

// ---------------------------------------------------------------------------
// Run benchmarks
// ---------------------------------------------------------------------------

async function main() {
  console.log('\n=== MemoryStore.apply() Throughput Benchmarks ===\n');
  console.log(`${'Concurrent Keys'.padEnd(20)} ${'Ops/sec'.padStart(14)} ${'ns/op'.padStart(10)}`);
  console.log('-'.repeat(46));

  for (const keyCount of KEY_COUNTS) {
    const result = await benchmarkStore(keyCount);
    console.log(
      `${`${result.keyCount} keys`.padEnd(20)} ${result.opsPerSec.toFixed(2).padStart(12)} ${result.nsPerOp.toFixed(2).padStart(10)}`,
    );
  }

  console.log('\n✅ Store benchmarks complete.\n');
}

main().catch((err) => {
  console.error('Store benchmark failed:', err);
  process.exit(1);
});
