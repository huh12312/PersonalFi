// SPDX-License-Identifier: MIT
/**
 * WP 9.11, gap G-03 (Medium): a passkey is two factors only with user
 * verification (ASVS V6.3.3, V6.5.7). WP 9.10's SAB-03 set
 * `requireUserVerification: false` on the assertion path and 47/47 stayed
 * green — no test ever presented an assertion with the UV flag clear, although
 * the test authenticator already could.
 *
 * Each ceremony is driven through the composed flow (`loginWithPasskey`,
 * `stepUp`, `completeRegistration`) twice: with UV (the positive control — the
 * same authenticator, same challenge shape, succeeds) and without it, which
 * must be refused as `invalid_credential` with nothing granted: no session, no
 * step-up freshness, no credential row.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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

describeWithDb('G-03: user verification is required on every WebAuthn ceremony', () => {
  let harness: IdentityHarness;

  beforeAll(async () => {
    harness = await createIdentityHarness('personalfi_wp911_uv');
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

  async function count(table: string): Promise<number> {
    const result = await harness.db.query(`SELECT count(*)::int AS n FROM ${table}`);
    return Number(result.rows[0]?.['n']);
  }

  it('login: an assertion without UV is refused and issues no session', async () => {
    const authenticator = await enrolPasskey();

    const refusedOptions = await harness.identity.webauthn.startAuthentication('authentication');
    await expect(
      flows().loginWithPasskey({
        response: await authenticator.authenticate(refusedOptions.challenge, {
          userVerified: false,
        }),
        context: requestContext(),
      }),
    ).rejects.toMatchObject({ code: 'invalid_credential' });
    expect(await count('sessions')).toBe(0);

    // Positive control: the same authenticator, with UV, signs in.
    const okOptions = await harness.identity.webauthn.startAuthentication('authentication');
    const issued = await flows().loginWithPasskey({
      response: await authenticator.authenticate(okOptions.challenge),
      context: requestContext(),
    });
    expect(issued.session.authMethod).toBe('webauthn');
  }, 60_000);

  it('step-up: an assertion without UV is refused and the session stays stale', async () => {
    const authenticator = await enrolPasskey();
    const loginOptions = await harness.identity.webauthn.startAuthentication('authentication');
    const issued = await flows().loginWithPasskey({
      response: await authenticator.authenticate(loginOptions.challenge),
      context: requestContext(),
    });
    harness.clock.advanceMs(6 * 60_000); // past the five-minute window
    const stale = await harness.identity.sessions.findById(issued.session.id);
    expect(harness.identity.sessions.isFresh(stale!)).toBe(false);

    const refused = await harness.identity.webauthn.startAuthentication('step_up', harness.userId);
    await expect(
      flows().stepUp({
        session: stale!,
        response: await authenticator.authenticate(refused.challenge, { userVerified: false }),
        context: requestContext(),
      }),
    ).rejects.toMatchObject({ code: 'invalid_credential' });
    const after = await harness.identity.sessions.findById(issued.session.id);
    expect(harness.identity.sessions.isFresh(after!)).toBe(false);

    // Positive control.
    const ok = await harness.identity.webauthn.startAuthentication('step_up', harness.userId);
    await flows().stepUp({
      session: after!,
      response: await authenticator.authenticate(ok.challenge),
      context: requestContext(),
    });
    const fresh = await harness.identity.sessions.findById(issued.session.id);
    expect(harness.identity.sessions.isFresh(fresh!)).toBe(true);
  }, 60_000);

  it('registration: an attestation without UV is refused and enrols nothing', async () => {
    const issued = await harness.identity.users.issueRegistrationToken(harness.userId);
    const begun = await flows().beginRegistration({
      registrationToken: issued.token,
      context: requestContext(),
    });
    const authenticator = await createAuthenticator({
      rpId: RP_ID,
      origin: ORIGIN,
      userId: harness.userId,
    });
    await expect(
      flows().completeRegistration({
        userId: begun.userId,
        response: await authenticator.register(begun.options.challenge, { userVerified: false }),
        friendlyName: 'no UV',
        issueSession: true,
        context: requestContext(),
      }),
    ).rejects.toThrow();
    expect(await count('webauthn_credentials')).toBe(0);
    expect(await count('sessions')).toBe(0);

    // Positive control: a fresh ceremony with UV enrols.
    const again = await harness.identity.users.issueRegistrationToken(harness.userId);
    const begunAgain = await flows().beginRegistration({
      registrationToken: again.token,
      context: requestContext(),
    });
    const completed = await flows().completeRegistration({
      userId: begunAgain.userId,
      response: await authenticator.register(begunAgain.options.challenge),
      friendlyName: 'with UV',
      issueSession: true,
      context: requestContext(),
    });
    expect(completed.credentialCount).toBe(1);
  }, 60_000);
});
