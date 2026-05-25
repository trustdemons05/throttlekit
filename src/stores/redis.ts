import type { Store } from '../core/types.js';

export interface RedisStoreOptions {
  /** Redis connection URL (e.g., redis://localhost:6379) */
  url?: string;
  /** Pre-configured ioredis instance (overrides url) */
  redis?: any;
}

/**
 * Redis-backed Store implementation using WATCH/MULTI/EXEC for atomic
 * read-modify-write operations.
 *
 * Uses optional peer dependency `ioredis` — install it separately:
 *   npm install ioredis
 *
 * For Redis Cluster, use hash tags: `{throttlekit}:<key>`.
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

  constructor(redis: any) {
    this.redis = redis;
  }

  async apply<S, T>(
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
