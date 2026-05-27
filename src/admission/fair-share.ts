import type { Clock, RateLimitResult } from '../core/types.js';
import { SystemClock } from '../core/clock.js';

export interface FairShareOptions {
  /** Maximum total requests per window across all tenants */
  limit: number;
  /** Window duration in milliseconds */
  windowMs: number;
  /** Clock for deterministic testing */
  clock?: Clock;
}

export interface FairShareLimiter {
  /**
   * Synchronously check if a request for the given tenant is allowed.
   */
  checkSync(tenantId: string): RateLimitResult;
  /**
   * Async check (wraps checkSync in Promise.resolve).
   */
  check(tenantId: string): Promise<RateLimitResult>;
  /** Reset all state. */
  reset(): void;
}

/**
 * Create a per-tenant fair-share rate limiter.
 *
 * Each active tenant is guaranteed at least `limit / activeTenants` capacity,
 * with unused capacity redistributed to other tenants.
 */
export function fairShare(options: FairShareOptions): FairShareLimiter {
  const { limit, windowMs, clock = new SystemClock() } = options;

  let windowStart = clock.now();
  const usage = new Map<string, number>();

  function checkSync(tenantId: string): RateLimitResult {
    const now = clock.now();

    // Rotate window if expired
    if (now >= windowStart + windowMs) {
      usage.clear();
      windowStart = now;
    }

    const activeTenants = usage.size;

    // Compute fair capacity per tenant
    let fairCap: number;
    if (activeTenants === 0) {
      // First tenant in this window gets full limit
      fairCap = limit;
    } else {
      fairCap = limit / activeTenants;
    }

    const currentUsage = usage.get(tenantId) ?? 0;
    const globalSum = Array.from(usage.values()).reduce((s, v) => s + v, 0);

    const allowed = currentUsage + 1 <= fairCap && globalSum + 1 <= limit;

    if (allowed) {
      usage.set(tenantId, currentUsage + 1);
    }

    const resetAt = windowStart + windowMs;
    const retryAfterMs = allowed ? 0 : resetAt - now;
    const remaining = Math.max(0, limit - (allowed ? globalSum + 1 : globalSum));

    return { allowed, limit, remaining, resetAt, retryAfterMs };
  }

  return {
    checkSync,
    check(tenantId: string): Promise<RateLimitResult> {
      return Promise.resolve(checkSync(tenantId));
    },
    reset(): void {
      usage.clear();
      windowStart = clock.now();
    },
  };
}
