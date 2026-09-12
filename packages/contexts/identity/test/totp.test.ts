// SPDX-License-Identifier: MIT
/**
 * TOTP: RFC 6238 conformance, a sealed seed, and no replay (03 §3.3).
 *
 * Three separate claims, and they need separate evidence:
 *
 * 1. **The codes are right.** Asserted against the test vectors in RFC 6238
 *    Appendix B, which is the only check that means anything to an authenticator
 *    app the user already has installed.
 * 2. **The seed is a credential.** It is sealed with `SecretBox` before it reaches
 *    the database, so P0-1 applies to it exactly as it applies to a Plaid token —
 *    and the raw-column assertion below is that evidence.
 * 3. **A code is spent when it is used.** Inside a 30-second window a code is a
 *    bearer token, and a bearer token that works twice is a replay.
 */
import { newId } from '@core/kernel';
import { Secret, TOTP } from 'otpauth';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { TOTP_DIGITS, TOTP_PERIOD_SECONDS, TOTP_WINDOW } from '../src/totp.ts';
import { ADMIN_URL, createIdentityHarness, type IdentityHarness } from './harness.ts';

const describeWithDb = ADMIN_URL === undefined ? describe.skip : describe;

/**
 * RFC 6238 Appendix B: the SHA-1 seed is the ASCII string `12345678901234567890`,
 * which is this in base32, and the published codes are eight digits.
 */
const RFC6238_SEED_BASE32 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const RFC6238_VECTORS: ReadonlyArray<readonly [seconds: number, code: string]> = [
  [59, '94287082'],
  [1_111_111_109, '07081804'],
  [1_111_111_111, '14050471'],
  [1_234_567_890, '89005924'],
  [2_000_000_000, '69279037'],
  [20_000_000_000, '65353130'],
];

describeWithDb('TOTP', () => {
  let harness: IdentityHarness;

  beforeAll(async () => {
    harness = await createIdentityHarness('personalfi_wp02_totp');
  }, 120_000);

  afterAll(async () => {
    await harness.drop();
  }, 30_000);

  beforeEach(async () => {
    await harness.reset();
  });

  const totp = () => harness.identity.totp;

  /** The code an authenticator app would be showing right now. */
  function codeAt(base32: string, atMs = harness.clock.nowMs(), digits = TOTP_DIGITS): string {
    return new TOTP({
      secret: Secret.fromBase32(base32),
      algorithm: 'SHA1',
      digits,
      period: TOTP_PERIOD_SECONDS,
    }).generate({ timestamp: atMs });
  }

  /** Enrol and confirm, returning the seed the user would have typed in. */
  async function enrolConfirmed(): Promise<{ id: string; secret: string }> {
    const enrolment = await totp().enrol(harness.userId, 'Chris');
    await totp().confirm(harness.userId, enrolment.id, codeAt(enrolment.secret));
    return { id: enrolment.id, secret: enrolment.secret };
  }

  /** Seed a confirmed enrolment directly, for the published RFC vectors. */
  async function seedConfirmed(base32: string, digits: number): Promise<string> {
    const id = newId();
    const sealed = await harness.secretBox.sealText(
      { table: 'totp_secrets', column: 'sealed_secret', rowId: id },
      base32,
    );
    await harness.db.query(
      `INSERT INTO totp_secrets (id, user_id, sealed_secret, digits, period_seconds, algorithm, confirmed_at, created_at)
       VALUES ($1, $2, $3, $4, 30, 'SHA1', $5, $5)`,
      [id, harness.userId, Buffer.from(sealed), digits, harness.clock.now()],
    );
    return id;
  }

  // ------------------------------------------------------------- conformance

  it('matches the RFC 6238 Appendix B test vectors', async () => {
    // Compatibility with an authenticator app the user already has is the entire
    // reason this fallback exists, and these vectors are what that means.
    await seedConfirmed(RFC6238_SEED_BASE32, 8);

    for (const [seconds, code] of RFC6238_VECTORS) {
      harness.clock.setTo(seconds * 1_000);
      expect(await totp().verify(harness.userId, code), `T=${seconds} should accept ${code}`).toBe(
        true,
      );
    }
  });

  it('rejects each vector`s code at a time it does not belong to', async () => {
    await seedConfirmed(RFC6238_SEED_BASE32, 8);
    // Two whole steps away is outside the ±1 skew window.
    harness.clock.setTo(59_000 + 2 * TOTP_PERIOD_SECONDS * 1_000 + 1_000);
    expect(await totp().verify(harness.userId, '94287082')).toBe(false);
  });

  it('uses SHA-1, six digits and a thirty-second period', () => {
    // Not a lapse: it is what every authenticator app supports without the user
    // installing anything new, which is the whole point of a fallback.
    expect(TOTP_DIGITS).toBe(6);
    expect(TOTP_PERIOD_SECONDS).toBe(30);
    expect(TOTP_WINDOW).toBe(1);
  });

  // -------------------------------------------------------------- enrolment

  it('returns the seed once and an otpauth URI for the QR code', async () => {
    const enrolment = await totp().enrol(harness.userId, 'Chris');
    expect(enrolment.secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(enrolment.uri).toMatch(/^otpauth:\/\/totp\/PersonalFi:Chris\?/);
    expect(enrolment.uri).toContain('algorithm=SHA1');
    expect(enrolment.uri).toContain('digits=6');
    expect(enrolment.uri).toContain('period=30');
  });

  it('seals the seed before it touches the database (P0-1)', async () => {
    const enrolment = await totp().enrol(harness.userId, 'Chris');

    const stored = await harness.db.query(
      `SELECT sealed_secret, encode(sealed_secret, 'escape') AS as_text
       FROM totp_secrets WHERE id = $1`,
      [enrolment.id],
    );
    const raw = Buffer.from(stored.rows[0]?.['sealed_secret'] as Uint8Array);

    // The exact assertion P0-1 asks for, on the exact column: read it as `psql`
    // would and find nothing readable.
    expect(raw.toString('latin1')).not.toContain(enrolment.secret);
    expect(raw.toString('utf8')).not.toContain(enrolment.secret);
    expect(String(stored.rows[0]?.['as_text'])).not.toContain(enrolment.secret);
    for (let i = 0; i + 8 <= enrolment.secret.length; i += 4) {
      expect(raw.toString('latin1')).not.toContain(enrolment.secret.slice(i, i + 8));
    }
    // Self-describing envelope: version 1, then a key id and a nonce.
    expect(raw[0]).toBe(1);
    expect(raw.length).toBeGreaterThan(41 + 16);
  });

  it('is not usable until a code has been proved', async () => {
    const enrolment = await totp().enrol(harness.userId, 'Chris');
    // Enrolling a factor the user has not proved they can compute is how a second
    // factor becomes a lockout.
    expect(await totp().isEnrolled(harness.userId)).toBe(false);
    expect(await totp().verify(harness.userId, codeAt(enrolment.secret))).toBe(false);

    await totp().confirm(harness.userId, enrolment.id, codeAt(enrolment.secret));
    expect(await totp().isEnrolled(harness.userId)).toBe(true);
  });

  it('refuses to confirm with a wrong code', async () => {
    const enrolment = await totp().enrol(harness.userId, 'Chris');
    await expect(totp().confirm(harness.userId, enrolment.id, '000000')).rejects.toMatchObject({
      code: 'invalid_credential',
    });
    expect(await totp().isEnrolled(harness.userId)).toBe(false);
  });

  it('refuses to confirm an enrolment belonging to somebody else', async () => {
    const enrolment = await totp().enrol(harness.userId, 'Chris');
    await expect(
      totp().confirm(newId(), enrolment.id, codeAt(enrolment.secret)),
    ).rejects.toMatchObject({ code: 'invalid_credential' });
  });

  it('discards unconfirmed enrolments once one is confirmed', async () => {
    // Two QR codes on screen at once is how a user ends up with a seed the server
    // has forgotten about.
    await totp().enrol(harness.userId, 'Chris');
    await totp().enrol(harness.userId, 'Chris');
    const keeper = await totp().enrol(harness.userId, 'Chris');
    await totp().confirm(harness.userId, keeper.id, codeAt(keeper.secret));

    const rows = await harness.db.query(`SELECT id FROM totp_secrets WHERE user_id = $1`, [
      harness.userId,
    ]);
    expect(rows.rows.map((row) => String(row['id']))).toEqual([keeper.id]);
  });

  // ------------------------------------------------------------ verification

  it('accepts the current code and spends it', async () => {
    const { secret } = await enrolConfirmed();
    harness.clock.advanceMs(TOTP_PERIOD_SECONDS * 1_000);
    const code = codeAt(secret);

    expect(await totp().verify(harness.userId, code)).toBe(true);
    // Inside its own window the same code is a bearer token; it works once.
    expect(await totp().verify(harness.userId, code)).toBe(false);
  });

  it('refuses a code from a window that has already been spent', async () => {
    const { secret } = await enrolConfirmed();
    harness.clock.advanceMs(2 * TOTP_PERIOD_SECONDS * 1_000);
    const older = codeAt(secret, harness.clock.nowMs() - TOTP_PERIOD_SECONDS * 1_000);
    expect(await totp().verify(harness.userId, codeAt(secret))).toBe(true);
    // The previous step is within the ±1 skew window but is already behind the
    // high-water mark, so it cannot be replayed.
    expect(await totp().verify(harness.userId, older)).toBe(false);
  });

  it('tolerates one step of clock skew in either direction, and no more', async () => {
    const { secret } = await enrolConfirmed();
    const base = harness.clock.nowMs() + 10 * TOTP_PERIOD_SECONDS * 1_000;

    harness.clock.setTo(base);
    expect(await totp().verify(harness.userId, codeAt(secret, base + 30_000))).toBe(true);

    harness.clock.setTo(base + 10 * TOTP_PERIOD_SECONDS * 1_000);
    expect(
      await totp().verify(harness.userId, codeAt(secret, harness.clock.nowMs() - 30_000)),
    ).toBe(true);

    // Two steps is a minute, and a 30-second code that lives for three minutes is
    // not a 30-second code.
    harness.clock.setTo(base + 20 * TOTP_PERIOD_SECONDS * 1_000);
    expect(
      await totp().verify(harness.userId, codeAt(secret, harness.clock.nowMs() + 90_000)),
    ).toBe(false);
  });

  it('refuses a wrong code without telling the caller why', async () => {
    await enrolConfirmed();
    expect(await totp().verify(harness.userId, '000000')).toBe(false);
    expect(await totp().verify(harness.userId, 'not-a-code')).toBe(false);
  });

  it('refuses everything when nothing is enrolled', async () => {
    expect(await totp().isEnrolled(harness.userId)).toBe(false);
    expect(await totp().verify(harness.userId, '123456')).toBe(false);
  });

  it('refuses a code computed from a different seed', async () => {
    await enrolConfirmed();
    const other = new Secret({ size: 20 }).base32;
    expect(await totp().verify(harness.userId, codeAt(other))).toBe(false);
  });

  it('removes the enrolment', async () => {
    await enrolConfirmed();
    await totp().remove(harness.userId);
    expect(await totp().isEnrolled(harness.userId)).toBe(false);
    const rows = await harness.db.query(`SELECT count(*)::int AS n FROM totp_secrets`);
    expect(Number(rows.rows[0]?.['n'])).toBe(0);
  });

  it('stops working entirely once the KEK is gone', async () => {
    // The seed is sealed, so a locked box means no TOTP — which is correct: the
    // alternative would be a factor that keeps working after key custody failed.
    const { secret } = await enrolConfirmed();
    harness.secretBox.destroy();
    await expect(totp().verify(harness.userId, codeAt(secret))).rejects.toThrow(/not available/);
    // Restore custody for the remaining cases in this file.
    await harness.secretBox.unlock('the test passphrase');
  });
});
