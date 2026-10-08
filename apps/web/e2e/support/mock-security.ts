// SPDX-License-Identifier: MIT
import type { Page, Route } from '@playwright/test';

/**
 * The sessions / sign-in-methods routes (WP 9.14; the API is WP 9.11's G-02 and G-12), as a layerable
 * mock. Install it **after** `installApiMocks` (`page.route` handlers registered later win;
 * `route.fallback()` hands everything else down).
 *
 * The honest part is the step-up: `GET /auth/sessions`, `DELETE /auth/sessions[/:id]` and
 * `DELETE /auth/totp` answer `403 step_up_required` until `POST /auth/step-up/verify` has been called,
 * exactly as `requireFreshSession` does, so a spec that passes proves the screen ran the passkey
 * ceremony and retried, not that it called a route that was never gated.
 *
 * Bodies are field-for-field instances of the contract's `SessionSummary` and `AuthOk`.
 */

const json = (body: unknown, status = 200) => ({
  status,
  contentType: 'application/json',
  body: JSON.stringify(body),
});

export interface MockSecurityState {
  /** Every request this mock saw, in order, as `METHOD path` — the step-up ordering is asserted from it. */
  readonly calls: string[];
  fresh: boolean;
  totpEnrolled: boolean;
  /** How many times the ten codes were generated; each call replaces the set. */
  generations: number;
  sessions: { familyId: string; [key: string]: unknown }[];
}

export const SESSION_CURRENT = '01920000-0000-7000-8000-0000000000a1';
export const SESSION_PHONE = '01920000-0000-7000-8000-0000000000a2';
export const SESSION_OLD = '01920000-0000-7000-8000-0000000000a3';

export async function installSecurityMocks(page: Page): Promise<MockSecurityState> {
  const state: MockSecurityState = {
    calls: [],
    fresh: false,
    totpEnrolled: true,
    generations: 0,
    sessions: [
      {
        familyId: SESSION_CURRENT,
        authMethod: 'totp',
        trustedDevice: true,
        lastSeenAt: '2026-10-07T12:00:00.000Z',
        familyExpiresAt: '2026-10-21T12:00:00.000Z',
        current: true,
      },
      {
        familyId: SESSION_PHONE,
        authMethod: 'webauthn',
        trustedDevice: false,
        lastSeenAt: '2026-10-06T08:30:00.000Z',
        familyExpiresAt: '2026-10-13T08:30:00.000Z',
        current: false,
      },
      {
        familyId: SESSION_OLD,
        authMethod: 'recovery_code',
        trustedDevice: false,
        lastSeenAt: '2026-10-01T08:30:00.000Z',
        familyExpiresAt: '2026-10-08T08:30:00.000Z',
        current: false,
      },
    ],
  };
  const stepUpRequired = {
    type: 'https://personalfi.local/problems/step_up_required',
    title: 'Forbidden',
    status: 403,
    code: 'step_up_required',
  };

  let signedIn = false;
  await page.route('**/api/auth/**', async (route: Route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();

    if (path === '/api/auth/step-up/verify' && method === 'POST') {
      state.calls.push(`${method} ${path}`);
      state.fresh = true;
      return route.fulfill(json({ freshUntil: new Date(Date.now() + 300_000).toISOString() }));
    }
    // Signing in is the general mock's; this layer only watches it happen so the session it serves
    // afterwards can carry this fixture's TOTP and recovery-code state.
    if (path === '/api/auth/totp/verify' && method === 'POST') {
      signedIn = true;
      return route.fallback();
    }
    if (path === '/api/auth/session' && method === 'GET' && signedIn) {
      return route.fulfill(
        json({
          userId: 'user_1',
          displayName: 'Chris',
          displayTimezone: 'UTC',
          authMethod: 'totp',
          trustedDevice: true,
          fresh: state.fresh,
          idleExpiresAt: new Date(Date.now() + 900_000).toISOString(),
          absoluteExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          credentialCount: 1,
          totpEnrolled: state.totpEnrolled,
          recoveryCodesRemaining: 10,
        }),
      );
    }

    if (path === '/api/auth/recovery-codes' && method === 'POST') {
      state.calls.push(`${method} ${path}`);
      if (!state.fresh) return route.fulfill(json(stepUpRequired, 403));
      state.generations += 1;
      // `{ codes: string[10] }`: the contract's own shape (`generateRecoveryCodes`), ten distinct codes.
      return route.fulfill(
        json({
          codes: Array.from(
            { length: 10 },
            (_, index) =>
              `PFI-${String(state.generations)}${String(index).padStart(3, '0')}-K7Q2-X9WD`,
          ),
        }),
      );
    }

    const isSessions = path === '/api/auth/sessions' || path.startsWith('/api/auth/sessions/');
    const isTotp = path === '/api/auth/totp' && method === 'DELETE';
    if (!isSessions && !isTotp) return route.fallback();

    state.calls.push(`${method} ${path}`);
    if (!state.fresh) return route.fulfill(json(stepUpRequired, 403));
    // Each assertion buys one gated call in this fixture, so a screen that forgets to step up for its
    // SECOND action is seen, as it would be after the real five-minute window.
    if (method === 'GET') {
      return route.fulfill(json({ sessions: state.sessions }));
    }
    if (isTotp) {
      state.totpEnrolled = false;
      return route.fulfill(json({ ok: true }));
    }
    if (path === '/api/auth/sessions' && method === 'DELETE') {
      const others = state.sessions.filter((entry) => entry['current'] !== true);
      state.sessions = state.sessions.filter((entry) => entry['current'] === true);
      return route.fulfill(json({ revoked: others.length }));
    }
    const familyId = path.split('/').at(-1);
    state.sessions = state.sessions.filter((entry) => entry.familyId !== familyId);
    return route.fulfill(json({ ok: true }));
  });

  return state;
}
