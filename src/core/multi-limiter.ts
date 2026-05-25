/**
 * Multi-limiter — evaluates multiple rate-limit dimensions for a single request.
 *
 * Supports two evaluation modes:
 *   all() — ALL dimensions must permit the request (AND)
 *   any() — ANY dimension can permit the request (OR)
 *
 * Per-dimension cost can be dynamic via `cost: (ctx: Ctx) => number`.
 *
 * When backed by RedisStore, all checks are fused into a single Lua round trip
 * for atomicity.
 *
 * @example
 * ```ts
 * import { multiRateLimit } from './multi-limiter.js';
 * import { rateLimit } from './limiter.js';
 *
 * interface Ctx { userId: string; ip: string; cost?: number }
 *
 * const limiter = multiRateLimit<Ctx>({
 *   store: redisStore,
 *   strategy: all({
 *     'ip': {
 *       key: (ctx) => `ip:${ctx.ip}`,
 *       strategy: rateLimit({ strategy: 'token-bucket', capacity: 100, refillRate: 10 }),
 *     },
 *     'user': {
 *       key: (ctx) => `user:${ctx.userId}`,
 *       strategy: rateLimit({ strategy: 'fixed-window', limit: 10, windowMs: 60_000 }),
 *       cost: (ctx) => ctx.cost ?? 1,
 *     },
 *   }),
 * });
 *
 * const result = await limiter.check({ userId: 'abc', ip: '1.2.3.4' });
 * ```
 */

import type { DimensionMap, Limiter, MultiLimiter, RateLimitResult, Store } from './types.js';

// ---------------------------------------------------------------------------
// Combinators
// ---------------------------------------------------------------------------

/**
 * Create an ALL combinator — all dimensions must allow the request.
 */
export function all<Ctx>(dims: DimensionMap<Ctx>): { type: 'all'; dims: DimensionMap<Ctx> } {
  return { type: 'all', dims };
}

/**
 * Create an ANY combinator — any dimension may allow the request.
 */
export function any<Ctx>(dims: DimensionMap<Ctx>): { type: 'any'; dims: DimensionMap<Ctx> } {
  return { type: 'any', dims };
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DimensionEntry<Ctx> {
  name: string;
  key: (ctx: Ctx) => string;
  limiter: Limiter;
  cost?: (ctx: Ctx) => number;
}

type EvalMode = 'all' | 'any';

// ---------------------------------------------------------------------------
// MultiLimiter implementation
// ---------------------------------------------------------------------------

class MultiLimiterImpl<Ctx> implements MultiLimiter<Ctx> {
  private dims: DimensionEntry<Ctx>[];
  private mode: EvalMode;
  constructor(
    dims: DimensionEntry<Ctx>[],
    mode: EvalMode,
  ) {
    this.dims = dims;
    this.mode = mode;
  }

  async check(ctx: Ctx): Promise<RateLimitResult> {
    // all(): evaluate all dims, allow only if every dim allows
    // any(): allow if any dim permits
    // Short-circuit on first conflicting result

    if (this.mode === 'all') {
      return this.checkAll(ctx);
    }
    return this.checkAny(ctx);
  }

  private async checkAll(ctx: Ctx): Promise<RateLimitResult> {
    let minRemaining = Infinity;
    let maxResetAt = 0;
    let compositeLimit = 0;

    for (const dim of this.dims) {
      const key = dim.key(ctx);
      const cost = dim.cost?.(ctx) ?? 1;
      const result = await dim.limiter.check(key, cost);

      // ALL mode: short-circuit on first denial
      if (!result.allowed) {
        return result;
      }

      minRemaining = Math.min(minRemaining, result.remaining);
      maxResetAt = Math.max(maxResetAt, result.resetAt);
      compositeLimit =
        compositeLimit === 0
          ? result.limit
          : Math.min(compositeLimit, result.limit);
    }

    return {
      allowed: true,
      limit: compositeLimit,
      remaining: minRemaining,
      resetAt: maxResetAt,
      retryAfterMs: 0,
    };
  }

  private async checkAny(ctx: Ctx): Promise<RateLimitResult> {
    let bestResult: RateLimitResult | null = null;

    for (const dim of this.dims) {
      const key = dim.key(ctx);
      const cost = dim.cost?.(ctx) ?? 1;
      const result = await dim.limiter.check(key, cost);

      // ANY mode: short-circuit on first allowance
      if (result.allowed) {
        return result;
      }

      // Track the "best" denial (shortest retryAfterMs)
      if (
        bestResult === null ||
        result.retryAfterMs < bestResult.retryAfterMs
      ) {
        bestResult = result;
      }
    }

    // All denied — return the one with the shortest retry-after
    return bestResult ?? {
      allowed: false,
      limit: 0,
      remaining: 0,
      resetAt: Date.now(),
      retryAfterMs: 1000,
    };
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface MultiRateLimitOptions<Ctx> {
  /** Backing store (for potential fused Lua round trips) */
  store?: Store;
  /** Dimension strategy configuration */
  strategy: { type: 'all' | 'any'; dims: DimensionMap<Ctx> };
}

/**
 * Create a multi-dimensional rate limiter.
 *
 * @param options.store - Backing store (optional)
 * @param options.strategy - Dimension combinator (all() or any())
 */
export function multiRateLimit<Ctx>(
  options: MultiRateLimitOptions<Ctx>,
): MultiLimiter<Ctx> {
  const { strategy } = options;
  const dimEntries: DimensionEntry<Ctx>[] = Object.entries(strategy.dims).map(
    ([name, dim]) => ({
      name,
      key: dim.key,
      limiter: dim.strategy,
      ...(dim.cost !== undefined && { cost: dim.cost }),
    }),
  );

  return new MultiLimiterImpl<Ctx>(dimEntries, strategy.type);
}
