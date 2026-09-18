// SPDX-License-Identifier: MIT
/**
 * The two-sided changepoint, tested from the side that matters: the things that
 * are **not** price changes.
 *
 * A one-sided rule (latest versus the median of what came before) fires on every
 * one of these, and each false "your subscription went up" is a notification, a
 * dollar-impact figure and a line in the insight feed built on nothing.
 */

import { DateOnly, Money } from '@core/kernel';
import { describe, expect, it } from 'vitest';
import { detectRecurring } from './detect.ts';
import { detectPriceChanges } from './price-change.ts';
import type { MerchantFacts, Occurrence, RecurringInput } from './types.ts';
import { fixedClock } from '@core/kernel';

function series(amounts: readonly bigint[], startMonth = 1): Occurrence[] {
  return amounts.map((minor, index) => ({
    transactionId: `t-${index}`,
    accountId: 'acc-1',
    date: DateOnly.addMonths(DateOnly.of(2025, startMonth, 12), index),
    amount: Money.of(-minor, 'USD'),
    residualDays: 0,
    duplicateOf: null,
  }));
}

const MONTHLY_FIXED = {
  streamKey: 'stream-1',
  cadence: 'MONTHLY' as const,
  // 04 §5.1's band for a ~$13 plan: max(5% of median, $1.00) = $1.00.
  tolerance: Money.of(100n, 'USD'),
};

describe('price change', () => {
  it('a one-off proration is not a price increase', () => {
    // Six months at $12.99, one prorated month at $4.33 when the plan changed,
    // then $12.99 again. A one-sided rule sees −67% and then +200%.
    const occurrences = series([1299n, 1299n, 1299n, 433n, 1299n, 1299n, 1299n, 1299n]);
    expect(detectPriceChanges(occurrences, MONTHLY_FIXED)).toEqual([]);

    // The same proration as the *latest* charge, where a one-sided rule is at
    // its most confident and most wrong.
    const trailing = series([1299n, 1299n, 1299n, 1299n, 1299n, 433n]);
    expect(detectPriceChanges(trailing, MONTHLY_FIXED)).toEqual([]);

    // And through the whole engine: the prorated charge buckets away from the
    // stream on amount, so the subscription keeps its price and its model.
    const facts = new Map<string, MerchantFacts>([['mer-1', { class: 'SUBSCRIPTION' }]]);
    const rows: RecurringInput[] = series([
      1299n,
      1299n,
      1299n,
      433n,
      1299n,
      1299n,
      1299n,
      1299n,
    ]).map((occurrence) => ({
      transactionId: occurrence.transactionId,
      merchantId: 'mer-1',
      accountId: 'acc-1',
      amount: occurrence.amount,
      date: occurrence.date,
      pending: false,
      isTransfer: false,
    }));
    const result = detectRecurring(rows, {
      clock: fixedClock('2025-09-15T12:00:00Z'),
      timeZone: 'UTC',
      merchantFacts: facts,
    });
    expect(result.priceChanges).toEqual([]);
    const main = result.streams.find((stream) => stream.type === 'SUBSCRIPTION');
    expect(main?.typicalAmount.minor).toBe(-1299n);
    expect(main?.amountModel).toBe('FIXED');
  });

  it('a genuine hike is a changepoint with both sides stable', () => {
    const occurrences = series([1799n, 1799n, 1799n, 1799n, 2194n, 2194n, 2194n]);
    const changes = detectPriceChanges(occurrences, MONTHLY_FIXED);
    expect(changes).toHaveLength(1);
    const change = changes[0];
    expect(change?.direction).toBe('INCREASE');
    expect(change?.from.minor).toBe(1799n);
    expect(change?.to.minor).toBe(2194n);
    expect(change?.delta.minor).toBe(395n);
    // Annualised by exact integer multiply: 12 monthly periods.
    expect(change?.annualImpact.minor).toBe(4740n);
    expect(change?.confirmed).toBe(true);
    expect(change?.priorTransactionIds).toHaveLength(3);
    expect(change?.recentTransactionIds).toHaveLength(2);
  });

  it('a second hike is measured against the new baseline, not the original', () => {
    const occurrences = series([999n, 999n, 999n, 1199n, 1199n, 1199n, 1499n, 1499n, 1499n]);
    const changes = detectPriceChanges(occurrences, MONTHLY_FIXED);
    expect(changes.map((change) => [change.from.minor, change.to.minor])).toEqual([
      [999n, 1199n],
      [1199n, 1499n],
    ]);
  });

  it('a wobbly "fixed" amount does not produce a change from its own noise', () => {
    // A payroll-style deposit whose amount moves a few tenths of a percent.
    // Every window is inside tolerance and the medians still differ by more
    // than 3%; only the MAD floor separates this from a raise.
    const occurrences = series([
      142_010n,
      139_880n,
      141_550n,
      144_090n,
      143_260n,
      140_770n,
      145_120n,
    ]);
    const changes = detectPriceChanges(occurrences, {
      ...MONTHLY_FIXED,
      tolerance: Money.of(7_100n, 'USD'),
    });
    expect(changes).toEqual([]);
  });

  it('an unconfirmed drop waits; an unconfirmed large rise does not', () => {
    const dropped = series([1299n, 1299n, 1299n, 1299n, 499n]);
    expect(detectPriceChanges(dropped, MONTHLY_FIXED)).toEqual([]);

    const jumped = series([1299n, 1299n, 1299n, 1299n, 2499n]);
    const changes = detectPriceChanges(jumped, MONTHLY_FIXED);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.direction).toBe('INCREASE');
    expect(changes[0]?.confirmed).toBe(false);
  });

  it('a series shorter than the prior window has no price history', () => {
    expect(detectPriceChanges(series([1299n, 1299n, 1299n]), MONTHLY_FIXED)).toEqual([]);
  });
});
