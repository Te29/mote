import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node', // We're testing node-side logic mostly, browser interactions are via Playwright
    testTimeout: 30000,
    globals: true,
    include: ['**/*.test.ts'],
  },
  esbuild: {
    target: 'node18',
  },
});
