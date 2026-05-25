import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    'core/index': 'src/core/index.ts',
    'adapters/express': 'src/adapters/express.ts',
    'adapters/fetch': 'src/adapters/fetch.ts',
    'stores/redis': 'src/stores/redis.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  splitting: false,
  sourcemap: true,
  minify: false,
  target: 'es2022',
});
