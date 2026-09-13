// SPDX-License-Identifier: MIT
import { fileURLToPath, URL } from 'node:url';

import tailwindcss from '@tailwindcss/vite';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import react from '@vitejs/plugin-react-swc';
import { defineConfig, type Plugin } from 'vitest/config';
import { VitePWA } from 'vite-plugin-pwa';

/**
 * gate-remediation-web.md H-3: `sonner`'s ESM build calls a module-scope
 * `__insertCSS(...)` helper — `document.createElement('style')` +
 * `head.appendChild` — the instant it's imported, unconditionally. That is
 * exactly the runtime `<style>` injection `style-src-elem 'self'` exists to
 * block: the browser refuses to apply it and fires a
 * `securitypolicyviolation` on every single page load, whether or not a
 * toast is ever shown. `src/app/App.tsx` imports `sonner/dist/styles.css` —
 * the identical rules sonner ships specifically for bundlers — so the
 * styling is never actually lost; this plugin only removes the now-fully-
 * redundant runtime call that would otherwise still fire (and still violate
 * CSP) even with the real stylesheet in place.
 *
 * A build-time source transform rather than a dependency patch: no new
 * tooling, no lockfile change, and it fails loudly (throws) if a future
 * `sonner` upgrade changes the helper's name or call shape instead of
 * silently leaving the injection in place.
 *
 * Reliably effective for `vite build` (verified: `e2e/csp.spec.ts` builds
 * with `--mode e2e-csp` and asserts zero `securitypolicyviolation` events).
 * `vite dev` pre-bundles dependencies with esbuild *before* this plugin's
 * `transform` hook ever sees them, so excluding `sonner` from
 * `optimizeDeps` was tried here first to fix that — and reverted: it also
 * pulled `react-dom` out of Vite's normal CJS/ESM interop handling, breaking
 * every route with "does not provide an export named 'default'". `vite
 * dev` was never the CSP-relevant target anyway (no proxy in front of it
 * sets `Content-Security-Policy` at all), so this plugin's dev-mode
 * no-op is an accepted gap, not a silent one.
 */
function stripSonnerRuntimeCss(): Plugin {
  const INSERT_CSS_CALL = /^\s*__insertCSS\(.*\);?\s*$/m;
  return {
    name: 'strip-sonner-runtime-css',
    enforce: 'pre',
    transform(code, id) {
      if (!id.includes('/sonner/dist/index.mjs')) return null;
      if (!INSERT_CSS_CALL.test(code)) {
        throw new Error(
          'strip-sonner-runtime-css: expected an __insertCSS(...) call in sonner/dist/index.mjs ' +
            'and did not find one — sonner likely changed its build output. Update or remove this ' +
            'plugin (see gate-remediation-web.md H-3) and re-verify the CSP Playwright test ' +
            '(e2e/csp.spec.ts) still passes without it.',
        );
      }
      return { code: code.replace(INSERT_CSS_CALL, ''), map: null };
    },
  };
}

/**
 * Vite config for `@app/web`.
 *
 * CSP-relevant choices (docs/research/03-security-architecture.md §4.4,
 * docs/research/05-frontend-architecture.md §7.3), verified by
 * `scripts/check-csp.mjs` after every production build:
 *
 * - `build.modulePreload.polyfill = false` — the polyfill is injected as an
 *   inline <script>; modern browsers (this app targets `es2022` only,
 *   Chris's own browsers) don't need it, and an inline script is the single
 *   most common reason a Vite app can't ship `script-src 'self'`/nonce.
 * - `build.assetsInlineLimit = 0` — nothing becomes a base64 data: URI that
 *   could otherwise tempt an inline <img style=...> or similar; every asset
 *   is a real hashed file.
 * - `build.sourcemap = 'hidden'` — maps are emitted for CI/error triage but
 *   never referenced from (or shipped inside) the artifact that becomes the
 *   Docker image.
 *
 * The dev-only plugins (TanStack Router route-tree generation, the PWA
 * manifest/service-worker injection) are skipped under `mode === 'test'` so
 * `vitest` stays fast and doesn't touch the filesystem for a generated file
 * or a service worker no unit test exercises.
 */
export default defineConfig(({ mode }) => ({
  plugins: [
    // Route-tree codegen must run before the React plugin sees route files.
    ...(mode !== 'test' ? [tanstackRouter({ target: 'react', autoCodeSplitting: true })] : []),
    react(),
    tailwindcss(),
    stripSonnerRuntimeCss(),
    ...(mode !== 'test'
      ? [
          VitePWA({
            strategies: 'injectManifest',
            srcDir: 'src',
            filename: 'sw.ts',
            injectRegister: false, // registered explicitly in src/main.tsx (registerType: 'prompt')
            manifest: {
              id: '/',
              name: 'PersonalFi',
              short_name: 'PersonalFi',
              description: 'Self-hosted personal finance.',
              start_url: '/',
              scope: '/',
              display: 'standalone',
              orientation: 'any',
              background_color: '#0E1012',
              theme_color: '#0E1012',
              icons: [
                { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
                {
                  src: '/icons/icon-192-maskable.png',
                  sizes: '192x192',
                  type: 'image/png',
                  purpose: 'maskable',
                },
                { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
                {
                  src: '/icons/icon-512-maskable.png',
                  sizes: '512x512',
                  type: 'image/png',
                  purpose: 'maskable',
                },
              ],
              shortcuts: [
                { name: 'Transactions', url: '/transactions' },
                { name: 'Budgets', url: '/budgets' },
              ],
            },
            injectManifest: {
              // App-shell only (memo §10.4): JS/CSS/fonts/icons. Never /api/*.
              globPatterns: ['**/*.{js,css,woff2,svg,png}'],
              // gate-remediation-web.md L-3: `/dev/kitchen-sink`'s own
              // `beforeLoad` (src/routes/dev.kitchen-sink.tsx) redirects away
              // outside `import.meta.env.DEV`, so this route is unreachable
              // in a production build — but `autoCodeSplitting` still emits
              // it as its own chunk, and the glob above would happily
              // precache that dead code onto every visitor's disk anyway.
              // Matched by the router-plugin's own chunk-naming convention
              // (the route id, `dev.kitchen-sink`, prefixes the hash) rather
              // than a hardcoded filename, since the hash changes every
              // build.
              globIgnores: ['**/dev.kitchen-sink-*.js'],
            },
            devOptions: { enabled: false },
          }),
        ]
      : []),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    target: 'es2022',
    modulePreload: { polyfill: false },
    assetsInlineLimit: 0,
    sourcemap: 'hidden',
    rollupOptions: {
      output: {
        // `vendor-charts` used to be its own manual chunk (`@visx/*` +
        // `d3-*`). Discovered while wiring up `e2e/csp.spec.ts` (gate-
        // remediation-web.md — that test is the first thing in this repo to
        // load a real `vite build` production bundle in an actual browser;
        // `e2e/smoke.spec.ts` only ever exercises the dev server, which
        // isn't chunked this way, and `scripts/check-csp.ts` never executes
        // any JS): Rollup's own build log for this config said outright
        // "Circular chunk: vendor-charts -> vendor-tanstack -> vendor-charts"
        // and "Generated an empty chunk: vendor-react", and the produced
        // bundle threw `Cannot set properties of undefined (setting
        // 'Activity')` on load — a chunk-load-order crash from React's own
        // exports object not being initialized yet, on *every* route, not
        // just the ones this WP added. Folding `vendor-charts` into
        // `vendor-tanstack` (whatever `@visx`/`d3` module Rollup was putting
        // in a chunk that also needed something from `@tanstack/*` no longer
        // has two chunks to split across) removes the cycle; `vendor-react`
        // comes back non-empty as a result. Worth a follow-up to split chart
        // vendor code back out if bundle size ever demands it, but correctly
        // this time — with a chunk graph a browser can actually load.
        manualChunks: {
          'vendor-react': ['react', 'react-dom'],
          'vendor-tanstack': [
            '@tanstack/react-router',
            '@tanstack/react-query',
            '@tanstack/react-table',
            '@tanstack/react-virtual',
            '@visx/axis',
            '@visx/curve',
            '@visx/event',
            '@visx/gradient',
            '@visx/group',
            '@visx/responsive',
            '@visx/scale',
            '@visx/shape',
            '@visx/tooltip',
            'd3-array',
            'd3-scale',
            'd3-shape',
            'd3-time-format',
          ],
        },
      },
    },
  },
  test: {
    name: 'web',
    environment: 'happy-dom',
    setupFiles: ['./vitest.setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    css: true,
  },
}));
