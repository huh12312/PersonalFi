// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';

import { isNetworkOnlyPath } from './sw-network-only.ts';

/**
 * gate-remediation-web.md M-5: the service worker's `NetworkOnly` predicate
 * used to match only `/api/*`, but every real endpoint in this app lives
 * under `/auth/*` — so nothing the app ever actually called was covered.
 * This pins the fixed predicate directly, independent of `sw.ts` (which has
 * service-worker-global-scope side effects vitest's happy-dom environment
 * can't provide).
 */
describe('isNetworkOnlyPath', () => {
  it.each([
    '/auth/session',
    '/auth/login/verify',
    '/auth',
    '/api/whatever',
    '/api',
    '/health',
    '/ready',
  ])('matches %s', (pathname) => {
    expect(isNetworkOnlyPath(pathname)).toBe(true);
  });

  it.each([
    '/',
    '/index.html',
    '/assets/vendor-react-abc123.js',
    '/icons/icon-192.png',
    '/authenticate', // a lookalike prefix, not the `/auth` segment itself
    '/apiary',
    '/healthcheck',
  ])('does not match %s', (pathname) => {
    expect(isNetworkOnlyPath(pathname)).toBe(false);
  });
});
