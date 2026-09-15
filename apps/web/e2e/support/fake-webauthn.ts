// SPDX-License-Identifier: MIT
import type { Page } from '@playwright/test';

/**
 * Stands in for a virtual authenticator for the one ceremony this suite
 * drives (the step-up assertion before adding a manual connection):
 * overrides `navigator.credentials.get` to resolve with a synthetic
 * assertion shaped exactly as `@simplewebauthn/browser`'s
 * `startAuthentication` expects (read from its source —
 * `esm/methods/startAuthentication.js` — id/rawId/response.{authenticatorData,
 * clientDataJSON,signature,userHandle}/type/`getClientExtensionResults()`).
 *
 * A real CDP virtual authenticator (`WebAuthn.addVirtualAuthenticator` +
 * `WebAuthn.addCredential`) is the more "real" alternative and is how a
 * live-backend passkey registration/login would be driven — left for the
 * live-backend walkthrough this suite deliberately doesn't attempt (see
 * `mock-api.ts`'s header). For a step-up ceremony whose server side is
 * already mocked to accept anything, a page-level override reaches the same
 * app code (`startAuthentication` really runs, really calls
 * `navigator.credentials.get`, really round-trips an assertion object
 * through the same serialization the real API client sends) with far fewer
 * moving parts.
 */
export async function installFakeWebAuthnAssertion(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const encoder = new TextEncoder();
    const clientData = JSON.stringify({
      type: 'webauthn.get',
      challenge: 'dGVzdC1jaGFsbGVuZ2U',
      origin: window.location.origin,
    });

    Object.defineProperty(window.navigator, 'credentials', {
      configurable: true,
      value: {
        ...window.navigator.credentials,
        get: async () => ({
          id: 'e2e-fake-credential',
          rawId: encoder.encode('e2e-fake-credential').buffer,
          type: 'public-key',
          authenticatorAttachment: 'platform',
          response: {
            authenticatorData: new ArrayBuffer(37),
            clientDataJSON: encoder.encode(clientData).buffer,
            signature: new ArrayBuffer(8),
            userHandle: null,
          },
          getClientExtensionResults: () => ({}),
        }),
      },
    });
  });
}
