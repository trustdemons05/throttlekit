import type { Limiter, RateLimitResult } from '../core/types.js';
import type {
  AnalyticsOptions,
  AnalyticsSnapshot,
  AnalyticsLimiter,
  HeavyHitter,
} from './types.js';
import { SpaceSaving } from './space-saving.js';

/**
 * Wrap a Limiter with analytics tracking.
 *
 * On each `check()`:
 *  - Increments allowed/denied counters
 *  - Tracks the key in `topRequested` SpaceSaving
 *  - If denied: also tracks the key in `topDenied` SpaceSaving
 *
 * For `peek()`: does NOT count as a request (no analytics update)
 * For `reset()`: forwards to underlying limiter, does NOT reset analytics
 * `resetAnalytics()`: clears all counters and SpaceSaving instances
 *
 * @param limiter - The underlying Limiter to wrap
 * @param options - Analytics configuration (e.g., topK)
 * @returns An AnalyticsLimiter that wraps the original
 */
export function withAnalytics(
  limiter: Limiter,
  options?: AnalyticsOptions,
): AnalyticsLimiter {
  const topK = options?.topK ?? 10;
  return new AnalyticsLimifier(limiter, topK);
}

class AnalyticsLimifier implements AnalyticsLimiter {
  private readonly _limiter: Limiter;
  private readonly _topRequested: SpaceSaving<string>;
  private readonly _topDenied: SpaceSaving<string>;
  private _allowed = 0;
  private _denied = 0;
  private _total = 0;

  constructor(limiter: Limiter, topK: number) {
    this._limiter = limiter;
    this._topRequested = new SpaceSaving<string>(topK);
    this._topDenied = new SpaceSaving<string>(topK);
  }

  /**
   * Track a request outcome in analytics.
   * Called by all check/checkSync methods.
   */
  private track(key: string, allowed: boolean): void {
    this._total++;
    this._topRequested.observe(key);
    if (!allowed) {
      this._denied++;
      this._topDenied.observe(key);
    } else {
      this._allowed++;
    }
  }

  /**
   * Check if a request is allowed. Tracks analytics.
   * Delegates to the underlying limiter.
   */
  async check(key: string, cost?: number): Promise<RateLimitResult> {
    const result = await this._limiter.check(key, cost);
    this.track(key, result.allowed);
    return result;
  }

  /**
   * Returns the current analytics snapshot.
   */
  analytics(): AnalyticsSnapshot {
    return {
      allowed: this._allowed,
      denied: this._denied,
      total: this._total,
      denyRate: this._total === 0
        ? 0
        : this._denied / this._total,
      topRequested: this._topRequested.topK().map(({ item, count, error }) => ({
        key: item,
        count,
        error,
      })),
      topDenied: this._topDenied.topK().map(({ item, count, error }) => ({
        key: item,
        count,
        error,
      })),
    };
  }

  /**
   * Reset all analytics counters and tracking.
   * Does NOT affect the underlying limiter.
   */
  resetAnalytics(): void {
    this._allowed = 0;
    this._denied = 0;
    this._total = 0;
    this._topRequested.reset();
    this._topDenied.reset();
  }

  // ---------------------------------------------------------------------------
  // Transparent forwarding of non-check methods
  // ---------------------------------------------------------------------------

  /**
   * Peek at current rate-limit state without counting as a request.
   * Does NOT update analytics. Delegates to underlying limiter's peek().
   */
  async peek(key: string, _cost?: number): Promise<RateLimitResult> {
    if (typeof (this._limiter as any).peek === 'function') {
      return (this._limiter as any).peek(key, _cost);
    }
    // Fallback: check with cost=0 (no-op for most strategies)
    return this._limiter.check(key, 0);
  }

  /**
   * Reset rate-limit state for a key.
   * Forwards to underlying limiter. Does NOT reset analytics.
   */
  async reset(key: string): Promise<void> {
    if (typeof (this._limiter as any).reset === 'function') {
      return (this._limiter as any).reset(key);
    }
  }

  /**
   * Synchronous rate-limit check.
   * Tracks analytics. Delegates to underlying limiter's checkSync() if available.
   */
  checkSync(key: string, cost?: number): RateLimitResult {
    if (typeof (this._limiter as any).checkSync === 'function') {
      const result = (this._limiter as any).checkSync(key, cost);
      this.track(key, result.allowed);
      return result;
    }
    throw new Error('AnalyticsLimiter: underlying limiter does not support checkSync()');
  }

  /**
   * Batch check multiple keys in a single operation.
   * Tracks analytics for each key.
   */
  async checkMany(keys: string[], cost?: number): Promise<RateLimitResult[]> {
    if (typeof (this._limiter as any).checkMany === 'function') {
      const results = await (this._limiter as any).checkMany(keys, cost);
      for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        if (key !== undefined) {
          const r = results[i];
          if (r !== undefined) {
            this.track(key, r.allowed);
          }
        }
      }
      return results;
    }
    // Fallback: check each key individually
    return Promise.all(keys.map((k) => this.check(k, cost)));
  }

  /**
   * Synchronous batch check for stores that support it.
   * Tracks analytics for each key.
   */
  checkManySync(keys: string[], cost?: number): RateLimitResult[] {
    if (typeof (this._limiter as any).checkManySync === 'function') {
      const results = (this._limiter as any).checkManySync(keys, cost);
      for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        if (key !== undefined) {
          const r = results[i];
          if (r !== undefined) {
            this.track(key, r.allowed);
          }
        }
      }
      return results;
    }
    // Fallback: check each key synchronously
    return keys.map((k) => this.checkSync(k, cost));
  }
}