import { defineConfig } from 'vitest/config';

export default defineConfig({
  worker: { format: 'es' },
  build: { target: 'es2022', chunkSizeWarningLimit: 800 },
  test: { include: ['test/**/*.test.ts'], testTimeout: 120_000 },
});
