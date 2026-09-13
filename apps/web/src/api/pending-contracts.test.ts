// SPDX-License-Identifier: MIT
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { apiFetch } from './pending-contracts.ts';

/**
 * gate-remediation-web.md L-1: `apiFetch` used to build its `RequestInit` as
 * `{ credentials: 'include', ...init, headers }`, which let a caller's own
 * `init.credentials` silently weaken the request and discarded any headers a
 * caller supplied instead of merging them. Both are fixed now; these tests
 * pin the fixed behaviour so a future edit can't reintroduce either bug by
 * reordering the spread.
 */
describe('apiFetch', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('always sends credentials: include, even if the caller tries to weaken it', async () => {
    // Deliberately hostile input: a caller (or a future refactor) trying to
    // override credentials must not be able to weaken the request.
    await apiFetch('/auth/session', z.object({ ok: z.literal(true) }), {
      credentials: 'omit',
    });

    const [, requestInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(requestInit.credentials).toBe('include');
  });

  it('merges caller-supplied headers instead of dropping them', async () => {
    await apiFetch('/auth/session', z.object({ ok: z.literal(true) }), {
      headers: { 'X-Test-Header': 'present' },
    });

    const [, requestInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = requestInit.headers as Record<string, string>;
    expect(headers['X-Test-Header']).toBe('present');
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('still attaches the CSRF header on mutating methods alongside merged headers', async () => {
    // happy-dom (correctly) refuses to *set* a `__Host-`-prefixed cookie over
    // `http:` — stubbing the getter sidesteps that browser-security rule,
    // which isn't what this test is checking.
    vi.spyOn(document, 'cookie', 'get').mockReturnValue('__Host-pfi_csrf=test-token');

    await apiFetch('/auth/logout', z.object({ ok: z.literal(true) }), {
      method: 'POST',
      headers: { 'X-Test-Header': 'present' },
    });

    const [, requestInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = requestInit.headers as Record<string, string>;
    expect(headers['x-csrf-token']).toBe('test-token');
    expect(headers['X-Test-Header']).toBe('present');
  });

  /**
   * gate-security-review-2.md P0-4. Both of these were *structural* breakages,
   * not races: with no `__Host-pfi_csrf` cookie every first mutation of a cold
   * browser session was rejected `403 csrf_failed`, and every bodyless
   * mutation was rejected `400 fst_err_ctp_empty_json_body`. Between them they
   * made first-run passkey enrolment, passkey login, step-up and logout all
   * impossible from the shipped bundle.
   */
  describe('cold-start mutations', () => {
    it('primes the CSRF cookie with a GET before the first mutation of a cold session', async () => {
      // No cookie at all — a browser that landed straight on /register or /login.
      vi.spyOn(document, 'cookie', 'get').mockReturnValue('');

      await apiFetch('/auth/login/options', z.object({ ok: z.literal(true) }), {
        method: 'POST',
      });

      expect(fetchMock).toHaveBeenCalledTimes(2);
      const [primePath, primeInit] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(primePath).toBe('/auth/unlock-state');
      expect(primeInit.credentials).toBe('include');
      // ...and the real mutation still goes out, after it.
      const [mutationPath] = fetchMock.mock.calls[1] as [string, RequestInit];
      expect(mutationPath).toBe('/auth/login/options');
    });

    it('does not prime when a CSRF cookie is already present', async () => {
      vi.spyOn(document, 'cookie', 'get').mockReturnValue('__Host-pfi_csrf=test-token');

      await apiFetch('/auth/logout', z.object({ ok: z.literal(true) }), { method: 'POST' });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [path] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(path).toBe('/auth/logout');
    });

    it('sends an empty JSON object for a bodyless mutation', async () => {
      vi.spyOn(document, 'cookie', 'get').mockReturnValue('__Host-pfi_csrf=test-token');

      await apiFetch('/auth/logout', z.object({ ok: z.literal(true) }), { method: 'POST' });

      const [, requestInit] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(requestInit.body).toBe('{}');
    });

    it('never overwrites a body the caller supplied', async () => {
      vi.spyOn(document, 'cookie', 'get').mockReturnValue('__Host-pfi_csrf=test-token');

      await apiFetch('/auth/login/verify', z.object({ ok: z.literal(true) }), {
        method: 'POST',
        body: JSON.stringify({ trustedDevice: true }),
      });

      const [, requestInit] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(requestInit.body).toBe('{"trustedDevice":true}');
    });

    it('leaves safe methods alone: no priming, no synthesised body', async () => {
      vi.spyOn(document, 'cookie', 'get').mockReturnValue('');

      await apiFetch('/auth/session', z.object({ ok: z.literal(true) }));

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [path, requestInit] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(path).toBe('/auth/session');
      expect(requestInit.body).toBeUndefined();
    });
  });
});
