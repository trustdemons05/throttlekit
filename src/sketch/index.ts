import type { Clock, RateLimitResult } from '../core/types.js';
import { SystemClock } from '../core/clock.js';
import { CountMinSketch } from './cms.js';
import type {
  SketchRateLimitOptions,
  SketchRateLimiter,
  MergeableSketchOptions,
  MergeableSketch,
  SketchSnapshot,
} from './types.js';

export type {
  SketchRateLimitOptions,
  SketchRateLimiter,
  MergeableSketchOptions,
  MergeableSketch,
  SketchSnapshot,
};

// ---------------------------------------------------------------------------
// Default dimension calculations
// ---------------------------------------------------------------------------

function defaultWidth(epsilon: number): number {
  return Math.ceil(Math.E / epsilon);
}

function defaultDepth(delta: number): number {
  return Math.ceil(Math.log(1 / delta));
}

// ---------------------------------------------------------------------------
// Basic Sketch Rate Limiter
// ---------------------------------------------------------------------------

/**
 * Create a Count-Min Sketch rate limiter.
 *
 * Uses a single CMS to probabilistically track request counts within a
 * fixed window. Provides memory-efficient approximate counting with
 * tunable error bounds.
 *
 * @param options.limit    - Maximum requests allowed per window
 * @param options.windowMs - Window duration in milliseconds
 * @param options.epsilon  - CMS error rate (width = ceil(E/epsilon)), default 0.01
 * @param options.delta    - CMS confidence (depth = ceil(ln(1/delta))), default 0.001
 * @param options.clock    - Clock implementation (injected for deterministic testing)
 */
export function sketchRateLimit(options: SketchRateLimitOptions): SketchRateLimiter {
  const {
    limit,
    windowMs,
    epsilon = 0.01,
    delta = 0.001,
    clock = new SystemClock(),
  } = options;

  const width = defaultWidth(epsilon);
  const depth = defaultDepth(delta);
  const cms = new CountMinSketch(width, depth);
  let windowStart: number = clock.now();

  function checkSync(key: string): RateLimitResult {
    const now = clock.now();

    // Window rotation
    if (now >= windowStart + windowMs) {
      cms.reset();
      windowStart = now;
    }

    const estimate = cms.estimate(key);
    const allowed = estimate + 1 <= limit;

    if (allowed) {
      cms.increment(key, 1);
    }

    const remaining = Math.max(0, limit - cms.estimate(key));
    const resetAt = windowStart + windowMs;
    const retryAfterMs = allowed ? 0 : resetAt - now;

    return { allowed, limit, remaining, resetAt, retryAfterMs };
  }

  return {
    check(key: string): Promise<RateLimitResult> {
      return Promise.resolve(checkSync(key));
    },
    checkSync,
    reset(): void {
      cms.reset();
      windowStart = clock.now();
    },
  };
}

// ---------------------------------------------------------------------------
// Mergeable Sketch Rate Limiter
// ---------------------------------------------------------------------------

/**
 * Create a mergeable Count-Min Sketch rate limiter.
 *
 * Extends the base sketch with snapshot, serialization, and merge capabilities
 * for distributed rate-limiting scenarios.
 */
export function mergeableSketch(options: MergeableSketchOptions): MergeableSketch {
  const {
    limit,
    windowMs,
    epsilon = 0.01,
    delta = 0.001,
    clock = new SystemClock(),
  } = options;

  const width = defaultWidth(epsilon);
  const depth = defaultDepth(delta);
  const cms = new CountMinSketch(width, depth);
  let windowStart: number = clock.now();

  function checkSync(key: string): RateLimitResult {
    const now = clock.now();

    if (now >= windowStart + windowMs) {
      cms.reset();
      windowStart = now;
    }

    const estimate = cms.estimate(key);
    const allowed = estimate + 1 <= limit;

    if (allowed) {
      cms.increment(key, 1);
    }

    const remaining = Math.max(0, limit - cms.estimate(key));
    const resetAt = windowStart + windowMs;
    const retryAfterMs = allowed ? 0 : resetAt - now;

    return { allowed, limit, remaining, resetAt, retryAfterMs };
  }

  return {
    check(key: string): Promise<RateLimitResult> {
      return Promise.resolve(checkSync(key));
    },
    checkSync,
    reset(): void {
      cms.reset();
      windowStart = clock.now();
    },

    snapshot(): SketchSnapshot {
      return {
        counters: cms.snapshot(),
        width,
        depth,
        windowStart,
      };
    },

    toBytes(): Uint8Array {
      return cms.toBytes();
    },

    merge(snapshot: SketchSnapshot): void {
      const temp = new CountMinSketch(snapshot.width, snapshot.depth, snapshot.counters);
      cms.merge(temp);
    },
  };
}

// ---------------------------------------------------------------------------
// Deserialization helper
// ---------------------------------------------------------------------------

/**
 * Reconstruct a snapshot from a byte array.
 *
 * @param bytes - Serialized counter data (length must be width × depth × 4)
 * @param width - Number of columns
 * @param depth - Number of rows
 * @returns A SketchSnapshot; caller should set `windowStart` if needed.
 */
export function sketchSnapshotFromBytes(
  bytes: Uint8Array,
  width: number,
  depth: number,
): SketchSnapshot {
  const expectedLen = width * depth * 4;
  if (bytes.length !== expectedLen) {
    throw new Error(
      `Invalid byte length: expected ${expectedLen}, got ${bytes.length}`,
    );
  }

  const counters = new Uint32Array(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  );
  return { counters, width, depth, windowStart: 0 };
}
