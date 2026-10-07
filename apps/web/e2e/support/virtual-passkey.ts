// SPDX-License-Identifier: MIT
import type { BrowserContext, Page } from '@playwright/test';

import { signIn } from './mock-sweep.ts';

/**
 * A real CDP virtual authenticator holding one discoverable credential for `localhost`, plus the two mocked
 * endpoints a passkey ceremony needs (`/auth/login/options` and `/auth/step-up/options` hand out real request
 * options; the `verify` endpoints accept the assertion (the step-up one through the mocked API's own handler)). The browser really signs what `startAuthentication` asks
 * for, so the ceremony a keyboard user triggers is the real one, not a stubbed `navigator.credentials`.
 *
 * Presence simulation starts **off**: the login screen arms a conditional (autofill) request on load, and an
 * authenticator that answers every request at once would sign in before a key was pressed. A journey turns it on
 * (`respond`) at the moment it presses the key that should trigger the ceremony.
 */
export interface VirtualPasskey {
  /** Answer the next ceremony(ies) automatically. */
  respond(enabled: boolean): Promise<void>;
  /** How many assertions reached a `verify` endpoint. */
  assertions(): number;
}

export async function installVirtualPasskey(
  page: Page,
  context: BrowserContext,
): Promise<VirtualPasskey> {
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: false,
      defaultBackupEligibility: true,
      defaultBackupState: true,
    },
  });
  // The key and the ids come from the runtime's global WebCrypto (the repo's `node:crypto` import ban is for app
  // secrets; a test authenticator's throwaway key does not belong in `@core/secretbox`).
  const b64 = (bytes: ArrayBuffer | Uint8Array): string =>
    Buffer.from(bytes as Uint8Array).toString('base64');
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
  ]);
  const material = {
    privateKey: b64(await crypto.subtle.exportKey('pkcs8', pair.privateKey)),
    credentialId: b64(crypto.getRandomValues(new Uint8Array(16))),
    userHandle: b64(crypto.getRandomValues(new Uint8Array(16))),
  };
  await cdp.send('WebAuthn.addCredential', {
    authenticatorId,
    credential: {
      credentialId: material.credentialId,
      isResidentCredential: true,
      rpId: 'localhost',
      privateKey: material.privateKey,
      userHandle: material.userHandle,
      signCount: 0,
    },
  });

  let asserted = 0;
  const options = {
    options: {
      challenge: 'dGVzdC1jaGFsbGVuZ2U',
      rpId: 'localhost',
      timeout: 60_000,
      userVerification: 'required',
    },
  };
  await page.route('**/api/auth/login/options', async (route) => {
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(options) });
  });
  await page.route('**/api/auth/step-up/options', async (route) => {
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(options) });
  });
  await page.route('**/api/auth/login/verify', async (route) => {
    asserted += 1;
    await signIn(page);
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });
  await page.route('**/api/auth/step-up/verify', async (route) => {
    asserted += 1;
    // The mocked API's own handler records the step-up (`steppedUp`), which later write routes require.
    await route.fallback();
  });

  return {
    respond: async (enabled) => {
      await cdp.send('WebAuthn.setAutomaticPresenceSimulation', { authenticatorId, enabled });
    },
    assertions: () => asserted,
  };
}
