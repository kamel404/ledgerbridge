import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    globals: true,
    root: './',
    include: ['**/*.spec.ts'],
    // `npm run test:cov`: fails if unit tests cover less than 80% of the
    // integration logic (PLAN Phase 8). Nest *.module.ts files only wire
    // classes together; the e2e tests exercise them.
    coverage: {
      provider: 'v8',
      include: ['src/flows/**/*.ts', 'src/erp-client/**/*.ts'],
      exclude: ['**/*.spec.ts', '**/*.module.ts'],
      reporter: ['text', 'html'],
      thresholds: { statements: 80, branches: 80, functions: 80, lines: 80 },
    },
  },
});
