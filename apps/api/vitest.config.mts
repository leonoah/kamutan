import { fileURLToPath } from 'node:url';
import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // SWC emits decorator metadata, which NestJS DI needs (esbuild does not).
  plugins: [swc.vite({ module: { type: 'es6' } })],
  resolve: {
    // Workspace contracts are not an npm dependency (Cloud Functions build); use the source directly.
    alias: { '@kamutan/contracts': fileURLToPath(new URL('../../packages/contracts/src/index.ts', import.meta.url)) },
  },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 60_000,
    pool: 'forks',
    setupFiles: ['test/support/setup.ts'],
  },
});
