import type { Limiter, RateLimitResult } from '../core/types.js';

export interface AnalyticsOptions {
  /** Number of top-K heavy hitters to track (default 10) */
  topK?: number;
}

export interface HeavyHitter {
  key: string;
  count: number;
  error: number;
}

export interface AnalyticsSnapshot {
  allowed: number;
  denied: number;
  total: number;
  denyRate: number;
  topRequested: HeavyHitter[];
  topDenied: HeavyHitter[];
}

export interface AnalyticsLimiter extends Limiter {
  /** Returns the current analytics snapshot */
  analytics(): AnalyticsSnapshot;
  /** Resets all analytics counters and tracking (does NOT affect underlying limiter) */
  resetAnalytics(): void;
  /** Peek at current rate-limit state without counting as a request */
  peek(key: string, cost?: number): Promise<RateLimitResult>;
  /** Reset rate-limit state for a key (forwards to underlying limiter) */
  reset(key: string): Promise<void>;
}