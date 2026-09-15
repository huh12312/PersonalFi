// SPDX-License-Identifier: MIT

/**
 * The service worker's (`src/sw.ts`) `NetworkOnly` predicate, pulled out into
 * its own side-effect-free module so it can be unit-tested directly
 * (`sw-network-only.test.ts`) without importing `sw.ts` itself — that file
 * calls `precacheAndRoute(self.__WB_MANIFEST)` at module scope, which needs a
 * real service-worker global scope and a build-time-injected manifest, not
 * vitest's happy-dom environment.
 *
 * gate-security-review.md F-4/C-1a: every API route — `/auth/*`,
 * `/health`, `/ready`, and everything WP 1.5/1.3b added — is reachable from
 * the browser at exactly one prefix, `/api/*` (`docker/Caddyfile`'s
 * `handle_path /api/*`, which is also `servers[0].url` in
 * `packages/contracts/openapi/openapi.json` and `baseUrl` in
 * `client-runtime-config.ts`). Before C-1a the API's own top-level prefixes
 * (`/auth`, `/health`, `/ready`, ...) were reachable directly at the site
 * root, so this predicate matched them by name; now a bare `/auth/session`
 * request never reaches the API at all (it falls to the SPA catch-all), so
 * matching on `/api` alone is both correct and total — there is no other
 * prefix left that answers with data. A `Response` for any of these must
 * never be readable from the Cache API days or months later, which is the "no
 * financial data or auth state in the Cache API" rule the service worker's
 * own header describes.
 */
export function isNetworkOnlyPath(pathname: string): boolean {
  return /^\/api(\/|$)/.test(pathname);
}
