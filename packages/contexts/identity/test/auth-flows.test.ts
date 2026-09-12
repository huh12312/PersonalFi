// SPDX-License-Identifier: MIT
/**
 * The composed flows: bootstrap, enrolment, login, step-up, recovery, and the
 * audit trail they all write (decision D21, P0-4, P0-5, P0-14, P1-2, P1-10).
 *
 * The individual services are dumb on purpose — `WebAuthnService` verifies an
 * assertion and nothing else, `RateLimiter` counts and nothing else — so the
 * sequence they have to follow exists in exactly one place. These tests are
 * about that sequence: rate limit → lockout → verify → record → event → session.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { isAuthError } from '../src/errors.ts';
import { LOCKOUT_THRESHOLD, RATE_LIMITS } from '../src/rate-limit.ts';
import { RECOVERY_CODE_COUNT } from '../src/recovery.ts';
import { REGISTRATION_TOKEN_TTL_SECONDS } from '../src/users.ts';
import { createAuthenticator, type TestAuthenticator } from './authenticator.ts';
import {
  ADMIN_URL,
  createIdentityHarness,
  ORIGIN,
  requestContext,
  RP_ID,
  type IdentityHarness,
} from './harness.ts';

const describeWithDb = ADMIN_URL === undefined ? describe.skip : describe;

describeWithDb('authentication flows', () => {
  let harness: IdentityHarness;

  beforeAll(async () => {
    harness = await createIdentityHarness('personalfi_wp02_flows');
  }, 120_000);

  afterAll(async () => {
    await harness.drop();
  }, 30_000);

  beforeEach(async () => {
    await harness.reset();
  });

  const flows = () => harness.identity.flows;

  async function enrolPasskey(): Promise<TestAuthenticator> {
    const authenticator = await createAuthenticator({
      rpId: RP_ID,
      origin: ORIGIN,
      userId: harness.userId,
    });
    const options = await harness.identity.webauthn.startRegistration(harness.userId, 'Chris');
    await harness.identity.webauthn.finishRegistration({
      userId: harness.userId,
      response: await authenticator.register(options.challenge),
      friendlyName: "Chris's phone",
    });
    return authenticator;
  }

  async function loginWith(authenticator: TestAuthenticator, trustedDevice = false) {
    const options = await harness.identity.webauthn.startAuthentication('authentication');
    return flows().loginWithPasskey({
      response: await authenticator.authenticate(options.challenge),
      trustedDevice,
      context: requestContext(),
    });
  }

  async function eventKinds(): Promise<string[]> {
    const result = await harness.db.query(
      `SELECT kind FROM security_events ORDER BY occurred_at, id`,
    );
    return result.rows.map((row) => String(row['kind']));
  }

  // ------------------------------------------------------------- bootstrap

  it('refuses to create a second account holder', async () => {
    // Single user by decision D6; multi-user is additive later, and an accidental
    // second row would silently become "the primary" for half the queries.
    await expect(
      harness.identity.users.createPrimary({ displayName: 'Someone Else' }),
    ).rejects.toMatchObject({ code: 'already_bootstrapped' });
  });

  it('refuses a time zone Postgres cannot check and the AAD cannot carry', async () => {
    await expect(
      harness.identity.users.setTimezone(harness.userId, 'Mars/Olympus_Mons'),
    ).rejects.toMatchObject({ code: 'invalid_credential' });
    // `|` is the AAD separator, and a time zone is exactly the kind of
    // user-controlled string that ends up concatenated into one.
    await expect(
      harness.identity.users.setTimezone(harness.userId, 'Europe|London'),
    ).rejects.toMatchObject({ code: 'invalid_credential' });
    await expect(
      harness.identity.users.setTimezone(harness.userId, 'Europe/London'),
    ).resolves.toBeUndefined();
  });

  it('stores a registration token only as a digest', async () => {
    const issued = await harness.identity.users.issueRegistrationToken(harness.userId);
    const stored = await harness.db.query(
      `SELECT token_hash, expires_at FROM registration_tokens WHERE user_id = $1`,
      [harness.userId],
    );
    const hash = Buffer.from(stored.rows[0]?.['token_hash'] as Uint8Array);
    expect(hash).toHaveLength(32);
    // A leaked database dump must not contain a working enrolment link.
    expect(hash.toString('latin1')).not.toContain(issued.token);
    expect((stored.rows[0]?.['expires_at'] as Date).getTime()).toBe(
      harness.clock.nowMs() + REGISTRATION_TOKEN_TTL_SECONDS * 1_000,
    );
  });

  it('redeems a registration token exactly once', async () => {
    const issued = await harness.identity.users.issueRegistrationToken(harness.userId);
    await expect(
      harness.identity.users.redeemRegistrationToken(issued.token),
    ).resolves.toMatchObject({ id: harness.userId });
    // A replayed link must not mint a second challenge.
    await expect(
      harness.identity.users.redeemRegistrationToken(issued.token),
    ).rejects.toMatchObject({ code: 'invalid_credential' });
  });

  it('expires a registration token after an hour', async () => {
    const issued = await harness.identity.users.issueRegistrationToken(harness.userId);
    harness.clock.advanceMs(REGISTRATION_TOKEN_TTL_SECONDS * 1_000 + 1_000);
    await expect(
      harness.identity.users.redeemRegistrationToken(issued.token),
    ).rejects.toMatchObject({ code: 'invalid_credential' });
  });

  it('enrols the first passkey from a bootstrap token and signs the user straight in', async () => {
    const issued = await harness.identity.users.issueRegistrationToken(harness.userId);
    const context = requestContext();

    const begun = await flows().beginRegistration({ registrationToken: issued.token, context });
    expect(begun.userId).toBe(harness.userId);

    const authenticator = await createAuthenticator({
      rpId: RP_ID,
      origin: ORIGIN,
      userId: harness.userId,
    });
    const completed = await flows().completeRegistration({
      userId: begun.userId,
      response: await authenticator.register(begun.options.challenge),
      friendlyName: "Chris's phone",
      issueSession: true,
      context,
    });

    // Having just proved possession of an authenticator, making the operator log
    // in again would be ceremony with no security content.
    expect(completed.session).not.toBeNull();
    expect(completed.credentialCount).toBe(1);
    expect(harness.identity.sessions.isFresh(completed.session!.session)).toBe(true);
    expect(await eventKinds()).toContain('credential.added');
  });

  it('refuses to begin an enrolment with neither a token nor a fresh session', async () => {
    // An unauthenticated registration endpoint is an account-takeover primitive
    // behind one misconfigured proxy.
    await expect(flows().beginRegistration({ context: requestContext() })).rejects.toMatchObject({
      code: 'step_up_required',
    });
  });

  it('requires a recent assertion to add a second authenticator (P1-2)', async () => {
    const authenticator = await enrolPasskey();
    const issued = await loginWith(authenticator);

    harness.clock.advanceMs(6 * 60_000); // step-up window is five minutes
    const stale = await harness.identity.sessions.findById(issued.session.id);
    await expect(
      flows().beginRegistration({ session: stale!, context: requestContext() }),
    ).rejects.toMatchObject({ code: 'step_up_required' });

    // A stolen session cookie must not be able to enrol a passkey and make
    // itself permanent; a fresh assertion is the price.
    const options = await harness.identity.webauthn.startAuthentication('step_up', harness.userId);
    await flows().stepUp({
      session: stale!,
      response: await authenticator.authenticate(options.challenge),
      context: requestContext(),
    });
    const refreshed = await harness.identity.sessions.findById(issued.session.id);
    await expect(
      flows().beginRegistration({ session: refreshed!, context: requestContext() }),
    ).resolves.toMatchObject({ userId: harness.userId });
  });

  // ------------------------------------------------------------------ login

  it('signs in with a passkey and starts the session step-up fresh', async () => {
    const authenticator = await enrolPasskey();
    const issued = await loginWith(authenticator);

    expect(issued.session.authMethod).toBe('webauthn');
    expect(harness.identity.sessions.isFresh(issued.session)).toBe(true);
    expect(await eventKinds()).toContain('auth.webauthn.success');
  });

  it('honours the trusted-device toggle (D21)', async () => {
    const authenticator = await enrolPasskey();
    const issued = await loginWith(authenticator, true);
    expect(issued.session.trustedDevice).toBe(true);
    expect(issued.session.familyExpiresAt.getTime() - issued.session.createdAt.getTime()).toBe(
      14 * 24 * 3_600 * 1_000,
    );
  });

  it('records a failed assertion and counts it towards a lockout', async () => {
    await enrolPasskey();
    const stranger = await createAuthenticator({
      rpId: RP_ID,
      origin: ORIGIN,
      userId: harness.userId,
    });

    const options = await harness.identity.webauthn.startAuthentication('authentication');
    await expect(
      flows().loginWithPasskey({
        response: await stranger.authenticate(options.challenge),
        context: requestContext(),
      }),
    ).rejects.toMatchObject({ code: 'invalid_credential' });

    expect(await eventKinds()).toContain('auth.webauthn.failure');
    const lockout = await harness.db.query(
      `SELECT consecutive_failures FROM auth_lockouts WHERE bucket = 'webauthn'`,
    );
    expect(Number(lockout.rows[0]?.['consecutive_failures'])).toBe(1);
  });

  it('locks the bucket after ten consecutive failures and says so in the log', async () => {
    const { totp } = harness.identity;
    const enrolment = await totp.enrol(harness.userId, 'Chris');
    await totp.confirm(
      harness.userId,
      enrolment.id,
      // A real code, so the enrolment is live and the failures below are genuine.
      await currentTotpCode(enrolment.secret),
    );

    // The clock is wound a full rate-limit window between attempts, which is what
    // separates the two controls: the fixed window forgives, the consecutive
    // failure count does not. An attacker who paces himself still gets locked out.
    for (let i = 0; i < LOCKOUT_THRESHOLD; i += 1) {
      if (i > 0) harness.clock.advanceMs(RATE_LIMITS['totp']!.windowSeconds * 1_000);
      await expect(
        flows().loginWithTotp({ token: '000000', context: requestContext() }),
      ).rejects.toSatisfy((error) => isAuthError(error) && error.code === 'invalid_credential');
    }

    await expect(
      flows().loginWithTotp({ token: '000000', context: requestContext() }),
    ).rejects.toMatchObject({ code: 'locked_out' });
    expect(await eventKinds()).toContain('auth.locked_out');
  });

  it('issues a session that is not step-up fresh for a TOTP login', async () => {
    const { totp } = harness.identity;
    const enrolment = await totp.enrol(harness.userId, 'Chris');
    await totp.confirm(harness.userId, enrolment.id, await currentTotpCode(enrolment.secret));

    harness.clock.advanceMs(60_000);
    const issued = await flows().loginWithTotp({
      token: await currentTotpCode(enrolment.secret),
      context: requestContext(),
    });

    expect(issued.session.authMethod).toBe('totp');
    // Secondary factor: it gets you in, it does not get you a Plaid credential.
    expect(harness.identity.sessions.isFresh(issued.session)).toBe(false);
  });

  // -------------------------------------------------------- recovery codes

  it('mints ten legible single-use codes, hashed at rest', async () => {
    const generated = await harness.identity.recoveryCodes.generate(harness.userId);
    expect(generated.codes).toHaveLength(RECOVERY_CODE_COUNT);

    for (const code of generated.codes) {
      // Crockford-ish base32 with no 0/O or 1/I: these get written on paper and
      // read back at a stressful moment.
      expect(code).toMatch(/^[2-9A-HJ-NP-TV-Z]{5}-[2-9A-HJ-NP-TV-Z]{5}$/);
    }
    expect(new Set(generated.codes).size).toBe(RECOVERY_CODE_COUNT);

    const stored = await harness.db.query(
      `SELECT code_hash FROM recovery_codes WHERE user_id = $1`,
      [harness.userId],
    );
    expect(stored.rows).toHaveLength(RECOVERY_CODE_COUNT);
    for (const row of stored.rows) {
      // Argon2id, not SHA-256: fifty bits is plenty online and not plenty against
      // an offline attacker holding a stolen dump.
      expect(String(row['code_hash'])).toMatch(/^\$argon2id\$/);
    }
    expect(await harness.identity.recoveryCodes.remainingCount(harness.userId)).toBe(10);
  });

  it('spends a recovery code exactly once, however the user types it', async () => {
    const generated = await harness.identity.recoveryCodes.generate(harness.userId);
    const code = generated.codes[0]!;

    // Accepted lower-case, without the dash, with stray spaces.
    const typed = code.toLowerCase().replace('-', ' ');
    const issued = await flows().loginWithRecoveryCode({ code: typed, context: requestContext() });
    expect(issued.remainingCodes).toBe(9);
    expect(issued.session.authMethod).toBe('recovery_code');
    expect(harness.identity.sessions.isFresh(issued.session)).toBe(false);

    await expect(
      flows().loginWithRecoveryCode({ code, context: requestContext() }),
    ).rejects.toMatchObject({ code: 'invalid_credential' });
    expect(await harness.identity.recoveryCodes.remainingCount(harness.userId)).toBe(9);
  });

  it('replaces the whole batch when codes are regenerated', async () => {
    const first = await harness.identity.recoveryCodes.generate(harness.userId);
    await harness.identity.recoveryCodes.consume(harness.userId, first.codes[0]!);
    const second = await harness.identity.recoveryCodes.generate(harness.userId);

    // A half-spent set of ten plus three new ones is a set nobody can reason about.
    expect(await harness.identity.recoveryCodes.remainingCount(harness.userId)).toBe(10);
    expect(await harness.identity.recoveryCodes.consume(harness.userId, first.codes[1]!)).toBe(
      false,
    );
    expect(await harness.identity.recoveryCodes.consume(harness.userId, second.codes[1]!)).toBe(
      true,
    );
  });

  // ------------------------------------------------------------ audit trail

  it('scrubs anything credential-shaped out of the event detail', async () => {
    await harness.identity.recoveryCodes.generate(harness.userId);
    await flows().recordRecoveryCodesGenerated(harness.userId, requestContext());

    const events = await flows().listEvents(harness.userId, 10);
    const event = events.find((candidate) => candidate.kind === 'recovery_codes.generated');
    expect(event?.detail).toEqual({ count: 10 });
  });

  it('stores the caller`s IP but only a hash of the user agent', async () => {
    const authenticator = await enrolPasskey();
    await loginWith(authenticator);

    const stored = await harness.db.query(
      `SELECT ip, user_agent_hash, correlation_id FROM security_events
       WHERE kind = 'auth.webauthn.success'`,
    );
    expect(String(stored.rows[0]?.['ip'])).toBe('198.51.100.7');
    // A UA string is a fingerprint and belongs in no log and no column.
    expect(Buffer.from(stored.rows[0]?.['user_agent_hash'] as Uint8Array)).toHaveLength(32);
    expect(String(stored.rows[0]?.['correlation_id'])).toMatch(/^[0-9a-f-]{36}$/);
  });

  /** The code an authenticator app would show right now, for a base32 seed. */
  async function currentTotpCode(base32: string): Promise<string> {
    const { Secret, TOTP } = await import('otpauth');
    return new TOTP({
      secret: Secret.fromBase32(base32),
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
    }).generate({ timestamp: harness.clock.nowMs() });
  }
});
