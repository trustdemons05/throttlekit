import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { ManualClock } from '../helpers/manual-clock.js';
import { createTokenBucketStrategy } from '../../src/strategies/token-bucket.js';
import { tokenBucketLuaMirror, type TokenBucketLuaState } from './lua-runner.js';

let luaFound = false;
try {
  const mod = await import('../../src/stores/redis.js');
  luaFound = typeof mod.tokenBucketLua === 'string';
} catch {
  luaFound = false;
}

export const suiteStatus = luaFound ? 'ran' : 'skipped';

if (luaFound) {
  describe('Token Bucket Lua conformance', () => {
    it('matches Lua decisions over randomized timelines', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 100 }),
          fc.integer({ min: 1, max: 100 }),
          fc.array(fc.integer({ min: 1, max: 100 }), { minLength: 10, maxLength: 200 }),
          fc.array(fc.integer({ min: 0, max: 500 }), { minLength: 10, maxLength: 200 }),
          (capacity, refillRate, costs, advances) => {
            const clock = new ManualClock(1_000_000);
            const jsStrategy = createTokenBucketStrategy({
              capacity,
              refillRate,
              clock,
            });

            let luaState: TokenBucketLuaState | null = null;
            const len = Math.min(costs.length, advances.length);

            for (let i = 0; i < len; i++) {
              clock.advanceBy(advances[i]!);
              const now = clock.now();
              const cost = costs[i]!;

              const jsResult = jsStrategy.apply('key', cost);
              const luaOutcome = tokenBucketLuaMirror(luaState, now, cost, capacity, refillRate);
              const luaResult = luaOutcome.result;
              luaState = luaOutcome.state;

              expect(jsResult.allowed).toBe(luaResult.allowed);
              expect(jsResult.remaining).toBe(luaResult.remaining);
              expect(jsResult.retryAfterMs).toBe(luaResult.retryAfterMs);
              expect(jsResult.resetAt).toBe(luaResult.resetAt);
              expect(jsResult.limit).toBe(luaResult.limit);
            }
          },
        ),
        { numRuns: 300 },
      );
    }, 15_000);
  });
}
