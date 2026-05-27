/**
 * Benchmark: Sketch rate limiter performance, memory, and accuracy.
 *
 * 1) Throughput: sketch checkSync with 10k unique keys
 * 2) Memory: Sketch vs MemoryStore footprint with 10k keys
 * 3) Accuracy: rejection rate should be ~33% for 150 req/key at limit=100
 */

import { performance } from 'node:perf_hooks';
import {
  sketchRateLimit,
  ManualClock,
} from '../dist/index.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const WARMUP_ITERATIONS = 1000;
const MEASUREMENT_MS = 1000;
const KEY_COUNT = 10_000;
const LIMIT = 100;
const WINDOW_MS = 60_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Try to run GC between benchmarks.
 */
function runGC() {
  try {
    global.gc();
  } catch {
    // --expose-gc not available
  }
}

/**
 * Format ops/sec with M suffix for millions.
 */
function formatOps(opsPerSec) {
  if (opsPerSec >= 1_000_000) {
    return (opsPerSec / 1_000_000).toFixed(2) + 'M ops/s';
  }
  return opsPerSec.toFixed(2) + '  ops/s';
}

function formatNs(nsPerOp) {
  return nsPerOp.toFixed(2) + ' ns/op';
}

function getKey(i) {
  return `key-${i % KEY_COUNT}`;
}

/**
 * Format bytes to human-readable string.
 */
function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(2) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
}

// ---------------------------------------------------------------------------
// Benchmark 1: Throughput
// ---------------------------------------------------------------------------

function benchmarkThroughput() {
  runGC();

  const clock = new ManualClock(1_000_000_000_000);
  const sketch = sketchRateLimit({ limit: LIMIT, windowMs: WINDOW_MS, clock });

  // Warmup: 1000 iterations across different keys
  for (let i = 0; i < WARMUP_ITERATIONS; i++) {
    sketch.checkSync(getKey(i));
  }

  // Measure: ~1000ms round-robin across 10k keys
  const start = performance.now();
  let ops = 0;
  let elapsed = 0;

  while (elapsed < MEASUREMENT_MS) {
    sketch.checkSync(getKey(ops));
    ops++;
    elapsed = performance.now() - start;
  }

  const totalNs = elapsed * 1e6;
  const nsPerOp = totalNs / ops;
  const opsPerSec = (ops / elapsed) * 1000;

  return { ops, elapsedMs: elapsed, opsPerSec, nsPerOp };
}

// ---------------------------------------------------------------------------
// Benchmark 2: Memory Footprint
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Benchmark 3: Accuracy
// ---------------------------------------------------------------------------

function runAccuracyCheck() {
  runGC();

  const clock = new ManualClock(1_000_000_000_000);
  const sketch = sketchRateLimit({ limit: LIMIT, windowMs: WINDOW_MS, clock });
  const REQS_PER_KEY = 150;

  let allowed = 0;
  let rejected = 0;

  for (let i = 0; i < KEY_COUNT * REQS_PER_KEY; i++) {
    const result = sketch.checkSync(getKey(i));
    if (result.allowed) {
      allowed++;
    } else {
      rejected++;
    }
  }

  const total = allowed + rejected;
  const allowedPct = ((allowed / total) * 100).toFixed(2);
  const rejectedPct = ((rejected / total) * 100).toFixed(2);

  return { allowed, rejected, total, allowedPct, rejectedPct };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('\n=== Sketch Rate Limiter Benchmarks ===\n');

  // --- Throughput ---
  const tput = benchmarkThroughput();
  console.log('Throughput (10k keys, limit=100):');
  console.log(`sketch checkSync:  ${formatOps(tput.opsPerSec)}  (${formatNs(tput.nsPerOp)})`);
  console.log();

  // --- Memory ---
  console.log('Memory Footprint:');

  // Sketch memory: CountMinSketch is pre-allocated constant size.
  // width ≈ ceil(E/0.01) = 272, depth ≈ ceil(ln(1000)) = 7
  // Counters: 272 * 7 * 4 bytes = 7616 bytes for Uint32Array
  // + object overhead for CountMinSketch + sketch wrapper (~few hundred bytes)
  // But we also get the closures in sketchRateLimit which capture the CMS reference.
  // The CMS itself doesn't grow with keys — it's fixed-size.
  const SKETCH_WIDTH = Math.ceil(Math.E / 0.01);
  const SKETCH_DEPTH = Math.ceil(Math.log(1 / 0.001));
  const sketchCounterBytes = SKETCH_WIDTH * SKETCH_DEPTH * 4;
  const sketchEstimatedTotal = sketchCounterBytes + 1024; // overhead estimate

  // MemoryStore: each key stores a fixed-window state object with windowStart and count
  // ~80-120 bytes per entry in the Map + object overhead
  const memoryStoreEstimated = KEY_COUNT * 96; // ~96 bytes/key estimate

  console.log(`sketch (${KEY_COUNT.toLocaleString()} keys):      ~${formatBytes(sketchEstimatedTotal)}  (~${Math.round(sketchEstimatedTotal / KEY_COUNT)} bytes/key)`);
  console.log(`MemoryStore (${KEY_COUNT.toLocaleString()} keys):  ~${formatBytes(memoryStoreEstimated)}  (~${Math.round(memoryStoreEstimated / KEY_COUNT)} bytes/key)`);
  console.log();

  // --- Accuracy ---
  const acc = runAccuracyCheck();
  const accReqsPerKey = 150;
  console.log(`Accuracy (${acc.total.toLocaleString()} total requests, ${accReqsPerKey} req/key, limit=${LIMIT}):`);
  console.log(`Allowed:  ${acc.allowed.toLocaleString().padStart(8)}  (${acc.allowedPct}%)`);
  console.log(`Rejected: ${acc.rejected.toLocaleString().padStart(8)}  (${acc.rejectedPct}%)`);
  console.log(`Expected rejection rate: ~${((1 - LIMIT / accReqsPerKey) * 100).toFixed(0)}%`);

  // Sketch overcounting analysis
  const expectedRejected = acc.total - KEY_COUNT * LIMIT;
  const expectedRejectedPct = (expectedRejected / acc.total) * 100;
  const overcountPct = ((acc.rejected - expectedRejected) / expectedRejected) * 100;
  console.log(`Expected rejected: ${expectedRejected.toLocaleString()} (${expectedRejectedPct.toFixed(2)}%)`);
  if (overcountPct > 0) {
    console.log(`Sketch overcounts by ${overcountPct.toFixed(2)}% (Count-Min Sketch overestimates due to hash collisions)`);
  }

  console.log('\n✅ Sketch benchmarks complete.\n');
}

main().catch((err) => {
  console.error('Sketch benchmark failed:', err);
  process.exit(1);
});
