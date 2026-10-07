// SPDX-License-Identifier: MIT
/**
 * [slow] The transaction list at 50,000 rows.
 *
 * The budget is **p95 < 200 ms for one page**, which is the number the list page
 * is designed around: a keyset scan of a partial index, not an `OFFSET` walk and
 * not a sort of the whole table. The interesting measurement is not the first
 * page — almost anything is fast at the top of an index — but a page four
 * thousand rows deep and a free-text search across three years, which is where an
 * `OFFSET`-based reader or a `tsvector` would fall over.
 *
 * Two assertions, deliberately:
 *
 *   * the **timing**, which is what a user experiences; and
 *   * the **plan**, via `EXPLAIN`, because a timing test on a warm 50k-row table
 *     can stay green through a sequential scan on a laptop with a fast disk and
 *     then fall off a cliff at 500k rows on a NUC. A plan assertion fails on the
 *     day the index stops being used, which is the day the mistake was made.
 *
 * The rows are bulk-inserted with `generate_series` rather than pushed through
 * `applyProviderTransactions`: this suite measures the *read* path, and spending
 * ninety seconds exercising the write path first would only make it likelier that
 * someone deletes the test for being slow.
 */
import { cpus, loadavg } from 'node:os';
import { DateOnly } from '@core/kernel';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listTransactions } from '../src/read.ts';
import {
  NO_DATABASE,
  ledgerDatabase,
  seedAccount,
  testClock,
  type TestDatabase,
} from './harness.ts';

const ROW_COUNT = 50_000;
const PAGE_SIZE = 50;
const BUDGET_MS = 200;

// perf-skip: NO_DATABASE — DATABASE_URL is unset, so there is no Postgres to bulk-insert the 50k rows into (CI's migration-test job has one)
describe.skipIf(NO_DATABASE)('[slow] transaction list at 50k rows', () => {
  let database: TestDatabase;
  let accountId: string;
  let secondAccountId: string;

  beforeAll(async () => {
    database = await ledgerDatabase('perf');
    const clock = testClock();
    accountId = await seedAccount(database, clock, { providerAccountId: 'pa-perf-1' });
    secondAccountId = await seedAccount(database, clock, { providerAccountId: 'pa-perf-2' });
    await bulkInsert(database, accountId, secondAccountId);
  }, 300_000);

  afterAll(async () => {
    await database.drop();
  });

  it('holds the p95 budget for the first page, a deep page, a filter and a search', async () => {
    const deepCursor = await walkTo(database, 80);
    const scenarios: { name: string; run: () => Promise<unknown> }[] = [
      {
        name: 'first page',
        run: () => listTransactions(database.db, { userId: database.userId, limit: PAGE_SIZE }),
      },
      {
        name: 'page ~4,000 rows deep',
        run: () =>
          listTransactions(database.db, {
            userId: database.userId,
            limit: PAGE_SIZE,
            cursor: deepCursor,
          }),
      },
      {
        name: 'account + date filter',
        run: () =>
          listTransactions(database.db, {
            userId: database.userId,
            limit: PAGE_SIZE,
            filters: {
              accountIds: [accountId],
              dateFrom: DateOnly.parse('2024-06-01'),
              dateTo: DateOnly.parse('2024-12-31'),
            },
          }),
      },
      {
        name: 'trigram search',
        run: () =>
          listTransactions(database.db, {
            userId: database.userId,
            limit: PAGE_SIZE,
            filters: { search: 'wholefds' },
          }),
      },
      {
        name: 'pending only',
        run: () =>
          listTransactions(database.db, {
            userId: database.userId,
            limit: PAGE_SIZE,
            filters: { pending: true },
          }),
      },
    ];

    const report: string[] = [];
    for (const scenario of scenarios) {
      const samples = await measure(scenario.run, 60);
      const p50 = percentile(samples, 0.5);
      const p95 = percentile(samples, 0.95);
      report.push(
        `    ${scenario.name.padEnd(24)} p50 ${p50.toFixed(1).padStart(6)} ms   p95 ${p95.toFixed(1).padStart(6)} ms`,
      );
      expect(p95, `${scenario.name} exceeded the ${String(BUDGET_MS)} ms budget`).toBeLessThan(
        BUDGET_MS,
      );
    }
    process.stdout.write(
      `\n  ${String(ROW_COUNT)} rows, page size ${String(PAGE_SIZE)}, load ` +
        `${loadavg()
          .map((x) => x.toFixed(2))
          .join(' ')} (${String(cpus().length)} cores):\n${report.join('\n')}\n`,
    );
  }, 300_000);

  it('reads the feed through an index, not a sequential scan', async () => {
    const cursor = await walkTo(database, 40);
    const decoded = Buffer.from(cursor ?? '', 'base64url')
      .toString('utf8')
      .split('|');
    const plan = await explain(
      database,
      sql`
        SELECT id FROM transactions
         WHERE user_id = ${database.userId}::uuid
           AND removed_at IS NULL
           AND (effective_date, id) < (${decoded[0] ?? ''}::date, ${decoded[1] ?? ''}::uuid)
         ORDER BY effective_date DESC, id DESC
         LIMIT ${PAGE_SIZE}
      `,
    );
    // `transactions_feed_idx` is `(user_id, effective_date DESC, id DESC) WHERE
    // removed_at IS NULL`: the row-wise comparison is what lets Postgres start
    // the scan *at* the cursor instead of filtering its way there.
    expect(plan).toContain('transactions_feed_idx');
    expect(plan).not.toContain('Seq Scan on transactions');
  }, 120_000);
});

async function bulkInsert(
  database: TestDatabase,
  accountId: string,
  secondAccountId: string,
): Promise<void> {
  // One statement, two tables: `transactions.current_fact_id` is NOT NULL and
  // references the fact, so the fact ids have to come back before the user-facing
  // rows can be written. A data-modifying CTE does both in one pass.
  await database.db.execute(sql`
    WITH facts AS (
      INSERT INTO transactions_provider (
        id, user_id, account_id, provider, provider_transaction_id,
        amount_minor, currency, posted_date, name, pending, raw,
        content_hash, revision, first_seen_at, last_seen_at
      )
      SELECT
        gen_random_uuid(),
        ${database.userId}::uuid,
        CASE WHEN i % 4 = 0 THEN ${secondAccountId}::uuid ELSE ${accountId}::uuid END,
        'perf',
        'perf-' || i,
        -(100 + (i % 20000)),
        'USD',
        DATE '2023-01-01' + (i % 1095),
        (ARRAY['Blue Bottle','Wholefds Mkt','Powells Books','Shell Oil','Costco Whse','Acme Corp Payroll'])[1 + (i % 6)] || ' ' || i,
        i % 97 = 0,
        '{}'::jsonb,
        md5(i::text),
        1,
        now(),
        now()
      FROM generate_series(1, ${ROW_COUNT}) AS i
      RETURNING id, user_id, account_id, amount_minor, currency, posted_date, name, pending
    )
    INSERT INTO transactions (
      id, user_id, account_id, current_fact_id,
      effective_date, effective_amount_minor, effective_currency, effective_name, pending
    )
    SELECT gen_random_uuid(), user_id, account_id, id, posted_date, amount_minor, currency, name, pending
      FROM facts
  `);
  // Without this the planner is working from an empty-table estimate, and the
  // first measurement would be of a plan no production database would ever use.
  await database.db.execute(sql`ANALYZE transactions`);
}

/** Page forward `pages` times to get a cursor that is genuinely deep. */
async function walkTo(database: TestDatabase, pages: number): Promise<string | null> {
  let cursor: string | null = null;
  for (let page = 0; page < pages; page += 1) {
    const result: Awaited<ReturnType<typeof listTransactions>> = await listTransactions(
      database.db,
      { userId: database.userId, limit: PAGE_SIZE, cursor },
    );
    if (result.nextCursor === null) break;
    cursor = result.nextCursor;
  }
  return cursor;
}

async function measure(run: () => Promise<unknown>, iterations: number): Promise<number[]> {
  // Warm the plan cache and the buffer pool; the first call of anything measures
  // the cold path, which is a different question from "is the query fast".
  await run();
  const samples: number[] = [];
  for (let index = 0; index < iterations; index += 1) {
    const started = performance.now();
    await run();
    samples.push(performance.now() - started);
  }
  return samples;
}

function percentile(samples: readonly number[], fraction: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * fraction));
  return sorted[index] ?? 0;
}

async function explain(database: TestDatabase, query: ReturnType<typeof sql>): Promise<string> {
  const result = await database.db.execute<{ 'QUERY PLAN': string }>(
    sql`EXPLAIN (ANALYZE false, COSTS false) ${query}`,
  );
  return result.rows.map((row) => row['QUERY PLAN']).join('\n');
}
