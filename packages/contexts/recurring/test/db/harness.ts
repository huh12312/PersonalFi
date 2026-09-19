// SPDX-License-Identifier: MIT
/**
 * The `@ctx/recurring` database-test harness.
 *
 * `@core/testkit` and `@core/seed` are dev-only dependencies of this context,
 * allowed by the `recurring` entry in `scripts/eslint-boundaries.js` rather than
 * by an `eslint-disable` here, so the looseness lives in the policy instead of
 * at the top of a file. No file under `src/` imports either of them.
 *
 * ## Why the seed is loaded into a port fake and not into `@ctx/ledger`
 *
 * The obvious harness would write the seed through `@ctx/ledger`'s real writer
 * and read it back through the real adapter. It is not available: the boundary
 * lint denies `@ctx/recurring` → `@ctx/ledger` **unconditionally**, tests
 * included, and that is the right call — a test-only exception is how a context
 * boundary becomes advisory. So `@core/seed` produces the household, this file
 * maps its rows onto `RecurringTransaction`, and `inMemoryLedgerPort` (which
 * lives in `src/`, not here, so a reviewer re-running these proofs cannot
 * accidentally re-implement a friendlier fake) serves them.
 *
 * What that costs: these suites do not prove `@ctx/ledger`'s `listTransactions`
 * still satisfies `LedgerPort`. That check belongs at the composition root,
 * where the adapter is written; the exact lines `apps/api/src/domain.ts` needs
 * are in `docs/evidence/phase-2/wp2.3-recurring.md` §6, and the orchestrator
 * compiling them is the check.
 *
 * What it buys: every claim these suites make — a confirmed series survives, a
 * rejection is permanent, `merchants` is untouched, a replay is identical — is
 * a claim about *this* context's writes, with nothing else in the loop that can
 * fail and muddy the result.
 *
 * ## `merchants` is seeded here by raw SQL, on purpose
 *
 * `no-merchant-creation.test.ts` needs real rows in a table this package may
 * never write to. `scripts/check-schema-ownership.ts` exempts `test/`
 * directories for exactly this reason (and still enforces table *ownership*),
 * so the D25 guard can be asserted against a populated table rather than an
 * empty one — "zero merchants before, zero after" would prove nothing.
 */
import { DateOnly, Money, fixedClock, newId, type Clock } from '@core/kernel';
import { silentLogger, type ConsumerContext, type EventEnvelope } from '@core/platform';
import { generateDemoData, type SeedDataset, type SeedTransaction } from '@core/seed';
import { ADMIN_URL, createTestDatabase, type TestDatabase } from '@core/testkit';
import { sql } from 'drizzle-orm';
import {
  inMemoryLedgerPort,
  type LedgerPort,
  type RecurringTransaction,
} from '../../src/ledger-port.ts';
import type { RecurringContext } from '../../src/store.ts';

export { ADMIN_URL, inMemoryLedgerPort, type LedgerPort, type TestDatabase };

/** `describe.skipIf(NO_DATABASE)` — the guard every `*-db` suite uses. */
export const NO_DATABASE = ADMIN_URL === undefined;

/**
 * `America/New_York`, and every suite uses it.
 *
 * Detection reads "today" through `todayIn(clock, timeZone)` and never the
 * container's `TZ`. Running every suite in a zone that is not UTC is what keeps
 * a "works on my machine at 14:00" bug from hiding: `EPOCH` below is 02:00 UTC,
 * which is the *previous* day in this zone, so any code that reached for a UTC
 * date would produce a visibly different answer.
 */
export const ZONE = 'America/New_York';

/** Fixed, so a failure message reads the same twice. Inside the seed window. */
export const EPOCH = '2026-06-15T02:00:00.000Z';

/**
 * `todayIn(clockAt(EPOCH), ZONE)` — the 14th, not the 15th.
 *
 * Spelled out as a constant because getting it wrong is silent: `EPOCH` is
 * 02:00 UTC, which is 22:00 on the *previous* day in New York, so a suite that
 * assumed the UTC date would feed the engine a day of transactions from its own
 * future and compare against a forecast window one day out of step. That is the
 * bug this fixture is shaped to catch rather than to hide.
 */
export const TODAY = DateOnly.parse('2026-06-14');

/** Later on the same *local* day. A re-run here must change nothing at all. */
export const LATER_SAME_DAY = '2026-06-15T03:55:00.000Z';
export const CORRELATION_ID = '01920000-0000-7000-8000-0000000000c3';
export const USD = 'USD';

/** The seed window. Two full years, so an ANNUAL stream has two occurrences. */
export const SEED_START_MONTH = DateOnly.parse('2025-01-01');
export const SEED_MONTHS = 24;
export const SEED_NUMBER = 20_260_615;

export function clockAt(instant: string = EPOCH): Clock {
  return fixedClock(instant);
}

export function contextFor(userId: string, clock: Clock = clockAt()): RecurringContext {
  return { userId, clock, correlationId: CORRELATION_ID, causationId: null };
}

/**
 * The scratch database a suite gets. One per file.
 *
 * `recurring-db` runs with `fileParallelism: false`, but a shared database
 * would still make every suite depend on the order the others ran in — and
 * `createTestDatabase` drops and recreates, so the second suite to start would
 * delete the first one's evidence mid-run.
 */
export async function recurringDatabase(suite: string): Promise<TestDatabase> {
  return createTestDatabase(`personalfi_wp_recur_${suite}`);
}

export function seedDataset(seed: number = SEED_NUMBER): SeedDataset {
  return generateDemoData(seed, {
    startMonth: SEED_START_MONTH,
    monthCount: SEED_MONTHS,
    timezone: ZONE,
    baseCurrency: USD,
  });
}

/**
 * One `SeedTransaction` as this context is allowed to see it.
 *
 * Note what does not cross: `descriptorRaw`, which the seed generator goes to
 * some trouble to make realistic. Detection has no field to put it in (D25) and
 * WP 2.2's `no-merchant-writes.test.ts` runs the engine behind a `Proxy` that
 * throws if it reads a key outside the contract, so adding it here would fail a
 * test that already exists.
 */
export function rowOf(transaction: SeedTransaction): RecurringTransaction {
  return {
    id: transaction.id,
    accountId: transaction.accountId,
    merchantId: transaction.merchantId,
    amount: Money.fromJSON(transaction.amount),
    // The ledger's budget date is the posted date; a pending row carries the
    // date it will post on, which is what the engine anchors its schedule to.
    date: transaction.postedOn,
    pending: transaction.status === 'pending',
    isTransfer: transaction.kind === 'transfer',
  };
}

/** Every seed transaction that had posted by `asOf`. The history a pass sees. */
export function rowsAsOf(dataset: SeedDataset, asOf: DateOnly): RecurringTransaction[] {
  return dataset.transactions
    .filter((transaction) => !DateOnly.isAfter(transaction.postedOn, asOf))
    .map(rowOf);
}

/**
 * Everything the generator *will* bill on a recurring schedule in `(after, until]`.
 *
 * Restricted to transactions the generator itself labelled as belonging to a
 * recurring series (`SeedLabels.recurringSeries[].transactionIds`), and that
 * restriction is the whole point rather than a convenience. A forecast claims
 * "this payee will bill you again"; it has never claimed to know when somebody
 * will next buy groceries. The seed's merchants include several that host both
 * — a labelled monthly series *and* discretionary purchases at the same payee —
 * so ground truth keyed on the merchant alone would grade the forecast against
 * shopping trips it never predicted and was never meant to.
 */
export function futureCharges(
  dataset: SeedDataset,
  after: DateOnly,
  until: DateOnly,
): readonly SeedTransaction[] {
  const scheduled = new Set<string>(
    dataset.labels.recurringSeries.flatMap((series) => [...series.transactionIds]),
  );
  return dataset.transactions.filter(
    (transaction) =>
      scheduled.has(transaction.id) &&
      DateOnly.isAfter(transaction.postedOn, after) &&
      !DateOnly.isAfter(transaction.postedOn, until) &&
      transaction.status === 'posted' &&
      transaction.merchantId !== null &&
      transaction.kind !== 'transfer',
  );
}

/** The labelled series a transaction belongs to, for a failure message worth reading. */
export function seedSeriesOf(
  dataset: SeedDataset,
  transactionId: string,
): { readonly cadence: string; readonly initialAmount: string } | null {
  for (const series of dataset.labels.recurringSeries) {
    if (series.transactionIds.includes(transactionId)) {
      return { cadence: series.cadence, initialAmount: series.initialAmount };
    }
  }
  return null;
}

/**
 * A hand-built monthly stream, ending on the most recent occurrence.
 *
 * The seed generator is the right instrument for the forecast proof, where the
 * point is realism. It is the wrong one for the lifecycle proofs, where the
 * point is a stream whose confidence band is known exactly: `count = 2` lands
 * at 0.70 (07 §2.4's `EARLY_DETECTION` cap) and therefore in the candidate
 * band, and `count >= 3` on a flawless schedule lands above 0.80 and therefore
 * auto-confirms. Both numbers are asserted in `src/confidence.test.ts`; the
 * suites below depend on which side of the 0.80 bar a stream falls, so they
 * build their own rather than hoping the seed obliges.
 */
export function monthlyRows(input: {
  readonly merchantId: string;
  readonly accountId: string;
  readonly lastOn: DateOnly;
  readonly count: number;
  readonly minor: bigint;
}): RecurringTransaction[] {
  const rows: RecurringTransaction[] = [];
  for (let index = 0; index < input.count; index += 1) {
    rows.push({
      id: newId(),
      accountId: input.accountId,
      merchantId: input.merchantId,
      amount: Money.of(input.minor, USD),
      date: DateOnly.addMonths(input.lastOn, -(input.count - 1 - index)),
      pending: false,
      isTransfer: false,
    });
  }
  return rows;
}

/**
 * Put the seed's merchants into `merchants`, by raw SQL.
 *
 * The only write to another context's table in this package, and it is here so
 * that `'a full detection pass leaves merchants row count and ids unchanged'`
 * has something to be unchanged *about*.
 */
export async function seedMerchants(
  database: TestDatabase,
  dataset: SeedDataset,
): Promise<readonly string[]> {
  for (const merchant of dataset.merchants) {
    await database.db.execute(sql`
      INSERT INTO merchants (id, user_id, normalized_key, display_name)
      VALUES (
        ${merchant.id}::uuid,
        ${database.userId}::uuid,
        ${merchant.canonicalName.toLowerCase()}::text,
        ${merchant.canonicalName}::text
      )
      ON CONFLICT (id) DO NOTHING
    `);
  }
  return [...dataset.merchants.map((merchant) => merchant.id)].sort();
}

export interface MerchantSnapshot {
  readonly count: number;
  readonly ids: readonly string[];
}

/** The D25 assertion's two halves: how many, and exactly which. */
export async function merchantSnapshot(database: TestDatabase): Promise<MerchantSnapshot> {
  const result = await database.db.execute<{ id: string }>(
    sql`SELECT id::text AS id FROM merchants ORDER BY id`,
  );
  const ids = result.rows.map((row) => row.id);
  return { count: ids.length, ids };
}

/** The envelope a consumer is handed. Shaped like the pump's, built by hand. */
export function upsertedEnvelope(input: {
  readonly userId: string;
  readonly accountId: string;
  readonly transactionIds: readonly string[];
  readonly id?: string;
}): EventEnvelope {
  return {
    id: input.id ?? newId(),
    seq: 1n,
    userId: input.userId,
    aggregateType: 'account',
    aggregateId: input.accountId,
    eventType: 'ledger.TransactionsUpserted',
    eventVersion: 1,
    payload: {
      accountId: input.accountId,
      addedIds: [...input.transactionIds],
      updatedIds: [],
      removedIds: [],
      dateFrom: null,
      dateTo: null,
      count: input.transactionIds.length,
    },
    occurredAt: new Date(EPOCH),
    recordedAt: new Date(EPOCH),
    correlationId: CORRELATION_ID,
    causationId: null,
    redaction: 'none',
  } as EventEnvelope;
}

export function consumerContext(clock: Clock = clockAt()): ConsumerContext {
  return {
    // The consumer opens its own transaction through the database handle it was
    // built with and never writes through `tx`; the pump's own suites cover the
    // receipt and the offset advance, which is what `tx` is for.
    tx: { execute: () => Promise.resolve({ rows: [] }) },
    logger: silentLogger,
    clock,
  };
}

/** Every row of one table, ordered, for a whole-row comparison across two runs. */
export async function dumpTable(
  database: TestDatabase,
  table: string,
  orderBy = 'id',
): Promise<readonly Record<string, unknown>[]> {
  const result = await database.db.execute<Record<string, unknown>>(
    sql.raw(`SELECT * FROM ${table} ORDER BY ${orderBy}`),
  );
  // `bigint` and `Date` do not survive `JSON.stringify`, and these dumps are
  // compared with `toEqual` on the parsed form: normalising here means a
  // difference in a `BIGINT` column is a visible difference and not a thrown
  // "Do not know how to serialize a BigInt".
  return result.rows.map((row) =>
    Object.fromEntries(
      Object.entries(row).map(([key, value]) => [
        key,
        typeof value === 'bigint'
          ? value.toString()
          : value instanceof Date
            ? value.toISOString()
            : value,
      ]),
    ),
  );
}

export async function countRows(database: TestDatabase, table: string): Promise<number> {
  const result = await database.db.execute<{ count: string }>(
    sql.raw(`SELECT count(*)::text AS count FROM ${table}`),
  );
  return Number(result.rows[0]?.count ?? '0');
}
