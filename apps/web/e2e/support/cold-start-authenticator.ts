// SPDX-License-Identifier: MIT
import type { BrowserContext, Page } from '@playwright/test';

/**
 * A real CDP virtual authenticator, not `fake-webauthn.ts`'s page-level
 * `navigator.credentials` override — for `cold-start.spec.ts`, which needs the
 * whole ceremony (browser prompt, attestation, the real
 * `@simplewebauthn/browser` round trip) to run against a real API over a real
 * TLS connection, the same way Phase 1's gate walk script did
 * (docs/evidence/phase-1/gate-security-review.md §8: `WebAuthn.enable` +
 * `WebAuthn.addVirtualAuthenticator`, ctap2/internal, resident key, user
 * verification, `automaticPresenceSimulation`).
 *
 * `defaultBackupEligibility`/`defaultBackupState` matter: without them
 * Chrome's `create()` succeeds but a later `get()` is refused and the app
 * reports "That was cancelled" (the same gate script's own comment) — carried
 * here even though this suite only exercises registration, not a second
 * assertion, so a future extension of this file does not have to rediscover
 * it.
 */
export async function attachVirtualAuthenticator(
  context: BrowserContext,
  page: Page,
): Promise<string> {
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
      defaultBackupEligibility: true,
      defaultBackupState: true,
    },
  });
  return authenticatorId;
}
