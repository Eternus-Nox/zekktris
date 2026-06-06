import { defineConfig } from 'vitest/config';

// Smoke tests live in ./test (NOT ./src) so they're excluded from the
// production `tsc` build, whose tsconfig only includes src/**. Vitest loads
// the TypeScript directly via esbuild and resolves workspace packages
// (@zekktris/*) from their source exports, so no pre-build is required.
export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./test/setup.ts'],
    include: ['test/**/*.test.ts'],
  },
});
