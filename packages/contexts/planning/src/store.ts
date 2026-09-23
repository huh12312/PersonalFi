// SPDX-License-Identifier: MIT
/**
 * The sole writer of `net_worth_daily` (08 §1.3 #8).
 *
 * Raw parameterised SQL rather than Drizzle's query builder for the three
 * statements that carry a rule, because each of them depends on something the
 * builder cannot express: `ON CONFLICT ... WHERE sealed_at IS NULL` against the
 * partial unique index, a `WHERE sealed_at IS NULL` guard whose *row count* is
 * the check, and a `SELECT DISTINCT ON` over the revision ladder. The Drizzle
 * definition in `schema/index.ts` still exists — it is what
 * `lint:schema-ownership` reads to see the claim.
 *
 * ## Three write paths, and only three
 *
 *   * `upsertOpenDay` — today. Idempotent on `(user_id, as_of_date)` among
 *     *unsealed* rows, so recomputing an open day fifty times leaves one row.
 *   * `sealDay` — the one-way door. Guarded on `sealed_at IS NULL`; a zero row
 *     count is a `SealedRowImmutable`, not a silent no-op.
 *   * `writeCorrection` — a *new revision*. It never touches the row it
 *     supersedes, which is what makes the byte-diff test meaningful.
 *
 * There is deliberately no `deleteDay` and no unguarded `update`. The only way a
 * row leaves this table is the `users` ON DELETE CASCADE, which outranks "a
 * sealed row is forever" for the reason 0014_lots.sql gives.
 */
import type { Database } from '@core/db';
import { newId, type Clock } from '@core/kernel';
import type { Executor } from '@core/platform';
import { sql, type SQL } from 'drizzle-orm';
import type { NetWorthSnapshot } from './net-worth.ts';
import { SealedRowImmutable } from './seal.ts';

/**
 * A `Pick` rather than the full `Database`, so a Drizzle transaction handle and
 * the pool-backed database both satisfy it structurally. Every write path takes
 * one, because computing a day and appending `NetWorthSnapshotTaken` must be one
 * transaction or none: an event announcing a snapshot that then rolled back has
 * told a notification rule something untrue.
 */
export type PlanningExecutor = Pick<
  Database,
  'select' | 'insert' | 'update' | 'delete' | 'execute' | 'with'
>;

export type PlanningDatabase = Database;

/**
 * Adapt a Drizzle handle to the platform's narrow `Executor`, for `appendEvent`.
 *
 * The identical one-cast-in-one-place `@ctx/ledger`, `@ctx/budgeting` and
 * `@ctx/connections` each make: Drizzle's `execute()` returns `PgRaw`, a lazily
 * executed thenable, where `Executor` declares a `Promise`. Interchangeable at
 * runtime, not assignable at compile time. Doing it here keeps the handle that
 * writes the row and the handle that appends the event the same one.
 */
export function platformOf(executor: PlanningExecutor): Executor {
  return {
    execute: <TRow extends Record<string, unknown>>(query: SQL) =>
      executor.execute(query) as unknown as Promise<{ rows: TRow[] }>,
  };
}

/** One stored row, in the shape this context reasons about. */
export interface NetWorthRow {
  readonly id: string;
  readonly asOfDate: string;
  readonly revision: number;
  readonly baseCurrency: string;
  readonly assetsMinor: bigint;
  readonly liabilitiesMinor: bigint;
  readonly netWorthMinor: bigint;
  readonly liquidMinor: bigint;
  readonly investableMinor: bigint;
  readonly onBudgetMinor: bigint;
  readonly source: string;
  readonly stalePrice: boolean;
  readonly dirty: boolean;
  readonly sealedAt: Date | null;
}

interface RawRow extends Record<string, unknown> {
  id: string;
  as_of_date: string;
  revision: number;
  base_currency: string;
  assets_minor: bigint | string;
  liabilities_minor: bigint | string;
  net_worth_minor: bigint | string;
  liquid_minor: bigint | string;
  investable_minor: bigint | string;
  on_budget_minor: bigint | string;
  source: string;
  stale_price: boolean;
  dirty: boolean;
  sealed_at: Date | string | null;
}

function rowOf(raw: RawRow): NetWorthRow {
  return {
    id: raw.id,
    // `date` comes back as `YYYY-MM-DD` with the type parsers installed; the
    // slice is belt and braces for a driver that hands back an instant.
    asOfDate: String(raw.as_of_date).slice(0, 10),
    revision: Number(raw.revision),
    baseCurrency: raw.base_currency.trim(),
    assetsMinor: BigInt(raw.assets_minor),
    liabilitiesMinor: BigInt(raw.liabilities_minor),
    netWorthMinor: BigInt(raw.net_worth_minor),
    liquidMinor: BigInt(raw.liquid_minor),
    investableMinor: BigInt(raw.investable_minor),
    onBudgetMinor: BigInt(raw.on_budget_minor),
    source: raw.source,
    stalePrice: raw.stale_price,
    dirty: raw.dirty,
    sealedAt: raw.sealed_at === null ? null : new Date(raw.sealed_at),
  };
}

const RETURNING = sql`
  RETURNING id, as_of_date, revision, base_currency, assets_minor, liabilities_minor,
            net_worth_minor, liquid_minor, investable_minor, on_budget_minor,
            source, stale_price, dirty, sealed_at
`;

/**
 * Write (or rewrite) the open day.
 *
 * `ON CONFLICT (user_id, as_of_date) WHERE sealed_at IS NULL` names the partial
 * unique index `net_worth_daily_one_open_day_idx` by its predicate, which is how
 * Postgres selects a partial index as an arbiter. The consequence worth stating:
 * if the day is already **sealed** there is no conflicting row for the arbiter
 * to find, so this INSERTs — and the `(user_id, as_of_date, revision)` unique
 * index then refuses it at revision 1. A recompute of a sealed day therefore
 * fails loudly here rather than silently doing nothing, and `writeCorrection` is
 * the path that exists for it.
 *
 * `dirty` is reset to `false` on every write: the row now reflects everything
 * known at `computed_at`, which is precisely what the flag means.
 */
export async function upsertOpenDay(
  executor: PlanningExecutor,
  input: {
    readonly userId: string;
    readonly snapshot: NetWorthSnapshot;
    readonly clock: Clock;
  },
): Promise<NetWorthRow> {
  const { snapshot } = input;
  const now = input.clock.now();
  const result = await executor.execute<RawRow>(sql`
    INSERT INTO net_worth_daily (
      id, user_id, as_of_date, revision, base_currency,
      assets_minor, liabilities_minor, net_worth_minor,
      liquid_minor, investable_minor, on_budget_minor,
      breakdown, source, stale_price, accounts_counted, accounts_unvalued,
      dirty, sealed_at, computed_at, created_at, updated_at
    ) VALUES (
      ${newId()}::uuid, ${input.userId}::uuid, ${snapshot.asOfDate}::date, 1, ${snapshot.baseCurrency},
      ${snapshot.assetsMinor}, ${snapshot.liabilitiesMinor}, ${snapshot.netWorthMinor},
      ${snapshot.liquidMinor}, ${snapshot.investableMinor}, ${snapshot.onBudgetMinor},
      ${JSON.stringify(snapshot.breakdown)}::jsonb, ${snapshot.source}, ${snapshot.stalePrice},
      ${snapshot.accountsCounted}, ${snapshot.accountsUnvalued},
      false, NULL, ${now.toISOString()}::timestamptz,
      ${now.toISOString()}::timestamptz, ${now.toISOString()}::timestamptz
    )
    ON CONFLICT (user_id, as_of_date) WHERE sealed_at IS NULL DO UPDATE SET
      base_currency     = EXCLUDED.base_currency,
      assets_minor      = EXCLUDED.assets_minor,
      liabilities_minor = EXCLUDED.liabilities_minor,
      net_worth_minor   = EXCLUDED.net_worth_minor,
      liquid_minor      = EXCLUDED.liquid_minor,
      investable_minor  = EXCLUDED.investable_minor,
      on_budget_minor   = EXCLUDED.on_budget_minor,
      breakdown         = EXCLUDED.breakdown,
      source            = EXCLUDED.source,
      stale_price       = EXCLUDED.stale_price,
      accounts_counted  = EXCLUDED.accounts_counted,
      accounts_unvalued = EXCLUDED.accounts_unvalued,
      dirty             = false,
      computed_at       = EXCLUDED.computed_at,
      updated_at        = EXCLUDED.updated_at
    ${RETURNING}
  `);
  const raw = result.rows[0];
  if (raw === undefined) {
    throw new Error(`net_worth_daily upsert for ${snapshot.asOfDate} returned no row`);
  }
  return rowOf(raw);
}

/**
 * Close the day. One way, once.
 *
 * The `AND sealed_at IS NULL` is guard 3 of `src/seal.ts`'s three: it makes a
 * second seal a zero-row UPDATE rather than a trigger exception, which lets the
 * caller distinguish "already sealed" from "a bug". The BEFORE UPDATE trigger is
 * still underneath it and is what catches a writer that drops this clause — the
 * §5 sabotage does exactly that and asserts the constraint's name.
 */
export async function sealDay(
  executor: PlanningExecutor,
  input: { readonly userId: string; readonly asOfDate: string; readonly clock: Clock },
): Promise<NetWorthRow> {
  const now = input.clock.now();
  const result = await executor.execute<RawRow>(sql`
    UPDATE net_worth_daily
       SET sealed_at  = ${now.toISOString()}::timestamptz,
           dirty      = false,
           updated_at = ${now.toISOString()}::timestamptz
     WHERE user_id = ${input.userId}::uuid
       AND as_of_date = ${input.asOfDate}::date
       AND sealed_at IS NULL
    ${RETURNING}
  `);
  const raw = result.rows[0];
  if (raw === undefined) {
    // Either the day was already sealed or it has no row at all. Both are
    // refusals to write history, and the caller decides which it cares about.
    const current = await currentRow(executor, input.userId, input.asOfDate);
    throw new SealedRowImmutable(input.asOfDate, current?.revision ?? 0);
  }
  return rowOf(raw);
}

/**
 * A correction: the next revision of a day, carrying its provenance.
 *
 * Note what is absent — there is no UPDATE here at all. The sealed row it
 * supersedes is not written to, is still readable, and still says what the app
 * displayed on the day it was current. That is the difference between a
 * correction and a rewrite, and it is why `'a past date is byte-identical after
 * a second snapshot run'` can compare bytes rather than compare a number to
 * itself.
 *
 * The new revision is inserted **already sealed**: a correction to a closed day
 * is not an invitation to keep editing it.
 */
export async function writeCorrection(
  executor: PlanningExecutor,
  input: {
    readonly userId: string;
    readonly snapshot: NetWorthSnapshot;
    readonly reason: string;
    readonly clock: Clock;
  },
): Promise<NetWorthRow> {
  const { snapshot } = input;
  const superseded = await currentRow(executor, input.userId, snapshot.asOfDate);
  if (superseded === null) {
    throw new Error(
      `cannot correct ${snapshot.asOfDate}: there is no revision to supersede. ` +
        'A correction carries supersedes_id by CHECK constraint (08 §3.5).',
    );
  }
  const now = input.clock.now();
  const result = await executor.execute<RawRow>(sql`
    INSERT INTO net_worth_daily (
      id, user_id, as_of_date, revision, base_currency,
      assets_minor, liabilities_minor, net_worth_minor,
      liquid_minor, investable_minor, on_budget_minor,
      breakdown, source, stale_price, accounts_counted, accounts_unvalued,
      dirty, sealed_at, supersedes_id, correction_reason,
      computed_at, created_at, updated_at
    ) VALUES (
      ${newId()}::uuid, ${input.userId}::uuid, ${snapshot.asOfDate}::date,
      ${superseded.revision + 1}, ${snapshot.baseCurrency},
      ${snapshot.assetsMinor}, ${snapshot.liabilitiesMinor}, ${snapshot.netWorthMinor},
      ${snapshot.liquidMinor}, ${snapshot.investableMinor}, ${snapshot.onBudgetMinor},
      ${JSON.stringify(snapshot.breakdown)}::jsonb, 'corrected', ${snapshot.stalePrice},
      ${snapshot.accountsCounted}, ${snapshot.accountsUnvalued},
      false, ${now.toISOString()}::timestamptz, ${superseded.id}::uuid, ${input.reason},
      ${now.toISOString()}::timestamptz, ${now.toISOString()}::timestamptz,
      ${now.toISOString()}::timestamptz
    )
    ${RETURNING}
  `);
  const raw = result.rows[0];
  if (raw === undefined) throw new Error(`correction for ${snapshot.asOfDate} returned no row`);
  return rowOf(raw);
}

/** The current revision of a day: the highest one. `null` if the day has none. */
export async function currentRow(
  executor: PlanningExecutor,
  userId: string,
  asOfDate: string,
): Promise<NetWorthRow | null> {
  const result = await executor.execute<RawRow>(sql`
    SELECT id, as_of_date, revision, base_currency, assets_minor, liabilities_minor,
           net_worth_minor, liquid_minor, investable_minor, on_budget_minor,
           source, stale_price, dirty, sealed_at
      FROM net_worth_daily
     WHERE user_id = ${userId}::uuid AND as_of_date = ${asOfDate}::date
     ORDER BY revision DESC
     LIMIT 1
  `);
  const raw = result.rows[0];
  return raw === undefined ? null : rowOf(raw);
}

/** Every day that is still open, oldest first. The seal's work list. */
export async function openDays(
  executor: PlanningExecutor,
  userId: string,
): Promise<readonly string[]> {
  const result = await executor.execute<{ as_of_date: string }>(sql`
    SELECT as_of_date FROM net_worth_daily
     WHERE user_id = ${userId}::uuid AND sealed_at IS NULL
     ORDER BY as_of_date
  `);
  return result.rows.map((row) => String(row.as_of_date).slice(0, 10));
}

/**
 * Mark the open day as needing a recompute.
 *
 * Deliberately an UPDATE and never an upsert. A day with no row yet is not a day
 * with pending work — it is a day the snapshotter will compute from scratch
 * anyway — and inserting a zero-valued placeholder so the flag has somewhere to
 * live would put a row on the chart claiming a net worth of nothing. Returns how
 * many rows it marked so a consumer can log the truth rather than an intention.
 */
export async function markDirty(
  executor: PlanningExecutor,
  input: { readonly userId: string; readonly asOfDate: string; readonly clock: Clock },
): Promise<number> {
  const result = await executor.execute<{ id: string }>(sql`
    UPDATE net_worth_daily
       SET dirty = true, updated_at = ${input.clock.now().toISOString()}::timestamptz
     WHERE user_id = ${input.userId}::uuid
       AND as_of_date = ${input.asOfDate}::date
       AND sealed_at IS NULL
       AND NOT dirty
    RETURNING id
  `);
  return result.rows.length;
}

/**
 * The series a chart is drawn from: the current revision of every day on the
 * calendar spine between two dates, gapless.
 *
 * `net_worth_calendar_spine` is the migration's function rather than a range
 * built in TypeScript, so "the series has no gaps" is a property of the database
 * that `test/db/spine.test.ts` asserts directly — and a future reader cannot
 * accidentally reimplement it with a `WHERE` that drops a weekend. A day with no
 * row appears with `null` totals rather than being absent: the chart needs to
 * know the day existed and had no data, which is not the same as zero.
 */
export async function readSeries(
  executor: PlanningExecutor,
  input: { readonly userId: string; readonly from: string; readonly to: string },
): Promise<readonly { readonly asOfDate: string; readonly netWorthMinor: bigint | null }[]> {
  const result = await executor.execute<{ as_of_date: string; net_worth_minor: bigint | null }>(sql`
    SELECT spine.as_of_date, current.net_worth_minor
      FROM net_worth_calendar_spine(${input.from}::date, ${input.to}::date) AS spine
      LEFT JOIN LATERAL (
        SELECT net_worth_minor
          FROM net_worth_daily
         WHERE user_id = ${input.userId}::uuid AND as_of_date = spine.as_of_date
         ORDER BY revision DESC
         LIMIT 1
      ) AS current ON true
     ORDER BY spine.as_of_date
  `);
  return result.rows.map((row) => ({
    asOfDate: String(row.as_of_date).slice(0, 10),
    netWorthMinor: row.net_worth_minor === null ? null : BigInt(row.net_worth_minor),
  }));
}
