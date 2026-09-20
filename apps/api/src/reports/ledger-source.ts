// SPDX-License-Identifier: MIT
/**
 * Reads `@ctx/ledger` and shapes it into what `@ctx/budgeting`'s pure
 * `computeActuals` expects — the one function in this application that decides
 * "budgets exclude transfers and net refunds" (`packages/contexts/budgeting/src/actuals.ts`).
 * WP 2.8's rule is to reuse that decision, never re-derive it, so every report
 * in this directory ends up here first.
 *
 * `apps/api` is the composition root and the only layer allowed to import more
 * than one bounded context (`scripts/eslint-boundaries.js`'s `app` layer has no
 * allow-list), which is what makes this file possible without a port: it reads
 * `@ctx/ledger`'s own read models directly and reshapes their rows into
 * `@ctx/budgeting`'s `BudgetTransaction`/`BudgetAccount` shapes locally, the same
 * translation `apps/api/src/domain.ts` would do if budgeting's own adapter were
 * wired here. It duplicates that adapter's *account role* mapping (the module
 * wiring in `domain.ts`/`modules.ts` is a shared file the orchestrator applies
 * between waves, and budgeting's own real DB adapter does not exist yet at the
 * time this was written) — a one-function, well-commented duplication rather
 * than a dependency on wiring that has not landed.
 */
import type { DateOnly, Money } from '@core/kernel';
import type { BudgetAccount, BudgetTransaction } from '@ctx/budgeting';
import { listAccounts, listTransactions, type LedgerDatabase } from '@ctx/ledger';
import type { AccountType } from '@ctx/ledger/schema';
import type { ReportAccount, ReportAccountRole, ReportRow } from './types.ts';

/** Rows per page while paging the whole report window. Never shipped to a client. */
const PAGE_SIZE = 500;

/**
 * `depository`/`manual` move cash directly; `credit` is revolving debt whose
 * balance is paid down by a transfer, never by category activity (07 §1.3);
 * `loan`/`investment`/`crypto` are net-worth accounts a budget does not reach
 * into. This is the same three-way split `@ctx/budgeting`'s `AccountRole`
 * exists to express (`packages/contexts/budgeting/src/ledger-port.ts`), applied
 * to reports so the transfer-exclusion rule sees the same account roles the
 * budget screen does.
 */
export function roleOfAccountType(type: AccountType): ReportAccountRole {
  switch (type) {
    case 'depository':
    case 'manual':
      return 'CASH';
    case 'credit':
      return 'CREDIT';
    case 'loan':
    case 'investment':
    case 'crypto':
      return 'OFF_BUDGET';
  }
}

export interface ReportWindow {
  readonly userId: string;
  /** Inclusive. */
  readonly dateFrom: DateOnly;
  /** Inclusive. */
  readonly dateTo: DateOnly;
  readonly categoryIds?: readonly string[];
  readonly accountIds?: readonly string[];
}

/**
 * Every row in `[dateFrom, dateTo]`, transfers and excluded rows **included** —
 * exactly `@ctx/budgeting`'s `LedgerPort` contract: the exclusion and the
 * netting are `computeActuals`'s decision, not this reader's, so the counts of
 * what was dropped stay observable.
 */
export async function loadReportRows(
  database: LedgerDatabase,
  window: ReportWindow,
): Promise<ReportRow[]> {
  const rows: ReportRow[] = [];
  let cursor: string | null = null;
  for (;;) {
    const page = await listTransactions(database, {
      userId: window.userId,
      filters: {
        dateFrom: window.dateFrom,
        dateTo: window.dateTo,
        transfers: 'include',
        includeDuplicates: false,
        ...(window.categoryIds === undefined ? {} : { categoryIds: window.categoryIds }),
        ...(window.accountIds === undefined ? {} : { accountIds: window.accountIds }),
      },
      limit: PAGE_SIZE,
      ...(cursor === null ? {} : { cursor }),
    });
    for (const row of page.items) {
      rows.push({
        id: row.id,
        accountId: row.accountId,
        date: row.effective.date,
        amount: row.effective.amount,
        categoryId: row.effective.categoryId,
        merchantId: row.merchantId,
        isTransfer: row.isTransfer,
        transferLinkId: row.transferLinkId,
        refundOfId: row.refundOfId,
        excluded: row.effective.excluded,
      });
    }
    if (page.nextCursor === null) break;
    cursor = page.nextCursor;
  }
  return rows;
}

/** Every account this user has, reduced to what `computeActuals` needs to see. */
export async function loadReportAccounts(
  database: LedgerDatabase,
  userId: string,
): Promise<ReportAccount[]> {
  const accounts = await listAccounts(database, { userId, includeClosed: true });
  return accounts.map((account) => ({
    id: account.id,
    role: roleOfAccountType(account.type),
    currency: account.currency.trim(),
  }));
}

/**
 * `ReportRow[]`/`ReportAccount[]` → `@ctx/budgeting`'s own
 * `BudgetTransaction[]`/`BudgetAccount[]`, now that `@ctx/budgeting` is a
 * declared dependency of `apps/api` (the dependency-batch item
 * `docs/evidence/phase-2/wp2.8-reports.md` §2 recorded as its open item),
 * so the reports directory calls the real `computeActuals` instead of the
 * port `reports/netting.ts` used to reproduce by hand.
 *
 * `computeActuals` reads only `.role` off each `BudgetAccount`
 * (`packages/contexts/budgeting/src/actuals.ts`); `type`, `workingBalance`
 * and `closed` are set to values it never reads. `funding` on each
 * `BudgetTransaction` is likewise only echoed onto the result's
 * `EnvelopeTransaction.funding` — reports never read it back — but it is
 * still derived correctly, from the same account-role map, rather than left
 * as an arbitrary placeholder.
 */
export function toBudgetAccounts(accounts: readonly ReportAccount[]): BudgetAccount[] {
  return accounts.map((account) => ({
    id: account.id,
    type: account.role.toLowerCase(),
    role: account.role,
    workingBalance: null,
    closed: false,
  }));
}

export function toBudgetTransactions(
  rows: readonly ReportRow[],
  accounts: readonly ReportAccount[],
): BudgetTransaction[] {
  const roleOf = new Map(accounts.map((account) => [account.id, account.role] as const));
  return rows.map((row) => ({
    id: row.id,
    accountId: row.accountId,
    budgetDate: row.date,
    amount: row.amount,
    categoryId: row.categoryId,
    funding: roleOf.get(row.accountId) === 'CREDIT' ? 'CREDIT' : 'CASH',
    transferLinkId: row.transferLinkId,
    isTransfer: row.isTransfer,
    refundOfId: row.refundOfId,
    excluded: row.excluded,
  }));
}

/** Money in more than one currency, ledger currency amounts unmixed. */
export function groupByCurrency<T extends { readonly amount: Money }>(
  rows: readonly T[],
): Map<string, T[]> {
  const byCurrency = new Map<string, T[]>();
  for (const row of rows) {
    const bucket = byCurrency.get(row.amount.currency);
    if (bucket === undefined) byCurrency.set(row.amount.currency, [row]);
    else bucket.push(row);
  }
  return byCurrency;
}
