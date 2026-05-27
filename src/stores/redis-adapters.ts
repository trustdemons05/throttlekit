// ---------------------------------------------------------------------------
// Redis client adapter wrappers
//
// Convert non-ioredis Redis clients (node-redis, Upstash Redis) to the
// shape IoredisLikeClient that RedisStore expects.  Everything is duck-typed
// so there are zero imports from any Redis driver package.
// ---------------------------------------------------------------------------

// ===========================================================================
// Custom error
// ===========================================================================

export class UnsupportedOperationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedOperationError';
  }
}

// ===========================================================================
// Ioredis-like interfaces (the shape RedisStore expects)
// ===========================================================================

export interface IoredisLikeClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ...args: string[]): Promise<string>;
  del(key: string): Promise<number>;
  watch(key: string): Promise<string>;
  multi(): IoredisLikeMulti;
  eval(script: string, numkeys: number, ...args: string[]): Promise<unknown>;
  evalsha(sha: string, numkeys: number, ...args: string[]): Promise<unknown>;
  script(cmd: string, ...args: string[]): Promise<string>;
  pexpire(key: string, ms: number): Promise<number>;
}

export interface IoredisLikeMulti {
  set(key: string, value: string, ...args: string[]): this;
  exec(): Promise<Array<[Error | null, unknown]> | null>;
}

// ===========================================================================
// Duck-typed input client interfaces
// ===========================================================================

/** Duck-typed node-redis v4+ client (no import from 'redis') */
export interface NodeRedisLike {
  get(key: string): Promise<string | null>;
  set(
    key: string,
    value: string,
    options?: Record<string, unknown>,
  ): Promise<string | null>;
  del(key: string): Promise<number>;
  watch(key: string): Promise<string>;
  multi(): NodeRedisMulti;
  eval(
    script: string,
    options: { keys: string[]; arguments: string[] },
  ): Promise<unknown>;
  evalSha(
    sha: string,
    options: { keys: string[]; arguments: string[] },
  ): Promise<unknown>;
  scriptLoad(script: string): Promise<string>;
  [key: string]: unknown;
}

/** Duck-typed node-redis v4+ multi/transaction */
export interface NodeRedisMulti {
  set(
    key: string,
    value: string,
    options?: Record<string, unknown>,
  ): this;
  exec(): Promise<unknown[]>;
}

/** Duck-typed @upstash/redis client (no import from '@upstash/redis') */
export interface UpstashLike {
  get<T>(key: string): Promise<T | null>;
  set(
    key: string,
    value: string,
    opts?: Record<string, unknown>,
  ): Promise<string | null>;
  del(key: string): Promise<number>;
  eval<T>(
    script: string,
    keys: string[],
    args: string[],
  ): Promise<T>;
  evalsha<T>(
    sha: string,
    keys: string[],
    args: string[],
  ): Promise<T>;
  scriptLoad(script: string): Promise<string>;
  [key: string]: unknown;
}

// ===========================================================================
// Helpers
// ===========================================================================

/**
 * Convert ioredis-style variadic SET arguments (e.g. `'PX', '1000'`, `'NX'`)
 * into a node-redis-style options record (e.g. `{PX: '1000'}`, `{NX: true}`).
 */
function parseSetArgs(args: string[]): Record<string, unknown> | undefined {
  if (args.length === 0) return undefined;

  const opts: Record<string, unknown> = {};
  let i = 0;
  while (i < args.length) {
    const key = args[i]!;
    if (key === 'PX' || key === 'EX' || key === 'KEEPTTL') {
      i++;
      opts[key] = args[i]!;
    } else if (key === 'NX' || key === 'XX' || key === 'GET') {
      opts[key] = true;
    }
    i++;
  }
  return opts;
}

/**
 * Split variadic eval/evalsha arguments into key and argument arrays.
 *
 * ioredis: `eval(script, numkeys, key1, key2, ..., arg1, arg2, ...)`
 */
function splitEvalArgs(
  numkeys: number,
  args: string[],
): { keys: string[]; arguments: string[] } {
  return {
    keys: args.slice(0, numkeys),
    arguments: args.slice(numkeys),
  };
}

// ===========================================================================
// Adapter: fromNodeRedis
// ===========================================================================

/**
 * Wrap a node-redis v4+ client so it satisfies the IoredisLikeClient shape
 * that RedisStore consumes.
 *
 * @example
 * ```ts
 * import { createClient } from 'redis';
 * import { fromNodeRedis } from 'throttlekit';
 *
 * const client = createClient();
 * await client.connect();
 * const adapted = fromNodeRedis(client);
 * const store = new RedisStore(adapted);
 * ```
 */
export function fromNodeRedis(client: NodeRedisLike): IoredisLikeClient {
  return {
    async get(key: string): Promise<string | null> {
      return client.get(key);
    },

    async set(
      key: string,
      value: string,
      ...args: string[]
    ): Promise<string> {
      const options = parseSetArgs(args);
      const result = options
        ? await client.set(key, value, options)
        : await client.set(key, value);
      // node-redis can return null on some configurations; coerce to 'OK'
      return result ?? 'OK';
    },

    async del(key: string): Promise<number> {
      return client.del(key);
    },

    async watch(key: string): Promise<string> {
      return client.watch(key);
    },

    multi(): IoredisLikeMulti {
      const nodeMulti = client.multi();

      return {
        set(
          multiKey: string,
          multiValue: string,
          ...multiArgs: string[]
        ): IoredisLikeMulti {
          const options = parseSetArgs(multiArgs);
          if (options) {
            nodeMulti.set(multiKey, multiValue, options);
          } else {
            nodeMulti.set(multiKey, multiValue);
          }
          return this;
        },

        async exec(): Promise<Array<[Error | null, unknown]> | null> {
          const raw = await nodeMulti.exec();

          // WATCH conflict — node-redis returns null (aborted transaction)
          if (raw === null) return null;

          // node-redis returns raw results without error tuples; wrap each
          // result as `[null, result]` to match ioredis shape.
          return raw.map(
            (r): [Error | null, unknown] => [null, r],
          );
        },
      };
    },

    async eval(
      script: string,
      numkeys: number,
      ...args: string[]
    ): Promise<unknown> {
      return client.eval(script, splitEvalArgs(numkeys, args));
    },

    async evalsha(
      sha: string,
      numkeys: number,
      ...args: string[]
    ): Promise<unknown> {
      return client.evalSha(sha, splitEvalArgs(numkeys, args));
    },

    async script(cmd: string, ...args: string[]): Promise<string> {
      if (cmd === 'LOAD' && args.length >= 1) {
        return client.scriptLoad(args[0]!);
      }
      throw new UnsupportedOperationError(
        `script(${cmd}) is not supported by this adapter`,
      );
    },

    async pexpire(key: string, ms: number): Promise<number> {
      // Prefer direct pexpire method if available
      if (typeof (client as any).pexpire === 'function') {
        return (client as any).pexpire(key, ms) as Promise<number>;
      }
      // Fall back to sendCommand generic interface (node-redis v4+)
      if (typeof (client as any).sendCommand === 'function') {
        return (client as any).sendCommand([
          'PEXPIRE',
          key,
          String(ms),
        ]) as Promise<number>;
      }
      throw new UnsupportedOperationError(
        'pexpire is not supported by this client. Provide a client with ' +
          'sendCommand or pexpire.',
      );
    },
  };
}

// ===========================================================================
// Adapter: fromUpstash
// ===========================================================================

/**
 * Wrap an Upstash Redis REST client so it satisfies the IoredisLikeClient
 * shape that RedisStore consumes.
 *
 * ⚠️  Upstash REST does not support WATCH / MULTI / EXEC.  If you need
 * atomic read-modify-write you **must** use Lua-backed strategies.
 *
 * @example
 * ```ts
 * import { Redis } from '@upstash/redis';
 * import { fromUpstash } from 'throttlekit';
 *
 * const upstash = new Redis({ url: '...', token: '...' });
 * const adapted = fromUpstash(upstash);
 * const store = new RedisStore(adapted);
 * ```
 */
export function fromUpstash(client: UpstashLike): IoredisLikeClient {
  return {
    async get(key: string): Promise<string | null> {
      const result = await client.get<string>(key);
      return result ?? null;
    },

    async set(
      key: string,
      value: string,
      ...args: string[]
    ): Promise<string> {
      const options = parseSetArgs(args);
      const result = options
        ? await client.set(key, value, options)
        : await client.set(key, value);
      return result ?? 'OK';
    },

    async del(key: string): Promise<number> {
      return client.del(key);
    },

    async watch(_key: string): Promise<string> {
      throw new UnsupportedOperationError(
        'Upstash REST does not support WATCH/MULTI. Use Lua-backed strategies only.',
      );
    },

    multi(): IoredisLikeMulti {
      throw new UnsupportedOperationError(
        'Upstash REST does not support WATCH/MULTI. Use Lua-backed strategies only.',
      );
    },

    async eval(
      script: string,
      numkeys: number,
      ...args: string[]
    ): Promise<unknown> {
      const { keys, arguments: scriptArgs } = splitEvalArgs(numkeys, args);
      return client.eval(script, keys, scriptArgs);
    },

    async evalsha(
      sha: string,
      numkeys: number,
      ...args: string[]
    ): Promise<unknown> {
      const { keys, arguments: scriptArgs } = splitEvalArgs(numkeys, args);
      return client.evalsha(sha, keys, scriptArgs);
    },

    async script(cmd: string, ...args: string[]): Promise<string> {
      if (cmd === 'LOAD' && args.length >= 1) {
        return client.scriptLoad(args[0]!);
      }
      throw new UnsupportedOperationError(
        `script(${cmd}) is not supported by this adapter`,
      );
    },

    async pexpire(key: string, ms: number): Promise<number> {
      // Upstash REST does not expose PEXPIRE directly.
      // Attempt to use pexpire on the client via the index signature.
      if (typeof (client as any).pexpire === 'function') {
        return (client as any).pexpire(key, ms) as Promise<number>;
      }
      // Fall back to SET with PX option (read current value, re-set with expiry).
      // This is not atomic, but it is the closest approximation available.
      try {
        const existing = await client.get<string>(key);
        if (existing !== null) {
          await client.set(key, existing, { PX: ms });
          return 1;
        }
        return 0;
      } catch {
        throw new UnsupportedOperationError(
          'pexpire is not supported by this client.',
        );
      }
    },
  };
}
