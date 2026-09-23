// SPDX-License-Identifier: MIT
/**
 * Idle cash — 07 I3's three conditions, each tested on its own, because a rule
 * with an `&&` in it is three rules and only one of them usually gets a test.
 */
import { Money, currency } from '@core/kernel';
import { describe, expect, it } from 'vitest';
import { FIXTURE_HOLDINGS } from '../../test/fixtures/portfolio.ts';
import { valueHoldings } from './allocation.ts';
import {
  IDLE_CASH_FLOOR_MINOR,
  IDLE_CASH_MIN_DAYS,
  cashByAccount,
  cashWeightOf,
  idleCash,
  valueByAccount,
  type CashPosition,
} from './cash.ts';
import { AnalyticsInputError, type ValuationOptions } from './types.ts';

const USD = currency('USD');
const LAST_KNOWN: ValuationOptions = { currency: USD, scale: 2, basis: 'last_known' };
const usd = (dollars: string) => Money.parseAmount(dollars, USD);

const position = (overrides: Partial<CashPosition> = {}): CashPosition => ({
  accountId: 'acct-taxable',
  cash: usd('12500.00'),
  accountValue: usd('100000.00'),
  idleDays: 30,
  earmarked: false,
  ...overrides,
});

describe('idle cash', () => {
  it('needs all three of 07 I3’s conditions', () => {
    expect(idleCash([position()], { currency: USD }).rows[0]?.idle).toBe(true);

    // Under the dwell time: a sale that has not settled is not a decision.
    expect(idleCash([position({ idleDays: 14 })], { currency: USD }).rows[0]?.idle).toBe(false);
    expect(idleCash([position({ idleDays: 15 })], { currency: USD }).rows[0]?.idle).toBe(true);
    expect(IDLE_CASH_MIN_DAYS).toBe(14);

    // Earmarked: reserved money is not idle however long it sits.
    expect(idleCash([position({ earmarked: true })], { currency: USD }).rows[0]?.idle).toBe(false);

    // Under the threshold.
    expect(idleCash([position({ cash: usd('900.00') })], { currency: USD }).rows[0]?.idle).toBe(
      false,
    );
  });

  it('uses max($1,000, 2% of the account), not one or the other', () => {
    // Small account: the floor binds. 2% of $2,000 is $40, and a $300 sweep
    // balance is not worth a sentence.
    const small = idleCash([position({ cash: usd('300.00'), accountValue: usd('2000.00') })], {
      currency: USD,
    });
    expect(Money.formatAmount(small.rows[0]?.threshold ?? Money.zero(USD))).toBe('1000.00');
    expect(small.rows[0]?.idle).toBe(false);

    // Large account: the share binds. $1,500 in $500,000 is 0.3% and also not
    // worth a sentence, even though it clears the floor.
    const large = idleCash([position({ cash: usd('1500.00'), accountValue: usd('500000.00') })], {
      currency: USD,
    });
    expect(Money.formatAmount(large.rows[0]?.threshold ?? Money.zero(USD))).toBe('10000.00');
    expect(large.rows[0]?.idle).toBe(false);

    expect(Money.of(IDLE_CASH_FLOOR_MINOR, USD)).toEqual(usd('1000.00'));
  });

  it('totals only what qualifies, and answers zero as a real zero', () => {
    const report = idleCash(
      [
        position({ accountId: 'acct-a' }),
        position({ accountId: 'acct-b', cash: usd('40000.00'), earmarked: true }),
        position({ accountId: 'acct-c', cash: usd('800.00') }),
      ],
      { currency: USD },
    );
    expect(Money.formatAmount(report.idleTotal)).toBe('12500.00');
    expect(report.rows.filter((row) => row.idle)).toHaveLength(1);

    const none = idleCash([position({ earmarked: true })], { currency: USD });
    expect(Money.formatAmount(none.idleTotal)).toBe('0.00');
  });

  it('refuses a currency it was not asked about, rather than adding it', () => {
    expect(() =>
      idleCash([position({ cash: Money.parseAmount('500.00', currency('EUR')) })], {
        currency: USD,
      }),
    ).toThrow(AnalyticsInputError);
    expect(() => idleCash([position({ idleDays: -1 })], { currency: USD })).toThrow(
      AnalyticsInputError,
    );
  });

  it('finds the cash in a portfolio of holdings, sweep funds included', () => {
    const set = valueHoldings(FIXTURE_HOLDINGS, LAST_KNOWN);
    const cash = cashByAccount(set);
    expect(Money.formatAmount(cash.get('acct-taxable') ?? Money.zero(USD))).toBe('12500.00');
    expect(cash.has('acct-ira')).toBe(false);

    const values = valueByAccount(set);
    expect(Money.formatAmount(values.get('acct-crypto') ?? Money.zero(USD))).toBe('19870.60');

    // 12,500 / 176,499.60 — reported beside allocation rather than hidden in it.
    expect(cashWeightOf(FIXTURE_HOLDINGS, LAST_KNOWN)).toBe('0.0708216902');
  });
});
