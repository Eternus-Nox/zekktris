import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { visualizer } from 'rollup-plugin-visualizer';
import { readFileSync, writeFileSync } from 'node:fs';

// Bundle analyzer — opt-in via `ANALYZE=1 pnpm build`, which writes a
// treemap to dist/stats.html.
function analyzerPlugins(): Plugin[] {
  if (!process.env.ANALYZE) return [];
  return [
    visualizer({
      filename: 'dist/stats.html',
      gzipSize: true,
      brotliSize: true,
      template: 'treemap',
    }) as Plugin,
  ];
}

// During dev, proxy all /api/* and /gateway requests to the API server. This
// lets us run the web client on :5173 and the API on :3000 while keeping the
// app code blissfully unaware (it just hits same-origin paths).

/**
 * SW build-stamp plugin.
 * ----------------------
 * Substitutes `__BUILD_VERSION__` in `public/sw.js` with a unique
 * per-build identifier so each deploy gets its own cache name. The
 * stamp is the build-time epoch milliseconds — guaranteed monotonic
 * and unique across deploys without needing a CI-injected git SHA.
 *
 * In dev (vite serve), the file is served from disk untouched and the
 * SW isn't typically registered (we register on production builds
 * only via main.tsx); the literal `__BUILD_VERSION__` string is
 * harmless in that case.
 *
 * The plugin hooks `transformIndexHtml`'s sibling for static assets
 * via the `closeBundle` step: after Vite has copied `public/sw.js`
 * to `dist/`, we rewrite it with the substituted version. This keeps
 * the source in `public/` clean (no Vite-isms in plain JS).
 */
function swVersionPlugin(): Plugin {
  const version = `${Date.now()}`;
  return {
    name: 'zekktris-sw-version',
    apply: 'build',
    closeBundle: {
      order: 'post',
      handler() {
        const path = 'dist/sw.js';
        try {
          const original = readFileSync(path, 'utf-8');
          const next = original.replace(/__BUILD_VERSION__/g, version);
          if (next !== original) {
            writeFileSync(path, next, 'utf-8');
          }
        } catch {
          // Build proceeds even if the sw isn't found — we don't want
          // to fail a build over a missing optional file.
        }
      },
    },
  };
}

/**
 * Dev-only: drop the Content-Security-Policy meta from index.html. The
 * production policy (script-src/style-src 'self') would block the inline
 * React-refresh preamble and the <style> tags Vite's dev server injects for
 * CSS/HMR. `vite build` and `vite preview` keep it.
 */
function stripCspInDevPlugin(): Plugin {
  return {
    name: 'zekktris-strip-csp-in-dev',
    apply: 'serve',
    transformIndexHtml(html) {
      return html.replace(/<meta\s+http-equiv="Content-Security-Policy"[\s\S]*?\/>/, '');
    },
  };
}

export default defineConfig({
  plugins: [react(), swVersionPlugin(), stripCspInDevPlugin(), ...analyzerPlugins()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:3000', changeOrigin: true },
      '/cdn': { target: 'http://localhost:3000', changeOrigin: true },
      '/gateway': {
        target: 'ws://localhost:3000',
        ws: true,
        changeOrigin: true,
      },
    },
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    // Two chunks sit in the ~500–560 KB range: the eager app chunk (index,
    // ~555 KB / ~150 KB gzip — lazy-loading the heavy modals already pulled it
    // down from ~675 KB) and livekit-client (~510 KB), which is third-party and
    // lazy (dynamic import in voice.ts, fetched only on voice join) and not
    // splittable further. We deliberately do NOT carve a separate vendor chunk
    // out of index — that reintroduces a React init-order crash (see the
    // manualChunks note below). Set the warning above both so it still flags
    // genuine new growth without nagging about these two known chunks.
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        /**
         * Split stable third-party code into separate chunks so browser
         * caches survive across deploys.
         *
         * Without this: every deploy hashes the entire app + react +
         * router into one ~690KB index-*.js. Hash changes whenever any
         * app code does, so every deploy re-downloads everything.
         *
         * With this: app code goes to index-*.js (hash invalidates on
         * deploy, as before). React/react-dom/react-router go to
         * react-vendor-*.js (hash invalidates only when we upgrade
         * react itself — rare). LiveKit is ALREADY in its own dynamic
         * chunk via lazy-import in voice.ts, so it's not touched here.
         *
         * Net effect: first visit is the same total bytes (+ a few
         * hundred bytes of chunk-overhead). Subsequent visits after
         * deploys save ~45KB gzipped of cached react code.
         *
         * No UI impact — pages render identically. The only change is
         * the HTTP cache hit rate.
         */
        manualChunks(id: string) {
          if (id.includes('node_modules')) {
            if (
              id.includes('/react/') ||
              id.includes('/react-dom/') ||
              id.includes('/react-router') ||
              id.includes('/scheduler/')
            ) {
              return 'react-vendor';
            }
            // Everything else stays where Rollup places it (with its importer,
            // i.e. the eager index chunk or a lazy chunk). Do NOT force a
            // catch-all `vendor` chunk: React-dependent libraries
            // (use-context-selector, virtua) would land in it while React sits
            // in react-vendor, creating a cross-chunk init-order dependency
            // where the lib evaluates `React.useLayoutEffect` before
            // react-vendor's exports are ready — crashing at load with
            // "Cannot read properties of undefined (reading 'useLayoutEffect')".
            // livekit-client is lazy (dynamic import in voice.ts), so leaving
            // it undefined keeps it in its own on-demand chunk.
            return undefined;
          }
          return undefined;
        },
      },
    },
  },
});
