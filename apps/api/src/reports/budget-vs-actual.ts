// SPDX-License-Identifier: MIT
/**
 * Budget vs. actual, one period at a time.
 *
 * Reads `budget_periods`, `budget_lines` and `budget_line_actuals` directly by
 * SQL rather than going through `@ctx/budgeting`'s own `getPeriod` — see
 * `reports/netting.ts`'s header for the reason common to every file in this
 * directory that would otherwise import `@ctx/budgeting`: that package is not
 * yet a declared dependency of `apps/api` (master plan §4 item 8's dependency
 * batch, an orchestrator step between waves, had not landed at the time this
 * work package ran), and this work package's own rules forbid editing
 * `package.json` or the lockfile.
 *
 * This is **not** a table-ownership violation: `scripts/check-schema-ownership.ts`
 * exempts `apps/` from its "raw SQL must not reach into another package's
 * tables" check by design (`NON_OWNING_PREFIXES`) — `apps/` is the composition
 * root and every export/import stream in `reports/export/**` already reads
 * arbitrary tables the same way. What makes this file different from
 * `getPeriod` is scope, not legitimacy: it reads the **cached** columns
 * `@ctx/budgeting`'s own recompute cascade already wrote
 * (`budget_lines.assigned_minor`/`available_minor`/`*_overspend_minor`,
 * `budget_line_actuals.activity_minor`) rather than re-deriving them, so there
 * is no envelope math to duplicate — only a read. `getPeriod`'s presentation
 * extras (`neededThisPeriod`, `underfunded`, `toStayOnTrack`) are 07 §1.8
 * budget-screen concerns WP 2.9 owns and are deliberately not reproduced here.
 *
 * **Open item for the orchestrator:** once `@ctx/budgeting` is a declared
 * dependency of `apps/api`, replace this file's two queries with a call to
 * `getPeriod` and delete the duplication.
 */
import { Money, type Money as MoneyType } from '@core/kernel';
import type { Pool } from 'pg';

export interface BudgetVsActualLine {
  readonly id: string;
  readonly categoryId: string | null;
  readonly name: string | null;
  readonly assigned: MoneyType;
  readonly activity: MoneyType;
  readonly available: MoneyType;
  readonly cashOverspend: MoneyType;
  readonly creditOverspend: MoneyType;
}

export interface BudgetVsActualPeriod {
  readonly id: string;
  readonly startDate: string;
  readonly endDate: string;
  readonly readyToAssign: MoneyType;
  readonly income: MoneyType;
  readonly lines: readonly BudgetVsActualLine[];
}

export interface BudgetVsActualInput {
  readonly userId: string;
  readonly periodId?: string;
  readonly budgetId?: string;
}

interface PeriodRow {
  id: string;
  start_date: string;
  end_date: string;
  ready_to_assign_minor: bigint;
  income_minor: bigint;
  currency: string;
}

interface LineRow {
  id: string;
  category_id: string | null;
  name: string | null;
  assigned_minor: bigint;
  available_minor: bigint;
  cash_overspend_minor: bigint;
  credit_overspend_minor: bigint;
  currency: string;
  activity_minor: bigint | null;
}

async function resolvePeriodId(pool: Pool, input: BudgetVsActualInput): Promise<string | null> {
  if (input.periodId !== undefined) return input.periodId;
  if (input.budgetId === undefined) return null;
  const rows = await pool.query<{ id: string; status: string }>(
    `SELECT id, status FROM budget_periods WHERE user_id = $1 AND budget_id = $2 ORDER BY sequence DESC`,
    [input.userId, input.budgetId],
  );
  if (rows.rows.length === 0) return null;
  const open = rows.rows.find((row) => row.status === 'open');
  return (open ?? rows.rows[0])?.id ?? null;
}

/**
 * Resolves `periodId` directly if given; otherwise the most recent period of
 * `budgetId` (open, or the last one if every period is closed). `null` means
 * "no such period" or "this budget has none yet" — a 404 at the route.
 */
export async function loadBudgetVsActual(
  pool: Pool,
  input: BudgetVsActualInput,
): Promise<BudgetVsActualPeriod | null> {
  const periodId = await resolvePeriodId(pool, input);
  if (periodId === null) return null;

  const periodRows = await pool.query<PeriodRow>(
    `SELECT id, start_date, end_date, ready_to_assign_minor, income_minor, currency
       FROM budget_periods WHERE id = $1 AND user_id = $2`,
    [periodId, input.userId],
  );
  const period = periodRows.rows[0];
  if (period === undefined) return null;

  const lineRows = await pool.query<LineRow>(
    `SELECT l.id, l.category_id, l.name, l.assigned_minor, l.available_minor,
            l.cash_overspend_minor, l.credit_overspend_minor, l.currency,
            a.activity_minor
       FROM budget_lines l
       LEFT JOIN budget_line_actuals a ON a.budget_line_id = l.id
      WHERE l.budget_period_id = $1 AND l.user_id = $2 AND l.kind = 'category'
      ORDER BY l.priority, l.id`,
    [periodId, input.userId],
  );

  return {
    id: period.id,
    startDate: period.start_date,
    endDate: period.end_date,
    readyToAssign: Money.of(period.ready_to_assign_minor, period.currency),
    income: Money.of(period.income_minor, period.currency),
    lines: lineRows.rows.map((row) => ({
      id: row.id,
      categoryId: row.category_id,
      name: row.name,
      assigned: Money.of(row.assigned_minor, row.currency),
      activity: Money.of(row.activity_minor ?? 0n, row.currency),
      available: Money.of(row.available_minor, row.currency),
      cashOverspend: Money.of(row.cash_overspend_minor, row.currency),
      creditOverspend: Money.of(row.credit_overspend_minor, row.currency),
    })),
  };
}
