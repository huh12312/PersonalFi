// SPDX-License-Identifier: MIT
/**
 * Income → category → top-N merchants (+ "other"), for one currency.
 *
 * Built from a single `computeCategoryActivity` call over the whole window
 * rather than one per month (unlike `spending-income.ts`): a Sankey diagram
 * shows *where the window's money went*, not a month-by-month breakdown, so
 * there is exactly one category bucket per category for the whole range.
 * Reusing the same `computeActuals` call here, rather than re-summing the raw
 * rows, is what makes the merchant split agree with the category total for
 * free: `LineActivity.transactions` already **is** the post-netting,
 * post-exclusion set — including a refund reassigned to the purchase's
 * category — so bucketing those same rows by merchant cannot disagree with
 * the category figure a caller drilled down from. (Previously reached through
 * `reports/netting.ts`, a hand-written port of `@ctx/budgeting`'s
 * `computeActuals`; deleted now that `@ctx/budgeting` is a declared
 * dependency of `apps/api` — `docs/evidence/phase-2/wp2.8-reports.md` §2.)
 */
import { Money, type Money as MoneyType } from '@core/kernel';
import { computeActuals } from '@ctx/budgeting';
import type { LedgerDatabase } from '@ctx/ledger';
import {
  groupByCurrency,
  loadReportAccounts,
  loadReportRows,
  toBudgetAccounts,
  toBudgetTransactions,
  type ReportWindow,
} from './ledger-source.ts';
import type { ReportRow } from './types.ts';

export const SANKEY_INCOME_NODE = 'income';
export const SANKEY_OTHER_SUFFIX = ':other';

export type SankeyNodeKind = 'income' | 'category' | 'merchant' | 'other';

export interface SankeyNode {
  readonly id: string;
  readonly kind: SankeyNodeKind;
  /** Opaque: a `categoryId` or a `merchantId`, or `null` for uncategorised/no merchant. */
  readonly refId: string | null;
}

export interface SankeyLink {
  readonly source: string;
  readonly target: string;
  readonly amount: MoneyType;
}

export interface SankeyResult {
  readonly currency: string;
  readonly nodes: readonly SankeyNode[];
  readonly links: readonly SankeyLink[];
}

/**
 * The Sankey for whichever currency has the most absolute activity in the
 * window, unless `currency` names one explicitly. A single diagram cannot mix
 * currencies without a conversion this application does not do (decision D4).
 */
export async function computeSankey(
  database: LedgerDatabase,
  window: ReportWindow,
  options: { readonly currency?: string; readonly topMerchants?: number } = {},
): Promise<SankeyResult> {
  const topN = options.topMerchants ?? 8;
  const [rows, accounts] = await Promise.all([
    loadReportRows(database, window),
    loadReportAccounts(database, window.userId),
  ]);
  const byCurrency = groupByCurrency(rows);

  const currency = options.currency ?? largestCurrency(byCurrency);
  const currencyRows = byCurrency.get(currency) ?? [];
  const rowsById = new Map(currencyRows.map((row) => [row.id, row] as const));
  const currencyAccounts = accounts.filter((account) => account.currency === currency);

  const categoryOfPurchase = new Map(currencyRows.map((row) => [row.id, row.categoryId] as const));
  const { byCategory } = computeActuals({
    transactions: toBudgetTransactions(currencyRows, currencyAccounts),
    accounts: toBudgetAccounts(currencyAccounts),
    categoryOfPurchase,
    currency,
  });

  const nodes: SankeyNode[] = [{ id: SANKEY_INCOME_NODE, kind: 'income', refId: null }];
  const links: SankeyLink[] = [];

  for (const activity of byCategory.values()) {
    const total = Money.sum(
      activity.transactions.map((transaction) => transaction.amount),
      currency,
    );
    if (!Money.isNegative(total)) {
      // Income-shaped or empty: not a spending flow. The income *total* is a
      // derived, presentation-only figure a caller can compute by summing the
      // positive category totals; this function only emits spending flows.
      continue;
    }

    const categoryNode = categoryNodeId(activity.categoryId);
    nodes.push({ id: categoryNode, kind: 'category', refId: activity.categoryId });
    const spend = Money.absolute(total);
    links.push({ source: SANKEY_INCOME_NODE, target: categoryNode, amount: spend });

    // Merchant split: bucket this category's own (already netted) rows by
    // merchant, using `rowsById` to recover the merchant a fingerprint alone
    // does not carry.
    const byMerchant = new Map<string | null, MoneyType>();
    for (const transaction of activity.transactions) {
      const merchantId = rowsById.get(transaction.id)?.merchantId ?? null;
      byMerchant.set(
        merchantId,
        Money.add(byMerchant.get(merchantId) ?? Money.zero(currency), transaction.amount),
      );
    }
    const merchantTotals = [...byMerchant.entries()]
      .map(([merchantId, merchantTotal]) => ({ merchantId, spend: Money.absolute(merchantTotal) }))
      .filter((entry) => Money.isPositive(entry.spend))
      .sort((a, b) => Money.compare(b.spend, a.spend));

    const top = merchantTotals.slice(0, topN);
    const rest = merchantTotals.slice(topN);
    for (const entry of top) {
      const merchantNode = merchantNodeId(categoryNode, entry.merchantId);
      nodes.push({ id: merchantNode, kind: 'merchant', refId: entry.merchantId });
      links.push({ source: categoryNode, target: merchantNode, amount: entry.spend });
    }
    if (rest.length > 0) {
      const otherTotal = Money.sum(
        rest.map((entry) => entry.spend),
        currency,
      );
      if (Money.isPositive(otherTotal)) {
        const otherNode = `${categoryNode}${SANKEY_OTHER_SUFFIX}`;
        nodes.push({ id: otherNode, kind: 'other', refId: null });
        links.push({ source: categoryNode, target: otherNode, amount: otherTotal });
      }
    }
  }

  return { currency, nodes, links };
}

function categoryNodeId(categoryId: string | null): string {
  return categoryId === null ? 'category:uncategorized' : `category:${categoryId}`;
}

function merchantNodeId(categoryNode: string, merchantId: string | null): string {
  return merchantId === null ? `${categoryNode}:no-merchant` : `merchant:${merchantId}`;
}

function largestCurrency(byCurrency: ReadonlyMap<string, readonly ReportRow[]>): string {
  let best: string | null = null;
  let bestTotal = -1n;
  for (const [currency, rowsForCurrency] of byCurrency) {
    const total = rowsForCurrency.reduce(
      (sum, row) => sum + (row.amount.minor < 0n ? -row.amount.minor : row.amount.minor),
      0n,
    );
    if (total > bestTotal) {
      bestTotal = total;
      best = currency;
    }
  }
  return best ?? 'USD';
}
