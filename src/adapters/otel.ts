import type { Limiter, ConcurrencyGuard, RateLimitResult } from '../core/types.js';

// ---------------------------------------------------------------------------
// OTEL types (duck-typed to avoid hard dep on @opentelemetry/api)
// ---------------------------------------------------------------------------

interface OtelMeter {
  createCounter(name: string, options?: { description?: string; unit?: string }): OtelCounter;
  createHistogram(name: string, options?: { description?: string; unit?: string }): OtelHistogram;
  createUpDownCounter(name: string, options?: { description?: string; unit?: string }): OtelUpDownCounter;
}

interface OtelCounter {
  add(value: number, attributes?: Record<string, string>): void;
}

interface OtelHistogram {
  record(value: number, attributes?: Record<string, string>): void;
}

interface OtelUpDownCounter {
  add(value: number, attributes?: Record<string, string>): void;
}

// ---------------------------------------------------------------------------
// instrumentLimiter
// ---------------------------------------------------------------------------

/**
 * Wrap a Limiter with OpenTelemetry metrics instrumentation.
 *
 * Metrics emitted:
 * - `throttlekit.checks` (counter): tagged with `{ allowed: "true" | "false", strategy: string }`
 * - `throttlekit.store.latency` (histogram): store operation latency in ms
 *
 * @param limiter - The Limiter to instrument
 * @param meter - An OpenTelemetry Meter instance (duck-typed)
 * @returns A wrapped Limiter that emits metrics on each check
 *
 * @throws If the `meter` parameter does not look like an OTEL meter
 *
 * @example
 * ```typescript
 * import { metrics } from '@opentelemetry/api';
 * const meter = metrics.getMeter('throttlekit');
 * const instrumented = instrumentLimiter(limiter, meter);
 * ```
 */
export function instrumentLimiter(limiter: Limiter, meter: unknown): Limiter {
  assertMeter(meter);

  const checksCounter = (meter as OtelMeter).createCounter('throttlekit.checks', {
    description: 'Number of rate-limit checks performed',
    unit: '1',
  });

  const latencyHistogram = (meter as OtelMeter).createHistogram('throttlekit.store.latency', {
    description: 'Store operation latency in milliseconds',
    unit: 'ms',
  });

  const wrapped: Limiter = {
    async check(key: string, cost?: number): Promise<RateLimitResult> {
      const start = performance.now();
      try {
        const result = await limiter.check(key, cost);

        checksCounter.add(1, {
          allowed: result.allowed ? 'true' : 'false',
          key: key,
        });

        return result;
      } finally {
        latencyHistogram.record(performance.now() - start, {
          key: key,
        });
      }
    },
  };

  return wrapped;
}

// ---------------------------------------------------------------------------
// instrumentGuard
// ---------------------------------------------------------------------------

/**
 * Wrap a ConcurrencyGuard with OpenTelemetry metrics instrumentation.
 *
 * Metrics emitted:
 * - `throttlekit.guard.inflight` (up-down counter): current inflight count
 * - `throttlekit.guard.limit` (gauge-like via up-down counter): configured limit
 *
 * @param guard - The ConcurrencyGuard to instrument
 * @param meter - An OpenTelemetry Meter instance (duck-typed)
 * @returns A wrapped ConcurrencyGuard that emits metrics on acquire
 */
export function instrumentGuard(guard: ConcurrencyGuard, meter: unknown): ConcurrencyGuard {
  assertMeter(meter);

  const inflightGauge = (meter as OtelMeter).createUpDownCounter('throttlekit.guard.inflight', {
    description: 'Current number of inflight requests',
    unit: '1',
  });

  const limitGauge = (meter as OtelMeter).createUpDownCounter('throttlekit.guard.limit', {
    description: 'Configured concurrency limit',
    unit: '1',
  });

  // Set initial limit value
  limitGauge.add(guard.limit);

  const wrapped: ConcurrencyGuard = {
    get limit(): number {
      return guard.limit;
    },
    get inflight(): number {
      return guard.inflight;
    },
    acquire() {
      const lease = guard.acquire();
      inflightGauge.add(1);

      const originalRelease = lease.release.bind(lease);
      lease.release = (opts?: { dropped?: boolean }) => {
        inflightGauge.add(-1);
        originalRelease(opts);
      };

      return lease;
    },
    stats() {
      return guard.stats();
    },
  };

  return wrapped;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function assertMeter(meter: unknown): asserts meter is OtelMeter {
  if (!meter || typeof meter !== 'object') {
    throw new Error(
      'OpenTelemetry Meter is required. ' +
        'Install @opentelemetry/api as a dependency and pass a valid Meter instance.',
    );
  }

  // Duck-type check
  const m = meter as Record<string, unknown>;
  if (
    typeof m.createCounter !== 'function' ||
    typeof m.createHistogram !== 'function'
  ) {
    throw new Error(
      'Invalid Meter: expected an OpenTelemetry Meter instance. ' +
        'Install @opentelemetry/api (npm install @opentelemetry/api) ' +
        'and pass metrics.getMeter("throttlekit") as the meter argument.',
    );
  }
}

// Re-export type for convenience
export type { OtelMeter };
