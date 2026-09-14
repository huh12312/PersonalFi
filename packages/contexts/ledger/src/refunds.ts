// SPDX-License-Identifier: MIT
/**
 * Refund hints.
 *
 * A refund is a real inflow that reverses a real outflow. Netting the two
 * automatically would make a month's spend "correct" by hiding two transactions
 * the user can see on their statement — and the first time the guess is wrong,
 * the app has silently changed a number the user was relying on. So this
 * **flags** (`refund_of_id`, `refund_confidence`) and nothing more: the UI can
 * offer "net these?", budgeting can offer to exclude the pair, and both of those
 * are the user's decision to make. 01 §5.2's rule for duplicates — prefer showing
 * the extra row over silently merging — applies here for the same reason.
 *
 * Deliberately *not* an event. The five ledger events are the facts other
 * contexts act on; a hint is advisory, it changes no total, and a consumer that
 * wants it re-reads the row it is attached to.
 */
import { DateOnly, type Money as MoneyType } from '@core/kernel';
import { and, eq, gte, isNull, lte, ne, sql } from 'drizzle-orm';
import { transactions } from '../schema/index.ts';
import { moneyOf, type LedgerExecutor } from './db.ts';
import type { LedgerWriteContext } from './accounts.ts';

/** A merchant's refund window. Ninety days is the common card-network figure. */
export const DEFAULT_REFUND_WINDOW_DAYS = 90;

/** The slice of a transaction the refund heuristic sees. */
export interface RefundLeg {
  readonly id: string;
  readonly accountId: string;
  readonly merchantId: string | null;
  readonly date: DateOnly;
  readonly amountMinor: bigint;
  readonly currency: string;
  readonly name: string;
}

export interface RefundHint {
  readonly refundTransactionId: string;
  readonly purchaseTransactionId: string;
  readonly confidence: number;
  readonly full: boolean;
}

export interface RefundOptions {
  readonly windowDays?: number;
  readonly minConfidence?: number;
}

/**
 * Propose refund links. Pure, so the same property tests that grade the pairing
 * heuristic can grade this one.
 *
 * The gates:
 *
 *   * **same account** — a refund goes back to the instrument that paid;
 *   * **same merchant**, by resolved merchant id. A refund from a payee you have
 *     never paid is not a refund, it is income;
 *   * **opposite sign**, and the refund is the inflow;
 *   * **at or below the purchase magnitude** — a "refund" larger than the thing
 *     it reverses is something else, and guessing what is not this function's job;
 *   * **after the purchase**, within `windowDays`;
 *   * each purchase backs at most one refund, and each refund points at one
 *     purchase: a merchant refunding two identical charges gets the earlier
 *     purchase matched to the earlier refund, deterministically.
 */
export function proposeRefundHints(
  legs: readonly RefundLeg[],
  options: RefundOptions = {},
): RefundHint[] {
  const windowDays = options.windowDays ?? DEFAULT_REFUND_WINDOW_DAYS;
  const minConfidence = options.minConfidence ?? 0.5;

  const purchases = legs
    .filter((leg) => leg.amountMinor < 0n && leg.merchantId !== null)
    .sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  const refunds = legs
    .filter((leg) => leg.amountMinor > 0n && leg.merchantId !== null)
    .sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));

  const claimed = new Set<string>();
  const hints: RefundHint[] = [];

  for (const refund of refunds) {
    let best: { purchase: RefundLeg; confidence: number; full: boolean } | undefined;
    for (const purchase of purchases) {
      if (claimed.has(purchase.id)) continue;
      if (purchase.accountId !== refund.accountId) continue;
      if (purchase.merchantId !== refund.merchantId) continue;
      if (purchase.currency !== refund.currency) continue;
      const gap = DateOnly.differenceInDays(purchase.date, refund.date);
      if (gap < 0 || gap > windowDays) continue;
      const magnitude = -purchase.amountMinor;
      if (refund.amountMinor > magnitude) continue;

      const full = refund.amountMinor === magnitude;
      // A full reversal soon after the charge is the clearest case there is; a
      // partial one months later is a guess, and says so in its score.
      const recency = 1 - Math.min(gap / windowDays, 1);
      const confidence = round(
        (full ? 0.75 : 0.55) + 0.2 * recency + (looksLikeRefund(refund.name) ? 0.05 : 0),
      );
      if (confidence < minConfidence) continue;
      if (best === undefined || confidence > best.confidence) {
        best = { purchase, confidence, full };
      }
    }
    if (best === undefined) continue;
    claimed.add(best.purchase.id);
    hints.push({
      refundTransactionId: refund.id,
      purchaseTransactionId: best.purchase.id,
      confidence: best.confidence,
      full: best.full,
    });
  }
  return hints;
}

function looksLikeRefund(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.includes('refund') || lower.includes('return') || lower.includes('credit');
}

function round(value: number): number {
  return Math.min(1, Math.max(0.01, Number(value.toFixed(4))));
}

export interface DetectRefundsInput extends RefundOptions {
  readonly userId: string;
  readonly dateFrom?: DateOnly;
  readonly dateTo?: DateOnly;
}

/**
 * Find and record refund hints.
 *
 * Scoped to a window by the caller (the one a sync just touched, typically),
 * widened by `windowDays` on the lower end so a refund landing today can still
 * see the purchase it reverses three months ago.
 */
export async function detectRefundHints(
  executor: LedgerExecutor,
  input: DetectRefundsInput,
  context: LedgerWriteContext,
): Promise<RefundHint[]> {
  const windowDays = input.windowDays ?? DEFAULT_REFUND_WINDOW_DAYS;
  const lowerBound =
    input.dateFrom === undefined ? undefined : DateOnly.addDays(input.dateFrom, -windowDays);

  const rows = await executor
    .select({
      id: transactions.id,
      accountId: transactions.accountId,
      merchantId: transactions.effectiveMerchantId,
      date: transactions.effectiveDate,
      amountMinor: transactions.effectiveAmountMinor,
      currency: transactions.effectiveCurrency,
      name: transactions.effectiveName,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.userId, input.userId),
        isNull(transactions.removedAt),
        isNull(transactions.supersededById),
        eq(transactions.isTransfer, false),
        ne(transactions.effectiveAmountMinor, 0n),
        lowerBound === undefined ? undefined : gte(transactions.effectiveDate, lowerBound),
        input.dateTo === undefined ? undefined : lte(transactions.effectiveDate, input.dateTo),
      ),
    );

  const legs: RefundLeg[] = rows.map((row) => ({
    id: row.id,
    accountId: row.accountId,
    merchantId: row.merchantId,
    date: DateOnly.parse(row.date),
    amountMinor: row.amountMinor,
    currency: row.currency.trim(),
    name: row.name,
  }));

  const hints = proposeRefundHints(legs, { ...input, windowDays });
  const now = context.clock.now();
  for (const hint of hints) {
    await executor
      .update(transactions)
      .set({
        refundOfId: hint.purchaseTransactionId,
        refundConfidence: hint.confidence,
        updatedAt: now,
      })
      .where(
        and(
          eq(transactions.id, hint.refundTransactionId),
          eq(transactions.userId, input.userId),
          // Never overwrite a hint a user has already acted on, and never write
          // one that is already there: a re-run is a no-op, which is what makes
          // calling this after every sync safe.
          sql`(${transactions.refundOfId} IS NULL OR ${transactions.refundOfId} = ${hint.purchaseTransactionId}::uuid)`,
        ),
      );
  }
  return hints;
}

/** The refund hint attached to one row, resolved for display. */
export interface RefundHintSummary {
  readonly purchaseTransactionId: string;
  readonly confidence: number;
  readonly amount: MoneyType;
}

export function refundHintOf(row: {
  refundOfId: string | null;
  refundConfidence: number | null;
  effectiveAmountMinor: bigint;
  effectiveCurrency: string;
}): RefundHintSummary | null {
  if (row.refundOfId === null) return null;
  return {
    purchaseTransactionId: row.refundOfId,
    confidence: row.refundConfidence ?? 0,
    amount: moneyOf(row.effectiveAmountMinor, row.effectiveCurrency),
  };
}
