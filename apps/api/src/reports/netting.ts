// SPDX-License-Identifier: MIT
/**
 * Transfers excluded, refunds netted — the v0.8 rung, applied to report rows.
 *
 * ## Why this is a port and not an import (read before touching this file)
 *
 * WP 2.8 was told to *reuse* `@ctx/budgeting`'s `computeActuals`
 * (`packages/contexts/budgeting/src/actuals.ts`), never re-derive the rule. The
 * intent here is exactly that reuse — this function's control flow is a
 * line-for-line copy of `computeActuals`, reduced to the fields a report
 * needs (no `funding`/`creditAccountId`/card-payment tracking: reports do not
 * render the cash/credit split, only `@ctx/budgeting`'s own screen does).
 *
 * It is a *copy* rather than a call because, at the time this work package ran,
 * `apps/api/package.json` did not yet declare a dependency on `@ctx/budgeting`
 * — that line, and the `pnpm install` that follows it, is master-plan §4 item
 * 8's "dependency batch", explicitly an **orchestrator** step applied between
 * waves ("Agents never run `pnpm install`"), and this work package's own rules
 * forbid editing `package.json`, the lockfile, or running `pnpm install`.
 * Importing `@ctx/budgeting` under those two constraints does not compile
 * (`Cannot find module '@ctx/budgeting'` — pnpm's per-package `node_modules`
 * isolation means a workspace package is invisible to a consumer that has not
 * declared it, dependency or not on disk).
 *
 * **Open item for the orchestrator (recorded again in the evidence note):**
 * once `@ctx/budgeting` is added to `apps/api/package.json`'s dependencies,
 * delete this file, import `computeActuals` directly in `spending-income.ts`
 * and `sankey.ts`, and delete `reports/netting.test.ts`'s standalone
 * assertions in favour of one asserting this file's old behaviour matches
 * `computeActuals`'s, byte for byte, before removing it.
 *
 * Kept in sync with `actuals.ts` as of commit `58599b0`. `refund` netting order
 * (categorise, then re-home a refund with no category of its own onto its
 * purchase's category) and transfer exclusion (both legs dropped, not just
 * netted) are the two rules this file exists to reproduce exactly.
 */
import { Money, type Money as MoneyType } from '@core/kernel';
import type { ReportAccount, ReportRow } from './types.ts';

export interface CategoryActivity {
  readonly categoryId: string | null;
  readonly transactions: readonly ReportRow[];
  readonly transactionCount: number;
  readonly transferExcludedCount: number;
  readonly refundNettedCount: number;
}

export interface ComputeCategoryActivityInput {
  /** Every row in the window, unfiltered — this function decides what counts. */
  readonly transactions: readonly ReportRow[];
  readonly accounts: readonly ReportAccount[];
  /** The purchase each refund reverses, when it lies outside this batch (see `actuals.ts`). */
  readonly categoryOfPurchase: ReadonlyMap<string, string | null>;
}

function resolveCategory(
  row: ReportRow,
  categoryOfPurchase: ReadonlyMap<string, string | null>,
): string | null {
  if (row.categoryId !== null) return row.categoryId;
  if (row.refundOfId === null) return null;
  return categoryOfPurchase.get(row.refundOfId) ?? null;
}

/**
 * Splits a batch of rows into per-category activity: transfers dropped (both
 * legs), refunds netted into the purchase's category. Mirrors
 * `@ctx/budgeting`'s `computeActuals` — see the module header for why this is
 * a port rather than a call.
 */
export function computeCategoryActivity(
  input: ComputeCategoryActivityInput,
): ReadonlyMap<string | null, CategoryActivity> {
  const roleOf = new Map(input.accounts.map((account) => [account.id, account.role] as const));

  const byCategory = new Map<
    string | null,
    {
      categoryId: string | null;
      transactions: ReportRow[];
      transactionCount: number;
      transferExcludedCount: number;
      refundNettedCount: number;
    }
  >();

  const bucket = (categoryId: string | null) => {
    const existing = byCategory.get(categoryId);
    if (existing !== undefined) return existing;
    const fresh = {
      categoryId,
      transactions: [] as ReportRow[],
      transactionCount: 0,
      transferExcludedCount: 0,
      refundNettedCount: 0,
    };
    byCategory.set(categoryId, fresh);
    return fresh;
  };

  for (const row of input.transactions) {
    const role = roleOf.get(row.accountId);
    if (role === undefined || role === 'OFF_BUDGET' || row.excluded) continue;

    if (row.transferLinkId !== null || row.isTransfer) {
      bucket(resolveCategory(row, input.categoryOfPurchase)).transferExcludedCount += 1;
      continue;
    }

    const categoryId = resolveCategory(row, input.categoryOfPurchase);
    const target = bucket(categoryId);
    target.transactions.push(row);
    target.transactionCount += 1;
    if (row.refundOfId !== null) target.refundNettedCount += 1;
  }

  return byCategory;
}

/** `Money.sum` over a category's netted rows, in the caller's known currency. */
export function totalOf(activity: CategoryActivity, currency: string): MoneyType {
  return Money.sum(
    activity.transactions.map((row) => row.amount),
    currency,
  );
}
