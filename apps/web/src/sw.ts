// SPDX-License-Identifier: MIT
/// <reference lib="webworker" />

/**
 * Hand-written service worker (`injectManifest` strategy, not `generateSW` —
 * docs/research/05-frontend-architecture.md §10.4). The default runtime
 * caching recipes `generateSW` offers would happily cache `/api/*` responses
 * containing balances to disk, which is wrong for this app by default.
 *
 * Policy:
 *   - precache the app shell only (JS/CSS/fonts/icons — content-hashed,
 *     non-sensitive; `self.__WB_MANIFEST` is injected at build time by
 *     `vite-plugin-pwa`'s `injectManifest.globPatterns` in vite.config.ts);
 *   - `NetworkOnly` for every `/api/*` request — no financial data ever
 *     touches the Cache API;
 *   - `registerType: 'prompt'`: a new SW installs and waits; it only takes
 *     over after the page posts `SKIP_WAITING` (src/lib/service-worker.ts,
 *     triggered by the user clicking "Reload" on the update toast). Never
 *     `skipWaiting()` unconditionally — swapping the bundle under someone
 *     mid-split-edit is hostile.
 *
 * Opt-in offline reads (IndexedDB-backed TanStack Query persistence, wiped
 * on logout/hard-expiry) are a `/settings/appearance` feature for a later
 * work package, not this service worker's job.
 */
import { precacheAndRoute } from 'workbox-precaching';
import { registerRoute } from 'workbox-routing';
import { NetworkOnly } from 'workbox-strategies';

declare const self: ServiceWorkerGlobalScope;

precacheAndRoute(self.__WB_MANIFEST);

registerRoute(({ url }) => url.pathname.startsWith('/api/'), new NetworkOnly());

self.addEventListener('message', (event: ExtendableMessageEvent) => {
  if (event.data === 'SKIP_WAITING') {
    void self.skipWaiting();
  }
});

self.addEventListener('activate', () => {
  void self.clients.claim();
});
