// SPDX-License-Identifier: MIT
import { fileURLToPath, URL } from 'node:url';

import tailwindcss from '@tailwindcss/vite';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import react from '@vitejs/plugin-react-swc';
import { defineConfig } from 'vitest/config';
import { VitePWA } from 'vite-plugin-pwa';

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
        manualChunks: {
          'vendor-react': ['react', 'react-dom'],
          'vendor-tanstack': [
            '@tanstack/react-router',
            '@tanstack/react-query',
            '@tanstack/react-table',
            '@tanstack/react-virtual',
          ],
          'vendor-charts': [
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
