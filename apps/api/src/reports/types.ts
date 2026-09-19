// SPDX-License-Identifier: MIT
/**
 * Shapes shared by every report aggregator under `reports/`.
 *
 * Every amount here is a `Money` from `@core/kernel` — never a `bigint`, never a
 * `number`. `routes/reports.ts` is the only place that calls `Money.toJSON`;
 * everything under this directory stays in the same currency the ledger stored
 * the row in, per docs/CONVENTIONS.md's "never sum across currencies" rule.
 */
import type { DateOnly, Money } from '@core/kernel';

/** How an account counts towards a report. Mirrors `@ctx/budgeting`'s `AccountRole`. */
export type ReportAccountRole = 'CASH' | 'CREDIT' | 'OFF_BUDGET';

/**
 * One ledger row, reduced to what report aggregation needs.
 *
 * Deliberately the same shape `@ctx/budgeting`'s `LedgerPort` declares
 * (`BudgetTransaction`), so `computeActuals` — the one place transfers are
 * excluded and refunds are netted — can run unmodified over report data. See
 * `ledger-source.ts` for why this file, not `@ctx/budgeting`, owns the adapter:
 * the budgeting module's own port/adapter is wired in `apps/api/src/domain.ts`
 * only once WP 2.1's consumer lands there, and reports needs no consumer, only
 * the pure math.
 */
export interface ReportRow {
  readonly id: string;
  readonly accountId: string;
  /** The ledger's resolved `effective.date` — see `budgetDate`'s doc in `@ctx/budgeting`. */
  readonly date: DateOnly;
  readonly amount: Money;
  readonly categoryId: string | null;
  readonly merchantId: string | null;
  readonly isTransfer: boolean;
  readonly transferLinkId: string | null;
  readonly refundOfId: string | null;
  readonly excluded: boolean;
}

export interface ReportAccount {
  readonly id: string;
  readonly role: ReportAccountRole;
  readonly currency: string;
}

/** One (month, category) cell of activity, transfers excluded and refunds netted. */
export interface CategoryMonthActivity {
  readonly month: string;
  readonly categoryId: string | null;
  readonly currency: string;
  readonly amount: Money;
  readonly transactionCount: number;
  readonly transferExcludedCount: number;
  readonly refundNettedCount: number;
}

/**
 * `GET /transactions`'s own filter params, ready to hand a client for
 * drill-through. Arrays are mutable (`string[]`, not `readonly string[]`) to
 * match the wire schema's zod-inferred output type exactly — a route's
 * `response` schema and its handler's return type must agree structurally, and
 * zod's `z.array(...)` never infers `readonly`.
 */
export interface DrillThroughFilter {
  categoryIds?: string[];
  merchantIds?: string[];
  readonly from: string;
  readonly to: string;
}
