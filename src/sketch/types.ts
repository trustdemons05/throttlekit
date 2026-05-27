import type { Clock, RateLimitResult } from '../core/types.js';

export interface SketchRateLimitOptions {
  limit: number;
  windowMs: number;
  epsilon?: number;   // CMS error rate, default 0.01
  delta?: number;     // CMS confidence, default 0.001
  clock?: Clock;
}

export interface SketchRateLimiter {
  check(key: string): Promise<RateLimitResult>;
  checkSync(key: string): RateLimitResult;
  reset(): void;
}

export interface MergeableSketchOptions extends SketchRateLimitOptions {}

export interface SketchSnapshot {
  counters: Uint32Array;
  width: number;
  depth: number;
  windowStart: number;
}

export interface MergeableSketch extends SketchRateLimiter {
  snapshot(): SketchSnapshot;
  toBytes(): Uint8Array;
  merge(snapshot: SketchSnapshot): void;
}
