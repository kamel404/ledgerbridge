import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: ['test/**/*.test.ts'],
    // Synthesising CDK stacks takes a few seconds.
    testTimeout: 30_000,
  },
});
