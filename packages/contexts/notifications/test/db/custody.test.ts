// SPDX-License-Identifier: MIT
/**
 * Custody of the channel config (decision D5), read the way an attacker would.
 *
 * The WP 1.3b pattern: do not ask the read model whether the secret is
 * protected — it will say yes because it never returns the column at all. Read
 * the **raw bytes** out of `notification_channels.sealed_config` with a plain
 * `SELECT`, exactly as somebody with a `psql` prompt and a stolen backup would,
 * and look for the password in them.
 *
 * The search is deliberately more than `indexOf(password)`:
 *
 *   * both `utf8` and `latin1` decodings, because a byte-preserving decode is
 *     what catches a secret that was stored as raw bytes rather than as text;
 *   * an **8-byte sliding window**, which catches a partial or chunked leak —
 *     a field written before the envelope closed, a prefix in a debug column —
 *     that a whole-string search walks straight past.
 *
 * Two portability properties are asserted as well, because "the bytes are not
 * plaintext" is the weakest of the three things sealing buys:
 *
 *   * **Across rows.** The AAD names the row
 *     (`personalfi/v1|notification_channels|sealed_config|<id>|<version>`), so
 *     lifting channel A's bytes into channel B stops the Poly1305 tag verifying.
 *   * **Across the clear columns.** `destination_host`, `port` and `scheme` live
 *     both in the envelope and in the clear, and `openChannelConfig` compares
 *     them. That is what stops an `UPDATE notification_channels SET
 *     destination_host = 'db'` by somebody with write access and no passphrase.
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openChannelConfig, findChannel, ChannelRefusedError } from '../../src/service.ts';
import {
  NO_DATABASE,
  SMTP_HOST,
  clockAt,
  contextFor,
  enabledChannel,
  notificationsDatabase,
  smtpConfig,
  unlockedSecretBox,
  type TestDatabase,
} from '../harness.ts';
import type { SecretBox } from '@core/secretbox';

const EPOCH = '2026-06-10T15:00:00.000Z';

/** Distinctive enough that a partial hit is unambiguous. */
const PASSWORD = 'correct-horse-battery-staple-DO-NOT-LEAK';
const USERNAME = 'notifier-DO-NOT-LEAK@notify.test';

describe.skipIf(NO_DATABASE)('channel config custody', () => {
  let database: TestDatabase;
  let secretBox: SecretBox;
  const clock = clockAt(EPOCH);

  beforeAll(async () => {
    database = await notificationsDatabase('custody');
    secretBox = await unlockedSecretBox(database, clock);
  }, 180_000);

  afterAll(async () => {
    await database.drop();
  });

  /** The raw column, exactly as `psql` would hand it over. */
  async function rawConfig(channelId: string): Promise<Buffer> {
    const result = await database.pool.query(
      `SELECT sealed_config FROM notification_channels WHERE id = $1`,
      [channelId],
    );
    const row = result.rows[0] as { sealed_config: Uint8Array } | undefined;
    expect(row, 'the channel row exists').toBeDefined();
    return Buffer.from(row?.sealed_config ?? new Uint8Array());
  }

  it('the raw channel config column contains no plaintext SMTP password', async () => {
    await database.truncate();
    const context = contextFor(database.userId, clock);
    const channelId = await enabledChannel(database, context, secretBox, {
      displayName: 'Mail',
      config: smtpConfig({ password: PASSWORD, username: USERNAME }),
    });

    const raw = await rawConfig(channelId);
    // 41 bytes of envelope header plus a 16-byte tag: anything at or below 57
    // bytes cannot be a sealed value, and the CHECK in 0011 says so too.
    expect(raw.length).toBeGreaterThan(57);

    for (const encoding of ['utf8', 'latin1', 'ascii'] as const) {
      const decoded = raw.toString(encoding);
      expect(decoded).not.toContain(PASSWORD);
      expect(decoded).not.toContain(USERNAME);
      // The JSON shape itself must not be visible either: a leaked key name is
      // how you learn there is a password in there to go looking for.
      expect(decoded).not.toContain('password');
    }

    // The 8-byte sliding window — a partial or chunked leak.
    const latin1 = raw.toString('latin1');
    const utf8 = raw.toString('utf8');
    for (let i = 0; i + 8 <= PASSWORD.length; i += 1) {
      const fragment = PASSWORD.slice(i, i + 8);
      expect(latin1, `fragment at ${String(i)}`).not.toContain(fragment);
      expect(utf8, `fragment at ${String(i)}`).not.toContain(fragment);
    }

    // No other column leaked it either: scan every text column on the row.
    const wholeRow = await database.db.execute<{ dump: string }>(sql`
      SELECT to_jsonb(c.*) #>> '{}' AS dump FROM notification_channels c WHERE c.id = ${channelId}::uuid
    `);
    expect(wholeRow.rows[0]?.dump ?? '').not.toContain(PASSWORD);

    // …and it does open, so this is custody and not a corrupted write.
    const row = await findChannel(database.db, database.userId, channelId);
    if (row === null) throw new Error('the channel row vanished');
    const opened = await openChannelConfig(row, secretBox);
    expect(opened.kind).toBe('smtp');
    expect(opened.kind === 'smtp' ? opened.password : null).toBe(PASSWORD);
  });

  it("another channel's envelope does not open in this row (the AAD names the row)", async () => {
    await database.truncate();
    const context = contextFor(database.userId, clock);
    const a = await enabledChannel(database, context, secretBox, {
      displayName: 'Mail A',
      config: smtpConfig({ password: PASSWORD }),
    });
    const b = await enabledChannel(database, context, secretBox, {
      displayName: 'Mail B',
      config: smtpConfig({ password: 'a different secret entirely' }),
    });

    // Lift A's bytes into B, which is the move somebody with write access but
    // no passphrase would make.
    const lifted = await rawConfig(a);
    await database.db.execute(sql`
      UPDATE notification_channels SET sealed_config = ${lifted} WHERE id = ${b}::uuid
    `);

    const row = await findChannel(database.db, database.userId, b);
    if (row === null) throw new Error('the channel row vanished');
    await expect(openChannelConfig(row, secretBox)).rejects.toThrow();
  });

  it('re-pointing the clear destination_host at an internal name fails to open', async () => {
    await database.truncate();
    const context = contextFor(database.userId, clock);
    const channelId = await enabledChannel(database, context, secretBox, {
      displayName: 'Mail',
      config: smtpConfig({ password: PASSWORD }),
    });

    const before = await findChannel(database.db, database.userId, channelId);
    expect(before?.destinationHost).toBe(SMTP_HOST);

    // The attack the sealed/clear split invites, and the reason the two copies
    // are compared: an operator-level UPDATE re-points a verified channel.
    await database.db.execute(sql`
      UPDATE notification_channels SET destination_host = 'db' WHERE id = ${channelId}::uuid
    `);

    const row = await findChannel(database.db, database.userId, channelId);
    if (row === null) throw new Error('the channel row vanished');
    await expect(openChannelConfig(row, secretBox)).rejects.toBeInstanceOf(ChannelRefusedError);
  });
});
