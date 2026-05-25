import { describe, it, expect } from 'vitest';
import * as tokenBucket from './token-bucket.conformance.js';
import * as fixedWindow from './fixed-window.conformance.js';
import * as gcra from './gcra.conformance.js';
import * as slidingWindowLog from './sliding-window-log.conformance.js';
import * as slidingWindowCounter from './sliding-window-counter.conformance.js';

describe('Conformance Suite Summary', () => {
  it('logs which suites ran and which were skipped', () => {
    const statuses = [
      `token-bucket: ${tokenBucket.suiteStatus === 'ran' ? 'Lua found — running' : 'Lua not found — skipped'}`,
      `fixed-window: ${fixedWindow.suiteStatus === 'ran' ? 'Lua found — running' : 'Lua not found — skipped'}`,
      `gcra: ${gcra.suiteStatus === 'ran' ? 'Lua found — running' : 'Lua not found — skipped'}`,
      `sliding-window-log: ${slidingWindowLog.suiteStatus === 'ran' ? 'Lua found — running' : 'Lua not found — skipped'}`,
      `sliding-window-counter: ${slidingWindowCounter.suiteStatus === 'ran' ? 'Lua found — running' : 'Lua not found — skipped'}`,
    ];

    for (const status of statuses) {
      console.log(status);
    }

    const ran = statuses.filter((s) => s.includes('running')).length;
    const skipped = statuses.filter((s) => s.includes('skipped')).length;
    console.log(`Total: ${ran} running, ${skipped} skipped`);

    expect(statuses.length).toBe(5);
  });
});
