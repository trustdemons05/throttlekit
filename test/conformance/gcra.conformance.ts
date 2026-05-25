import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { ManualClock } from '../helpers/manual-clock.js';
import { createGcraStrategy } from '../../src/strategies/gcra.js';
import { gcraLuaMirror } from './lua-runner.js';

let luaFound = false;
try {
  const mod = await import('../../src/strategies/gcra.js');
  luaFound = typeof mod.gcraLua === 'string';
} catch {
  luaFound = false;
}

export const suiteStatus = luaFound ? 'ran' : 'skipped';

if (luaFound) {
  describe('GCRA Lua conformance', () => {
    it('matches Lua decisions over randomized timelines', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 100 }),
          fc.integer({ min: 100, max: 10_000 }),
          // GCRA Lua is hard-coded for cost=1; test only cost=1 to match Lua capability
          fc.array(fc.integer({ min: 1, max: 1 }), { minLength: 10, maxLength: 200 }),
          fc.array(fc.integer({ min: 0, max: 500 }), { minLength: 10, maxLength: 200 }),
          (limit, periodMs, costs, advances) => {
            const burst = limit; // default burst = limit
            const clock = new ManualClock(1_000_000);
            const jsStrategy = createGcraStrategy({ limit, periodMs, burst, clock });

            let luaState: number | null = null;
            const len = Math.min(costs.length, advances.length);

            for (let i = 0; i < len; i++) {
              clock.advanceBy(advances[i]!);
              const now = clock.now();
              const cost = costs[i]!;

              const jsResult = jsStrategy.apply('key', cost);
              const luaOutcome = gcraLuaMirror(luaState, now, cost, limit, periodMs, burst);
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
        { numRuns: 500 },
      );
    });
  });
}
