/**
 * Tests for Redis client adapter wrappers.
 *
 * Covers:
 *   - fromNodeRedis wraps get/set/del/eval/evalsha/script correctly
 *   - fromNodeRedis multi adapts set chaining and exec result shape
 *   - fromNodeRedis pexpire via sendCommand fallback
 *   - fromUpstash wraps get/set/del/eval/evalsha/script correctly
 *   - fromUpstash throws on watch() with exact error message
 *   - fromUpstash throws on multi() with exact error message
 *   - Both adapted clients structurally satisfy IoredisLikeClient
 */

import { describe, it, expect, vi, expectTypeOf } from 'vitest';
import {
  fromNodeRedis,
  fromUpstash,
  UnsupportedOperationError,
} from '../../src/stores/redis-adapters.js';
import type {
  IoredisLikeClient,
  NodeRedisLike,
  NodeRedisMulti,
  UpstashLike,
} from '../../src/stores/redis-adapters.js';

// ===========================================================================
// Helpers
// ===========================================================================

/** Create a minimal NodeRedisLike mock with all required methods. */
function createNodeRedisMock(overrides?: Partial<NodeRedisLike>): NodeRedisLike {
  const nodeMulti: NodeRedisMulti = {
    set: vi.fn().mockReturnThis(),
    exec: vi.fn().mockResolvedValue(['OK']),
  };

  return {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue('OK'),
    del: vi.fn().mockResolvedValue(1),
    watch: vi.fn().mockResolvedValue('OK'),
    multi: vi.fn().mockReturnValue(nodeMulti),
    eval: vi.fn().mockResolvedValue([1, 5, 5, 1000, 0]),
    evalSha: vi.fn().mockResolvedValue([1, 5, 5, 1000, 0]),
    scriptLoad: vi.fn().mockResolvedValue('mock-sha'),
    ...overrides,
    // Allow pexpire and sendCommand to be passed through overrides
    ...(overrides as any),
  };
}

/** Create a minimal UpstashLike mock with all required methods. */
function createUpstashMock(overrides?: Partial<UpstashLike>): UpstashLike {
  return {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue('OK'),
    del: vi.fn().mockResolvedValue(1),
    eval: vi.fn().mockResolvedValue([1, 10, 10, 2000, 0]),
    evalsha: vi.fn().mockResolvedValue([1, 10, 10, 2000, 0]),
    scriptLoad: vi.fn().mockResolvedValue('upstash-sha'),
    ...overrides,
  };
}

// ===========================================================================
// fromNodeRedis
// ===========================================================================

describe('fromNodeRedis', () => {
  it('adapts get — returns value when key exists', async () => {
    const mock = createNodeRedisMock({
      get: vi.fn().mockResolvedValue('stored-value'),
    });
    const adapted = fromNodeRedis(mock);

    const result = await adapted.get('my-key');

    expect(result).toBe('stored-value');
    expect(mock.get).toHaveBeenCalledTimes(1);
    expect(mock.get).toHaveBeenCalledWith('my-key');
  });

  it('adapts get — returns null when key missing', async () => {
    const mock = createNodeRedisMock({
      get: vi.fn().mockResolvedValue(null),
    });
    const adapted = fromNodeRedis(mock);

    const result = await adapted.get('missing');

    expect(result).toBeNull();
  });

  it('adapts set — without extra args', async () => {
    const mock = createNodeRedisMock();
    const adapted = fromNodeRedis(mock);

    const result = await adapted.set('key', 'value');

    expect(result).toBe('OK');
    expect(mock.set).toHaveBeenCalledWith('key', 'value');
  });

  it('adapts set — with PX expiry args', async () => {
    const mock = createNodeRedisMock();
    const adapted = fromNodeRedis(mock);

    const result = await adapted.set('key', 'value', 'PX', '5000');

    expect(result).toBe('OK');
    expect(mock.set).toHaveBeenCalledWith('key', 'value', { PX: '5000' });
  });

  it('adapts set — with NX flag', async () => {
    const mock = createNodeRedisMock();
    const adapted = fromNodeRedis(mock);

    const result = await adapted.set('key', 'value', 'NX');

    expect(result).toBe('OK');
    expect(mock.set).toHaveBeenCalledWith('key', 'value', { NX: true });
  });

  it('adapts set — with combined PX and NX', async () => {
    const mock = createNodeRedisMock();
    const adapted = fromNodeRedis(mock);

    const result = await adapted.set('key', 'value', 'PX', '3000', 'NX');

    expect(result).toBe('OK');
    expect(mock.set).toHaveBeenCalledWith('key', 'value', {
      PX: '3000',
      NX: true,
    });
  });

  it('adapts set — coerces null return to "OK"', async () => {
    const mock = createNodeRedisMock({
      set: vi.fn().mockResolvedValue(null),
    });
    const adapted = fromNodeRedis(mock);

    const result = await adapted.set('key', 'value');

    expect(result).toBe('OK');
  });

  it('adapts del', async () => {
    const mock = createNodeRedisMock();
    const adapted = fromNodeRedis(mock);

    const result = await adapted.del('delete-me');

    expect(result).toBe(1);
    expect(mock.del).toHaveBeenCalledWith('delete-me');
  });

  it('adapts watch', async () => {
    const mock = createNodeRedisMock();
    const adapted = fromNodeRedis(mock);

    const result = await adapted.watch('watch-key');

    expect(result).toBe('OK');
    expect(mock.watch).toHaveBeenCalledWith('watch-key');
  });

  describe('multi', () => {
    it('returns adapted multi with chaining set', async () => {
      const nodeMulti: NodeRedisMulti = {
        set: vi.fn().mockReturnThis(),
        exec: vi.fn().mockResolvedValue(['OK', 'OK']),
      };
      const mock = createNodeRedisMock({
        multi: vi.fn().mockReturnValue(nodeMulti),
      });
      const adapted = fromNodeRedis(mock);

      const multi = adapted.multi();
      const result = multi.set('k1', 'v1', 'PX', '1000');
      multi.set('k2', 'v2');

      // Must return this for chaining
      expect(result).toBe(multi);
      expect(nodeMulti.set).toHaveBeenCalledTimes(2);
      expect(nodeMulti.set).toHaveBeenNthCalledWith(1, 'k1', 'v1', {
        PX: '1000',
      });
      expect(nodeMulti.set).toHaveBeenNthCalledWith(2, 'k2', 'v2');
    });

    it('adapts multi exec result to ioredis shape', async () => {
      const nodeMulti: NodeRedisMulti = {
        set: vi.fn().mockReturnThis(),
        exec: vi.fn().mockResolvedValue(['OK', '42']),
      };
      const mock = createNodeRedisMock({
        multi: vi.fn().mockReturnValue(nodeMulti),
      });
      const adapted = fromNodeRedis(mock);

      const multi = adapted.multi();
      multi.set('k', 'v');
      const execResult = await multi.exec();

      // ioredis shape: Array<[Error | null, unknown]>
      expect(execResult).toEqual([
        [null, 'OK'],
        [null, '42'],
      ]);
    });

    it('adapts multi exec — returns null on WATCH conflict', async () => {
      const nodeMulti: NodeRedisMulti = {
        set: vi.fn().mockReturnThis(),
        exec: vi.fn().mockResolvedValue(null as unknown as unknown[]),
      };
      const mock = createNodeRedisMock({
        multi: vi.fn().mockReturnValue(nodeMulti),
      });
      const adapted = fromNodeRedis(mock);

      const multi = adapted.multi();
      multi.set('k', 'v');
      const execResult = await multi.exec();

      // null signals a WATCH conflict / aborted transaction
      expect(execResult).toBeNull();
    });
  });

  describe('eval / evalsha', () => {
    it('adapts eval — splits args into keys and argv', async () => {
      const mock = createNodeRedisMock();
      const adapted = fromNodeRedis(mock);

      const result = await adapted.eval(
        'return ARGV[1]',
        2,
        'key1',
        'key2',
        'arg1',
        'arg2',
      );

      // First 2 args after numkeys are keys, rest are arguments
      expect(mock.eval).toHaveBeenCalledWith('return ARGV[1]', {
        keys: ['key1', 'key2'],
        arguments: ['arg1', 'arg2'],
      });
      expect(result).toEqual([1, 5, 5, 1000, 0]);
    });

    it('adapts eval — with single key and no args', async () => {
      const mock = createNodeRedisMock();
      const adapted = fromNodeRedis(mock);

      await adapted.eval('return 1', 1, 'only-key');

      expect(mock.eval).toHaveBeenCalledWith('return 1', {
        keys: ['only-key'],
        arguments: [],
      });
    });

    it('adapts evalsha — splits args into keys and argv', async () => {
      const mock = createNodeRedisMock();
      const adapted = fromNodeRedis(mock);

      const result = await adapted.evalsha(
        'sha-hash',
        1,
        'key1',
        'arg1',
        'arg2',
      );

      expect(mock.evalSha).toHaveBeenCalledWith('sha-hash', {
        keys: ['key1'],
        arguments: ['arg1', 'arg2'],
      });
      expect(result).toEqual([1, 5, 5, 1000, 0]);
    });
  });

  describe('script', () => {
    it('adapts script("LOAD", ...) to scriptLoad', async () => {
      const mock = createNodeRedisMock();
      const adapted = fromNodeRedis(mock);

      const sha = await adapted.script('LOAD', 'return 1');

      expect(sha).toBe('mock-sha');
      expect(mock.scriptLoad).toHaveBeenCalledWith('return 1');
    });

    it('throws on unsupported script command', async () => {
      const mock = createNodeRedisMock();
      const adapted = fromNodeRedis(mock);

      await expect(
        adapted.script('EXISTS', 'sha-hash'),
      ).rejects.toThrow(UnsupportedOperationError);
    });
  });

  describe('pexpire', () => {
    it('uses sendCommand when pexpire is not available', async () => {
      const sendCommand = vi.fn().mockResolvedValue(1);
      const mock = createNodeRedisMock({
        sendCommand: sendCommand,
      } as unknown as NodeRedisLike & { sendCommand: typeof sendCommand });
      const adapted = fromNodeRedis(mock);

      const result = await adapted.pexpire('my-key', 5000);

      expect(result).toBe(1);
      expect(sendCommand).toHaveBeenCalledWith([
        'PEXPIRE',
        'my-key',
        '5000',
      ]);
    });

    it('prefers direct pexpire method over sendCommand', async () => {
      const pexpireFn = vi.fn().mockResolvedValue(1);
      const sendCommand = vi.fn();
      const mock = createNodeRedisMock({
        pexpire: pexpireFn,
        sendCommand: sendCommand,
      } as unknown as NodeRedisLike & { pexpire: typeof pexpireFn; sendCommand: typeof sendCommand });
      const adapted = fromNodeRedis(mock);

      const result = await adapted.pexpire('my-key', 5000);

      expect(result).toBe(1);
      expect(pexpireFn).toHaveBeenCalledWith('my-key', 5000);
      expect(sendCommand).not.toHaveBeenCalled();
    });

    it('throws when neither pexpire nor sendCommand exists', async () => {
      const mock = createNodeRedisMock();
      const adapted = fromNodeRedis(mock);

      await expect(adapted.pexpire('k', 1000)).rejects.toThrow(
        UnsupportedOperationError,
      );
    });
  });
});

// ===========================================================================
// fromUpstash
// ===========================================================================

describe('fromUpstash', () => {
  it('adapts get — returns value when key exists', async () => {
    const mock = createUpstashMock({
      get: vi.fn().mockResolvedValue('upstash-val'),
    });
    const adapted = fromUpstash(mock);

    const result = await adapted.get('ukey');

    expect(result).toBe('upstash-val');
    expect(mock.get).toHaveBeenCalledWith('ukey');
  });

  it('adapts get — returns null when key missing', async () => {
    const mock = createUpstashMock({
      get: vi.fn().mockResolvedValue(null),
    });
    const adapted = fromUpstash(mock);

    const result = await adapted.get('missing');

    expect(result).toBeNull();
  });

  it('adapts set — without extra args', async () => {
    const mock = createUpstashMock();
    const adapted = fromUpstash(mock);

    const result = await adapted.set('uk', 'uv');

    expect(result).toBe('OK');
    expect(mock.set).toHaveBeenCalledWith('uk', 'uv');
  });

  it('adapts set — with PX expiry', async () => {
    const mock = createUpstashMock();
    const adapted = fromUpstash(mock);

    const result = await adapted.set('uk', 'uv', 'PX', '3000');

    expect(result).toBe('OK');
    expect(mock.set).toHaveBeenCalledWith('uk', 'uv', { PX: '3000' });
  });

  it('adapts del', async () => {
    const mock = createUpstashMock();
    const adapted = fromUpstash(mock);

    const result = await adapted.del('delete-me');

    expect(result).toBe(1);
    expect(mock.del).toHaveBeenCalledWith('delete-me');
  });

  describe('eval / evalsha', () => {
    it('adapts eval — splits args into keys and args arrays', async () => {
      const mock = createUpstashMock();
      const adapted = fromUpstash(mock);

      const result = await adapted.eval(
        'return ARGV[1]',
        2,
        'k1',
        'k2',
        'a1',
        'a2',
      );

      expect(mock.eval).toHaveBeenCalledWith(
        'return ARGV[1]',
        ['k1', 'k2'],
        ['a1', 'a2'],
      );
      expect(result).toEqual([1, 10, 10, 2000, 0]);
    });

    it('adapts evalsha', async () => {
      const mock = createUpstashMock();
      const adapted = fromUpstash(mock);

      const result = await adapted.evalsha('sha', 1, 'k1', 'a1');

      expect(mock.evalsha).toHaveBeenCalledWith('sha', ['k1'], ['a1']);
      expect(result).toEqual([1, 10, 10, 2000, 0]);
    });
  });

  describe('script', () => {
    it('adapts script("LOAD", ...) to scriptLoad', async () => {
      const mock = createUpstashMock();
      const adapted = fromUpstash(mock);

      const sha = await adapted.script('LOAD', 'return 1');

      expect(sha).toBe('upstash-sha');
      expect(mock.scriptLoad).toHaveBeenCalledWith('return 1');
    });

    it('throws on unsupported script command', async () => {
      const mock = createUpstashMock();
      const adapted = fromUpstash(mock);

      await expect(adapted.script('KILL')).rejects.toThrow(
        UnsupportedOperationError,
      );
    });
  });

  describe('watch', () => {
    it('throws with exact Upstash error message', async () => {
      const mock = createUpstashMock();
      const adapted = fromUpstash(mock);

      await expect(adapted.watch('any-key')).rejects.toThrow(
        UnsupportedOperationError,
      );
      await expect(adapted.watch('any-key')).rejects.toThrow(
        'Upstash REST does not support WATCH/MULTI. Use Lua-backed strategies only.',
      );
    });
  });

  describe('multi', () => {
    it('throws with exact Upstash error message', async () => {
      const mock = createUpstashMock();
      const adapted = fromUpstash(mock);

      expect(() => adapted.multi()).toThrow(UnsupportedOperationError);
      expect(() => adapted.multi()).toThrow(
        'Upstash REST does not support WATCH/MULTI. Use Lua-backed strategies only.',
      );
    });
  });

  describe('pexpire', () => {
    it('uses direct pexpire method if available', async () => {
      const pexpireFn = vi.fn().mockResolvedValue(1);
      const mock = createUpstashMock({
        pexpire: pexpireFn,
      } as unknown as UpstashLike & { pexpire: typeof pexpireFn });
      const adapted = fromUpstash(mock);

      const result = await adapted.pexpire('uk', 5000);

      expect(result).toBe(1);
      expect(pexpireFn).toHaveBeenCalledWith('uk', 5000);
    });

    it('falls back to SET with PX when pexpire is missing', async () => {
      const getFn = vi.fn().mockResolvedValue('existing-val');
      const setFn = vi.fn().mockResolvedValue('OK');
      const mock = createUpstashMock({
        get: getFn,
        set: setFn,
      });
      const adapted = fromUpstash(mock);

      const result = await adapted.pexpire('uk', 5000);

      expect(result).toBe(1);
      expect(getFn).toHaveBeenCalledWith('uk');
      expect(setFn).toHaveBeenCalledWith('uk', 'existing-val', { PX: 5000 });
    });

    it('returns 0 when key does not exist (pexpire fallback)', async () => {
      const getFn = vi.fn().mockResolvedValue(null);
      const setFn = vi.fn();
      const mock = createUpstashMock({
        get: getFn,
        set: setFn,
      });
      const adapted = fromUpstash(mock);

      const result = await adapted.pexpire('missing', 5000);

      expect(result).toBe(0);
      expect(setFn).not.toHaveBeenCalled();
    });

    it('throws when both pexpire and fallback fail', async () => {
      const getFn = vi.fn().mockRejectedValue(new Error('connection failed'));
      const mock = createUpstashMock({
        get: getFn,
      });
      const adapted = fromUpstash(mock);

      await expect(adapted.pexpire('uk', 5000)).rejects.toThrow(
        UnsupportedOperationError,
      );
    });
  });
});

// ===========================================================================
// Structural interface conformance
// ===========================================================================

describe('interface conformance', () => {
  it('fromNodeRedis result structurally satisfies IoredisLikeClient', () => {
    const mock = createNodeRedisMock();
    const adapted = fromNodeRedis(mock);

    // Compile-time structural check
    const client: IoredisLikeClient = adapted;
    expect(client).toBeDefined();

    // Runtime shape check
    expect(typeof client.get).toBe('function');
    expect(typeof client.set).toBe('function');
    expect(typeof client.del).toBe('function');
    expect(typeof client.watch).toBe('function');
    expect(typeof client.multi).toBe('function');
    expect(typeof client.eval).toBe('function');
    expect(typeof client.evalsha).toBe('function');
    expect(typeof client.script).toBe('function');
    expect(typeof client.pexpire).toBe('function');
  });

  it('fromUpstash result structurally satisfies IoredisLikeClient', () => {
    const mock = createUpstashMock();
    const adapted = fromUpstash(mock);

    // Compile-time structural check
    const client: IoredisLikeClient = adapted;
    expect(client).toBeDefined();

    // Runtime shape check
    expect(typeof client.get).toBe('function');
    expect(typeof client.set).toBe('function');
    expect(typeof client.del).toBe('function');
    expect(typeof client.watch).toBe('function');
    expect(typeof client.multi).toBe('function');
    expect(typeof client.eval).toBe('function');
    expect(typeof client.evalsha).toBe('function');
    expect(typeof client.script).toBe('function');
    expect(typeof client.pexpire).toBe('function');
  });

  it('expectTypeOf confirms IoredisLikeClient interface', () => {
    const nodeMock = createNodeRedisMock();
    const nodeAdapted = fromNodeRedis(nodeMock);
    expectTypeOf(nodeAdapted).toMatchTypeOf<IoredisLikeClient>();

    const upstashMock = createUpstashMock();
    const upstashAdapted = fromUpstash(upstashMock);
    expectTypeOf(upstashAdapted).toMatchTypeOf<IoredisLikeClient>();
  });
});
