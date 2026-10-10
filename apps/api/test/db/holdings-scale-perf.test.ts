// SPDX-License-Identifier: MIT
/**
 * WP 9.9 (g) — `GET /holdings` and `GET /investments/allocation` on the SCALE seed.
 *
 * `investments-perf.test.ts` (WP 3.14) times these two routes over the Phase 3
 * correctness seed — a dozen positions, which wp3.14-quality §8 item 6 itself
 * calls "a correctness seed, not a scale seed". WP 4.13's scale seed
 * (`generatePhase4Scale`) is the dataset the master plan's performance budgets are
 * sized for: **200 positions across eleven accounts** (all four tax buckets plus a
 * CAD account), **five years of daily prices** (365,000 `prices` rows), and a
 * declared FX gap. Nothing timed the holdings routes over it; this does.
 *
 * ## Informational in WP 9.9, asserted since WP 9.14
 *
 * The dispatch recorded these two rows "informationally" (§3 WP 9.9 (g)), and they read
 * p95 2,051 / 2,012 ms (P-6: the price read walked every row of every security, one
 * security at a time). WP 9.14 bounded and batched that read (65 / 51 ms), so the last
 * test now asserts the 200 ms the same routes meet over `investments-perf.test.ts`'s
 * 12-position seed — through `assertWithinBudget`, so a loaded host skips by name and a
 * quiet one fails. The rows-in-the-database check stays a separate `it` with no skip.
 *
 * ## Loading
 *
 * Accounts are real (a `ManualConnector` link over HTTP, as `investments-perf` does);
 * securities, holdings, prices and FX are SQL, for the reason that file's header
 * gives (the only production writer is the Plaid sync). Prices go in 5,000-row JSON
 * batches. Today's price is added per security, so every position reads FRESH
 * (`observed_at`, not `price_date`, decides staleness: 07 §6.1), and today's CAD/USD
 * rate, so the CAD account converts.
 */
import { newId, systemClock } from '@core/kernel';
import { generatePhase4Scale } from '@core/seed';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  NO_DATABASE,
  createApiHarness,
  linkManual,
  type ApiHarness,
} from '../helpers/api-harness.ts';
import { priceHoldings, priceReaderFor, readHoldings } from '../../src/routes/investments.ts';
import {
  assertWithinBudget,
  describeLoad,
  measureGet,
  recordFigure,
  settleLoad,
} from './perf-support.ts';

// perf-skip: NO_DATABASE — DATABASE_URL is unset, so there is no Postgres to load the 365,000-row scale seed into (CI's migration-test job has one)
// perf-skip: HOST_LOADED — an over-budget reading at a 1-minute load of 3 or more (or beside a CPU burst) is not believed (09 §3 rule 4); in-budget readings pass at any load
// perf-skip: ON_SHARED_RUNNER — a GitHub shared runner is not the target hardware (09 §6 Q1) and the 365,000-row load is not worth a CI job's minutes
const ON_SHARED_RUNNER = process.env['CI'] !== undefined;

const scale = generatePhase4Scale(20_260_926);
const PRICE_BATCH = 5_000;

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** `quantity` (a 4-place decimal string) × `closeMinor` (cents), as integer minor units. */
function valueMinor(quantity: string, closeMinor: bigint): bigint {
  const [whole = '0', fraction = ''] = quantity.split('.');
  const scaled = BigInt(`${whole}${fraction.padEnd(4, '0').slice(0, 4)}`);
  return (scaled * closeMinor) / 10_000n;
}

function minorOf(decimal: string): bigint {
  const [whole = '0', fraction = ''] = decimal.split('.');
  return BigInt(`${whole}${fraction.padEnd(2, '0').slice(0, 2)}`);
}

describe.skipIf(NO_DATABASE)(
  '[slow] holdings and allocation on the Phase 4 scale seed (WP 9.9 (g), informational)',
  () => {
    describe.skipIf(ON_SHARED_RUNNER)('over the 200-position, five-year scale seed', () => {
      let h: ApiHarness;
      let base: string;
      let cookie: string;
      let loadSeconds = 0;

      beforeAll(async () => {
        expect(scale.holdings.length).toBe(200);
        h = await createApiHarness({ suite: 'wp99-holdings-scale' });
        const started = performance.now();

        await linkManual(h, {
          providerConnectionId: 'wp99-scale-conn',
          displayName: 'Scale Brokerage',
          accounts: scale.accounts.map((account) => ({
            providerAccountId: account.id,
            name: account.name,
            type: 'investment' as const,
            currency: account.currency,
          })),
        });
        const accountRows = await h.database.db.execute<{
          id: string;
          provider_account_id: string;
        }>(sql`SELECT id, provider_account_id FROM accounts WHERE user_id = ${h.userId}::uuid`);
        const accountIdOf = new Map(
          accountRows.rows.map((row) => [row.provider_account_id, row.id]),
        );

        const securityIdOf = new Map<string, string>();
        for (const security of scale.securities) {
          const id = newId();
          securityIdOf.set(security.id, id);
          // fixture: securities row written by SQL because its only writer is the investments sync's SecurityResolver (no route writes it) and this test pins a reader/route over it; the resolver writes this shape (identity_kind 'ticker', identity_key 'ticker:<T>:<user>', classification LOCAL_SEED_TABLE) — the same rows investments-routes.test.ts's header rules on
          await h.database.db.execute(sql`
          INSERT INTO securities (
            id, user_id, identity_kind, identity_key, ticker, name, type, currency,
            is_cash_equivalent, asset_class, region, sector, classification_source,
            classification_depth, classification_flagged
          ) VALUES (
            ${id}::uuid, ${h.userId}::uuid, 'ticker',
            ${`ticker:${security.symbol}:${h.userId.slice(0, 8)}`},
            ${security.symbol}, ${`Scale ${security.symbol}`}, 'equity', ${security.currency},
            false, 'US_EQUITY', 'US', 'UNKNOWN', 'LOCAL_SEED_TABLE', 0, false
          )
        `);
        }

        // Last close per security, for each position's institution value.
        const lastClose = new Map<string, bigint>();
        const lastDay = scale.days.at(-1);
        for (const point of scale.prices) {
          if (point.date === lastDay) lastClose.set(point.securityId, minorOf(point.close));
        }
        const today = todayIso();
        for (const holding of scale.holdings) {
          const accountId = accountIdOf.get(holding.accountId);
          const securityId = securityIdOf.get(holding.securityId);
          if (accountId === undefined || securityId === undefined) continue;
          const security = scale.securities.find((entry) => entry.id === holding.securityId);
          // fixture: holdings row written by SQL because its only writer is the investments sync (WP 3.7's lot consumer, `upsertHolding`; no route writes it); the sync could write it as a decimal-string quantity on an open account with BROKER/ESTIMATED cost basis, as here
          await h.database.db.execute(sql`
          INSERT INTO holdings (
            id, user_id, account_id, security_id, quantity, institution_value_minor, currency,
            cost_basis_minor, cost_basis_is_user_supplied, cost_basis_source, as_of_date
          ) VALUES (
            ${newId()}::uuid, ${h.userId}::uuid, ${accountId}::uuid, ${securityId}::uuid,
            ${holding.quantity},
            ${valueMinor(holding.quantity, lastClose.get(holding.securityId) ?? 0n)},
            ${security?.currency ?? 'USD'}, NULL, false, 'ESTIMATED', ${today}::date
          )
        `);
        }

        // Five years of daily prices, in JSON batches.
        for (let start = 0; start < scale.prices.length; start += PRICE_BATCH) {
          const batch = scale.prices.slice(start, start + PRICE_BATCH).flatMap((point) => {
            const securityId = securityIdOf.get(point.securityId);
            return securityId === undefined
              ? []
              : [{ s: securityId, d: point.date, c: point.close }];
          });
          // fixture: prices row written by SQL because its only writer is the market-data refresh/price ladder (no route writes it); the ladder writes an observation with source tiingo/coingecko/fred, never last_known (the prices_source_is_an_observation CHECK), as here
          await h.database.db.execute(sql`
          INSERT INTO prices (id, user_id, security_id, price_date, source, close, currency, stale, observed_at)
          SELECT gen_random_uuid(), ${h.userId}::uuid, (r->>'s')::uuid, (r->>'d')::date, 'tiingo',
                 (r->>'c')::numeric, 'USD', false, ((r->>'d') || 'T21:00:00.000Z')::timestamptz
            FROM jsonb_array_elements(${JSON.stringify(batch)}::jsonb) AS r
          ON CONFLICT DO NOTHING
        `);
        }
        for (const security of scale.securities) {
          const securityId = securityIdOf.get(security.id);
          if (securityId === undefined) continue;
          await h.database.db.execute(sql`
          INSERT INTO prices (id, user_id, security_id, price_date, source, close, currency, stale, observed_at)
          VALUES (${newId()}::uuid, ${h.userId}::uuid, ${securityId}::uuid, ${today}::date, 'tiingo',
                  ${(Number(lastClose.get(security.id) ?? 0n) / 100).toFixed(2)}, ${security.currency}, false, now())
          ON CONFLICT DO NOTHING
        `);
        }
        for (const point of scale.fx) {
          // fixture: fx_rates row written by SQL because its only writer is the market-data FX refresh (no route writes it); the refresh writes a dated observation with a named source (fred) and a decimal rate, as here
          await h.database.db.execute(sql`
          INSERT INTO fx_rates (id, user_id, base_currency, quote_currency, rate_date, source, rate, observed_at)
          VALUES (${newId()}::uuid, ${h.userId}::uuid, 'CAD', 'USD', ${point.date}::date, 'fred',
                  ${point.rate}, ${`${point.date}T21:00:00.000Z`}::timestamptz)
          ON CONFLICT DO NOTHING
        `);
        }
        await h.database.db.execute(sql`
        INSERT INTO fx_rates (id, user_id, base_currency, quote_currency, rate_date, source, rate, observed_at)
        VALUES (${newId()}::uuid, ${h.userId}::uuid, 'CAD', 'USD', ${today}::date, 'fred', '0.7400000000', now())
        ON CONFLICT DO NOTHING
      `);
        await h.database.db.execute(sql`ANALYZE prices`);
        await h.database.db.execute(sql`ANALYZE holdings`);
        loadSeconds = (performance.now() - started) / 1_000;
        recordFigure('holdings scale seed load', {
          positions: scale.holdings.length,
          priceRows: scale.prices.length,
          seconds: Number(loadSeconds.toFixed(1)),
        });

        base = await h.listen();
        cookie = `__Host-pfi_session=${h.fresh.accessToken}`;
        await settleLoad();
      }, 1_800_000);

      afterAll(async () => {
        await h?.close();
      }, 120_000);

      // The row-count sanity check: no skip of its own beyond the file's.
      it('the scale seed is actually in the database (a perf number over an empty table is a lie)', async () => {
        const rows = await h.database.db.execute<{
          holdings: string;
          securities: string;
          prices: string;
          accounts: string;
        }>(sql`
        SELECT (SELECT count(*) FROM holdings WHERE user_id = ${h.userId}::uuid)::text AS holdings,
               (SELECT count(*) FROM securities WHERE user_id = ${h.userId}::uuid)::text AS securities,
               (SELECT count(*) FROM prices WHERE user_id = ${h.userId}::uuid)::text AS prices,
               (SELECT count(*) FROM accounts WHERE user_id = ${h.userId}::uuid)::text AS accounts
      `);
        expect(Number(rows.rows[0]?.holdings)).toBe(200);
        expect(Number(rows.rows[0]?.securities)).toBe(200);
        expect(Number(rows.rows[0]?.accounts)).toBe(scale.accounts.length);
        expect(Number(rows.rows[0]?.prices)).toBeGreaterThanOrEqual(scale.prices.length);

        const response = await fetch(`${base}/holdings`, { headers: { cookie } });
        expect(response.status).toBe(200);
        const body = await response.text();
        expect(body.length).toBeGreaterThan(10_000);
        process.stdout.write(
          `perf holdings scale: 200 positions, ${String(scale.prices.length)} price rows, ` +
            `/holdings body ${String(body.length)} bytes ${describeLoad()}\n`,
        );
      }, 60_000);

      it('where the time goes: reading the holdings is one query; pricing is one ladder walk per security, in sequence', async () => {
        await settleLoad();
        const database = h.database.db;
        const readStarted = performance.now();
        const reads = await readHoldings(database, h.userId, null);
        const readMs = performance.now() - readStarted;
        const kinds = new Map<string, string>(
          reads.map((read) => [read.securityId, read.securityType]),
        );
        const securityIds = [...new Set(reads.map((read) => read.securityId))];
        expect(securityIds.length).toBe(200);
        const asOf = todayIso();

        // Price the first N securities' holdings only: if the cost is per security it is linear in N.
        const rows: { securities: number; ms: number }[] = [];
        for (const securities of [1, 10, 50, 200]) {
          const subset = reads.filter((read) =>
            securityIds.slice(0, securities).includes(read.securityId),
          );
          const samples: number[] = [];
          for (let i = 0; i < 5; i += 1) {
            const started = performance.now();
            await priceHoldings(
              subset,
              priceReaderFor(database, h.userId, systemClock, kinds),
              asOf,
            );
            samples.push(performance.now() - started);
          }
          samples.sort((a, b) => a - b);
          rows.push({ securities, ms: samples[2] ?? 0 });
        }
        recordFigure('holdings scale profile', {
          readHoldingsMs: Number(readMs.toFixed(1)),
          pricingMedianMsBySecurities: Object.fromEntries(
            rows.map((row) => [row.securities, Number(row.ms.toFixed(1))]),
          ),
          perSecurityMs200: Number(((rows.at(-1)?.ms ?? 0) / 200).toFixed(2)),
        });
        // Recorded, never asserted (informational); only that the pricing is the whole cost.
        expect(rows.at(-1)?.ms ?? 0).toBeGreaterThan(0);
      }, 300_000);

      it('GET /holdings and GET /investments/allocation over the scale seed stay inside 200 ms (P-6, WP 9.14)', async (ctx) => {
        await settleLoad();
        const checks: { label: string; p95: number; budgetMs: number }[] = [];
        for (const [label, path] of [
          ['GET /holdings (200 positions, 5 years of prices)', '/holdings'],
          ['GET /investments/allocation (200 positions)', '/investments/allocation'],
        ] as const) {
          const measured = await measureGet(label, base, path, cookie, { samples: 30 });
          expect(measured.samples.length).toBe(30);
          checks.push({ label, p95: measured.p95, budgetMs: 200 });
        }
        // Informational in WP 9.9 (p95 2,051 / 2,012 ms: the price read walked every row of every
        // security, one security at a time). WP 9.14 bounded and batched that read (65 / 51 ms), so the
        // 200 ms those routes meet over the 12-position seed is now asserted at the scale the plan sizes the
        // product for. Over budget on a loaded host is the named HOST_LOADED skip; on a quiet one it fails.
        assertWithinBudget(ctx, checks);
      }, 300_000);
    });
  },
);
