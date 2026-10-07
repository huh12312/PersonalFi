// SPDX-License-Identifier: MIT
/**
 * Loads a verified bundle (`parseAndVerifyBundle`) into a clean instance, one
 * transaction, `TABLE_ORDER` order, then re-runs `@ctx/ledger`'s own
 * projection rather than trusting the `effective_*` columns the export
 * carried — decision D11's `resolveEffective()` is the *only* function allowed
 * to produce them, and an import that copied them verbatim would be a second
 * writer of a column the whole schema depends on having exactly one.
 *
 * ## Every row's `user_id` is rewritten to the importing user, not preserved
 *
 * `user_id` carries a real database foreign key to `identity`'s `users` table
 * on every migration (`@core/db`'s `userIdColumn()` doc: "the foreign key is
 * declared in SQL" — Drizzle cannot express a cross-context reference, so it
 * lives in the raw migration instead). A clean instance's own bootstrap user
 * (`just bootstrap-user`) has a different id than whoever the export came
 * from, so inserting the exported rows verbatim fails that constraint on the
 * very first row — caught by this file's own `export-import.test.ts` the
 * first time it ran. Restoring a backup onto a freshly bootstrapped instance
 * always means "attach this data to *this* instance's one account holder", so
 * `importBundle`'s caller supplies `targetUserId` (the step-up session's own
 * `userId` at the route) and every table's `user_id` column is overwritten
 * with it during insert, before the row ever reaches Postgres.
 */
import { DateOnly } from '@core/kernel';
import type { TransactionProviderRow, TransactionRow } from '@ctx/ledger/schema';
import { projectEffective } from '@ctx/ledger';
import {
  currentRegistry,
  deriveTolerance,
  LIQUIDITY_NEEDS,
  profileFromJson,
  resolveOverrides,
  UnknownAssumptionsVersion,
  type AssumptionDeltas,
  type AssumptionsRegistry,
} from '@ctx/planning';
import type { Pool, PoolClient } from 'pg';
import { AppError } from '../../problem.ts';
import { TABLE_ORDER } from './registry.ts';
import type { ParsedBundle } from './bundle.ts';
import type { RawRow } from './codec.ts';

/** Structural: both `pg.Pool` and `pg.PoolClient` satisfy this. */
interface Queryable {
  query<T extends Record<string, unknown>>(
    text: string,
    params?: readonly unknown[],
  ): Promise<{ rows: T[] }>;
}

/**
 * Every user-scoped table has at least one row, on any user, anywhere.
 *
 * Called twice on purpose: once against the pool for a fast pre-flight 409
 * before the bundle's rows are even parsed, and again against the open
 * transaction's own client, right before the first insert, so a second import
 * racing the first cannot both pass the check against a database neither has
 * written to yet — the second call sees the first import's own uncommitted
 * inserts once it has started writing, which is the property that matters.
 */
export async function instanceHasUserData(db: Queryable): Promise<boolean> {
  for (const table of TABLE_ORDER) {
    const exists = await db.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1
       ) AS exists`,
      [table],
    );
    if (exists.rows[0]?.exists !== true) continue;
    const count = await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM "${table}"`);
    if (Number(count.rows[0]?.n ?? '0') > 0) return true;
  }
  return false;
}

function toCamel(snake: string): string {
  return snake.replace(/_([a-z0-9])/gu, (_match, letter: string) => letter.toUpperCase());
}

/** `RawRow` (snake_case, decoded) → the camelCase shape every Drizzle table uses. */
function camelRow(row: RawRow): Record<string, unknown> {
  const camel: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) camel[toCamel(key)] = value;
  return camel;
}

/**
 * `json`/`jsonb` columns of one table, from the target database's own
 * `information_schema` — needed because node-postgres's parameter encoding
 * (`pg/lib/utils.js`'s `prepareValue`) treats *any* JS array as a native
 * Postgres array literal (`{a,b,c}`) before it ever asks what the target
 * column type is. A `jsonb` column whose value happens to be a JSON array —
 * `budgets.off_budget_account_ids`, `recurring_series.account_ids` — gets a
 * curly-brace array literal instead of JSON text, and Postgres refuses it
 * ("invalid input syntax for type json", the jsonb parser's own error text).
 * Pre-serialising exactly those columns to a JSON string here sends plain text
 * instead, which Postgres casts to `jsonb` implicitly on `INSERT` the same way
 * it already does for a `json`-typed column literal.
 */
async function jsonColumnsOf(client: PoolClient, table: string): Promise<Set<string>> {
  const result = await client.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1 AND data_type IN ('json', 'jsonb')`,
    [table],
  );
  return new Set(result.rows.map((row) => row.column_name));
}

async function columnsOf(client: PoolClient, table: string): Promise<Set<string>> {
  const result = await client.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1`,
    [table],
  );
  return new Set(result.rows.map((row) => row.column_name));
}

function refuseBundle(code: string, detail: string): AppError {
  return new AppError({ status: 400, code, title: 'Bad Request', detail, family: 'user' });
}

/**
 * O-11 (Phase 4 gate; WP 9.11, ASVS V2): the plan data a bundle carries is
 * re-validated through the same functions the routes use, the way D11 already
 * re-projects transactions rather than trusting the export. A bundle's
 * per-stream SHA-256s detect corruption but are not a MAC — a crafted bundle
 * with recomputed hashes verifies — and until this the only check on its plan
 * rows was the database's own CHECKs (structural, not semantic: a 99 %
 * expected return passed, so did a tolerance the answers do not score to).
 *
 * - `plan_assumptions`: every delta through `resolveOverrides` — the
 *   overridable paths and the bounds `PUT /assumptions/overrides` enforces —
 *   when its assumptions version is one this build carries (a version it does
 *   not is inert: the read path refuses to apply it, as on a live install);
 * - `risk_profile`: the stored answers re-scored by `deriveTolerance` (the
 *   questionnaire's own scoring) and the stored tolerance and scores required
 *   to be what they score to; horizon and liquidity in the route's vocabulary;
 * - `plan_scenarios`: a baseline's profile through `profileFromJson`, the
 *   parser the projection reads it with.
 *
 * Pure: runs before the transaction opens, so a refusal writes nothing.
 */
export function revalidatePlanRows(
  parsed: ParsedBundle,
  registry: AssumptionsRegistry = currentRegistry(),
): void {
  const at = DateOnly.parse('2000-01-01');
  const refuseRow = (table: string, index: number, why: string): never => {
    throw refuseBundle(
      'export.bundle_row_invalid',
      `${table} row ${String(index + 1)} does not pass the checks its route applies: ${why}`,
    );
  };
  const reason = (error: unknown): string =>
    error instanceof Error ? error.message : String(error);

  (parsed.rowsByTable.get('plan_assumptions') ?? []).forEach((row, index) => {
    try {
      resolveOverrides(
        {
          assumptionsVersion: String(row['assumptions_version']),
          deltas: (row['deltas'] ?? {}) as AssumptionDeltas,
        },
        at,
        registry,
      );
    } catch (error) {
      // An assumptions version this build does not hold (a bundle from a
      // release whose file has since rolled off) is imported as it is: the
      // read path refuses to apply such a delta exactly as it does for a row
      // left behind on a live install by an upgrade (409
      // `planning.assumptions_version_unknown`), so its values can never
      // reach a projection. Everything checkable against a known file is.
      if (error instanceof UnknownAssumptionsVersion) return;
      refuseRow('plan_assumptions', index, reason(error));
    }
  });

  (parsed.rowsByTable.get('risk_profile') ?? []).forEach((row, index) => {
    let derived: ReturnType<typeof deriveTolerance>;
    try {
      derived = deriveTolerance(row['answers']);
    } catch (error) {
      return refuseRow('risk_profile', index, reason(error));
    }
    const stored = {
      tolerance: row['tolerance'],
      composite: Number(row['composite_score']),
      unpenalised: Number(row['unpenalised_score']),
      penalty: Number(row['consistency_penalty']),
    };
    if (
      stored.tolerance !== derived.tolerance ||
      stored.composite !== derived.compositeScore ||
      stored.unpenalised !== derived.unpenalisedScore ||
      stored.penalty !== derived.consistencyPenalty
    ) {
      refuseRow(
        'risk_profile',
        index,
        `the answers score to ${derived.tolerance} (${String(derived.compositeScore)}), not the ` +
          `stored ${String(stored.tolerance)} (${String(stored.composite)})`,
      );
    }
    const horizon = Number(row['horizon_years']);
    if (!Number.isInteger(horizon) || horizon < 0 || horizon > 100) {
      refuseRow('risk_profile', index, 'horizon_years must be a whole number from 0 to 100');
    }
    if (!(LIQUIDITY_NEEDS as readonly unknown[]).includes(row['liquidity_need'])) {
      refuseRow(
        'risk_profile',
        index,
        `liquidity_need must be one of ${LIQUIDITY_NEEDS.join(', ')}`,
      );
    }
  });

  (parsed.rowsByTable.get('plan_scenarios') ?? []).forEach((row, index) => {
    if (row['kind'] !== 'baseline') return;
    try {
      profileFromJson(row['profile']);
    } catch (error) {
      refuseRow('plan_scenarios', index, reason(error));
    }
  });
}

async function insertRows(
  client: PoolClient,
  table: string,
  rows: readonly RawRow[],
  targetUserId: string,
): Promise<void> {
  if (rows.length === 0) return;
  const columns = Object.keys(rows[0] ?? {});
  // O-11 (WP 9.11): a column name is interpolated into the INSERT below, and
  // it arrives from the bundle — whose hashes are a checksum, not a MAC, so a
  // crafted bundle chooses them. Every name must be a real column of this
  // table, or nothing is written.
  const known = await columnsOf(client, table);
  const unknown = columns.filter((column) => !known.has(column));
  if (unknown.length > 0) {
    throw refuseBundle(
      'export.bundle_column_unknown',
      `${table}: ${unknown.map((column) => JSON.stringify(column)).join(', ')} is not a column of this table`,
    );
  }
  const jsonColumns = await jsonColumnsOf(client, table);
  const columnList = columns.map((column) => `"${column}"`).join(', ');
  const placeholders = columns.map((_column, index) => `$${String(index + 1)}`).join(', ');
  const statement = `INSERT INTO "${table}" (${columnList}) VALUES (${placeholders})`;
  for (const row of rows) {
    await client.query(
      statement,
      columns.map((column) => {
        if (column === 'user_id') return targetUserId;
        const value = row[column];
        return jsonColumns.has(column) && value !== null ? JSON.stringify(value) : value;
      }),
    );
  }
}

/**
 * Recomputes `transactions.effective_*` and `pending` from the facts and
 * merchants just loaded, via `@ctx/ledger`'s own `projectEffective` — the same
 * function `applyProviderTransactions` calls on every sync. Nothing here
 * re-implements D11's resolution order; it only re-runs it.
 */
async function reprojectTransactions(client: PoolClient, userId: string): Promise<number> {
  const merchantRows = await client.query<{ normalized_key: string; id: string }>(
    `SELECT normalized_key, id FROM merchants WHERE user_id = $1`,
    [userId],
  );
  const merchantIds = new Map(
    merchantRows.rows.map((row) => [row.normalized_key, row.id] as const),
  );

  const transactionRows = await client.query<RawRow>(
    `SELECT * FROM transactions WHERE user_id = $1`,
    [userId],
  );
  let updated = 0;
  for (const raw of transactionRows.rows) {
    const row = camelRow(raw) as unknown as TransactionRow;
    const factRows = await client.query<RawRow>(
      `SELECT * FROM transactions_provider WHERE id = $1`,
      [row.currentFactId],
    );
    const factRaw = factRows.rows[0];
    if (factRaw === undefined) continue; // orphaned pointer; leave the stored projection alone
    const fact = camelRow(factRaw) as unknown as TransactionProviderRow;
    const projected = projectEffective(row, fact, merchantIds);
    await client.query(
      `UPDATE transactions SET
         effective_date = $1, effective_amount_minor = $2, effective_currency = $3,
         effective_name = $4, effective_merchant_id = $5, pending = $6
       WHERE id = $7`,
      [
        projected.effectiveDate,
        projected.effectiveAmountMinor,
        projected.effectiveCurrency,
        projected.effectiveName,
        projected.effectiveMerchantId,
        projected.pending,
        row.id,
      ],
    );
    updated += 1;
  }
  return updated;
}

export interface ImportResult {
  readonly tablesLoaded: string[];
  readonly rowsLoaded: number;
  readonly transactionsReprojected: number;
}

/**
 * Loads every stream the bundle carried, in `TABLE_ORDER`, inside one
 * transaction — all of it lands, or none of it does. Refuses (409) unless the
 * instance has no user data yet, checked inside the same transaction so a
 * concurrent write cannot race the check.
 */
export async function importBundle(
  pool: Pool,
  parsed: ParsedBundle,
  targetUserId: string,
): Promise<ImportResult> {
  // O-11: before a connection is taken — a refused bundle writes nothing.
  revalidatePlanRows(parsed);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    if (await instanceHasUserData(client)) {
      await client.query('ROLLBACK');
      throw new AppError({
        status: 409,
        code: 'export.instance_not_empty',
        title: 'Conflict',
        detail: 'This instance already has user data; import only targets a clean instance.',
        family: 'domain',
      });
    }

    const tablesLoaded: string[] = [];
    let rowsLoaded = 0;
    for (const table of TABLE_ORDER) {
      const rows = parsed.rowsByTable.get(table);
      if (rows === undefined || rows.length === 0) continue;
      await insertRows(client, table, rows, targetUserId);
      tablesLoaded.push(table);
      rowsLoaded += rows.length;
    }

    const transactionsReprojected = tablesLoaded.includes('transactions')
      ? await reprojectTransactions(client, targetUserId)
      : 0;

    await client.query('COMMIT');
    return { tablesLoaded, rowsLoaded, transactionsReprojected };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
