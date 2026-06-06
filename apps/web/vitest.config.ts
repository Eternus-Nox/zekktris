import { defineConfig } from 'vitest/config';

// Standalone vitest config for the web package. These are pure-logic unit
// tests (e.g. the channel reorder diff), so we use the node environment and
// don't pull in the full Vite build/plugin chain. Tests live in test/ — kept
// outside src/ so the production `tsc -b` build never compiles them.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
