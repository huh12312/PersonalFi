// SPDX-License-Identifier: MIT
/**
 * WP 10.9 — the spending pace's p95 budget, over real HTTP, on the 50k seed.
 *
 * Measured the way WP 2.12's `phase2-reports-http-perf.test.ts` established for this repository: `h.listen()` +
 * `fetch()` (inject never opens a socket, so it never measures routing, the auth hook, serialisation or the round
 * trip), warm-ups excluded, every sample printed. **Budget: p95 < 150 ms** (the dispatch's).
 *
 * Two corpora, both the 50,040 rows of `generateDemoData(1, { monthCount: 1264 })` loaded through the production
 * loader (`loadSeedDataset`):
 *
 *  - **as generated**: the seed spreads its rows over 1,264 months from 2024-10, so a month holds about forty —
 *    the dispatched "50k seed", and the number recorded first;
 *  - **dense**: the same rows with every date mapped monotonically (order and same-day pairs preserved) onto the
 *    24 months 2024-10 … 2026-09, about 2,000 rows a month and 8,000 in the pace's four-month read. This is the
 *    case a budget is for: a holder with years of real history reads four busy months, not four quiet ones.
 *
 * The row counts are asserted by tests with no skip of their own (WP 9.9).
 */
import { DateOnly, systemClock } from '@core/kernel';
import { generateDemoData } from '@core/seed';
import { loadSeedDataset } from '@ctx/ledger';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApiHarness, NO_DATABASE, type ApiHarness } from '../helpers/api-harness.ts';
import { assertWithinBudget, measureGet, settleLoad } from './perf-support.ts';

// perf-skip: NO_DATABASE — DATABASE_URL is unset, so there is no Postgres to load the 50k corpus into (CI's migration-test job has one)
// perf-skip: HOST_LOADED — an over-budget reading at a 1-minute load of 3 or more is not believed (09 §3 rule 4); in-budget readings pass at any load
const describeWithDb = describe.skipIf(NO_DATABASE);

const EXPECTED_TRANSACTION_COUNT = 50_040;
const BUDGET_MS = 150;

type Dataset = ReturnType<typeof generateDemoData>;

/** Every date mapped monotonically from the seed's span onto [2024-10-01, 2026-09-30]: same order, same-day pairs kept. */
function densify(dataset: Dataset): Dataset {
  const dates = dataset.transactions.flatMap((t) =>
    t.pendingOn === null ? [t.postedOn] : [t.postedOn, t.pendingOn],
  );
  const epochs = dates.map((date) => DateOnly.toEpochDay(date));
  const lo = Math.min(...epochs);
  const hi = Math.max(...epochs);
  const targetLo = DateOnly.toEpochDay(DateOnly.of(2024, 10, 1));
  const targetSpan = DateOnly.toEpochDay(DateOnly.of(2026, 9, 30)) - targetLo;
  const map = (date: DateOnly): DateOnly =>
    DateOnly.fromEpochDay(
      targetLo + Math.floor(((DateOnly.toEpochDay(date) - lo) * targetSpan) / Math.max(hi - lo, 1)),
    );
  return {
    ...dataset,
    transactions: dataset.transactions.map((t) => ({
      ...t,
      postedOn: map(t.postedOn),
      pendingOn: t.pendingOn === null ? null : map(t.pendingOn),
    })),
  };
}

async function liveRows(h: ApiHarness): Promise<number> {
  const rows = await h.database.db.execute<{ live: string }>(
    sql`SELECT count(*)::text AS live FROM transactions WHERE user_id = ${h.userId}::uuid AND removed_at IS NULL`,
  );
  return Number(rows.rows[0]?.live);
}

async function rowsIn(h: ApiHarness, from: string, to: string): Promise<number> {
  const rows = await h.database.db.execute<{ n: string }>(
    sql`SELECT count(*)::text AS n FROM transactions WHERE user_id = ${h.userId}::uuid AND removed_at IS NULL AND effective_date BETWEEN ${from}::date AND ${to}::date`,
  );
  return Number(rows.rows[0]?.n);
}

describeWithDb('[slow] spending pace p95, over real HTTP (50k seed)', () => {
  let sparse: ApiHarness;
  let dense: ApiHarness;
  let sparseBase: string;
  let denseBase: string;

  beforeAll(async () => {
    const dataset = generateDemoData(1, { monthCount: 1264 });
    expect(dataset.transactions.length).toBe(EXPECTED_TRANSACTION_COUNT);
    sparse = await createApiHarness({ suite: 'wp109_pace_perf' });
    await loadSeedDataset(sparse.database.db, sparse.userId, dataset, { clock: systemClock });
    sparseBase = await sparse.listen();
    dense = await createApiHarness({ suite: 'wp109_pace_perf_dense' });
    await loadSeedDataset(dense.database.db, dense.userId, densify(dataset), {
      clock: systemClock,
    });
    denseBase = await dense.listen();
  }, 600_000);

  afterAll(async () => {
    await sparse?.close();
    await dense?.close();
  }, 120_000);

  it('the 50k corpus is in both databases, and the dense one has thousands of rows in the window read', async () => {
    expect(await liveRows(sparse)).toBe(EXPECTED_TRANSACTION_COUNT);
    expect(await liveRows(dense)).toBe(EXPECTED_TRANSACTION_COUNT);
    expect(await rowsIn(sparse, '2026-06-01', '2026-09-30')).toBeGreaterThan(50);
    expect(await rowsIn(dense, '2026-06-01', '2026-09-30')).toBeGreaterThan(6_000);
  }, 60_000);

  it('GET /reports/spending-pace holds p95 < 150 ms on the 50k seed, as generated and dense', async (ctx) => {
    const path = '/reports/spending-pace?month=2026-09';
    await settleLoad();
    const asGenerated = await measureGet(
      'GET /reports/spending-pace (50k seed, as generated)',
      sparseBase,
      path,
      `__Host-pfi_session=${sparse.fresh.accessToken}`,
      { warmups: 3, samples: 30 },
    );
    const denseMeasured = await measureGet(
      'GET /reports/spending-pace (50k seed, dense: ~8k rows read)',
      denseBase,
      path,
      `__Host-pfi_session=${dense.fresh.accessToken}`,
      { warmups: 3, samples: 30 },
    );
    assertWithinBudget(ctx, [
      { label: asGenerated.label, p95: asGenerated.p95, budgetMs: BUDGET_MS },
      { label: denseMeasured.label, p95: denseMeasured.p95, budgetMs: BUDGET_MS },
    ]);
  }, 300_000);
});
