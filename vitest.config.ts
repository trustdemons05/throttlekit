import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    setupFiles: ['./test/setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'lcov', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/test/**', 'src/**/*.d.ts'],
      thresholds: {
        lines: 95,
        branches: 90,
        functions: 100,
        statements: 95,
      },
    },
    maxConcurrency: 10,
    testTimeout: 10_000,
    sequence: { concurrent: false },
    retry: 0,
  },
});
