// SPDX-License-Identifier: MIT
/**
 * Idle cash — 07's I3: *"Brokerage cash > max($1,000, 2% of account) for > 14
 * days and not earmarked"*.
 *
 * Every part of that trigger is a guard against a false alarm, and each one is
 * a constant here rather than a literal at a comparison site:
 *
 *   * **`max($1,000, 2%)`** — a floor *and* a share. A $300 sweep balance in a
 *     $2,000 account is 15% and not worth a sentence; $1,500 in a $500,000
 *     account is 0.3% and also not worth one. A single threshold gets one of
 *     those two cases wrong.
 *   * **`> 14 days`** — cash that arrived this morning is a dividend or a sale
 *     waiting to settle, not a decision the user forgot to make. The age is an
 *     input rather than something derived here, because "how long has this
 *     balance been sitting?" is a question about a snapshot history (WP 3.2's
 *     `holdings_snapshots`) and this module reads nothing.
 *   * **`not earmarked`** — money reserved for a known purpose is not idle.
 *     There is no way to infer this, so it is an explicit flag; a rule that
 *     nags about the down payment somebody deliberately parked is a rule the
 *     user turns off, taking the useful alerts with it.
 *
 * The impact 07 quotes is `x × (expected_return − sweep_apy)`, which needs an
 * assumption this context does not own. This module reports the **amount and
 * its age**; WP 3.10's I3 supplies the rate and pairs it with its caveat.
 */
import { Money, type CurrencyCode, type Money as MoneyType } from '@core/kernel';
import { valueHoldings, type ValuationSet } from './allocation.ts';
import {
  AnalyticsInputError,
  RATIO_ZERO,
  ratio,
  ratioOfMoney,
  scaleMoney,
  type AnalyticsHolding,
  type Ratio,
  type ValuationOptions,
} from './types.ts';

/** 07 I3's floor, in minor units of the account's currency: `$1,000`. */
export const IDLE_CASH_FLOOR_MINOR = 100_000n;

/** 07 I3's share of the account: 2%. */
export const IDLE_CASH_ACCOUNT_SHARE: Ratio = ratio('0.02');

/** 07 I3's dwell time: strictly more than fourteen days. */
export const IDLE_CASH_MIN_DAYS = 14;

export interface CashPosition {
  readonly accountId: string;
  /** Cash and cash equivalents in the account. */
  readonly cash: MoneyType;
  /** Everything in the account, cash included — the 2% denominator. */
  readonly accountValue: MoneyType;
  /** Days this balance has been at or above its current level. An input, not a guess. */
  readonly idleDays: number;
  /** Reserved for a known purpose, so not idle however long it sits. */
  readonly earmarked: boolean;
}

export interface IdleCashRow {
  readonly accountId: string;
  readonly cash: MoneyType;
  readonly accountValue: MoneyType;
  /** `max($1,000, 2% of account)`, computed and reported, not just applied. */
  readonly threshold: MoneyType;
  readonly cashWeight: Ratio;
  readonly idleDays: number;
  readonly earmarked: boolean;
  /** Over the threshold, past the dwell time, and not earmarked. */
  readonly idle: boolean;
}

export interface IdleCashReport {
  readonly currency: CurrencyCode;
  readonly rows: readonly IdleCashRow[];
  /** Σ of the idle rows only. Zero when nothing qualifies — a real zero. */
  readonly idleTotal: MoneyType;
  readonly floor: MoneyType;
  readonly accountShare: Ratio;
  readonly minDays: number;
}

/**
 * Which accounts are holding idle cash, and how much.
 *
 * Pure over explicit positions: nothing here reads an account, a snapshot or a
 * clock. `idleDays` is supplied by the caller that owns the history.
 */
export function idleCash(
  positions: readonly CashPosition[],
  options: { readonly currency: CurrencyCode },
): IdleCashReport {
  const floor = Money.of(IDLE_CASH_FLOOR_MINOR, options.currency);
  const rows: IdleCashRow[] = positions.map((position) => {
    if (position.cash.currency !== options.currency) {
      throw new AnalyticsInputError(
        `a ${position.cash.currency} cash balance cannot be measured against a ${options.currency} threshold`,
      );
    }
    if (!Number.isInteger(position.idleDays) || position.idleDays < 0) {
      throw new AnalyticsInputError(
        `idleDays must be a whole number of days, got ${position.idleDays}`,
      );
    }
    const share = scaleMoney(position.accountValue, IDLE_CASH_ACCOUNT_SHARE);
    const threshold = Money.max(floor, share);
    return {
      accountId: position.accountId,
      cash: position.cash,
      accountValue: position.accountValue,
      threshold,
      cashWeight: Money.isZero(position.accountValue)
        ? RATIO_ZERO
        : ratioOfMoney(position.cash, position.accountValue),
      idleDays: position.idleDays,
      earmarked: position.earmarked,
      idle:
        !position.earmarked &&
        position.idleDays > IDLE_CASH_MIN_DAYS &&
        Money.compare(position.cash, threshold) > 0,
    };
  });

  return {
    currency: options.currency,
    rows,
    idleTotal: rows
      .filter((row) => row.idle)
      .reduce((running, row) => Money.add(running, row.cash), Money.zero(options.currency)),
    floor,
    accountShare: IDLE_CASH_ACCOUNT_SHARE,
    minDays: IDLE_CASH_MIN_DAYS,
  };
}

/**
 * Cash and cash equivalents per account, from valued holdings.
 *
 * A "cash holding" is one the classifier called `CASH` **or** flagged
 * `is_cash_equivalent` — a sweep money-market fund is cash for this purpose
 * however it is typed, which is 07 §4.3's reason for carrying the boolean
 * beside the asset class rather than folding one into the other.
 */
export function cashByAccount(set: ValuationSet): ReadonlyMap<string, MoneyType> {
  const byAccount = new Map<string, MoneyType>();
  for (const entry of set.valued) {
    if (!isCash(entry.holding)) continue;
    const existing = byAccount.get(entry.holding.accountId) ?? Money.zero(set.currency);
    byAccount.set(entry.holding.accountId, Money.add(existing, entry.marketValue));
  }
  return byAccount;
}

/** Total account value per account, cash included. The 2% denominator. */
export function valueByAccount(set: ValuationSet): ReadonlyMap<string, MoneyType> {
  const byAccount = new Map<string, MoneyType>();
  for (const entry of set.valued) {
    const existing = byAccount.get(entry.holding.accountId) ?? Money.zero(set.currency);
    byAccount.set(entry.holding.accountId, Money.add(existing, entry.marketValue));
  }
  return byAccount;
}

/** The cash weight of a whole portfolio — reported beside allocation, never hidden. */
export function cashWeightOf(
  holdings: readonly AnalyticsHolding[],
  options: ValuationOptions,
): Ratio {
  const set = valueHoldings(holdings, options);
  if (Money.isZero(set.total)) return RATIO_ZERO;
  const cash = set.valued
    .filter((entry) => isCash(entry.holding))
    .reduce((running, entry) => Money.add(running, entry.marketValue), Money.zero(set.currency));
  return ratioOfMoney(cash, set.total);
}

function isCash(holding: AnalyticsHolding): boolean {
  return holding.assetClass === 'CASH' || holding.isCashEquivalent;
}
