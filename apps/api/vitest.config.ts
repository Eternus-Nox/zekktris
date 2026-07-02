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
    // The repo lives on a slow SMB volume: the FIRST test in a file pays the
    // dynamic-import transform cost of its route/service graph, which under a
    // full parallel run can exceed the 5s default (and occasionally even 20s).
    // A generous ceiling only affects genuinely hung tests — passing tests
    // still finish in milliseconds.
    testTimeout: 40_000,
  },
});
