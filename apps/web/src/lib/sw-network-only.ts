// SPDX-License-Identifier: MIT

/**
 * The service worker's (`src/sw.ts`) `NetworkOnly` predicate, pulled out into
 * its own side-effect-free module so it can be unit-tested directly
 * (`sw-network-only.test.ts`) without importing `sw.ts` itself — that file
 * calls `precacheAndRoute(self.__WB_MANIFEST)` at module scope, which needs a
 * real service-worker global scope and a build-time-injected manifest, not
 * vitest's happy-dom environment.
 *
 * gate-remediation-web.md M-5: the previous predicate matched only `/api/*`,
 * but every real endpoint in this app lives under `/auth/*`
 * (`apps/api/src/routes/auth.ts`) — so the "no financial data or auth state
 * in the Cache API" rule the service worker's header describes was never
 * actually exercised by anything that got called. This is a positive
 * allow-list of every data prefix this app calls or is documented to call:
 * `/auth/*` (every real route today), `/api/*` (kept in case Caddy's dead
 * `/api/*` block — §3 M-3 of the security review — is ever revived), and the
 * two unauthenticated probes `/health` and `/ready`. A `Response` for any of
 * these must never be readable from the Cache API days or months later.
 */
export function isNetworkOnlyPath(pathname: string): boolean {
  return /^\/(api|auth|health|ready)(\/|$)/.test(pathname);
}
