// SPDX-License-Identifier: MIT
/**
 * WP 3.14 — the investments perf budgets, over real HTTP, on the seed.
 *
 * Three routes, three budgets, measured the way WP 2.12's
 * `phase2-reports-http-perf.test.ts` established for this repository:
 * `h.listen()` + `fetch()` rather than `app.inject()`, because inject never
 * opens a socket and therefore never measures Fastify's routing, the auth
 * hook, serialisation or the round trip — which is the part a browser waits
 * for. Warm-ups are excluded; every sample is printed, not just the verdict,
 * because the gap between p50 and p95 is itself evidence.
 *
 * | Route | Budget | Where the budget comes from |
 * |---|---|---|
 * | `GET /holdings` | **p95 < 200 ms** | dispatch §3 WP 3.14, the exit test's own name |
 * | `GET /investments/allocation` | **p95 < 200 ms** | same |
 * | `GET /net-worth/series` (180 days) | **p95 < 200 ms** | 08 §7.1 budgets 150 ms for *1,825* points straight from `net_worth_daily`; 200 ms over a tenth of that window is the looser of the two and is recorded as such in the evidence |
 *
 * ## What "on the seed" means here
 *
 * `@core/seed`'s `generatePhase3Investments` — the WP 3.14 dataset, with the
 * declared ground truth `packages/seed/test/investments-ground-truth.test.ts`
 * grades the engine against. So the rows this measures over are the same rows
 * the correctness suite reasons about, rather than a second fixture invented
 * for timing. Securities, holdings and prices are written with SQL for the
 * reason `investments-routes.test.ts`'s header gives at length (the only
 * production writer is WP 3.7's Plaid sync); the **accounts** are real,
 * created by linking a `ManualConnector` over HTTP, and the `net_worth_daily`
 * rows are written by `@ctx/planning`'s own `computeNetWorth` → `upsertOpenDay`,
 * which is exactly what the 04:00 job calls.
 *
 * A perf test that passes because the table is empty is worse than none, so
 * the row counts are asserted before the timings are taken.
 */
import { newId, systemClock } from '@core/kernel';
import { generatePhase3Investments } from '@core/seed';
import { computeNetWorth, upsertOpenDay } from '@ctx/planning';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { planningPortsFor } from '../../src/domain.ts';
import {
  NO_DATABASE,
  createApiHarness,
  linkManual,
  type ApiHarness,
} from '../helpers/api-harness.ts';
import { assertWithinBudget, describeLoad, settleLoad } from './perf-support.ts';

// perf-skip: NO_DATABASE — DATABASE_URL is unset, so there is no Postgres to load the seed into (CI's migration-test job has one)
// perf-skip: HOST_LOADED — an over-budget reading at a 1-minute load of 3 or more is not believed (09 §3 rule 4); in-budget readings pass at any load
const DAY_MS = 86_400_000;
const BUDGET_MS = 200;
const SAMPLE_COUNT = 15;
const WARMUP_COUNT = 3;
/** Days of `net_worth_daily` history. 08 §7.1's own figure is 1,825; see the header. */
const SERIES_DAYS = 180;

const dataset = generatePhase3Investments(1);

function isoDay(offsetDays: number): string {
  return new Date(Date.now() + offsetDays * DAY_MS).toISOString().slice(0, 10);
}

function percentile(samplesAscending: readonly number[], p: number): number {
  const index = Math.floor(samplesAscending.length * p);
  return samplesAscending[Math.min(index, samplesAscending.length - 1)] ?? 0;
}

async function timeGet(base: string, path: string, cookie: string): Promise<number> {
  const start = performance.now();
  const response = await fetch(`${base}${path}`, { headers: { cookie } });
  const elapsed = performance.now() - start;
  // Drain the body: otherwise this times the headers, not the answer.
  await response.arrayBuffer();
  if (!response.ok) {
    throw new Error(`GET ${path} -> ${String(response.status)}: ${await response.text()}`);
  }
  return elapsed;
}

interface Measured {
  readonly p50: number;
  readonly p95: number;
  readonly samples: readonly number[];
}

async function measure(base: string, path: string, cookie: string): Promise<Measured> {
  for (let i = 0; i < WARMUP_COUNT; i += 1) await timeGet(base, path, cookie);
  const samples: number[] = [];
  for (let i = 0; i < SAMPLE_COUNT; i += 1) samples.push(await timeGet(base, path, cookie));
  samples.sort((a, b) => a - b);
  const measured = { p50: percentile(samples, 0.5), p95: percentile(samples, 0.95), samples };
  process.stdout.write(
    `perf ${path}: p50=${measured.p50.toFixed(1)}ms p95=${measured.p95.toFixed(1)}ms ` +
      `${describeLoad()} samples=${JSON.stringify(samples.map((s) => Math.round(s)))}\n`,
  );
  return measured;
}

describe.skipIf(NO_DATABASE)('[slow] investments perf budgets on the seed (WP 3.14)', () => {
  let h: ApiHarness;
  let base: string;
  let cookie: string;
  let holdingRows = 0;
  let priceRows = 0;

  beforeAll(async () => {
    h = await createApiHarness({ suite: 'wp314-perf' });

    // Real accounts, created the way every other suite creates them.
    await linkManual(h, {
      providerConnectionId: 'wp314-perf-conn',
      displayName: 'Seeded Brokerage',
      accounts: dataset.accounts
        .filter((account) => account.kind !== 'liability' && account.kind !== 'manual_asset')
        .map((account) => ({
          providerAccountId: account.id,
          name: account.name,
          type: 'investment' as const,
          currency: account.currency,
        })),
    });

    const accountRows = await h.database.db.execute<{ id: string; provider_account_id: string }>(
      sql`SELECT id, provider_account_id FROM accounts WHERE user_id = ${h.userId}::uuid`,
    );
    const accountIdOf = new Map(accountRows.rows.map((row) => [row.provider_account_id, row.id]));

    // --- securities, holdings, prices: the seed's own rows.
    const securityIdOf = new Map<string, string>();
    for (const security of dataset.securities) {
      const id = newId();
      securityIdOf.set(security.id, id);
      // fixture: securities row written by SQL because its only writer is the investments sync's SecurityResolver (no route writes it) and this test pins a reader/route over it; the resolver writes this shape (identity_kind 'ticker', identity_key 'ticker:<T>:<user>', classification LOCAL_SEED_TABLE) — the same rows investments-routes.test.ts's header rules on
      await h.database.db.execute(sql`
        INSERT INTO securities (
          id, user_id, identity_kind, identity_key, ticker, name, type, currency,
          is_cash_equivalent, asset_class, region, sector, chain, contract,
          classification_source, classification_depth, classification_flagged
        ) VALUES (
          ${id}::uuid, ${h.userId}::uuid, 'ticker',
          ${`ticker:${security.symbol}:${h.userId.slice(0, 8)}`},
          ${security.symbol}, ${security.name}, ${security.type}, ${security.currency},
          ${security.isCashEquivalent}, ${security.assetClass}, ${security.region},
          ${security.sector}, ${security.chain}, ${security.contract},
          'LOCAL_SEED_TABLE', 0, false
        )
      `);
    }

    for (const holding of dataset.holdings) {
      const accountId = accountIdOf.get(holding.accountId);
      const securityId = securityIdOf.get(holding.securityId);
      if (accountId === undefined || securityId === undefined) continue;
      // fixture: holdings row written by SQL because its only writer is the investments sync (WP 3.7's lot consumer, `upsertHolding`; no route writes it); the sync could write it as a decimal-string quantity on an open account with BROKER/ESTIMATED cost basis, as here
      await h.database.db.execute(sql`
        INSERT INTO holdings (
          id, user_id, account_id, security_id, quantity, institution_value_minor, currency,
          cost_basis_minor, cost_basis_is_user_supplied, cost_basis_source, as_of_date
        ) VALUES (
          ${newId()}::uuid, ${h.userId}::uuid, ${accountId}::uuid, ${securityId}::uuid,
          ${holding.quantity}, ${BigInt(holding.expectedMarketValue.minor)}, ${holding.currency},
          NULL, false, 'ESTIMATED', ${isoDay(0)}::date
        )
      `);
      holdingRows += 1;
    }

    // The historical series, plus one observation dated today per security so
    // every position is priced and FRESH (`observed_at`, not `price_date`,
    // is what decides staleness — 07 §6.1).
    const today = isoDay(0);
    for (const point of dataset.prices) {
      const securityId = securityIdOf.get(point.securityId);
      if (securityId === undefined) continue;
      if (point.date >= today) continue;
      // fixture: prices row written by SQL because its only writer is the market-data refresh/price ladder (no route writes it); the ladder writes an observation with source tiingo/coingecko/fred, never last_known (the prices_source_is_an_observation CHECK), as here
      await h.database.db.execute(sql`
        INSERT INTO prices (id, user_id, security_id, price_date, source, close, currency, stale, observed_at)
        VALUES (${newId()}::uuid, ${h.userId}::uuid, ${securityId}::uuid, ${point.date}::date,
                'tiingo', ${point.close}, 'USD', false, ${`${point.date}T21:00:00.000Z`}::timestamptz)
        ON CONFLICT DO NOTHING
      `);
      priceRows += 1;
    }
    for (const security of dataset.securities) {
      const securityId = securityIdOf.get(security.id);
      if (securityId === undefined) continue;
      await h.database.db.execute(sql`
        INSERT INTO prices (id, user_id, security_id, price_date, source, close, currency, stale, observed_at)
        VALUES (${newId()}::uuid, ${h.userId}::uuid, ${securityId}::uuid, ${today}::date,
                'tiingo', ${security.closeOnAsOf}, ${security.currency}, false, now())
        ON CONFLICT DO NOTHING
      `);
      priceRows += 1;
    }

    // --- FX. The seed's CAD/USD series, gap and all.
    //
    // Worth recording why this block exists: without it, `computeNetWorth`
    // threw `FxRateUnavailable` on the seeded CAD account — observed, not
    // reasoned about, while this file was being written. That is the §5
    // "never" (a missing FX rate never defaults to 1.0) firing over the seed
    // on the real net-worth path, and it is written up in
    // `docs/evidence/phase-3/wp3.14-quality.md` §5.
    for (const point of dataset.fx) {
      const [fxBase = 'CAD', fxQuote = 'USD'] = point.pair.split('/');
      if (point.date >= today) continue;
      // fixture: fx_rates row written by SQL because its only writer is the market-data FX refresh (no route writes it); the refresh writes a dated observation with a named source (fred) and a decimal rate, as here
      await h.database.db.execute(sql`
        INSERT INTO fx_rates (id, user_id, base_currency, quote_currency, rate_date, source, rate, observed_at)
        VALUES (${newId()}::uuid, ${h.userId}::uuid, ${fxBase}, ${fxQuote}, ${point.date}::date,
                'fred', ${point.rate}, ${`${point.date}T21:00:00.000Z`}::timestamptz)
        ON CONFLICT DO NOTHING
      `);
    }
    // Plus today's, so every day in the measured window can convert. The
    // generator's deliberate hole at 2026-03-31 stays a hole.
    await h.database.db.execute(sql`
      INSERT INTO fx_rates (id, user_id, base_currency, quote_currency, rate_date, source, rate, observed_at)
      VALUES (${newId()}::uuid, ${h.userId}::uuid, 'CAD', 'USD', ${today}::date, 'fred', '0.7400000000', now())
      ON CONFLICT DO NOTHING
    `);

    // --- net_worth_daily, written by the snapshotter, one row per day.
    const ports = planningPortsFor(h.database.db, {
      userId: h.userId,
      timeZone: 'UTC',
      clock: systemClock,
    });
    for (let offset = SERIES_DAYS - 1; offset >= 0; offset -= 1) {
      const snapshot = await computeNetWorth(ports, {
        userId: h.userId,
        asOfDate: isoDay(-offset),
        baseCurrency: 'USD',
      });
      await upsertOpenDay(h.database.db, { userId: h.userId, snapshot, clock: systemClock });
    }

    base = await h.listen();
    cookie = `__Host-pfi_session=${h.fresh.accessToken}`;
  }, 600_000);

  afterAll(async () => {
    await h.close();
  }, 60_000);

  it('the seeded dataset is actually in the database (a perf number over an empty table is a lie)', async () => {
    expect(holdingRows).toBe(dataset.holdings.length);
    expect(priceRows).toBeGreaterThan(100);
    const days = await h.database.db.execute<{ count: string }>(
      sql`SELECT count(*)::text AS count FROM net_worth_daily WHERE user_id = ${h.userId}::uuid`,
    );
    expect(Number(days.rows[0]?.count ?? '0')).toBe(SERIES_DAYS);
  });

  // WP 9.9 (j): an over-budget reading at a 1-minute load of 3 or more is the
  // named skip HOST_LOADED, not a red (perf-support.ts); a quiet host still fails.
  it('holdings and allocation p95 < 200 ms on the seed', async (ctx) => {
    await settleLoad();
    const holdings = await measure(base, '/holdings', cookie);
    const allocation = await measure(base, '/investments/allocation', cookie);

    assertWithinBudget(ctx, [
      { label: 'GET /holdings', p95: holdings.p95, budgetMs: BUDGET_MS },
      { label: 'GET /investments/allocation', p95: allocation.p95, budgetMs: BUDGET_MS },
    ]);
  }, 120_000);

  it('the net-worth series p95 < 200 ms over 180 seeded days', async (ctx) => {
    const series = await measure(
      base,
      `/net-worth/series?from=${isoDay(-(SERIES_DAYS - 1))}&to=${isoDay(0)}`,
      cookie,
    );
    assertWithinBudget(ctx, {
      label: 'GET /net-worth/series',
      p95: series.p95,
      budgetMs: BUDGET_MS,
    });
  }, 120_000);
});
