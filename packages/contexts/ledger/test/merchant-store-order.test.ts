// SPDX-License-Identifier: MIT
/**
 * Two syncs for one holder resolving the same payees at the same moment must
 * not deadlock each other (CI 2026-10-28, run 40765767260: the nightly chain's
 * first sync for one of eight connections failed `INTERNAL` on Postgres
 * `40P01`, both backends inside `insert into "merchants" … values (…)` while
 * inserting index tuples for `(user_id, normalized_key)`).
 *
 * A multi-row `INSERT … ON CONFLICT DO NOTHING` takes the unique index's locks
 * in the order of its VALUES; two statements with the same keys in different
 * orders each hold what the other wants. `ensureMerchants` therefore inserts in
 * one global key order, so the locks are always taken monotonically. This test
 * runs the two orders concurrently, inside transactions, many times over: with
 * the ordering removed it deadlocks on most rounds; with it, never.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ensureMerchants, type WantedMerchant } from '../src/merchant-store.ts';
import { NO_DATABASE, ledgerDatabase, type TestDatabase } from './harness.ts';

const ROUNDS = 12;
const KEYS = 60;

function wantedOf(keys: readonly string[]): Map<string, WantedMerchant> {
  return new Map(
    keys.map((key) => [key, { display: key.toUpperCase(), entityIds: [`plaid:${key}`] }]),
  );
}

describe.skipIf(NO_DATABASE)('ensureMerchants under two concurrent syncs', () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await ledgerDatabase('merchant_store_order');
  });

  afterAll(async () => {
    await database.drop();
  });

  beforeEach(async () => {
    await database.truncate();
  });

  it('resolves the same payees from two transactions in opposite key orders without deadlocking', async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const keys = Array.from(
        { length: KEYS },
        (_, i) => `payee${String(round)}x${String(i).padStart(3, '0')}`,
      );
      const forward = wantedOf(keys);
      const backward = wantedOf([...keys].reverse());
      const now = new Date('2026-06-01T12:00:00.000Z');

      const [a, b] = await Promise.all([
        database.db.transaction((tx) => ensureMerchants(tx, database.userId, forward, now)),
        database.db.transaction((tx) => ensureMerchants(tx, database.userId, backward, now)),
      ]);

      expect(a.size).toBe(KEYS);
      expect(b.size).toBe(KEYS);
      for (const key of keys) expect(b.get(key), `round ${String(round)}: ${key}`).toBe(a.get(key));
    }
  });
});
