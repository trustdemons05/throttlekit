import type { RateLimitResult, Store } from '../core/types.js';
import { gcraLua } from '../strategies/gcra.js';

// ---------------------------------------------------------------------------
// Exported Lua scripts for each built-in strategy
// ---------------------------------------------------------------------------

/**
 * Token Bucket Lua script.
 *
 * KEYS[1]: key
 * ARGV[1]: cost (number)
 * ARGV[2]: ttlMs (ms)
 * ARGV[3]: capacity (max tokens)
 * ARGV[4]: refillRate (tokens per second)
 *
 * Returns: [allowed (0/1), limit, remaining, resetAt, retryAfterMs]
 */
export const tokenBucketLua: string = [
  'local cost = tonumber(ARGV[1])',
  'local ttlMs = tonumber(ARGV[2])',
  'local capacity = tonumber(ARGV[3])',
  'local refillRate = tonumber(ARGV[4])',
  '',
  'local time = redis.call(\'TIME\')',
  'local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)',
  '',
  'local raw = redis.call(\'GET\', KEYS[1])',
  'local tokens, lastRefill',
  'if raw then',
  '  local state = cjson.decode(raw)',
  '  tokens = state[1]',
  '  lastRefill = state[2]',
  'else',
  '  tokens = capacity',
  '  lastRefill = now',
  'end',
  '',
  'if cost > capacity then',
  '  if not raw then',
  '    redis.call(\'SET\', KEYS[1], cjson.encode({tokens, lastRefill}), \'PX\', ttlMs)',
  '  else',
  '    redis.call(\'PEXPIRE\', KEYS[1], ttlMs)',
  '  end',
  '  return {0, capacity, capacity, now, 2147483647}',
  'end',
  '',
  'local elapsed = (now - lastRefill) / 1000',
  'tokens = math.min(capacity, tokens + elapsed * refillRate)',
  '',
  'if tokens >= cost then',
  '  tokens = tokens - cost',
  '  local remaining = math.floor(tokens)',
  '  local resetAt',
  '  if refillRate > 0 then',
  '    resetAt = now + math.ceil(((capacity - tokens) / refillRate) * 1000)',
  '  else',
  '    resetAt = now',
  '  end',
  '  redis.call(\'SET\', KEYS[1], cjson.encode({tokens, now}), \'PX\', ttlMs)',
  '  return {1, capacity, remaining, resetAt, 0}',
  'else',
  '  local deficit = cost - tokens',
  '  local retryAfterMs',
  '  if refillRate > 0 then',
  '    retryAfterMs = math.ceil((deficit / refillRate) * 1000)',
  '  else',
  '    retryAfterMs = 2147483647',
  '  end',
  '  local resetAt = now + retryAfterMs',
  '  redis.call(\'SET\', KEYS[1], cjson.encode({tokens, now}), \'PX\', ttlMs)',
  '  return {0, capacity, 0, resetAt, retryAfterMs}',
  'end',
].join('\n');

/**
 * Fixed Window Lua script.
 *
 * KEYS[1]: key
 * ARGV[1]: cost (number)
 * ARGV[2]: ttlMs (ms)
 * ARGV[3]: limit (max requests per window)
 * ARGV[4]: windowMs (window duration in ms)
 *
 * Returns: [allowed (0/1), limit, remaining, resetAt, retryAfterMs]
 */
export const fixedWindowLua: string = [
  'local cost = tonumber(ARGV[1])',
  'local ttlMs = tonumber(ARGV[2])',
  'local limit = tonumber(ARGV[3])',
  'local windowMs = tonumber(ARGV[4])',
  '',
  'local time = redis.call(\'TIME\')',
  'local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)',
  '',
  'local windowStart = math.floor(now / windowMs) * windowMs',
  'local resetAt = windowStart + windowMs',
  '',
  'if cost > limit then',
  '  return {0, limit, limit, now, 2147483647}',
  'end',
  '',
  'local raw = redis.call(\'GET\', KEYS[1])',
  'local count',
  'local stateWindowStart',
  '',
  'if raw then',
  '  local state = cjson.decode(raw)',
  '  count = state[1]',
  '  stateWindowStart = state[2]',
  'else',
  '  count = 0',
  '  stateWindowStart = windowStart',
  'end',
  '',
  'if stateWindowStart ~= windowStart then',
  '  count = cost',
  '  stateWindowStart = windowStart',
  '  local remaining = limit - cost',
  '  redis.call(\'SET\', KEYS[1], cjson.encode({count, stateWindowStart}), \'PX\', ttlMs)',
  '  return {1, limit, remaining, resetAt, 0}',
  'end',
  '',
  'local newCount = count + cost',
  'if newCount <= limit then',
  '  local remaining = limit - newCount',
  '  redis.call(\'SET\', KEYS[1], cjson.encode({newCount, stateWindowStart}), \'PX\', ttlMs)',
  '  return {1, limit, remaining, resetAt, 0}',
  'end',
  '',
  'local retryAfterMs = resetAt - now',
  'if not raw then',
  '  redis.call(\'SET\', KEYS[1], cjson.encode({count, stateWindowStart}), \'PX\', ttlMs)',
  'else',
  '  redis.call(\'PEXPIRE\', KEYS[1], ttlMs)',
  'end',
  'return {0, limit, 0, resetAt, retryAfterMs}',
].join('\n');

/**
 * Sliding Window Log Lua script.
 *
 * KEYS[1]: key
 * ARGV[1]: cost (number)
 * ARGV[2]: ttlMs (ms)
 * ARGV[3]: limit (max requests per window)
 * ARGV[4]: windowMs (window duration in ms)
 *
 * Returns: [allowed (0/1), limit, remaining, resetAt, retryAfterMs]
 */
export const slidingWindowLogLua: string = [
  'local cost = tonumber(ARGV[1])',
  'local ttlMs = tonumber(ARGV[2])',
  'local limit = tonumber(ARGV[3])',
  'local windowMs = tonumber(ARGV[4])',
  '',
  'local time = redis.call(\'TIME\')',
  'local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)',
  '',
  'local windowStart = now - windowMs',
  '',
  'if cost > limit then',
  '  return {0, limit, limit, now + windowMs, windowMs}',
  'end',
  '',
  'if cost <= 0 then',
  '  return {1, limit, limit, now + windowMs, 0}',
  'end',
  '',
  'local raw = redis.call(\'GET\', KEYS[1])',
  'local log = {}',
  'if raw then',
  '  log = cjson.decode(raw)',
  'end',
  '',
  '-- Prune expired entries',
  'local pruned = {}',
  'local prunedLen = 0',
  'for i = 1, #log do',
  '  if log[i] >= windowStart then',
  '    prunedLen = prunedLen + 1',
  '    pruned[prunedLen] = log[i]',
  '  end',
  'end',
  '',
  'if prunedLen + cost <= limit then',
  '  -- Insert cost timestamps at now',
  '  for i = 1, cost do',
  '    prunedLen = prunedLen + 1',
  '    pruned[prunedLen] = now',
  '  end',
  '  local remaining = limit - prunedLen',
  '  redis.call(\'SET\', KEYS[1], cjson.encode(pruned), \'PX\', ttlMs)',
  '  return {1, limit, remaining, now + windowMs, 0}',
  'end',
  '',
  'local oldest = pruned[1]',
  'local retryAfterMs = math.max(0, oldest + windowMs - now)',
  'redis.call(\'PEXPIRE\', KEYS[1], ttlMs)',
  'return {0, limit, 0, oldest + windowMs, retryAfterMs}',
].join('\n');

/**
 * Sliding Window Counter Lua script.
 *
 * KEYS[1]: key
 * ARGV[1]: cost (number)
 * ARGV[2]: ttlMs (ms)
 * ARGV[3]: limit (max requests per window)
 * ARGV[4]: windowMs (window duration in ms)
 *
 * Returns: [allowed (0/1), limit, remaining, resetAt, retryAfterMs]
 */
export const slidingWindowCounterLua: string = [
  'local cost = tonumber(ARGV[1])',
  'local ttlMs = tonumber(ARGV[2])',
  'local limit = tonumber(ARGV[3])',
  'local windowMs = tonumber(ARGV[4])',
  '',
  'local time = redis.call(\'TIME\')',
  'local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)',
  '',
  'local windowStart = math.floor(now / windowMs) * windowMs',
  'local resetAt = windowStart + windowMs',
  '',
  'if cost > limit then',
  '  return {0, limit, limit, now + windowMs, windowMs}',
  'end',
  '',
  'if cost <= 0 then',
  '  return {1, limit, limit, now + windowMs, 0}',
  'end',
  '',
  'local elapsed = (now - windowStart) / windowMs',
  'local weight = math.max(0, math.min(1, 1 - elapsed))',
  '',
  'local raw = redis.call(\'GET\', KEYS[1])',
  'local prevCount = 0',
  'local currCount = 0',
  'local currentWindowStart = windowStart',
  '',
  'if raw then',
  '  local state = cjson.decode(raw)',
  '  prevCount = state[1]',
  '  currCount = state[2]',
  '  currentWindowStart = state[3]',
  'end',
  '',
  'if currentWindowStart ~= windowStart then',
  '  prevCount = 0',
  '  currCount = 0',
  '  currentWindowStart = windowStart',
  'end',
  '',
  'local estimated = prevCount * weight + currCount',
  '',
  'if estimated + cost <= limit then',
  '  currCount = currCount + cost',
  '  local remaining = math.max(0, math.floor(limit - estimated - cost))',
  '  redis.call(\'SET\', KEYS[1], cjson.encode({prevCount, currCount, currentWindowStart}), \'PX\', ttlMs)',
  '  return {1, limit, remaining, resetAt, 0}',
  'end',
  '',
  'local deficit = estimated + cost - limit',
  'local retryAfterMs = math.ceil((deficit / limit) * windowMs)',
  'if not raw then',
  '  redis.call(\'SET\', KEYS[1], cjson.encode({prevCount, currCount, currentWindowStart}), \'PX\', ttlMs)',
  'else',
  '  redis.call(\'PEXPIRE\', KEYS[1], ttlMs)',
  'end',
  'return {0, limit, 0, now + retryAfterMs, retryAfterMs}',
].join('\n');

// Re-export GCRA Lua from strategies
export { gcraLua };

// ---------------------------------------------------------------------------
// RedisStore
// ---------------------------------------------------------------------------

export interface RedisStoreOptions {
  /** Redis connection URL (e.g., redis://localhost:6379) */
  url?: string;
  /** Pre-configured ioredis instance (overrides url) */
  redis?: any;
}

/**
 * Redis-backed Store implementation with Lua EVALSHA fast path.
 *
 * Uses Lua EVALSHA for built-in strategies (primary) and falls back to
 * WATCH/MULTI/EXEC for custom strategies or when Lua is unavailable.
 *
 * ```ts
 * const store = await createRedisStore({ url: 'redis://localhost:6379' });
 * // or with a pre-configured instance:
 * const store = await createRedisStore({ redis: new Redis({ ... }) });
 * ```
 */
class RedisStore implements Store {
  private redis: any;
  private maxRetries = 3;
  private luaScript: string | null = null;
  private luaSha: string | null = null;

  constructor(redis: any) {
    this.redis = redis;
  }

  /**
   * Configure a Lua script for the fast path.
   * Called by rateLimit() factory when a built-in strategy is used.
   */
  setLuaStrategy(luaScript: string): void {
    this.luaScript = luaScript;
    this.luaSha = null; // Invalidate cached SHA
  }

  /**
   * Clear the Lua fast-path configuration (reverts to WATCH/MULTI/EXEC).
   */
  clearLuaStrategy(): void {
    this.luaScript = null;
    this.luaSha = null;
  }

  /**
   * Check if Lua fast path is configured.
   */
  hasLua(): boolean {
    return this.luaScript !== null;
  }

  /**
   * Atomic read-modify-write via store.apply().
   *
   * When a Lua script is configured (via setLuaStrategy), uses the EVALSHA
   * fast path. Falls back to WATCH/MULTI/EXEC for custom strategies.
   */
  async apply<S, T>(
    key: string,
    ttlMs: number,
    transform: (state: S | null) => { state: S; result: T },
  ): Promise<T> {
    if (this.luaScript) {
      // Lua fast path — bypass transform, run strategy logic atomically in Redis
      return (await this.evalLua(key, ttlMs)) as T;
    }

    // WATCH/MULTI/EXEC fallback
    return this.evalWatch(key, ttlMs, transform);
  }

  /**
   * Apply rate-limit check with explicit cost via Lua fast path.
   * Used by the limiter when Lua is configured.
   */
  async applyWithLua(key: string, ttlMs: number, cost: number): Promise<RateLimitResult> {
    // The luaScript must already be configured via setLuaStrategy.
    // The cost is passed to the Lua script as ARGV[1].
    // ARGV[2] is ttlMs.
    // ARGV[3+] are the strategy-specific params stored internally.
    // For applyWithLua we call evalLua which passes cost as the first ARGV.
    return this.evalLua(key, ttlMs, cost);
  }

  /**
   * Execute the configured Lua script via EVALSHA (or EVAL on NOSCRIPT).
   */
  private async evalLua(key: string, ttlMs: number, cost?: number): Promise<RateLimitResult> {
    const script = this.luaScript!;

    // Cache SHA on first use
    if (!this.luaSha) {
      this.luaSha = await this.redis.script('LOAD', script);
    }

    // Build args: cost is provided or default to 1
    const actualCost = cost ?? 1;

    // Try EVALSHA first
    try {
      const result: number[] = await this.redis.evalsha(
        this.luaSha,
        1,
        key,
        String(actualCost),
        String(ttlMs),
      );

      return parseLuaResult(result);
    } catch (err: any) {
      // NOSCRIPT: script was evicted from Redis cache — fall back to EVAL
      if (err && typeof err.message === 'string' && err.message.includes('NOSCRIPT')) {
        const result: number[] = await this.redis.eval(
          script,
          1,
          key,
          String(actualCost),
          String(ttlMs),
        );

        // Re-cache SHA
        this.luaSha = await this.redis.script('LOAD', script);

        return parseLuaResult(result);
      }

      throw err;
    }
  }

  /**
   * WATCH/MULTI/EXEC fallback for custom strategies.
   */
  private async evalWatch<S, T>(
    key: string,
    ttlMs: number,
    transform: (state: S | null) => { state: S; result: T },
  ): Promise<T> {
    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      await this.redis.watch(key);
      const raw = await this.redis.get(key);
      const currentState = raw ? (JSON.parse(raw) as S) : null;
      const { state: newState, result } = transform(currentState);

      const multi = this.redis.multi();
      multi.set(key, JSON.stringify(newState), 'PX', ttlMs);
      // eslint-disable-next-line no-await-in-loop
      const execResult: [Error | null, any][] | null = await multi.exec();

      if (execResult !== null) {
        return result; // Success — no WATCH conflict
      }

      // WATCH triggered — retry with exponential backoff + jitter
      if (attempt < this.maxRetries - 1) {
        const delay = Math.pow(2, attempt) * 10 + Math.random() * 10;
        await new Promise((r) => setTimeout(r, delay));
      }
    }

    throw new Error('RedisStore: max retries exceeded');
  }

  async get<T>(key: string): Promise<T | null> {
    const raw = await this.redis.get(key);
    return raw ? (JSON.parse(raw) as T) : null;
  }

  async set<T>(key: string, value: T, ttlMs?: number): Promise<void> {
    if (ttlMs !== undefined) {
      await this.redis.set(key, JSON.stringify(value), 'PX', ttlMs);
    } else {
      await this.redis.set(key, JSON.stringify(value));
    }
  }

  async delete(key: string): Promise<void> {
    await this.redis.del(key);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse a Lua script result array into a RateLimitResult.
 *
 * Lua returns: [allowed (0/1), limit, remaining, resetAt, retryAfterMs]
 */
function parseLuaResult(result: number[]): RateLimitResult {
  return {
    allowed: result[0] === 1,
    limit: result[1] ?? 0,
    remaining: result[2] ?? 0,
    resetAt: result[3] ?? 0,
    retryAfterMs: result[4] ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a Redis-backed Store.
 *
 * @example
 * ```ts
 * import { createRedisStore } from 'throttlekit/redis';
 * const store = await createRedisStore({ url: 'redis://localhost:6379' });
 * ```
 */
export async function createRedisStore(
  options: RedisStoreOptions = {},
): Promise<Store> {
  // ioredis is an optional peer dependency — dynamic import allows it to be
  // missing at build time but required at runtime.  Cast the module specifier
  // to `any` so TS does not attempt to resolve it at compile time.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
  const ioredisModule: any = await import('ioredis' as any);
  const Redis = ioredisModule.Redis;
  const redis = options.redis ?? new Redis(options.url);
  return new RedisStore(redis);
}
