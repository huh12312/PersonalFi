// SPDX-License-Identifier: MIT
/**
 * WP 2.12 — Phase 1's R-5 ("the merchant growth bound"), finally promoted to
 * a condition (docs/plan/02-phase-2-dispatch.md §2: "no bound on distinct
 * merchants or on `transactions_provider` revisions; never promoted to a
 * condition. `pruneNoiseMerchants` is the repair, not the bound.").
 *
 * `test/seed.test.ts`'s own `'is idempotent: loading the dataset again
 * changes nothing'` already proves replay is safe — but only at the
 * generator's default 982-transaction, 24-month scale, and only by comparing
 * a transaction *count* and an *effective sum*, neither of which would
 * notice a merchant-resolution regression that quietly minted a near-duplicate
 * merchant per sync (same total transaction count, same total spend, twice
 * the merchant rows). This file promotes the claim to what dispatch §5's R-5
 * risk actually asks for: distinct-merchant count and `transactions_provider`
 * revision counts, at a realistic backfill scale, across repeated syncs of
 * the identical corpus.
 *
 * `generateDemoData`'s existing `monthCount` option (no `@core/seed` code
 * change needed) reaches ~50k transactions deterministically:
 * `generateDemoData(1, { monthCount: 1264 })` produces 50,040 transactions
 * across the same fixed 32-merchant, 6-account household the rest of the
 * Phase 1/2 evidence already uses at its default 24-month scale — the
 * generator's merchant pool does not grow with the window, which is exactly
 * the property this file measures downstream, in the real ledger.
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { merchants } from '../schema/index.ts';
import { loadSeedDataset } from '../src/seed-loader.ts';
import {
  generateDemoData,
  ledgerDatabase,
  testClock,
  NO_DATABASE,
  type TestDatabase,
} from './harness.ts';

// 50,040 transactions, deterministic — verified once by hand (packages/seed's
// own generator is a pure function of (seed, monthCount)):
//   generateDemoData(1, { monthCount: 1264 }).transactions.length === 50_040
const MONTH_COUNT = 1264;

// perf-skip: NO_DATABASE — DATABASE_URL is unset, so there is no Postgres to load the 50k backfill into (CI's migration-test job has one)
describe.skipIf(NO_DATABASE)(
  '[slow] R-5: merchant and provider-revision growth bound on a 50k-row backfill',
  () => {
    let database: TestDatabase;
    let dataset: ReturnType<typeof generateDemoData>;

    beforeAll(async () => {
      database = await ledgerDatabase('growth');
      dataset = generateDemoData(1, { monthCount: MONTH_COUNT });
    }, 60_000);

    afterAll(async () => {
      await database.drop();
    });

    async function merchantSnapshot(): Promise<{ count: number; ids: string[] }> {
      const rows = await database.db
        .select({ id: merchants.id })
        .from(merchants)
        .orderBy(merchants.id);
      return { count: rows.length, ids: rows.map((row) => row.id) };
    }

    /** Sum of `transactions_provider.revision` — grows only on a real content change. */
    async function totalRevisions(): Promise<number> {
      const result = await database.db.execute<{ total: string | null }>(
        sql`SELECT sum(revision) AS total FROM transactions_provider`,
      );
      return Number(result.rows[0]?.total ?? 0);
    }

    async function factCount(): Promise<number> {
      const result = await database.db.execute<{ count: string }>(
        sql`SELECT count(*) AS count FROM transactions_provider`,
      );
      return Number(result.rows[0]?.count ?? 0);
    }

    it('three syncs of the same corpus add no merchants and no provider revisions', async () => {
      expect(dataset.transactions.length).toBe(50_040);
      expect(dataset.merchants.length).toBe(32);

      // Sync 1: the real write path (applyProviderTransactions, resolveMerchants),
      // not a raw bulk insert — a bulk-loaded fixture would prove nothing about
      // merchant resolution, which is exactly what R-5 is about.
      const first = await loadSeedDataset(database.db, database.userId, dataset, {
        clock: testClock(),
      });
      expect(first.transactionCount).toBe(50_040);

      const afterSync1 = {
        merchants: await merchantSnapshot(),
        facts: await factCount(),
        revisions: await totalRevisions(),
      };
      // The generator's own merchant pool is fixed at 32; the ledger's
      // resolution must not fragment it into more rows than that.
      expect(afterSync1.merchants.count).toBeLessThanOrEqual(dataset.merchants.length);
      expect(afterSync1.facts).toBe(50_040);
      // A first sighting is always revision 1, so the sum equals the fact count.
      expect(afterSync1.revisions).toBe(afterSync1.facts);

      // Sync 2: replay the identical corpus (a webhook redelivery, a schedule
      // firing on top of a manual refresh — the exact shape connections-db's
      // own dedupe tests cover for the orchestrator; this is the same claim at
      // the ledger + merchant-resolution layer, at 50k rows).
      const second = await loadSeedDataset(database.db, database.userId, dataset, {
        clock: testClock(),
        detect: false,
      });
      expect(second.transactionCount).toBe(50_040);

      const afterSync2 = {
        merchants: await merchantSnapshot(),
        facts: await factCount(),
        revisions: await totalRevisions(),
      };
      // Not "no more than 32" again — the *exact same* ids, so a regression
      // that deleted one merchant and minted a near-duplicate would still be
      // caught even though the count alone would not move.
      expect(afterSync2.merchants).toEqual(afterSync1.merchants);
      expect(afterSync2.facts).toBe(afterSync1.facts);
      expect(afterSync2.revisions).toBe(afterSync1.revisions);

      // Sync 3, for good measure — a bound proven at n=2 could still be an
      // off-by-one that only shows up on the third pass (an upsert that
      // silently keys on insertion order, say).
      const third = await loadSeedDataset(database.db, database.userId, dataset, {
        clock: testClock(),
        detect: false,
      });
      expect(third.transactionCount).toBe(50_040);

      const afterSync3 = {
        merchants: await merchantSnapshot(),
        facts: await factCount(),
        revisions: await totalRevisions(),
      };
      expect(afterSync3.merchants).toEqual(afterSync1.merchants);
      expect(afterSync3.facts).toBe(afterSync1.facts);
      expect(afterSync3.revisions).toBe(afterSync1.revisions);
    }, 300_000);
  },
);
