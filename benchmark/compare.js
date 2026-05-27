/**
 * Benchmark: Head-to-head comparison against competitors.
 *
 * Compares ThrottleKit's GCRA and fixed-window strategies against
 * rate-limiter-flexible's RateLimiterMemory and express-rate-limit's MemoryStore.
 *
 * Methodology:
 *   - Warmup: 1000 iterations discarded
 *   - Measurement: run for ~1000ms (time-based, not fixed count)
 *   - Reports ops/s and ns/op using performance.now() from node:perf_hooks
 *   - Runs GC between benchmarks if --expose-gc is available
 */

import { performance } from 'node:perf_hooks';
import {
  createGcraStrategy,
  createFixedWindowStrategy,
  LimiterImpl,
  MemoryStore as ThrottleKitMemoryStore,
  ManualClock,
  rateLimit,
} from '../dist/index.js';
import { RateLimiterMemory } from 'rate-limiter-flexible';
import { MemoryStore as ExpressMemoryStore } from 'express-rate-limit';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const WARMUP_ITERATIONS = 1000;
const MEASUREMENT_MS = 1000; // Run each benchmark for 1 second wall-clock
const KEY = 'benchmark-key';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Try to run GC between benchmarks. Only works with --expose-gc flag.
 */
function runGC() {
  try {
    global.gc();
  } catch {
    // --expose-gc not available, skip
  }
}

/**
 * Format ops/sec to a readable string (with M suffix for millions).
 */
function formatOps(opsPerSec) {
  if (opsPerSec >= 1_000_000) {
    return (opsPerSec / 1_000_000).toFixed(2) + 'M ops/s';
  }
  return opsPerSec.toFixed(2).padStart(10) + '  ops/s';
}

/**
 * Format ns/op.
 */
function formatNs(nsPerOp) {
  return nsPerOp.toFixed(2) + ' ns/op';
}

/**
 * Format a benchmark result line.
 */
function formatLine(name, opsPerSec, nsPerOp) {
  const pad = name.length < 42 ? name.padEnd(42) : name;
  const ops = formatOps(opsPerSec);
  const ns = formatNs(nsPerOp);
  return `${pad} ${ops}  (${ns})`;
}

/**
 * Run a synchronous benchmark.
 * Calls fn() repeatedly for ~durationMs.
 * Returns { ops, elapsedMs, opsPerSec, nsPerOp }.
 */
function benchmarkSync(fn, durationMs = MEASUREMENT_MS) {
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

/**
 * Run an asynchronous benchmark.
 * Calls fn() repeatedly for ~durationMs.
 * Returns { ops, elapsedMs, opsPerSec, nsPerOp }.
 */
async function benchmarkAsync(fn, durationMs = MEASUREMENT_MS) {
  // Warmup
  for (let i = 0; i < WARMUP_ITERATIONS; i++) {
    await fn();
  }

  // Measure
  const start = performance.now();
  let ops = 0;
  let elapsed = 0;

  while (elapsed < durationMs) {
    await fn();
    ops++;
    elapsed = performance.now() - start;
  }

  const totalNs = elapsed * 1e6;
  const nsPerOp = totalNs / ops;
  const opsPerSec = (ops / elapsed) * 1000;

  return { ops, elapsedMs: elapsed, opsPerSec, nsPerOp };
}

// ---------------------------------------------------------------------------
// Benchmark Suite
// ---------------------------------------------------------------------------

async function main() {
  console.log('\n=== In-Memory, Single Hot Key ===\n');

  // ---------------------------------------------------------------
  // 1) ThrottleKit GCRA checkSync
  // ---------------------------------------------------------------
  runGC();

  const gcClock1 = new ManualClock(1_000_000_000_000);
  const gcStore1 = new ThrottleKitMemoryStore({ clock: gcClock1 });
  const gcStrategy1 = createGcraStrategy({ limit: 100, periodMs: 60000, burst: 100, clock: gcClock1 });
  const gcraLimiterSync = new LimiterImpl(gcStrategy1, gcStore1, 60000);

  const resultGCRA = benchmarkSync(() => gcraLimiterSync.checkSync(KEY));
  console.log(formatLine('throttlekit GCRA checkSync:', resultGCRA.opsPerSec, resultGCRA.nsPerOp));

  // ---------------------------------------------------------------
  // 2) rate-limiter-flexible consume (async)
  // ---------------------------------------------------------------
  runGC();

  const rlFlexible = new RateLimiterMemory({ points: 100, duration: 60 });

  const resultRLF = await benchmarkAsync(async () => {
    try {
      await rlFlexible.consume(KEY);
    } catch {
      // Expected when rate limited — ignore
    }
  });
  console.log(formatLine('rate-limiter-flexible (async):', resultRLF.opsPerSec, resultRLF.nsPerOp));

  // ---------------------------------------------------------------
  // 3) ThrottleKit GCRA check (async)
  // ---------------------------------------------------------------
  runGC();

  const gcClock2 = new ManualClock(1_000_000_000_000);
  const gcStore2 = new ThrottleKitMemoryStore({ clock: gcClock2 });
  const gcStrategy2 = createGcraStrategy({ limit: 100, periodMs: 60000, burst: 100, clock: gcClock2 });
  const gcraLimiterAsync = new LimiterImpl(gcStrategy2, gcStore2, 60000);

  const resultGCRAAsync = await benchmarkAsync(() => gcraLimiterAsync.check(KEY));
  console.log(formatLine('throttlekit GCRA check (async):', resultGCRAAsync.opsPerSec, resultGCRAAsync.nsPerOp));

  // ---------------------------------------------------------------
  // 4) ThrottleKit fixed-window check (async)
  // ---------------------------------------------------------------
  runGC();

  const fwClock = new ManualClock(1_000_000_000_000);
  const fwStore = new ThrottleKitMemoryStore({ clock: fwClock });
  const fwLimiter = rateLimit({
    strategy: 'fixed-window',
    store: fwStore,
    clock: fwClock,
    limit: 100,
    windowMs: 60000,
  });

  const resultFW = await benchmarkAsync(() => fwLimiter.check(KEY));
  console.log(formatLine('throttlekit fixed-window (async):', resultFW.opsPerSec, resultFW.nsPerOp));

  // ---------------------------------------------------------------
  // 5) express-rate-limit MemoryStore increment (async)
  // ---------------------------------------------------------------
  runGC();

  // express-rate-limit MemoryStore stores hits in a Map
  // increment(key) returns { totalHits, resetTime }
  const expressStore = new ExpressMemoryStore(60000);

  const resultExpress = await benchmarkAsync(async () => {
    await expressStore.increment(KEY);
  });
  console.log(formatLine('express-rate-limit (async):', resultExpress.opsPerSec, resultExpress.nsPerOp));

  // ---------------------------------------------------------------
  // Summary
  // ---------------------------------------------------------------
  console.log('\n✅ Comparative benchmarks complete.\n');
}

main().catch((err) => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
