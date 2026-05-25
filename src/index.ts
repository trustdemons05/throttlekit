export type {
  Clock,
  RateLimitResult,
  StrategyResult,
  StrategyFn,
  Store,
  Limiter,
  RateLimitOptions,
  Shaper,
  ShaperResult,
  QueueFullError,
  ConcurrencyLease,
  ConcurrencyGuard,
  DimensionMap,
  MultiLimiter,
  TwoTierMode,
  LeaseConfig,
  HeaderEmitOptions,
} from './core/types.js';

export { SystemClock, ManualClock } from './core/clock.js';
export { LimiterImpl, rateLimit } from './core/limiter.js';
export { combine } from './core/combine.js';
export { multiRateLimit, all, any } from './core/multi-limiter.js';

export { MemoryStore } from './stores/memory-store.js';
export { createRedisStore } from './stores/redis.js';
export { createTwoTierStore } from './stores/two-tier.js';
export type { TwoTierStoreOptions } from './stores/two-tier.js';

export { createTokenBucketStrategy, tokenBucketConsume } from './strategies/token-bucket.js';
export { createFixedWindowStrategy } from './strategies/fixed-window.js';
export { createGcraStrategy, gcraLua } from './strategies/gcra.js';
export { createLeakyBucket } from './strategies/leaky-bucket.js';
export { createAdaptiveConcurrency } from './strategies/adaptive-concurrency.js';

export { clientIp } from './utils/client-ip.js';
export type { ClientIpOptions } from './utils/client-ip.js';
export { hmacKeyer, hashKey } from './utils/hmac-key.js';
export { buildRateLimitHeaders } from './utils/headers.js';
export type { BuildHeadersOptions } from './utils/headers.js';
