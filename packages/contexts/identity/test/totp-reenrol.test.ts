// SPDX-License-Identifier: MIT
/**
 * WP 9.11, gap G-12 (Medium): a TOTP seed can be replaced, atomically.
 *
 * At HEAD `confirm` set `confirmed_at` on the new enrolment while the old
 * confirmed seed still existed, and `totp_secrets_confirmed_key` (one confirmed
 * seed per user) refused it: a leaked seed could not be rotated at all. The
 * swap is now one statement — the old seed retired and the new one confirmed
 * together — so there is never a moment with two live seeds or with none.
 */
import { Secret, TOTP } from 'otpauth';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { TOTP_DIGITS, TOTP_PERIOD_SECONDS } from '../src/totp.ts';
import { ADMIN_URL, createIdentityHarness, type IdentityHarness } from './harness.ts';

const describeWithDb = ADMIN_URL === undefined ? describe.skip : describe;

describeWithDb('G-12: TOTP re-enrolment swaps the seed atomically', () => {
  let harness: IdentityHarness;

  beforeAll(async () => {
    harness = await createIdentityHarness('personalfi_wp911_totp_swap');
  }, 120_000);

  afterAll(async () => {
    await harness.drop();
  }, 30_000);

  beforeEach(async () => {
    await harness.reset();
  });

  const totp = () => harness.identity.totp;

  function codeAt(base32: string, atMs = harness.clock.nowMs()): string {
    return new TOTP({
      secret: Secret.fromBase32(base32),
      algorithm: 'SHA1',
      digits: TOTP_DIGITS,
      period: TOTP_PERIOD_SECONDS,
    }).generate({ timestamp: atMs });
  }

  async function confirmedSeeds(): Promise<string[]> {
    const result = await harness.db.query(
      `SELECT id FROM totp_secrets WHERE user_id = $1 AND confirmed_at IS NOT NULL`,
      [harness.userId],
    );
    return result.rows.map((row) => String(row['id']));
  }

  it('a confirmed seed is replaced by a new one, and only the new one then works', async () => {
    const first = await totp().enrol(harness.userId, 'Chris');
    await totp().confirm(harness.userId, first.id, codeAt(first.secret));
    expect(await confirmedSeeds()).toEqual([first.id]);

    harness.clock.advanceMs(TOTP_PERIOD_SECONDS * 1_000 * 3);
    const second = await totp().enrol(harness.userId, 'Chris');
    // Until the new seed is confirmed, the old one is still the live factor.
    expect(await confirmedSeeds()).toEqual([first.id]);

    await totp().confirm(harness.userId, second.id, codeAt(second.secret));
    expect(await confirmedSeeds()).toEqual([second.id]);

    harness.clock.advanceMs(TOTP_PERIOD_SECONDS * 1_000 * 3);
    expect(await totp().verify(harness.userId, codeAt(first.secret))).toBe(false);
    expect(await totp().verify(harness.userId, codeAt(second.secret))).toBe(true);
  }, 60_000);

  it('a wrong code on the new seed leaves the old seed live and alone', async () => {
    const first = await totp().enrol(harness.userId, 'Chris');
    await totp().confirm(harness.userId, first.id, codeAt(first.secret));
    harness.clock.advanceMs(TOTP_PERIOD_SECONDS * 1_000 * 3);

    const second = await totp().enrol(harness.userId, 'Chris');
    await expect(totp().confirm(harness.userId, second.id, '000000')).rejects.toMatchObject({
      code: 'invalid_credential',
    });
    expect(await confirmedSeeds()).toEqual([first.id]);
    expect(await totp().verify(harness.userId, codeAt(first.secret))).toBe(true);
  }, 60_000);

  it('remove() revokes the seed: no code verifies afterwards', async () => {
    const first = await totp().enrol(harness.userId, 'Chris');
    await totp().confirm(harness.userId, first.id, codeAt(first.secret));
    await totp().remove(harness.userId);
    harness.clock.advanceMs(TOTP_PERIOD_SECONDS * 1_000 * 3);
    expect(await totp().isEnrolled(harness.userId)).toBe(false);
    expect(await totp().verify(harness.userId, codeAt(first.secret))).toBe(false);
  }, 60_000);
});
