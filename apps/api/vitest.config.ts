import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts', 'src/matching/test/**/*.test.ts'],
    globalSetup: ['test/global-setup.ts'],
    fileParallelism: false,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/matching/**', 'src/db/migrations/**', 'src/server.ts'],
      reporter: ['text-summary', 'json-summary', 'text'],
    },
    testTimeout: 30000,
    hookTimeout: 120000,
  },
});
