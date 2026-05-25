export type {
  Clock,
  RateLimitResult,
  StrategyResult,
  StrategyFn,
  Store,
  Limiter,
  RateLimitOptions,
} from './types.js';

export { SystemClock, ManualClock } from './clock.js';
export { LimiterImpl, rateLimit } from './limiter.js';
export { combine } from './combine.js';
