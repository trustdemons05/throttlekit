import { describe, it, expect } from 'vitest';
import { mockRedisClient } from '../../src/testkit/index.js';
import { runStoreConformance } from './store-conformance.js';
import { MemoryStore } from '../../src/stores/memory-store.js';

// Register the conformance suite for MemoryStore
runStoreConformance(new MemoryStore(), 'MemoryStore');

describe('testkit - mockRedisClient', () => {
  it('get returns null for missing key', async () => {
    const redis = mockRedisClient();
    const val = await redis.get('missing');
    expect(val).toBeNull();
  });

  it('set and get round-trip', async () => {
    const redis = mockRedisClient();
    await redis.set('key1', 'value1');
    const val = await redis.get('key1');
    expect(val).toBe('value1');
  });

  it('del removes key', async () => {
    const redis = mockRedisClient();
    await redis.set('key1', 'value1');
    const deleted = await redis.del('key1');
    expect(deleted).toBe(1);
    const val = await redis.get('key1');
    expect(val).toBeNull();
  });

  it('del returns 0 for missing key', async () => {
    const redis = mockRedisClient();
    const deleted = await redis.del('nonexistent');
    expect(deleted).toBe(0);
  });

  it('watch and multi exec', async () => {
    const redis = mockRedisClient();
    await redis.watch('mykey');
    const multi = redis.multi();
    multi.set('mykey', 'value');
    const result = await multi.exec();
    // Result is an array of [error, result] tuples (ioredis convention)
    // For a single SET command: [[null, 'OK']]
    expect(Array.isArray(result)).toBe(true);
    expect(result[0]).toEqual([null, 'OK']);
    const val = await redis.get('mykey');
    expect(val).toBe('value');
  });

  it('evalsha throws NOSCRIPT on first call', async () => {
    const redis = mockRedisClient();
    await expect(
      redis.evalsha('script_sha', []),
    ).rejects.toMatchObject({ code: 'NOSCRIPT' });
  });

  it('evalsha succeeds on second call', async () => {
    const redis = mockRedisClient();
    try {
      await redis.evalsha('script_sha2', []);
    } catch {
      // ignore first call error
    }
    const result = await redis.evalsha('script_sha2', []);
    expect(result).toBeNull();
  });
});
