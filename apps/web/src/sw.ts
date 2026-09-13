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
 *     `vite-plugin-pwa`'s `injectManifest.globPatterns`/`globIgnores` in
 *     vite.config.ts, which also excludes the dev-only kitchen-sink route's
 *     chunk — gate-remediation-web.md L-3 — since it is dead code in
 *     production and has no business being fetched onto disk at all);
 *   - `NetworkOnly` for every data endpoint (`isNetworkOnlyPath`,
 *     src/lib/sw-network-only.ts — gate-remediation-web.md M-5) — no
 *     financial data, and no auth state, ever touches the Cache API. That
 *     predicate is unit-tested on its own, independent of this file, since
 *     this module has build-time (`self.__WB_MANIFEST`) and
 *     service-worker-global-scope side effects a plain test environment
 *     can't provide;
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

import { isNetworkOnlyPath } from './lib/sw-network-only.ts';

declare const self: ServiceWorkerGlobalScope;

precacheAndRoute(self.__WB_MANIFEST);

registerRoute(({ url }) => isNetworkOnlyPath(url.pathname), new NetworkOnly());

self.addEventListener('message', (event: ExtendableMessageEvent) => {
  if (event.data === 'SKIP_WAITING') {
    void self.skipWaiting();
  }
});

self.addEventListener('activate', () => {
  void self.clients.claim();
});
