import type { Store } from '../core/types.js';

export interface StoreConformanceOptions {
  name: string;
  createStore: () => Promise<Store> | Store;
  cleanup?: () => Promise<void>;
}

export interface StoreConformanceApi {
  describe: (name: string, fn: () => void) => void;
  it: (name: string, fn: () => void | Promise<void>) => void;
  expect: <T = unknown>(actual: T) => {
    toBe(expected: unknown): void;
    toEqual(expected: unknown): void;
    toBeNull(): void;
  };
  beforeEach: (fn: () => void | Promise<void>) => void;
  afterEach: (fn: () => void | Promise<void>) => void;
}

/**
 * Run a standard conformance test suite against a Store implementation.
 *
 * Supports the current object form:
 *
 * ```ts
 * runStoreConformance({ name: 'MemoryStore', createStore: () => new MemoryStore() });
 * ```
 *
 * The older `(store, label)` form is still accepted for compatibility. When
 * Vitest globals are disabled, pass the Vitest API as the second or third
 * argument.
 */
export function runStoreConformance(options: StoreConformanceOptions, api?: StoreConformanceApi): void;
export function runStoreConformance(store: Store, label?: string, api?: StoreConformanceApi): void;
export function runStoreConformance(
  optionsOrStore: StoreConformanceOptions | Store,
  labelOrApi?: string | StoreConformanceApi,
  api?: StoreConformanceApi,
): void {
  const runner = resolveConformanceApi(
    typeof labelOrApi === 'string' ? api : labelOrApi,
  );
  const options: StoreConformanceOptions =
    'createStore' in optionsOrStore
      ? optionsOrStore
      : {
          name: typeof labelOrApi === 'string' ? labelOrApi : 'Store',
          createStore: () => optionsOrStore,
        };

  runner.describe(`${options.name} Store Conformance`, () => {
    let store: Store;

    runner.beforeEach(async () => {
      store = await options.createStore();
    });

    runner.afterEach(async () => {
      await options.cleanup?.();
    });

    runner.describe('Basic CRUD', () => {
      runner.it('get returns null for missing key', async () => {
        if (!store.get) return;
        const result = await store.get<unknown>('missing-key');
        runner.expect(result).toBeNull();
      });

      runner.it('set then get roundtrips JSON', async () => {
        if (!store.set || !store.get) return;
        await store.set('json-key', { foo: 'bar', num: 42 });
        const result = await store.get<{ foo: string; num: number }>('json-key');
        runner.expect(result).toEqual({ foo: 'bar', num: 42 });
      });

      runner.it('delete removes key', async () => {
        if (!store.set || !store.get || !store.delete) return;
        await store.set('del-key', 'value');
        await store.delete('del-key');
        const result = await store.get<string>('del-key');
        runner.expect(result).toBeNull();
      });
    });

    runner.describe('Atomic apply', () => {
      runner.it('apply creates fresh state from null', async () => {
        const result = await store.apply<{ n: number }, number>('fresh', 60_000, (prev) => ({
          state: { n: (prev?.n ?? 0) + 1 },
          result: (prev?.n ?? 0) + 1,
        }));
        runner.expect(result).toBe(1);
      });

      runner.it('apply updates existing state', async () => {
        const first = await store.apply<{ n: number }, number>('existing', 60_000, (prev) => ({
          state: { n: (prev?.n ?? 0) + 1 },
          result: (prev?.n ?? 0) + 1,
        }));
        runner.expect(first).toBe(1);

        const second = await store.apply<{ n: number }, number>('existing', 60_000, (prev) => ({
          state: { n: (prev?.n ?? 0) + 1 },
          result: (prev?.n ?? 0) + 1,
        }));
        runner.expect(second).toBe(2);
      });
    });

    runner.describe('200-way concurrent atomicity', () => {
      runner.it('200 concurrent increments land exactly 200', async () => {
        const promises = Array.from({ length: 200 }, () =>
          store.apply<{ n: number }, number>('concurrent', 60_000, (prev) => ({
            state: { n: (prev?.n ?? 0) + 1 },
            result: (prev?.n ?? 0) + 1,
          })),
        );

        const results = await Promise.all(promises);
        const uniqueResults = new Set(results);

        runner.expect(uniqueResults.size).toBe(200);
        runner.expect(Math.max(...results)).toBe(200);
      });
    });

    runner.describe('TTL/expiry', () => {
      runner.it('expired keys return null on get', async () => {
        if (!store.set || !store.get) return;
        await store.set('short-ttl', 'value', 1);
        await new Promise((resolve) => setTimeout(resolve, 50));
        const result = await store.get<string>('short-ttl');
        runner.expect(result).toBeNull();
      });
    });

    runner.describe('Prefix isolation', () => {
      runner.it('different keys are independent', async () => {
        const a = await store.apply<{ n: number }, number>('a', 60_000, (prev) => ({
          state: { n: (prev?.n ?? 0) + 10 },
          result: (prev?.n ?? 0) + 10,
        }));
        runner.expect(a).toBe(10);

        const b = await store.apply<{ n: number }, number>('b', 60_000, (prev) => ({
          state: { n: (prev?.n ?? 0) + 1 },
          result: (prev?.n ?? 0) + 1,
        }));
        runner.expect(b).toBe(1);
      });
    });
  });
}

function resolveConformanceApi(api?: StoreConformanceApi): StoreConformanceApi {
  if (api) return api;

  const globalApi = globalThis as unknown as Partial<StoreConformanceApi>;
  if (
    typeof globalApi.describe === 'function' &&
    typeof globalApi.it === 'function' &&
    typeof globalApi.expect === 'function' &&
    typeof globalApi.beforeEach === 'function' &&
    typeof globalApi.afterEach === 'function'
  ) {
    return globalApi as StoreConformanceApi;
  }

  throw new Error(
    'runStoreConformance requires Vitest globals or an explicit test API. ' +
      'Pass { describe, it, expect, beforeEach, afterEach } when globals are disabled.',
  );
}

/**
 * Create a minimal in-memory Redis mock for testing.
 *
 * Supports `get`, `set`, `del`, `watch`, `multi`, `eval`, and `evalsha`.
 * `evalsha` throws `{ code: 'NOSCRIPT' }` on first call per SHA.
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
