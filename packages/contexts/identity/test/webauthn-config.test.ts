// SPDX-License-Identifier: MIT
/**
 * **P0-4 evidence: the passkey ceremony is bound to the configured relying
 * party, and proved against a deployment-shaped one.**
 *
 * The gate found the deployed stack running `AUTH_RP_ID=localhost` and
 * `AUTH_ALLOWED_ORIGINS=http://localhost:8080` while serving
 * `https://personalfi.lan`, and concluded that no passkey had ever been enrolled
 * through it. `loadConfig` now refuses that pairing at boot
 * (`packages/config/src/load.test.ts`). This file proves the other half: that
 * when the configuration *is* right, the ceremony actually completes — and that
 * the origin check is load-bearing rather than decorative.
 *
 * Why `personalfi.lan` and not the existing suite's `localhost`: `localhost` is
 * the one hostname browsers special-case, and an RP id of `localhost` is a
 * registrable suffix of nothing but itself. Running the whole ceremony against a
 * real-looking hostname is what demonstrates the deployment works, rather than
 * demonstrating that the development default works.
 *
 * The signatures here are real — `authenticator.ts` assembles genuine CBOR, a
 * genuine COSE ES256 key and a genuine ECDSA signature over
 * `authenticatorData || SHA-256(clientDataJSON)`, and `@simplewebauthn/server`
 * verifies them. An `rpIdHash` or an origin that did not match would fail in the
 * library, not in an assertion of ours.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { isAuthError } from '../src/errors.ts';
import { createAuthenticator } from './authenticator.ts';
import { ADMIN_URL, createIdentityHarness, type IdentityHarness } from './harness.ts';

const describeWithDb = ADMIN_URL === undefined ? describe.skip : describe;

/** The deployment the gate was actually looking at. */
const DEPLOYED_RP_ID = 'personalfi.lan';
const DEPLOYED_ORIGIN = 'https://personalfi.lan';

describeWithDb('WebAuthn is bound to the configured relying party (P0-4)', () => {
  let harness: IdentityHarness;

  beforeAll(async () => {
    harness = await createIdentityHarness('personalfi_wp02_rpconfig', {
      rpId: DEPLOYED_RP_ID,
      allowedOrigins: [DEPLOYED_ORIGIN],
    });
  }, 120_000);

  afterAll(async () => {
    await harness.drop();
  }, 30_000);

  beforeEach(async () => {
    await harness.reset();
  });

  it('offers the configured RP id in registration options, not a default', () => {
    // The gate could not tell from the outside whether `AUTH_RP_ID` was reaching
    // the ceremony at all. This is that wire, asserted.
    return harness.identity.webauthn.startRegistration(harness.userId, 'Chris').then((options) => {
      expect(options.rp.id).toBe(DEPLOYED_RP_ID);
      expect(options.rp.id).not.toBe('localhost');
      expect(options.challenge.length).toBeGreaterThan(0);
      expect(options.authenticatorSelection?.userVerification).toBe('required');
    });
  });

  it('offers the configured RP id in authentication options too', async () => {
    const authenticator = await createAuthenticator({
      rpId: DEPLOYED_RP_ID,
      origin: DEPLOYED_ORIGIN,
      userId: harness.userId,
    });
    const registration = await harness.identity.webauthn.startRegistration(harness.userId, 'Chris');
    await harness.identity.webauthn.finishRegistration({
      userId: harness.userId,
      response: await authenticator.register(registration.challenge),
      friendlyName: 'phone',
    });

    const options = await harness.identity.webauthn.startAuthentication('authentication');

    expect(options.rpId).toBe(DEPLOYED_RP_ID);
  });

  it('enrols a passkey end to end against https://personalfi.lan', async () => {
    // options -> attestation -> verify, with a real signature, at the hostname
    // the stack actually serves. This is the Phase 0 exit criterion the gate
    // reported could not be met as configured.
    const authenticator = await createAuthenticator({
      rpId: DEPLOYED_RP_ID,
      origin: DEPLOYED_ORIGIN,
      userId: harness.userId,
    });

    const options = await harness.identity.webauthn.startRegistration(harness.userId, 'Chris');
    expect(options.rp.id).toBe(DEPLOYED_RP_ID);

    const credential = await harness.identity.webauthn.finishRegistration({
      userId: harness.userId,
      response: await authenticator.register(options.challenge),
      friendlyName: "Chris's phone",
    });

    expect(credential.friendlyName).toBe("Chris's phone");

    const stored = await harness.identity.webauthn.listCredentials(harness.userId);
    expect(stored).toHaveLength(1);

    // And the credential is usable, which is the part that matters: an enrolment
    // that cannot subsequently authenticate is not an enrolment.
    const assertionOptions = await harness.identity.webauthn.startAuthentication('authentication');
    const verified = await harness.identity.webauthn.finishAuthentication({
      response: await authenticator.authenticate(assertionOptions.challenge),
      purpose: 'authentication',
    });

    expect(verified.userId).toBe(harness.userId);
  });

  it('refuses an attestation from the wrong origin', async () => {
    // Same RP id, same real signature, different origin. If `expectedOrigin` were
    // not wired to config this would succeed, and the CSRF/WebAuthn allow-list
    // would be decoration.
    const impostor = await createAuthenticator({
      rpId: DEPLOYED_RP_ID,
      origin: 'https://evil.example',
      userId: harness.userId,
    });
    const options = await harness.identity.webauthn.startRegistration(harness.userId, 'Chris');

    let error: unknown;
    try {
      await harness.identity.webauthn.finishRegistration({
        userId: harness.userId,
        response: await impostor.register(options.challenge),
        friendlyName: 'impostor',
      });
    } catch (caught) {
      error = caught;
    }

    expect(isAuthError(error)).toBe(true);
    expect(error).toMatchObject({ code: 'invalid_credential' });
    expect(await harness.identity.webauthn.listCredentials(harness.userId)).toHaveLength(0);
  });

  it('refuses an assertion from an unknown credential at a look-alike origin', async () => {
    const authenticator = await createAuthenticator({
      rpId: DEPLOYED_RP_ID,
      origin: DEPLOYED_ORIGIN,
      userId: harness.userId,
    });
    const registration = await harness.identity.webauthn.startRegistration(harness.userId, 'Chris');
    await harness.identity.webauthn.finishRegistration({
      userId: harness.userId,
      response: await authenticator.register(registration.challenge),
      friendlyName: 'phone',
    });

    // A credential this server has never seen, presented from a look-alike
    // origin. Deliberately *not* claimed to be the same-credential replay a
    // phishing proxy performs: `createAuthenticator` mints a fresh keypair, so
    // this asserts unknown-credential rejection, and the origin binding on the
    // assertion path is covered by the attestation case below plus
    // `webauthn.ts`'s shared `expectedOrigin: [...this.#origins]`.
    const relayed = await createAuthenticator({
      rpId: DEPLOYED_RP_ID,
      origin: 'https://personalfi.lan.evil.example',
      userId: harness.userId,
    });
    const options = await harness.identity.webauthn.startAuthentication('authentication');

    let error: unknown;
    try {
      await harness.identity.webauthn.finishAuthentication({
        response: await relayed.authenticate(options.challenge),
        purpose: 'authentication',
      });
    } catch (caught) {
      error = caught;
    }

    expect(isAuthError(error)).toBe(true);
  });

  it('refuses an attestation whose RP id is not the configured one', async () => {
    // The `localhost`-against-`personalfi.lan` mismatch itself: a browser would
    // refuse this before the server saw it, so the server must refuse it too.
    const wrongRp = await createAuthenticator({
      rpId: 'localhost',
      origin: DEPLOYED_ORIGIN,
      userId: harness.userId,
    });
    const options = await harness.identity.webauthn.startRegistration(harness.userId, 'Chris');

    let error: unknown;
    try {
      await harness.identity.webauthn.finishRegistration({
        userId: harness.userId,
        response: await wrongRp.register(options.challenge),
        friendlyName: 'wrong-rp',
      });
    } catch (caught) {
      error = caught;
    }

    expect(isAuthError(error)).toBe(true);
    expect(error).toMatchObject({ code: 'invalid_credential' });
  });
});
