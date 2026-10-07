// SPDX-License-Identifier: MIT
/**
 * WP 9.9 (CF-12) — the 50k-row transaction list, over real HTTP.
 *
 * §3.4's first budget: "Transactions list p95 under 200 ms at 50k rows." Until
 * this file the number was measured only in-process
 * (`packages/contexts/ledger/test/perf.test.ts`: `listTransactions` over
 * `generate_series` rows), while the reports, investments and net-worth budgets
 * all had an HTTP-level test. What a browser waits for is Fastify's routing, the
 * session guard, the Zod response serialiser, the `count` and `sum` the first
 * page adds for its summary, and a TCP round trip — none of which an in-process
 * call touches. The in-process test and its `EXPLAIN` assertion stay; this is
 * the missing half.
 *
 * ## The corpus
 *
 * `generateDemoData(1, { monthCount: 1264 })` — 50,040 transactions across six
 * accounts and 32 merchants — loaded through `loadSeedDataset`, the real write
 * path (`applyProviderTransactions`, merchant resolution, transfer pairing,
 * refund hints), exactly as `packages/contexts/ledger/test/growth-bound.test.ts`
 * does. Not `generate_series`: that is how the in-process test gets its rows,
 * and it skips every write-path side effect (merchant rows, transfer links) the
 * list query joins against.
 *
 * `PERF_TXN_MONTHS` (default 1264) scales it: 6,320 months is the 250k-row
 * corpus 09 §5.3 names and §6 Q12 says is **measured and recorded, not gated**.
 * Any scale other than the default prints its numbers and asserts only the
 * row-count sanity check.
 *
 * ## The four scenarios, each its own budget
 *
 * | Scenario | Request |
 * |---|---|
 * | first page | `GET /transactions?limit=50` (with the summary the first page carries) |
 * | a deep keyset page | the cursor ~4,000 rows down, reached by walking the real cursor over HTTP |
 * | a filter | an account and a year (`accountIds`, `from`, `to`), first page with its summary |
 * | a search | `q=` on a common and on a rare merchant word (trigram) |
 *
 * Each is sampled 40 times after three warm-ups, and the p95 asserted against
 * 200 ms through `assertWithinBudget` (a reading over budget at a host load of 3
 * or more is a named skip, not a red: see `perf-support.ts`).
 *
 * ## Measuring, not asserting, the planner
 *
 * `ANALYZE` runs after the load. A real install gets the same from autovacuum
 * within about a minute of a bulk write; without it the first reading is of an
 * empty-table plan no database would keep.
 */
import { systemClock } from '@core/kernel';
import { generateDemoData } from '@core/seed';
import { loadSeedDataset } from '@ctx/ledger';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApiHarness, NO_DATABASE, type ApiHarness } from '../helpers/api-harness.ts';
import {
  assertWithinBudget,
  describeLoad,
  measureGet,
  recordFigure,
  settleLoad,
  timeGet,
  type Measured,
} from './perf-support.ts';

// perf-skip: NO_DATABASE — DATABASE_URL is unset, so there is no Postgres to load the corpus into (CI's migration-test job has one)
// perf-skip: ON_SHARED_RUNNER — a GitHub shared runner is not the target hardware (09 §6 Q1); the corpus still loads and the row-count test still runs there, the timing assertions do not
// perf-skip: HOST_LOADED — an over-budget reading at a 1-minute load of 3 or more is not believed (09 §3 rule 4); in-budget readings pass at any load
const describeWithDb = describe.skipIf(NO_DATABASE);
const ON_SHARED_RUNNER = process.env['CI'] !== undefined;

/** The 50k corpus: `generateDemoData(1, { monthCount: 1264 }).transactions.length`. */
const GATED_MONTHS = 1264;
const GATED_ROWS = 50_040;
const MONTHS = Number(process.env['PERF_TXN_MONTHS'] ?? GATED_MONTHS);
const GATED = MONTHS === GATED_MONTHS;
const BUDGET_MS = 200;
const PAGE_SIZE = 50;
const DEEP_PAGES = 80;

describeWithDb(
  `[slow] transactions list p95, over real HTTP (${GATED ? '50k, gated' : `${String(MONTHS)} months, informational`})`,
  () => {
    let h: ApiHarness;
    let base: string;
    let cookie: string;
    let datasetRows = 0;
    let loadSeconds = 0;
    let deepCursor = '';
    let accountId = '';
    const measured = new Map<string, Measured>();

    beforeAll(async () => {
      h = await createApiHarness({ suite: 'wp99-txn-http' });
      const dataset = generateDemoData(1, { monthCount: MONTHS });
      datasetRows = dataset.transactions.length;
      if (GATED) expect(datasetRows).toBe(GATED_ROWS);

      const started = performance.now();
      await loadSeedDataset(h.database.db, h.userId, dataset, { clock: systemClock });
      loadSeconds = (performance.now() - started) / 1_000;
      await h.database.db.execute(sql`ANALYZE transactions`);
      await h.database.db.execute(sql`ANALYZE transactions_provider`);
      recordFigure('transactions corpus load (loadSeedDataset)', {
        rows: datasetRows,
        seconds: Number(loadSeconds.toFixed(1)),
      });

      const accounts = await h.database.db.execute<{ id: string }>(
        sql`SELECT id FROM accounts WHERE user_id = ${h.userId}::uuid ORDER BY id LIMIT 1`,
      );
      accountId = accounts.rows[0]?.id ?? '';

      base = await h.listen();
      cookie = `__Host-pfi_session=${h.fresh.accessToken}`;

      // Walk the real cursor, over HTTP, ~4,000 rows down: the page an
      // OFFSET-based reader would be slow at.
      let cursor: string | null = null;
      for (let page = 0; page < DEEP_PAGES; page += 1) {
        const query = cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`;
        const response = await fetch(`${base}/transactions?limit=${String(PAGE_SIZE)}${query}`, {
          headers: { cookie },
        });
        const body = (await response.json()) as { nextCursor: string | null };
        if (body.nextCursor === null) break;
        cursor = body.nextCursor;
      }
      deepCursor = cursor ?? '';
      // The corpus load lifts the load average for a minute or two on its own.
      await settleLoad();
    }, 1_800_000);

    afterAll(async () => {
      await h?.close();
    }, 120_000);

    // ---- the row-count sanity check: never skips, for any reason ----------
    it('the corpus is actually in the database (a perf number over an empty table is a lie)', async () => {
      const rows = await h.database.db.execute<{ live: string; facts: string; merchants: string }>(
        sql`SELECT
              (SELECT count(*) FROM transactions WHERE user_id = ${h.userId}::uuid AND removed_at IS NULL)::text AS live,
              (SELECT count(*) FROM transactions_provider WHERE user_id = ${h.userId}::uuid)::text AS facts,
              (SELECT count(*) FROM merchants WHERE user_id = ${h.userId}::uuid)::text AS merchants`,
      );
      expect(Number(rows.rows[0]?.live)).toBe(datasetRows);
      expect(Number(rows.rows[0]?.facts)).toBe(datasetRows);
      expect(Number(rows.rows[0]?.merchants)).toBeGreaterThan(20);
      if (GATED) expect(datasetRows).toBe(GATED_ROWS);

      // The route sees the rows too: the first page carries a non-empty page,
      // a summary, and a continuation cursor, and the deep cursor really is deep.
      const response = await fetch(`${base}/transactions?limit=${String(PAGE_SIZE)}`, {
        headers: { cookie },
      });
      const body = (await response.json()) as {
        items: unknown[];
        nextCursor: string | null;
        summary: { count: number } | null;
      };
      expect(body.items).toHaveLength(PAGE_SIZE);
      expect(body.nextCursor).not.toBeNull();
      expect(body.summary?.count ?? 0).toBeGreaterThan(datasetRows / 2);
      expect(deepCursor.length).toBeGreaterThan(0);
      expect(accountId.length).toBeGreaterThan(0);
      process.stdout.write(
        `perf corpus: ${String(datasetRows)} rows, summary.count=${String(body.summary?.count)} ${describeLoad()}\n`,
      );
    }, 60_000);

    // ---- the four budgets --------------------------------------------------
    const scenarios: readonly {
      readonly title: string;
      readonly label: string;
      readonly path: () => string;
    }[] = [
      {
        title: 'the first page (with its summary) holds p95 < 200 ms',
        label: 'GET /transactions first page',
        path: () => `/transactions?limit=${String(PAGE_SIZE)}`,
      },
      {
        title: 'a page ~4,000 rows deep holds p95 < 200 ms',
        label: 'GET /transactions deep keyset page',
        path: () =>
          `/transactions?limit=${String(PAGE_SIZE)}&cursor=${encodeURIComponent(deepCursor)}`,
      },
      {
        title: 'an account + date filter holds p95 < 200 ms',
        label: 'GET /transactions filter (account + year)',
        path: () =>
          `/transactions?limit=${String(PAGE_SIZE)}&accountIds=${accountId}` +
          '&from=2025-01-01&to=2025-12-31',
      },
      {
        title: 'a trigram search on a common merchant word holds p95 < 200 ms',
        label: 'GET /transactions search (common: coffee)',
        path: () => `/transactions?limit=${String(PAGE_SIZE)}&q=coffee`,
      },
      {
        title: 'a trigram search on a rare merchant word holds p95 < 200 ms',
        label: 'GET /transactions search (rare: planet fitness)',
        path: () => `/transactions?limit=${String(PAGE_SIZE)}&q=${encodeURIComponent('planet')}`,
      },
    ];

    for (const scenario of scenarios) {
      it.skipIf(ON_SHARED_RUNNER)(
        scenario.title,
        async (ctx) => {
          // Pointless to time a path that answers nothing: the page must be full
          // (or, for the rare search, non-empty) before its latency means anything.
          const probe = await fetch(`${base}${scenario.path()}`, { headers: { cookie } });
          const body = (await probe.json()) as { items: unknown[] };
          expect(body.items.length, `${scenario.label} returned no rows`).toBeGreaterThan(0);

          const result = await measureGet(
            `${scenario.label} [${String(datasetRows)} rows]`,
            base,
            scenario.path(),
            cookie,
          );
          measured.set(scenario.label, result);
          if (!GATED) return; // 250k is measured and recorded, not gated (§6 Q12)
          assertWithinBudget(ctx, {
            label: scenario.label,
            p95: result.p95,
            budgetMs: BUDGET_MS,
          });
        },
        120_000,
      );
    }

    it('records the worst of the four as the headline number', () => {
      const all = [...measured.values()];
      if (all.length === 0) return;
      const worst = all.reduce((a, b) => (b.p95 > a.p95 ? b : a));
      recordFigure('transactions list worst scenario p95', {
        rows: datasetRows,
        scenario: worst.label,
        p95: Number(worst.p95.toFixed(1)),
        gated: GATED,
      });
      expect(all.length).toBe(scenarios.length);
    });

    it('a request that fails is reported as a failure, not as a fast reading', async () => {
      // `timeGet` throws on a non-2xx: a 401 or 500 is the fastest response a
      // route ever gives, and a perf test that timed one would pass.
      await expect(timeGet(base, '/transactions?limit=50', 'x=y')).rejects.toThrow(/401/);
    }, 30_000);
  },
);
