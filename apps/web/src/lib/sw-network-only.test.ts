// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';

import { isNetworkOnlyPath } from './sw-network-only.ts';

/**
 * gate-remediation-web.md M-5 pinned the predicate against `/auth/*` because
 * that was, at the time, every real endpoint in this app living outside
 * `/api`. gate-security-review.md F-4/C-1a moved every API route (including
 * `/auth/*`, `/health`, `/ready`) behind the single `/api/*` proxy prefix
 * (`docker/Caddyfile`'s `handle_path /api/*`), so a bare `/auth/session`
 * request from the browser no longer reaches the API at all — it falls to the
 * SPA catch-all and gets `index.html`, which is exactly why it must *not* be
 * treated as network-only data here (caching that 200 would be caching the
 * app shell, which is fine, not financial data). This pins the current
 * predicate directly, independent of `sw.ts` (which has
 * service-worker-global-scope side effects vitest's happy-dom environment
 * can't provide).
 */
describe('isNetworkOnlyPath', () => {
  it.each(['/api/auth/session', '/api/auth/login/verify', '/api/health', '/api/ready', '/api'])(
    'matches %s',
    (pathname) => {
      expect(isNetworkOnlyPath(pathname)).toBe(true);
    },
  );

  it.each([
    '/',
    '/index.html',
    '/assets/vendor-react-abc123.js',
    '/icons/icon-192.png',
    '/auth/session', // pre-C-1a shape: no longer reachable through the proxy, must not be treated as data
    '/health',
    '/ready',
    '/apiary', // a lookalike prefix, not the `/api` segment itself
  ])('does not match %s', (pathname) => {
    expect(isNetworkOnlyPath(pathname)).toBe(false);
  });
});
