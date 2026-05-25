import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    'index': 'src/index.ts',
    'adapters/express': 'src/adapters/express.ts',
    'adapters/fetch': 'src/adapters/fetch.ts',
    'stores/redis': 'src/stores/redis.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  target: 'node18',
  outDir: 'dist',
  treeshake: true,
  external: ['ioredis', 'express', '@opentelemetry/api'],
});
