// SPDX-License-Identifier: MIT
/**
 * WP 10.13 — the stacked net-worth chart's p95 budget, over real HTTP, on the dense corpus WP 10.9 added.
 *
 * Measured the way `spending-pace-http-perf.test.ts` (WP 10.9) and WP 2.12 established: `h.listen()` +
 * `fetch()`, warm-ups excluded, every sample printed. **Budget: p95 < 150 ms for All** (the dispatch's):
 * `GET /net-worth/series?from=…&to=…&bucket=month` over the widest window the route materialises, which
 * is the whole extended endpoint — the gapless series (`readSeries`), the per-day detail, the last
 * snapshot failure, the ledger's accounts list and the one bucketed read — not the bucketed read alone.
 *
 * The corpus: V2's 50,040 transactions, densified (`dense-seed.ts`), loaded through the production loader
 * — which gives the holder the seed's real accounts — and then **ten years of `net_worth_daily`**, one row
 * per day from 2016-10-01 to 2026-09-30 (3,652 days, the All window), each with a breakdown entry for every
 * one of those accounts in `net-worth.ts`'s exact shape. Nothing in the 50k transactions is read by this
 * route; they are here so the database is the one the other budget measures, not an empty one.
 *
 * The row counts are asserted by a test with no skip of its own (WP 9.9).
 */
import { systemClock } from '@core/kernel';
import { generateDemoData } from '@core/seed';
import { loadSeedDataset } from '@ctx/ledger';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApiHarness, NO_DATABASE, type ApiHarness } from '../helpers/api-harness.ts';
import { densify } from './dense-seed.ts';
import { assertWithinBudget, measureGet, settleLoad } from './perf-support.ts';

// perf-skip: NO_DATABASE — DATABASE_URL is unset, so there is no Postgres to load the corpus into (CI's migration-test job has one)
// perf-skip: HOST_LOADED — an over-budget reading at a 1-minute load of 3 or more is not believed (09 §3 rule 4); in-budget readings pass at any load
const describeWithDb = describe.skipIf(NO_DATABASE);

const EXPECTED_TRANSACTION_COUNT = 50_040;
const BUDGET_MS = 150;
const FROM = '2016-10-01';
const TO = '2026-09-30';
const EXPECTED_DAYS = 3652;

/** Ten years of days, every seed account on each, written in one statement. */
async function writeTenYears(h: ApiHarness): Promise<void> {
  await h.database.db.execute(sql`
    INSERT INTO net_worth_daily (
      id, user_id, as_of_date, revision, base_currency, assets_minor, liabilities_minor,
      net_worth_minor, liquid_minor, investable_minor, on_budget_minor, breakdown, source,
      accounts_counted, accounts_unvalued, sealed_at
    )
    SELECT md5(${h.userId} || day::text)::uuid, ${h.userId}::uuid, day::date, 1, 'USD',
           totals.assets, totals.liabilities, totals.assets - totals.liabilities, 0, 0, 0,
           totals.breakdown, 'observed', totals.n, 0, day + interval '1 day 6 hours'
      FROM generate_series(${FROM}::date, ${TO}::date, interval '1 day') AS day
     CROSS JOIN LATERAL (
       SELECT jsonb_agg(jsonb_build_object(
                'accountId', acc.id::text, 'currency', 'USD',
                'nativeMinor', acc.v::text, 'baseMinor', acc.v::text,
                'fxRate', '1', 'fxRateDate', to_char(day, 'YYYY-MM-DD'),
                'onBudget', true, 'inNetWorth', true, 'isLiquid', false, 'isInvestable', false,
                'side', acc.side, 'kind', acc.kind, 'valuation', 'observed', 'stalePrice', false
              ) ORDER BY acc.id) AS breakdown,
              coalesce(sum(acc.v) FILTER (WHERE acc.side = 'asset'), 0) AS assets,
              -coalesce(sum(acc.v) FILTER (WHERE acc.side = 'liability'), 0) AS liabilities,
              count(*)::int AS n
         FROM (
           SELECT a.id,
                  CASE WHEN a.classification = 'liability' THEN 'liability' ELSE 'asset' END AS side,
                  CASE a.type WHEN 'depository' THEN 'cash' WHEN 'credit' THEN 'credit'
                              WHEN 'loan' THEN 'loan' WHEN 'investment' THEN 'investment'
                              WHEN 'crypto' THEN 'investment' ELSE 'manual_asset' END AS kind,
                  (CASE WHEN a.classification = 'liability' THEN -1 ELSE 1 END)
                    * (100000 + (abs(hashtext(a.id::text || day::text)) % 5000000))::bigint AS v
             FROM accounts AS a
            WHERE a.user_id = ${h.userId}::uuid
         ) AS acc
     ) AS totals
  `);
}

describeWithDb(
  '[slow] net worth by account type p95, over real HTTP (dense corpus + ten years of days)',
  () => {
    let h: ApiHarness;
    let base: string;

    beforeAll(async () => {
      const dataset = generateDemoData(1, { monthCount: 1264 });
      expect(dataset.transactions.length).toBe(EXPECTED_TRANSACTION_COUNT);
      h = await createApiHarness({ suite: 'wp1013_nw_perf' });
      await loadSeedDataset(h.database.db, h.userId, densify(dataset), { clock: systemClock });
      await h.database.db.execute(
        sql`DELETE FROM net_worth_daily WHERE user_id = ${h.userId}::uuid`,
      );
      await writeTenYears(h);
      await h.database.db.execute(sql`ANALYZE net_worth_daily`);
      base = await h.listen();
    }, 600_000);

    afterAll(async () => {
      await h?.close();
    }, 120_000);

    it('the corpus is there: 50k transactions, ten years of days, every account on every day', async () => {
      const counts = await h.database.db.execute<{
        tx: string;
        days: string;
        accounts: string;
        entries: string;
      }>(sql`
      SELECT (SELECT count(*) FROM transactions WHERE user_id = ${h.userId}::uuid AND removed_at IS NULL)::text AS tx,
             (SELECT count(*) FROM net_worth_daily WHERE user_id = ${h.userId}::uuid)::text AS days,
             (SELECT count(*) FROM accounts WHERE user_id = ${h.userId}::uuid)::text AS accounts,
             (SELECT sum(jsonb_array_length(breakdown)) FROM net_worth_daily WHERE user_id = ${h.userId}::uuid)::text AS entries
    `);
      const row = counts.rows[0]!;
      expect(Number(row.tx)).toBe(EXPECTED_TRANSACTION_COUNT);
      expect(Number(row.days)).toBe(EXPECTED_DAYS);
      expect(Number(row.accounts)).toBeGreaterThanOrEqual(3);
      expect(Number(row.entries)).toBe(EXPECTED_DAYS * Number(row.accounts));
      console.log(
        `[wp1013 perf corpus] ${row.tx} transactions, ${row.days} days, ${row.accounts} accounts, ${row.entries} breakdown entries`,
      );
    }, 60_000);

    it('GET /net-worth/series?bucket=month over All holds p95 < 150 ms', async (ctx) => {
      const cookie = `__Host-pfi_session=${h.fresh.accessToken}`;
      await settleLoad();
      const all = await measureGet(
        'GET /net-worth/series All (3,652 days, bucket=month)',
        base,
        `/net-worth/series?from=${FROM}&to=${TO}&bucket=month`,
        cookie,
        { warmups: 3, samples: 30 },
      );
      // For the record, not the budget: the same window without `bucket` — the endpoint as it was before this WP.
      await measureGet(
        'GET /net-worth/series All (3,652 days, no bucket: the pre-WP 10.13 read, for comparison)',
        base,
        `/net-worth/series?from=${FROM}&to=${TO}`,
        cookie,
        { warmups: 3, samples: 30 },
      );
      const sixMonths = await measureGet(
        'GET /net-worth/series 6M (182 days, bucket=week)',
        base,
        `/net-worth/series?from=2026-04-02&to=${TO}&bucket=week`,
        cookie,
        { warmups: 3, samples: 30 },
      );
      assertWithinBudget(ctx, [
        { label: all.label, p95: all.p95, budgetMs: BUDGET_MS },
        { label: sixMonths.label, p95: sixMonths.p95, budgetMs: BUDGET_MS },
      ]);
    }, 300_000);
  },
);
