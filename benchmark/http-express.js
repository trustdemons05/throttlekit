/**
 * Benchmark: Express adapter overhead.
 *
 * Tests the expressAdapter() middleware with mock req/res objects.
 * No real HTTP server is started — purely measures the middleware
 * function call overhead including the limiter.check() path.
 */

import { performance } from 'node:perf_hooks';
import { rateLimit } from '../src/core/limiter.js';
import { expressAdapter } from '../src/adapters/express.js';
import { MemoryStore } from '../src/stores/memory-store.js';
import { ManualClock } from '../src/core/clock.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const WARMUP_ITERATIONS = 1000;
const MEASUREMENT_MS = 1000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockReqRes() {
  const req = { ip: '10.0.0.1', headers: {} };
  const res = {
    statusCode: 200,
    headers: {},
    setHeader(name, value) {
      this.headers[name] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
    },
  };
  const next = () => {};
  return { req, res, next };
}

/**
 * Create a fresh limiter + express adapter pair.
 */
function createBenchmarkFixture() {
  const clock = new ManualClock(1_000_000_000_000);
  const store = new MemoryStore({ clock });
  const limiter = rateLimit({
    strategy: 'fixed-window',
    limit: 10000,
    windowMs: 60_000,
    clock,
    store,
  });
  const middleware = expressAdapter(limiter);
  return { middleware, clock };
}

/**
 * Benchmark the express middleware.
 * Returns ops/sec and ns/op.
 */
async function benchmarkMiddleware(fn, durationMs = MEASUREMENT_MS) {
  // Warmup
  for (let i = 0; i < WARMUP_ITERATIONS; i++) {
    const { req, res, next } = createMockReqRes();
    await fn(req, res, next);
  }

  // Measure
  const start = performance.now();
  let ops = 0;
  let elapsed = 0;

  while (elapsed < durationMs) {
    const { req, res, next } = createMockReqRes();
    await fn(req, res, next);
    ops++;
    elapsed = performance.now() - start;
  }

  const totalNs = elapsed * 1e6;
  const nsPerOp = totalNs / ops;
  const opsPerSec = (ops / elapsed) * 1000;

  return { ops, elapsedMs: elapsed, opsPerSec, nsPerOp };
}

// ---------------------------------------------------------------------------
// Run benchmarks
// ---------------------------------------------------------------------------

async function main() {
  console.log('\n=== Express Adapter Overhead Benchmarks ===\n');

  // Benchmark 1: Request within limit (allowed path)
  {
    const { middleware } = createBenchmarkFixture();
    const result = await benchmarkMiddleware(middleware);
    console.log('Scenario: Allowed request (within limit)');
    console.log(`  ${'Ops/sec:'.padEnd(12)} ${result.opsPerSec.toFixed(2)}`);
    console.log(`  ${'ns/op:'.padEnd(12)} ${result.nsPerOp.toFixed(2)}`);
    console.log(`  ${'Duration:'.padEnd(12)} ${result.elapsedMs.toFixed(0)} ms`);
    console.log(`  ${'Total ops:'.padEnd(12)} ${result.ops}`);
    console.log();
  }

  // Benchmark 2: Request that is blocked (exhausted limit)
  {
    const { middleware, clock } = createBenchmarkFixture();

    // Exhaust the limiter by making limit+1 requests first
    for (let i = 0; i < 10001; i++) {
      const { req, res, next } = createMockReqRes();
      await middleware(req, res, next);
    }

    const result = await benchmarkMiddleware(middleware);
    console.log('Scenario: Blocked request (rate limited)');
    console.log(`  ${'Ops/sec:'.padEnd(12)} ${result.opsPerSec.toFixed(2)}`);
    console.log(`  ${'ns/op:'.padEnd(12)} ${result.nsPerOp.toFixed(2)}`);
    console.log(`  ${'Duration:'.padEnd(12)} ${result.elapsedMs.toFixed(0)} ms`);
    console.log(`  ${'Total ops:'.padEnd(12)} ${result.ops}`);
    console.log();
  }

  // Benchmark 3: Mixed keys (multi-tenant scenario)
  {
    const { middleware } = createBenchmarkFixture();

    // Measure with varying IPs (like real multi-tenant traffic)
    const start = performance.now();
    let ops = 0;
    let elapsed = 0;

    for (let i = 0; i < WARMUP_ITERATIONS; i++) {
      const { req, res, next } = createMockReqRes();
      req.ip = `10.0.0.${i % 256}`;
      await middleware(req, res, next);
    }

    while (elapsed < MEASUREMENT_MS) {
      const { req, res, next } = createMockReqRes();
      req.ip = `10.0.0.${ops % 256}`;
      await middleware(req, res, next);
      ops++;
      elapsed = performance.now() - start;
    }

    const totalNs = elapsed * 1e6;
    const nsPerOp = totalNs / ops;
    const opsPerSec = (ops / elapsed) * 1000;

    console.log('Scenario: Multi-tenant (256 IPs, round-robin)');
    console.log(`  ${'Ops/sec:'.padEnd(12)} ${opsPerSec.toFixed(2)}`);
    console.log(`  ${'ns/op:'.padEnd(12)} ${nsPerOp.toFixed(2)}`);
    console.log(`  ${'Duration:'.padEnd(12)} ${elapsed.toFixed(0)} ms`);
    console.log(`  ${'Total ops:'.padEnd(12)} ${ops}`);
    console.log();
  }

  console.log('✅ Express adapter benchmarks complete.\n');
}

main().catch((err) => {
  console.error('Express adapter benchmark failed:', err);
  process.exit(1);
});
