import type { Store } from '../core/types.js';

// ---------------------------------------------------------------------------
// Store conformance test suite
// ---------------------------------------------------------------------------

/**
 * Run a standard conformance test suite against a Store implementation.
 *
 * Tests:
 * - Atomicity: 50 concurrent applies, exactly limit allowed
 * - TTL expiry: write with ttlMs=50, wait 100ms, verify gone
 * - Round-trip: get/set/delete
 *
 * This is a vitest test suite — call it inside a `describe` or at the top-level
 * of a `.test.ts` file.
 *
 * @param store - The store implementation to test
 * @param label - Optional label for the test suite (default: 'Store')
 *
 * @example
 * ```typescript
 * import { runStoreConformance } from 'throttlekit/testkit';
 * import { MemoryStore } from 'throttlekit';
 *
 * runStoreConformance(new MemoryStore(), 'MemoryStore');
 * ```
 */
export function runStoreConformance(store: Store, label?: string): void {
  // Use global vitest functions (vitest sets globals when globals: true)
  // These are available as describe, it, expect in the global scope

  const suite = label ?? 'Store';

  describe(`${suite} conformance`, () => {
    it('atomicity — 50 concurrent applies, exactly limit allowed', async () => {
      const key = `concurrent-${Date.now()}`;
      const limit = 10;
      const concurrency = 50;

      const tasks = Array.from({ length: concurrency }, async (_, i) => {
        return store.apply<number, { allowed: boolean; idx: number }>(
          key,
          5000,
          (state: number | null) => {
            const count = (state ?? 0) + 1;
            return {
              state: count,
              result: { allowed: count <= limit, idx: i },
            };
          },
        );
      });

      const results = await Promise.all(tasks);
      const allowed = results.filter((r) => r.allowed).length;

      expect(allowed).toBe(limit);
    });

    it('TTL — write with ttlMs=50, wait 100ms, verify gone', async () => {
      const key = `ttl-${Date.now()}`;

      if (!store.set) throw new Error('Store does not implement set');
      await store.set(key, 'present', 50);

      // Should be present immediately
      const immediate: unknown = await store.get?.(key);
      expect(immediate).toBe('present');

      // Wait for TTL to expire
      await new Promise((r) => setTimeout(r, 100));

      const afterTtl: unknown = await store.get?.(key);
      expect(afterTtl).toBeNull();
    });

    it('get/set/delete round-trip', async () => {
      const key = `roundtrip-${Date.now()}`;

      // get on empty key returns null
      const empty: unknown = await store.get?.(key);
      expect(empty).toBeNull();

      // set value
      if (!store.set) throw new Error('Store does not implement set');
      await store.set(key, { foo: 'bar' });
      const value: unknown = await store.get?.(key);
      expect(value).toEqual({ foo: 'bar' });

      // delete
      if (!store.delete) throw new Error('Store does not implement delete');
      await store.delete(key);
      const deleted: unknown = await store.get?.(key);
      expect(deleted).toBeNull();
    });
  });
}

// ---------------------------------------------------------------------------
// Mock Redis client
// ---------------------------------------------------------------------------

/**
 * Create a minimal in-memory Redis mock for testing.
 *
 * Supports:
 * - `get`, `set`, `del`, `watch`, `multi`, `eval`, `evalsha`
 *
 * `evalsha` throws `{ code: 'NOSCRIPT' }` on first call per SHA.
 *
 * @returns A mock Redis client
 *
 * @example
 * ```typescript
 * import { mockRedisClient } from 'throttlekit/testkit';
 *
 * const redis = mockRedisClient();
 * await redis.set('key', 'value');
 * const val = await redis.get('key');
 * ```
 */
export function mockRedisClient(): Record<string, any> {
  const data = new Map<string, string>();
  const watchedKeys = new Set<string>();
  const multiCommands: Array<[string, ...unknown[]]> = [];
  const scriptShas = new Set<string>();

  return {
    async get(key: string): Promise<string | null> {
      return data.get(key) ?? null;
    },

    async set(key: string, value: string, ..._args: unknown[]): Promise<'OK'> {
      data.set(key, value);
      return 'OK';
    },

    async del(key: string): Promise<number> {
      return data.delete(key) ? 1 : 0;
    },

    async watch(...keys: string[]): Promise<'OK'> {
      keys.forEach((k) => watchedKeys.add(k));
      return 'OK';
    },

    multi(): {
      set(key: string, value: string, ...args: unknown[]): void;
      exec(): Promise<[Error | null, unknown][]>;
    } {
      const commands = multiCommands;
      commands.length = 0;

      return {
        set(key: string, value: string, ...args: unknown[]): void {
          commands.push(['set', key, value, ...args]);
        },

        async exec(): Promise<[Error | null, unknown][]> {
          // In this simple mock, no concurrent modifications happen,
          // so WATCH always succeeds. We just execute the queued commands.
          const results: [Error | null, unknown][] = [];
          for (const [cmd, key, value] of commands) {
            if (cmd === 'set') {
              data.set(key as string, value as string);
              results.push([null, 'OK']);
            }
          }

          watchedKeys.clear();
          return results;
        },
      };
    },

    async eval(
      _script: string,
      _keys: string[],
      ...args: string[]
    ): Promise<unknown> {
      // Simplified: return the first arg for testing
      return args[0] ?? null;
    },

    async evalsha(sha: string, _keys: string[], ...args: string[]): Promise<unknown> {
      if (!scriptShas.has(sha)) {
        scriptShas.add(sha);
        const err: any = new Error('NOSCRIPT');
        err.code = 'NOSCRIPT';
        throw err;
      }
      return args[0] ?? null;
    },
  };
}
