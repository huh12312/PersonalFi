// SPDX-License-Identifier: MIT
/**
 * Splits, reverse splits, and the invariant that makes them safe: **total basis
 * does not move.**
 *
 * A split is not an economic event. The holder owns the same fraction of the
 * same company before and after, so quantity scales, per-unit basis scales the
 * other way, and the sum is untouched. Getting that wrong does not produce an
 * error — it produces a portfolio whose cost basis drifts by a few cents per
 * corporate action and can never again be reconciled to a brokerage statement.
 */
import { DateOnly, Money, Quantity, currency } from '@core/kernel';
import { describe, expect, it } from 'vitest';
import {
  applySplit,
  isReverseSplit,
  scaleQuantity,
  splitRatio,
  totalBasisOf,
} from './corporate-actions.ts';
import {
  LotError,
  matchDisposal,
  openLot,
  remainingBasisPerUnit,
  termOf,
  type Lot,
} from './lots.ts';

const USD = currency('USD');
const ACCOUNT = 'acct-brokerage';
const SECURITY = 'sec-aapl';

const usd = (dollars: string): ReturnType<typeof Money.of> =>
  Money.of(BigInt(dollars.replace('.', '')), USD);

function lot(id: string, quantity: string, basisDollars: string, securityId = SECURITY): Lot {
  return openLot({
    id,
    accountId: ACCOUNT,
    securityId,
    openDate: DateOnly.parse('2023-05-01'),
    quantity: Quantity.of(quantity),
    basis: usd(basisDollars),
    currency: USD,
    basisSource: 'BROKER',
    acquisitionType: 'BUY',
  }).lot;
}

describe('splits', () => {
  it('a 4:1 split quadruples quantity, quarters per-unit basis and leaves total basis unchanged to the cent', () => {
    // 10 shares, $1,000 basis, $100 per share. After a 4:1 split: 40 shares,
    // $1,000 basis, $25 per share.
    //
    // `remainingBasisPerUnit` is *minor units* per share — 10,000 cents, not
    // 100 dollars. It is a ratio HIFO compares and nothing stores, so it never
    // crosses a column boundary; asserting it in cents here is what stops a
    // later reader from reading it as dollars and writing it somewhere.
    const before = [lot('lot-a', '10', '1000.00')];
    expect(remainingBasisPerUnit(before[0] as Lot)).toBe(Quantity.of('10000'));

    const { lots: after, adjustedLotIds } = applySplit(before, {
      securityId: SECURITY,
      ratio: splitRatio(4n, 1n),
      effectiveDate: '2024-06-10',
    });

    const split = after[0] as Lot;
    expect(adjustedLotIds).toEqual(['lot-a']);
    expect(Quantity.toDatabaseString(split.quantity)).toBe('40.000000000000000000');
    expect(Quantity.toDatabaseString(split.quantityRemaining)).toBe('40.000000000000000000');
    // $25.00 per share, in cents.
    expect(remainingBasisPerUnit(split)).toBe(Quantity.of('2500'));

    // The invariant, stated on the total rather than on a per-unit figure:
    // exactly equal, in bigint minor units, so "to the cent" is literal.
    expect(totalBasisOf(after)).toEqual(totalBasisOf(before));
    expect(totalBasisOf(after)).toEqual(usd('1000.00'));
    expect(split.basis?.minor).toBe(100_000n);
  });

  it('a 3:2 split is exact, where 1.5 as a float would not be', () => {
    // The reason the ratio is two bigints. 100 shares → 150; $1,234.57 of
    // basis stays $1,234.57 because it is carried, not multiplied by 1.5 and
    // divided back.
    const before = [lot('lot-a', '100', '1234.57')];
    const { lots: after } = applySplit(before, {
      securityId: SECURITY,
      ratio: splitRatio(3n, 2n),
    });
    expect(Quantity.toDatabaseString((after[0] as Lot).quantity)).toBe('150.000000000000000000');
    expect(totalBasisOf(after)).toEqual(usd('1234.57'));
  });

  it('a 1:10 reverse split divides quantity and leaves the total basis alone', () => {
    const ratio = splitRatio(1n, 10n);
    expect(isReverseSplit(ratio)).toBe(true);
    expect(isReverseSplit(splitRatio(4n, 1n))).toBe(false);

    const before = [lot('lot-a', '1000', '5000.00')];
    const { lots: after } = applySplit(before, { securityId: SECURITY, ratio });
    const split = after[0] as Lot;
    expect(Quantity.toDatabaseString(split.quantity)).toBe('100.000000000000000000');
    // $50.00 per share, in cents.
    expect(remainingBasisPerUnit(split)).toBe(Quantity.of('5000'));
    expect(totalBasisOf(after)).toEqual(usd('5000.00'));
  });

  it('a split is not an acquisition: the holding period and the basis source survive', () => {
    // If a split restarted the clock, every long-term holding in a company
    // that split would silently become short-term.
    const before = [lot('lot-a', '10', '1000.00')];
    const { lots: after } = applySplit(before, {
      securityId: SECURITY,
      ratio: splitRatio(4n, 1n),
    });
    const split = after[0] as Lot;
    expect(split.openDate).toBe((before[0] as Lot).openDate);
    expect(split.holdingPeriodStartDate).toBe((before[0] as Lot).holdingPeriodStartDate);
    expect(split.basisSource).toBe('BROKER');
    expect(split.acquisitionType).toBe('BUY');
    expect(split.washSaleAdjustment).toEqual(Money.zero(USD));
    expect(termOf(split.holdingPeriodStartDate, DateOnly.parse('2025-01-01'))).toBe('LONG_TERM');
  });

  it('leaves every other security alone', () => {
    const before = [lot('lot-aapl', '10', '1000.00'), lot('lot-msft', '10', '2000.00', 'sec-msft')];
    const { lots: after, adjustedLotIds } = applySplit(before, {
      securityId: SECURITY,
      ratio: splitRatio(4n, 1n),
    });
    expect(adjustedLotIds).toEqual(['lot-aapl']);
    expect(Quantity.toDatabaseString((after[1] as Lot).quantity)).toBe('10.000000000000000000');
  });

  it('re-runs the lot math forward: a sale after the split consumes split-adjusted shares', () => {
    // The dispatch's "then re-run lot math forward". A sale of 20 shares after
    // a 4:1 split takes half the lot, so half the basis — $500 of $1,000 — and
    // not the $2,000 a pre-split per-unit figure would have produced.
    const before = [lot('lot-a', '10', '1000.00')];
    const { lots: after } = applySplit(before, {
      securityId: SECURITY,
      ratio: splitRatio(4n, 1n),
    });
    const sale = matchDisposal(after, {
      accountId: ACCOUNT,
      securityId: SECURITY,
      date: DateOnly.parse('2025-01-01'),
      quantity: Quantity.of('20'),
      proceeds: usd('1500.00'),
    });
    expect(sale.matches[0]?.basis).toEqual(usd('500.00'));
    expect(sale.realized.longTerm).toEqual({ status: 'available', amount: usd('1000.00') });

    // And the conservation still holds across the split *and* the sale.
    expect(totalBasisOf(sale.lots)).toEqual(usd('1000.00'));
  });

  it('a partially sold lot splits both its quantity and its remainder', () => {
    const before = [lot('lot-a', '10', '1000.00')];
    const sold = matchDisposal(before, {
      accountId: ACCOUNT,
      securityId: SECURITY,
      date: DateOnly.parse('2024-01-01'),
      quantity: Quantity.of('4'),
      proceeds: usd('500.00'),
    });
    const { lots: after } = applySplit(sold.lots, {
      securityId: SECURITY,
      ratio: splitRatio(4n, 1n),
    });
    const split = after[0] as Lot;
    expect(Quantity.toDatabaseString(split.quantity)).toBe('40.000000000000000000');
    // 6 remaining × 4 = 24, and `quantity_remaining <= quantity` still holds —
    // scaling only one of the two would violate 0014's CHECK.
    expect(Quantity.toDatabaseString(split.quantityRemaining)).toBe('24.000000000000000000');
    expect(Quantity.compare(split.quantityRemaining, split.quantity)).toBeLessThanOrEqual(0);
  });

  it('refuses a ratio that is not two positive integers', () => {
    expect(() => splitRatio(0n, 1n)).toThrowError(LotError);
    expect(() => splitRatio(4n, 0n)).toThrowError(LotError);
    expect(() => splitRatio(-4n, 1n)).toThrowError(/two positive integers/);
  });

  it('scaleQuantity keeps 18 decimals of a crypto quantity exact', () => {
    // A 2:1 "split" is not a real corporate action for BTC, but the scaling is
    // the same arithmetic and the satoshi is where a float would show.
    expect(
      Quantity.toDatabaseString(scaleQuantity(Quantity.of('0.00000001'), splitRatio(2n, 1n))),
    ).toBe('0.000000020000000000');
  });

  it('totalBasisOf refuses to total a set containing an unknown basis', () => {
    const lots = [
      lot('lot-known', '10', '1000.00'),
      openLot({
        id: 'lot-unknown',
        accountId: ACCOUNT,
        securityId: SECURITY,
        openDate: DateOnly.parse('2023-05-01'),
        quantity: Quantity.of('5'),
        basis: null,
        currency: USD,
        basisSource: 'ESTIMATED',
        acquisitionType: 'TRANSFER_IN',
      }).lot,
    ];
    // `null`, not $1,000 — a total that silently omits a lot is smaller than
    // the truth and looks exactly like a correct one.
    expect(totalBasisOf(lots)).toBeNull();
  });
});
