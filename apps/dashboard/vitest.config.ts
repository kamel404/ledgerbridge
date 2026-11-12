import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // `server-only` throws outside Next's server build; in tests it's just a marker.
    alias: { 'server-only': path.resolve(import.meta.dirname, 'lib/test-support/server-only-stub.ts') },
  },
  test: { globals: true, include: ['**/*.spec.ts'], exclude: ['node_modules', '.next'] },
});
