// SPDX-License-Identifier: MIT
/**
 * G-18 (ASVS 6.3.8, WP 9.14): a failed sign-in says the same thing, in the same time, whichever factor
 * failed — proved at the HTTP route of the shipped composition (`buildApp`, the real identity context, the
 * production 250 ms `AUTH_FAILURE_DELAY_MS` default; the harness overrides nothing).
 *
 * WP 9.10 found two properties that held by reading and had no test that could fail: the route maps every
 * refusal that is not a rate limit, a lockout, a step-up or a session condition to ONE flat 401
 * `invalid_credential` (`toProblemError`'s default), and the identity context holds every failure for a
 * floor before it answers (`#applyFailureDelay`), so "unknown credential" and "wrong code" cannot be told
 * apart by a stopwatch. Both are pinned here:
 *
 * - the three login routes answer a wrong credential with byte-identical problem bodies (a passkey
 *   assertion with no challenge outstanding is `challenge_expired` inside the context — the route must
 *   flatten it), and
 * - each of them takes at least the floor, measured with the real clock on the real timer.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createApiHarness,
  expectStatus,
  NO_DATABASE,
  problemOf,
  type ApiHarness,
} from '../helpers/api-harness.ts';

/** The production default, `AUTH_FAILURE_DELAY_MS`; a margin for timer granularity only. */
const FLOOR_MS = 250;
const TIMER_SLACK_MS = 15;
const CSRF = 'c'.repeat(43);

describe.skipIf(NO_DATABASE)('G-18: a failed sign-in is uniform in body and in time', () => {
  let h: ApiHarness;

  beforeAll(async () => {
    h = await createApiHarness({ suite: 'g18_uniform' });
    // A holder who HAS the factors, so the wrong-code case is a wrong code and not "no such factor".
    const identity = h.security.requireIdentity();
    await identity.recoveryCodes.generate(h.userId);
  }, 120_000);

  afterAll(async () => {
    await h?.close();
  }, 60_000);

  const attempts = [
    {
      name: 'a passkey assertion for a login nobody started',
      url: '/auth/login/verify',
      body: { response: { id: 'AAAA', rawId: 'AAAA', type: 'public-key' }, trustedDevice: false },
    },
    {
      name: 'a wrong authenticator code',
      url: '/auth/totp/verify',
      body: { token: '000000', trustedDevice: false },
    },
    {
      name: 'a wrong recovery code',
      url: '/auth/recovery-code/verify',
      body: { code: 'AAAA-BBBB-CCCC-DDDD' },
    },
  ] as const;

  async function timed(attempt: (typeof attempts)[number]) {
    const started = performance.now();
    const response = await h.request({
      method: 'POST',
      url: attempt.url,
      body: attempt.body,
      // The double-submit pair a browser holds before it has signed in (the same shape `unlock-state` sets).
      headers: { cookie: `__Host-pfi_csrf=${CSRF}`, 'x-csrf-token': CSRF },
    });
    return { response, elapsedMs: performance.now() - started };
  }

  it('answers a wrong credential with one flat 401 body, whichever factor failed', async () => {
    const bodies: Record<string, unknown>[] = [];
    for (const attempt of attempts) {
      const { response } = await timed(attempt);
      expectStatus(response, 401);
      bodies.push(problemOf(response));
    }
    for (const body of bodies) {
      expect(body['code']).toBe('invalid_credential');
      expect(body['detail']).toBe('That credential is not valid.');
    }
    // Everything that identifies the REQUEST (instance, correlation id) may differ; nothing about the
    // factor may. Compare what is left.
    const strip = (body: Record<string, unknown>) => {
      const {
        instance: _instance,
        correlationId: _correlationId,
        requestId: _requestId,
        ...rest
      } = body;
      return rest;
    };
    expect(strip(bodies[1]!)).toEqual(strip(bodies[0]!));
    expect(strip(bodies[2]!)).toEqual(strip(bodies[0]!));
  }, 30_000);

  it.each(attempts)(
    'holds a failed attempt for the latency floor: $name',
    async (attempt) => {
      const { response, elapsedMs } = await timed(attempt);
      expectStatus(response, 401);
      expect(elapsedMs).toBeGreaterThanOrEqual(FLOOR_MS - TIMER_SLACK_MS);
    },
    30_000,
  );
});
