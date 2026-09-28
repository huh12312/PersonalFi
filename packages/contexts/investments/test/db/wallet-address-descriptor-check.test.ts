// SPDX-License-Identifier: MIT
/**
 * Migration 0027's structural half of C-13 (`docs/evidence/phase-3/
 * gate-security-review.md` §4.1(c)), against a real Postgres:
 * `wallet_addresses.descriptor` is nullable now, `descriptor_sealed` exists,
 * and `wallet_addresses_descriptor_has_a_representation` refuses a row that
 * lands with neither.
 *
 * This is the structural proof only, not the cryptographic one. The full
 * raw-column custody proof (WP 1.3b's pattern — seal through the real
 * `SecretBox`, read the column back exactly as `psql` would, assert no
 * plaintext survives) needs `@core/secretbox`, which is not a dependency of
 * `@ctx/investments` (unlike `@ctx/connections`/`@ctx/notifications`/
 * `@ctx/identity`, which declare it) — adding one is a `package.json` edit
 * this work package's rules forbid. It also needs the real write path
 * (`apps/api/src/domain.ts`'s `WalletAddressStore`), which lives outside
 * this package and whose own test seam (`apps/api/test/db`) is outside this
 * work package's granted files. Both gaps are recorded, not silently
 * closed, in `docs/evidence/phase-4/wp4.12c-gate-conditions.md` §1.
 *
 * What this file *can* prove without either: that the migration's own
 * refusal is real SQL enforcement and not merely a comment, by writing raw
 * rows the same way `domain.ts`'s store does (arbitrary bytes stand in for
 * a sealed envelope — this test never touches `SecretBox`).
 */
import { newId } from '@core/kernel';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NO_DATABASE, investmentsDatabase, pgFailureOf, type TestDatabase } from './harness.ts';

const WALLETRPC_PROVIDER = 'wallet_rpc';

describe.skipIf(NO_DATABASE)('wallet_addresses.descriptor / descriptor_sealed (0027, C-13)', () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await investmentsDatabase('wallet_desc_check');
  }, 60_000);

  afterAll(async () => {
    await database.drop();
  });

  beforeEach(async () => {
    await database.db.execute(
      sql.raw('TRUNCATE wallet_addresses, connections, domain_events RESTART IDENTITY CASCADE'),
    );
  });

  /** A minimal `connections` row — `wallet_addresses.connection_id`'s FK target. */
  async function seedConnection(): Promise<string> {
    const connectionId = newId();
    await database.db.execute(sql`
      INSERT INTO connections (id, user_id, provider, provider_connection_id, display_name)
      VALUES (
        ${connectionId}::uuid, ${database.userId}::uuid, ${WALLETRPC_PROVIDER},
        ${`pcid-${connectionId}`}, 'Test wallet'
      )
    `);
    return connectionId;
  }

  it('accepts a row with only descriptor_sealed set (the sealed write path)', async () => {
    const connectionId = await seedConnection();
    const walletId = newId();
    // Arbitrary bytes stand in for a SecretBox envelope — this test proves
    // the column shape and the CHECK, not the cryptography.
    const sealed = Buffer.from('not-a-real-envelope-just-bytes', 'utf8');

    await database.db.execute(sql`
      INSERT INTO wallet_addresses (
        id, user_id, connection_id, chain, descriptor, descriptor_sealed, derivation_scheme
      ) VALUES (
        ${walletId}::uuid, ${database.userId}::uuid, ${connectionId}::uuid, 'ethereum',
        NULL, ${sealed}, NULL
      )
    `);

    const result = await database.db.execute<{
      descriptor: string | null;
      descriptor_sealed: Buffer;
    }>(
      sql`SELECT descriptor, descriptor_sealed FROM wallet_addresses WHERE id = ${walletId}::uuid`,
    );
    expect(result.rows[0]?.descriptor).toBeNull();
    expect(Buffer.from(result.rows[0]?.descriptor_sealed ?? []).toString('utf8')).toBe(
      'not-a-real-envelope-just-bytes',
    );
  });

  it('still accepts a row with only the legacy plaintext descriptor (unsealed installs, unchanged)', async () => {
    const connectionId = await seedConnection();
    const walletId = newId();

    await database.db.execute(sql`
      INSERT INTO wallet_addresses (
        id, user_id, connection_id, chain, descriptor, descriptor_sealed, derivation_scheme
      ) VALUES (
        ${walletId}::uuid, ${database.userId}::uuid, ${connectionId}::uuid, 'bitcoin',
        'xpub6CUGRUonZSQ4TWtTMmzXdrXDtypWKiKrhko4egpiMZbpiaQL2jkwSB1icqYh2cfDfVxdx4df189oLKnC5fSwqPfgyP3hooxujYzAu3fDVmz',
        NULL, 'bip84'
      )
    `);

    const result = await database.db.execute<{ descriptor: string | null }>(
      sql`SELECT descriptor FROM wallet_addresses WHERE id = ${walletId}::uuid`,
    );
    expect(result.rows[0]?.descriptor).toMatch(/^xpub/);
  });

  it('refuses a row with neither descriptor nor descriptor_sealed (23514)', async () => {
    const connectionId = await seedConnection();
    const walletId = newId();

    const failure = await pgFailureOf(
      database.db.execute(sql`
        INSERT INTO wallet_addresses (
          id, user_id, connection_id, chain, descriptor, descriptor_sealed, derivation_scheme
        ) VALUES (
          ${walletId}::uuid, ${database.userId}::uuid, ${connectionId}::uuid, 'ethereum',
          NULL, NULL, NULL
        )
      `),
    );
    expect(failure.code).toBe('23514');
    expect(failure.constraint).toBe('wallet_addresses_descriptor_has_a_representation');
  });
});
