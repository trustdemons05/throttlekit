/**
 * Injectable clock for deterministic testing and production use.
 */
export interface Clock {
  /** Returns current time in epoch milliseconds (monotonic preferred) */
  now(): number;
}

/**
 * Result of a rate-limit check.
 */
export interface RateLimitResult {
  /** Whether the request is permitted */
  allowed: boolean;
  /** The configured limit */
  limit: number;
  /** Remaining capacity (floor) */
  remaining: number;
  /** Epoch ms when capacity fully resets */
  resetAt: number;
  /** Milliseconds client should wait before retrying (0 if allowed) */
  retryAfterMs: number;
}

/**
 * Result returned by a strategy pure function.
 * Includes the new state to persist and the rate-limit result.
 */
export interface StrategyResult<S> {
  /** New state to persist */
  state: S;
  /** Rate-limit result */
  result: RateLimitResult;
}

/**
 * Pure strategy function: (state, now, cost) -> { state, result }
 */
export type StrategyFn<S> = (
  state: S | null,
  now: number,
  cost: number
) => StrategyResult<S>;

/**
 * Store abstraction: atomic read-modify-write with per-key serialization.
 */
export interface Store {
  /**
   * Atomic read-modify-write.
   * @param key - The rate-limit key
   * @param ttlMs - Time-to-live in milliseconds for the state entry
   * @param transform - Pure function that receives current state and returns new state + result
   */
  apply<S, T>(
    key: string,
    ttlMs: number,
    transform: (state: S | null) => { state: S; result: T }
  ): Promise<T>;

  /** Optional: read raw state without mutating */
  get?<T>(key: string): Promise<T | null>;
  /** Optional: write raw state */
  set?<T>(key: string, value: T, ttlMs?: number): Promise<void>;
  /** Optional: delete state */
  delete?(key: string): Promise<void>;
}

/**
 * Limiter interface: checks if a request is allowed.
 */
export interface Limiter {
  /**
   * Check if a request is allowed.
   * @param key - The rate-limit key
   * @param cost - Request cost (default 1)
   */
  check(key: string, cost?: number): Promise<RateLimitResult>;

  /**
   * Check multiple keys concurrently. On Redis stores with auto-pipelining,
   * these collapse to a single round trip.
   */
  checkMany?(keys: string[], cost?: number): Promise<RateLimitResult[]>;

  /**
   * Synchronous batch check for stores that support applySync (e.g. MemoryStore).
   * Throws UnsupportedOperationError if the store does not support sync.
   */
  checkManySync?(keys: string[], cost?: number): RateLimitResult[];
}

/**
 * Options for creating a rate limiter.
 */
export interface RateLimitOptions {
  /** Rate-limiting strategy */
  strategy: 'token-bucket' | 'fixed-window' | 'sliding-window-log' | 'sliding-window-counter' | 'sliding-window';
  /** Store implementation (defaults to MemoryStore) */
  store?: Store;
  /** Clock implementation (defaults to SystemClock) */
  clock?: Clock;
  /** TTL in milliseconds for store entries (auto-calculated if omitted) */
  ttlMs?: number;
  // Strategy-specific options are added by the factory
  [key: string]: unknown;
}

// --- Shaper (Leaky Bucket) ---

export interface ShaperResult {
  accepted: boolean;
  delayMs: number;
  retryAfterMs: number;
  queueDepth: number;
}

export interface Shaper {
  reserve(key: string, cost?: number): Promise<ShaperResult>;
  reserveSync(key: string, cost?: number): ShaperResult;
  schedule(key: string, cost?: number): Promise<void>;
  reset(key: string): Promise<void>;
}

export class QueueFullError extends Error {
  retryAfterMs: number;

  constructor(message: string, retryAfterMs: number) {
    super(message);
    this.retryAfterMs = retryAfterMs;
  }
}

// --- Concurrency Guard (Adaptive Concurrency) ---

export interface ConcurrencyLease {
  ok: boolean;
  inflight: number;
  limit: number;
  release(opts?: { dropped?: boolean }): void;
}

export interface ConcurrencyGuard {
  acquire(): ConcurrencyLease;
  readonly limit: number;
  readonly inflight: number;
  stats(): { p50Rtt: number; p99Rtt: number; noloadRtt: number };
}

// --- Multi-dimensional ---

export type DimensionMap<Ctx> = Record<
  string,
  { key: (ctx: Ctx) => string; strategy: Limiter; cost?: (ctx: Ctx) => number }
>;

export interface MultiLimiter<Ctx> {
  check(ctx: Ctx): Promise<RateLimitResult>;
}

// --- Two-tier lease config ---

export type TwoTierMode = 'strict' | 'cached-deny' | 'leased';

export interface LeaseConfig {
  batch: number;
  lowWater?: number;
  /**
   * When true, local lease credits expire at the L2 window boundary (resetAt).
   * Effect: overshoot bound becomes admitted <= Limit, independent of fleet size N.
   * Without windowCoupled: overshoot = Limit + N*(Batch-1).
   */
  windowCoupled?: boolean;
}

// --- Header emit options ---

export interface HeaderEmitOptions {
  draft?: boolean;
  structured?: boolean;
  legacy?: boolean;
}
