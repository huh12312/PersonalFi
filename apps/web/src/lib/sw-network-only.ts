// SPDX-License-Identifier: MIT

/**
 * The service worker's (`src/sw.ts`) `NetworkOnly` predicate, pulled out into
 * its own side-effect-free module so it can be unit-tested directly
 * (`sw-network-only.test.ts`) without importing `sw.ts` itself — that file
 * calls `precacheAndRoute(self.__WB_MANIFEST)` at module scope, which needs a
 * real service-worker global scope and a build-time-injected manifest, not
 * vitest's happy-dom environment.
 *
 * A positive allow-list of every data prefix this app calls or is documented
 * to call: `/auth/*` (every real route today, `apps/api/src/routes/auth.ts`),
 * `/api/*` (kept in case Caddy's currently-dead `/api/*` block is revived),
 * and the two unauthenticated probes `/health` and `/ready`. A `Response` for
 * any of these must never be readable from the Cache API days or months
 * later, which is the "no financial data or auth state in the Cache API" rule
 * the service worker's own header describes.
 */
export function isNetworkOnlyPath(pathname: string): boolean {
  return /^\/(api|auth|health|ready)(\/|$)/.test(pathname);
}
