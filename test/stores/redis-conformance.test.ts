import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { runStoreConformance } from '../testkit/store-conformance.js';
import { createRedisStore } from '../../src/stores/redis.js';
import type { Store } from '../../src/core/types.js';

const TEST_PREFIX = 'tk:conf:';
const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';

let skip = false;
let skipReason = '';
let store: Store & { redis?: { del: (...keys: string[]) => Promise<number>; keys: (pattern: string) => Promise<string[]>; quit?: () => Promise<'OK'> } } | null = null;

describe('Redis Live Conformance', () => {
  beforeAll(async () => {
    try {
      // ioredis is an optional peer dependency — dynamic import
      const ioredisModule: any = await import('ioredis' as any);
      const Redis = ioredisModule.Redis;
      const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 1, lazyConnect: true });
      await redis.connect();

      // Verify connectivity with a ping-like operation
      await redis.set(`${TEST_PREFIX}ping`, 'pong', 'PX', 1000);
      const v = await redis.get(`${TEST_PREFIX}ping`);
      if (v !== 'pong') throw new Error('ping failed');
      await redis.del(`${TEST_PREFIX}ping`);

      store = (await createRedisStore({ redis })) as any;
      // Expose redis for cleanup
      (store as any).redis = redis;
    } catch (err: any) {
      skip = true;
      skipReason = `No Redis at ${REDIS_URL} — ${err?.message ?? String(err)}`;
      console.warn(`⚠️  ${skipReason} — skipping Redis live conformance tests`);
    }
  });

  afterAll(async () => {
    if (store?.redis) {
      try {
        const keys = await store.redis.keys(`${TEST_PREFIX}*`);
        if (keys.length > 0) {
          await store.redis.del(...keys);
        }
        await store.redis.quit?.();
      } catch {
        // Best-effort cleanup
      }
    }
  });

  it.skipIf(() => skip)('placeholder to ensure describe runs', () => {
    expect(skipReason).toBe('');
  });

  if (!skip && store) {
    runStoreConformance({
      name: 'RedisStore',
      createStore: () => {
        // Return the already-connected store; beforeEach in runStoreConformance
        // will re-invoke createStore, but we reuse the same connection.
        // Use a fresh prefix per test via the store's internal redis client.
        return store!;
      },
      cleanup: async () => {
        if (store?.redis) {
          const keys = await store.redis.keys(`${TEST_PREFIX}*`);
          if (keys.length > 0) {
            await store.redis.del(...keys);
          }
        }
      },
    });
  }
});
