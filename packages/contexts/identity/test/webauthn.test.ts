// SPDX-License-Identifier: MIT
/**
 * Passkey registration and authentication against a software authenticator
 * (03 §3.2, decision D21, P0-4).
 *
 * The signatures are real: `test/authenticator.ts` assembles genuine CBOR, a
 * genuine COSE ES256 key and a genuine ECDSA signature, and
 * `@simplewebauthn/server` verifies them. Nothing here is stubbed, because the
 * only part of this flow with security content is the verification.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { isAuthError } from '../src/errors.ts';
import { createAuthenticator } from './authenticator.ts';
import {
  ADMIN_URL,
  createIdentityHarness,
  ORIGIN,
  RP_ID,
  type IdentityHarness,
} from './harness.ts';

const describeWithDb = ADMIN_URL === undefined ? describe.skip : describe;

describeWithDb('WebAuthn', () => {
  let harness: IdentityHarness;

  beforeAll(async () => {
    harness = await createIdentityHarness('personalfi_wp02_webauthn');
  }, 120_000);

  afterAll(async () => {
    await harness.drop();
  }, 30_000);

  beforeEach(async () => {
    await harness.reset();
  });

  function newAuthenticator(overrides: Parameters<typeof createAuthenticator>[0] | null = null) {
    return createAuthenticator(
      overrides ?? { rpId: RP_ID, origin: ORIGIN, userId: harness.userId },
    );
  }

  /** Enrol one credential and return the authenticator that holds it. */
  async function enrol(friendlyName = "Chris's phone") {
    const authenticator = await newAuthenticator();
    const options = await harness.identity.webauthn.startRegistration(harness.userId, 'Chris');
    const credential = await harness.identity.webauthn.finishRegistration({
      userId: harness.userId,
      response: await authenticator.register(options.challenge),
      friendlyName,
    });
    return { authenticator, credential, options };
  }

  // ---------------------------------------------------------- registration

  it('asks for a discoverable credential with user verification and no RS256', async () => {
    const options = await harness.identity.webauthn.startRegistration(harness.userId, 'Chris');

    expect(options.rp).toEqual({ id: RP_ID, name: 'PersonalFi Test' });
    expect(options.authenticatorSelection).toMatchObject({
      residentKey: 'required',
      requireResidentKey: true,
      userVerification: 'required',
    });
    expect(options.attestation).toBe('none');

    // ES256 and EdDSA only. RS256 (-257) is deliberately absent.
    const algorithms = options.pubKeyCredParams.map((param) => param.alg);
    expect(algorithms).toEqual(expect.arrayContaining([-7, -8]));
    expect(algorithms).not.toContain(-257);

    // `authenticatorAttachment` is unset so a YubiKey is as welcome as a phone;
    // 03 §3.2 wants at least two enrolled and one of each is the sane pair.
    expect(options.authenticatorSelection?.authenticatorAttachment).toBeUndefined();
  });

  it('registers a credential and stores only its public key', async () => {
    const { credential, authenticator } = await enrol();

    expect(credential.credentialId).toBe(authenticator.credentialId);
    expect(credential.friendlyName).toBe("Chris's phone");
    expect(credential.transports).toEqual(['internal', 'hybrid']);
    expect(credential.deviceType).toBe('singleDevice');
    expect(credential.backedUp).toBe(false);

    const stored = await harness.db.query(
      `SELECT public_key, sign_count, credential_id FROM webauthn_credentials WHERE id = $1`,
      [credential.id],
    );
    const row = stored.rows[0];
    expect(row).toBeDefined();
    // A public key is not a secret, and there is no shared secret to steal —
    // that is the whole reason passkeys are the primary factor here.
    expect((row?.['public_key'] as Uint8Array).length).toBeGreaterThan(32);
    expect(String(row?.['sign_count'])).toBe('0');
  });

  it('records a backed-up multi-device credential as such', async () => {
    const authenticator = await newAuthenticator({
      rpId: RP_ID,
      origin: ORIGIN,
      userId: harness.userId,
      backedUp: true,
    });
    const options = await harness.identity.webauthn.startRegistration(harness.userId, 'Chris');
    const credential = await harness.identity.webauthn.finishRegistration({
      userId: harness.userId,
      response: await authenticator.register(options.challenge),
      friendlyName: 'iCloud Keychain',
    });

    expect(credential.deviceType).toBe('multiDevice');
    expect(credential.backedUp).toBe(true);
  });

  it('offers the already-enrolled credentials so the same key is not enrolled twice', async () => {
    const { authenticator } = await enrol();
    const options = await harness.identity.webauthn.startRegistration(harness.userId, 'Chris');
    expect(options.excludeCredentials?.map((entry) => entry.id)).toEqual([
      authenticator.credentialId,
    ]);
  });

  it('refuses to enrol the same credential id twice', async () => {
    const { authenticator } = await enrol();
    const options = await harness.identity.webauthn.startRegistration(harness.userId, 'Chris');

    await expect(
      harness.identity.webauthn.finishRegistration({
        userId: harness.userId,
        response: await authenticator.register(options.challenge),
        friendlyName: 'the same phone again',
      }),
    ).rejects.toMatchObject({ code: 'credential_in_use' });
  });

  it('refuses a registration for a challenge that was never issued', async () => {
    const authenticator = await newAuthenticator();
    // No `startRegistration`, so there is no pending challenge to consume.
    await expect(
      harness.identity.webauthn.finishRegistration({
        userId: harness.userId,
        response: await authenticator.register('Y2hhbGxlbmdlLXRoYXQtd2FzLW5ldmVyLWlzc3VlZA'),
        friendlyName: 'forged',
      }),
    ).rejects.toMatchObject({ code: 'challenge_expired' });
  });

  it('refuses a registration whose client data quotes a different challenge', async () => {
    const authenticator = await newAuthenticator();
    await harness.identity.webauthn.startRegistration(harness.userId, 'Chris');
    await expect(
      harness.identity.webauthn.finishRegistration({
        userId: harness.userId,
        response: await authenticator.register('c29tZS1vdGhlci1jaGFsbGVuZ2U'),
        friendlyName: 'replayed',
      }),
    ).rejects.toMatchObject({ code: 'invalid_credential' });
  });

  it('refuses a registration from another origin', async () => {
    const authenticator = await newAuthenticator({
      rpId: RP_ID,
      origin: 'https://evil.example',
      userId: harness.userId,
    });
    const options = await harness.identity.webauthn.startRegistration(harness.userId, 'Chris');
    await expect(
      harness.identity.webauthn.finishRegistration({
        userId: harness.userId,
        response: await authenticator.register(options.challenge),
        friendlyName: 'phished',
      }),
    ).rejects.toMatchObject({ code: 'invalid_credential' });
  });

  it('refuses a registration for another relying party', async () => {
    // The RP id is what makes a passkey unphishable: an authenticator that
    // computed `rpIdHash` over a different name must not verify here.
    const authenticator = await newAuthenticator({
      rpId: 'evil.example',
      origin: ORIGIN,
      userId: harness.userId,
    });
    const options = await harness.identity.webauthn.startRegistration(harness.userId, 'Chris');
    await expect(
      harness.identity.webauthn.finishRegistration({
        userId: harness.userId,
        response: await authenticator.register(options.challenge),
        friendlyName: 'wrong rp',
      }),
    ).rejects.toMatchObject({ code: 'invalid_credential' });
  });

  it('burns a challenge on use, so a replayed registration fails', async () => {
    const authenticator = await newAuthenticator();
    const options = await harness.identity.webauthn.startRegistration(harness.userId, 'Chris');
    const response = await authenticator.register(options.challenge);
    await harness.identity.webauthn.finishRegistration({
      userId: harness.userId,
      response,
      friendlyName: 'first',
    });

    // Single-use is a `consumed_at` stamp inside an `UPDATE ... RETURNING`, not a
    // cookie attribute — which is why challenges live in a table.
    await expect(
      harness.identity.webauthn.finishRegistration({
        userId: harness.userId,
        response,
        friendlyName: 'replay',
      }),
    ).rejects.toMatchObject({ code: 'challenge_expired' });
  });

  it('refuses a challenge that has expired', async () => {
    const authenticator = await newAuthenticator();
    const options = await harness.identity.webauthn.startRegistration(harness.userId, 'Chris');
    harness.clock.advanceMs(301_000); // TTL is 300 s

    await expect(
      harness.identity.webauthn.finishRegistration({
        userId: harness.userId,
        response: await authenticator.register(options.challenge),
        friendlyName: 'stale',
      }),
    ).rejects.toMatchObject({ code: 'challenge_expired' });
  });

  // G-18 (ASVS 6.7.2, 11.5.1; WP 9.14): the challenge's size and uniqueness are the library's default
  // today, so nothing failed when a change shrank it. 32 bytes is what the library draws; the bar here
  // is the ASVS floor with room to spare (16 bytes = 128 bits), measured on what a client is sent.
  it('draws a fresh challenge of at least 128 bits for every registration and every login', async () => {
    const decodedLength = (challenge: string): number => Buffer.from(challenge, 'base64url').length;
    const seen = new Set<string>();
    for (let i = 0; i < 20; i += 1) {
      const registration = await harness.identity.webauthn.startRegistration(
        harness.userId,
        'Chris',
      );
      const login = await harness.identity.webauthn.startAuthentication('authentication');
      const stepUp = await harness.identity.webauthn.startAuthentication('step_up', harness.userId);
      for (const challenge of [registration.challenge, login.challenge, stepUp.challenge]) {
        expect(decodedLength(challenge)).toBeGreaterThanOrEqual(16);
        seen.add(challenge);
      }
    }
    expect(seen.size).toBe(60);
  });

  // --------------------------------------------------------- authentication

  it('logs in without a username and does not enumerate credentials', async () => {
    const { authenticator, credential } = await enrol();

    const options = await harness.identity.webauthn.startAuthentication('authentication');
    // Empty on purpose: with discoverable credentials the client picks, and an
    // empty list tells an unauthenticated caller nothing about what exists.
    expect(options.allowCredentials ?? []).toEqual([]);
    expect(options.userVerification).toBe('required');
    expect(options.rpId).toBe(RP_ID);

    const assertion = await harness.identity.webauthn.finishAuthentication({
      response: await authenticator.authenticate(options.challenge),
      purpose: 'authentication',
    });

    expect(assertion).toMatchObject({
      credentialId: authenticator.credentialId,
      credentialRowId: credential.id,
      userId: harness.userId,
      userVerified: true,
    });
  });

  it('stamps last_used_at so the credential list can show it', async () => {
    const { authenticator, credential } = await enrol();
    expect(credential.lastUsedAt).toBeNull();

    harness.clock.advanceMs(60_000);
    const options = await harness.identity.webauthn.startAuthentication('authentication');
    await harness.identity.webauthn.finishAuthentication({
      response: await authenticator.authenticate(options.challenge),
      purpose: 'authentication',
    });

    const [refreshed] = await harness.identity.webauthn.listCredentials(harness.userId);
    expect(refreshed?.lastUsedAt?.toISOString()).toBe('2026-03-01T12:01:00.000Z');
  });

  it('refuses an assertion signed by a different key', async () => {
    // The clone that stole the credential id but not the private key.
    const { authenticator } = await enrol();
    const options = await harness.identity.webauthn.startAuthentication('authentication');

    await expect(
      harness.identity.webauthn.finishAuthentication({
        response: await authenticator.authenticateWithForeignKey(options.challenge),
        purpose: 'authentication',
      }),
    ).rejects.toMatchObject({ code: 'invalid_credential' });
  });

  it('refuses an assertion for a credential that was never enrolled', async () => {
    await enrol();
    const stranger = await newAuthenticator();
    const options = await harness.identity.webauthn.startAuthentication('authentication');

    await expect(
      harness.identity.webauthn.finishAuthentication({
        response: await stranger.authenticate(options.challenge),
        purpose: 'authentication',
      }),
    ).rejects.toMatchObject({ code: 'invalid_credential' });
  });

  it('refuses an assertion from a different origin', async () => {
    const { credential } = await enrol();
    expect(credential.id).toBeTruthy();

    const attacker = await newAuthenticator({
      rpId: RP_ID,
      origin: 'https://evil.example',
      userId: harness.userId,
    });
    // Same credential id, different origin in the client data.
    const options = await harness.identity.webauthn.startAuthentication('authentication');
    const response = await attacker.authenticate(options.challenge);
    await expect(
      harness.identity.webauthn.finishAuthentication({ response, purpose: 'authentication' }),
    ).rejects.toMatchObject({ code: 'invalid_credential' });
  });

  it('keeps a step-up challenge separate from a login challenge', async () => {
    const { authenticator } = await enrol();
    const stepUp = await harness.identity.webauthn.startAuthentication('step_up', harness.userId);

    // A challenge minted for one purpose must not satisfy the other, or a
    // login-page challenge would be usable to elevate an existing session.
    await expect(
      harness.identity.webauthn.finishAuthentication({
        response: await authenticator.authenticate(stepUp.challenge),
        purpose: 'authentication',
      }),
    ).rejects.toMatchObject({ code: 'challenge_expired' });

    harness.clock.advanceMs(1_000);
    const fresh = await harness.identity.webauthn.startAuthentication('step_up', harness.userId);
    await expect(
      harness.identity.webauthn.finishAuthentication({
        response: await authenticator.authenticate(fresh.challenge),
        purpose: 'step_up',
        userId: harness.userId,
      }),
    ).resolves.toMatchObject({ userId: harness.userId });
  });

  // ---------------------------------------------------------- clone detection

  it('accepts an authenticator that always reports zero', async () => {
    // Most platform passkeys never increment, so a naive `newCounter > stored`
    // check would lock Chris out of his own phone.
    const { authenticator } = await enrol();
    for (let i = 0; i < 3; i += 1) {
      const options = await harness.identity.webauthn.startAuthentication('authentication');
      await expect(
        harness.identity.webauthn.finishAuthentication({
          response: await authenticator.authenticate(options.challenge),
          purpose: 'authentication',
        }),
      ).resolves.toMatchObject({ userId: harness.userId });
    }
  });

  it('advances the stored counter for an authenticator that keeps one', async () => {
    const authenticator = await newAuthenticator({
      rpId: RP_ID,
      origin: ORIGIN,
      userId: harness.userId,
      signCount: 10,
    });
    const registration = await harness.identity.webauthn.startRegistration(harness.userId, 'C');
    const credential = await harness.identity.webauthn.finishRegistration({
      userId: harness.userId,
      response: await authenticator.register(registration.challenge),
      friendlyName: 'YubiKey',
    });

    const options = await harness.identity.webauthn.startAuthentication('authentication');
    await harness.identity.webauthn.finishAuthentication({
      response: await authenticator.authenticate(options.challenge),
      purpose: 'authentication',
    });

    const stored = await harness.db.query(
      `SELECT sign_count FROM webauthn_credentials WHERE id = $1`,
      [credential.id],
    );
    expect(Number(stored.rows[0]?.['sign_count'])).toBe(11);
  });

  it('refuses an assertion whose counter went backwards — the clone signal', async () => {
    const authenticator = await newAuthenticator({
      rpId: RP_ID,
      origin: ORIGIN,
      userId: harness.userId,
      signCount: 10,
    });
    const registration = await harness.identity.webauthn.startRegistration(harness.userId, 'C');
    const credential = await harness.identity.webauthn.finishRegistration({
      userId: harness.userId,
      response: await authenticator.register(registration.challenge),
      friendlyName: 'YubiKey',
    });

    const first = await harness.identity.webauthn.startAuthentication('authentication');
    await harness.identity.webauthn.finishAuthentication({
      response: await authenticator.authenticate(first.challenge),
      purpose: 'authentication',
    });

    const replay = await harness.identity.webauthn.startAuthentication('authentication');
    await expect(
      harness.identity.webauthn.finishAuthentication({
        response: await authenticator.authenticate(replay.challenge, { signCount: 9 }),
        purpose: 'authentication',
      }),
    ).rejects.toMatchObject({ code: 'invalid_credential' });

    expect(await harness.identity.webauthn.counterRegressed(credential.id, 9)).toBe(true);
    expect(await harness.identity.webauthn.counterRegressed(credential.id, 12)).toBe(false);
  });

  // -------------------------------------------------------------- management

  it('refuses to remove the last passkey', async () => {
    const { credential } = await enrol();
    // Not paternalism: with no credentials and no recovery code the only way back
    // in is a database edit, and the point of the design is that there is none.
    await expect(
      harness.identity.webauthn.removeCredential(harness.userId, credential.id),
    ).rejects.toSatisfy((error) => isAuthError(error) && error.code === 'last_credential');
  });

  it('removes a credential once a second one exists', async () => {
    const first = await enrol('phone');
    const second = await newAuthenticator();
    const options = await harness.identity.webauthn.startRegistration(harness.userId, 'Chris');
    await harness.identity.webauthn.finishRegistration({
      userId: harness.userId,
      response: await second.register(options.challenge),
      friendlyName: 'yubikey',
    });

    await harness.identity.webauthn.removeCredential(harness.userId, first.credential.id);
    const remaining = await harness.identity.webauthn.listCredentials(harness.userId);
    expect(remaining.map((entry) => entry.friendlyName)).toEqual(['yubikey']);
  });

  it('purges expired challenges', async () => {
    await harness.identity.webauthn.startRegistration(harness.userId, 'Chris');
    harness.clock.advanceMs(4 * 3_600_000);
    await harness.identity.webauthn.purgeExpiredChallenges();

    const left = await harness.db.query(`SELECT count(*)::int AS n FROM webauthn_challenges`);
    expect(Number(left.rows[0]?.['n'])).toBe(0);
  });
});
