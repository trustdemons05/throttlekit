import { vi } from 'vitest';

expect.extend({
  toBeWithinOneSecondOf(received: number, expected: number) {
    const pass = Math.abs(received - expected) <= 1000;
    return {
      pass,
      message: () =>
        `expected ${received} to be within 1s of ${expected}`,
    };
  },
});

vi.stubGlobal('performance', {
  now: () => Date.now(),
});
