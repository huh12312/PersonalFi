// SPDX-License-Identifier: MIT
/**
 * The never-zero-basis rule, which is the one thing in this package that is
 * worth more than the arithmetic around it.
 *
 * 04 §5.5: "Where basis is unknown, report unrealized gain as *unavailable*
 * rather than computing it from a zero basis." The failure mode this prevents
 * is not an error message — it is a number. A $40,000 position with no basis
 * reported as a $40,000 gain looks exactly like a $40,000 gain, flows into the
 * allocation chart, into the tax estimate and onto the screen, and nothing
 * anywhere says it was invented.
 *
 * The sabotage recorded in `docs/evidence/phase-3/wp3.2-lots.md` is one line:
 * coalescing the null basis to `Money.zero` inside `costBasisOf`. These tests
 * are what turns red when it is applied.
 */
import { DateOnly, Money, Quantity, currency } from '@core/kernel';
import { describe, expect, it } from 'vitest';
import {
  PRICE_UNKNOWN_WARNING,
  costBasisOf,
  lotsWithoutBasis,
  marketValueOf,
  unrealizedGainOf,
  type LotPrice,
} from './basis.ts';
import { UNKNOWN_BASIS_WARNING, matchDisposal, openLot, type Lot } from './lots.ts';

const USD = currency('USD');
const ACCOUNT = 'acct-brokerage';
const SECURITY = 'sec-vti';

const usd = (dollars: string): ReturnType<typeof Money.of> =>
  Money.of(BigInt(dollars.replace('.', '')), USD);

const price = (amount: string): LotPrice => ({ amount: Quantity.of(amount), currency: USD });

function lot(id: string, quantity: string, basisDollars: string | null): Lot {
  return openLot({
    id,
    accountId: ACCOUNT,
    securityId: SECURITY,
    openDate: DateOnly.parse('2024-01-15'),
    quantity: Quantity.of(quantity),
    basis: basisDollars === null ? null : usd(basisDollars),
    currency: USD,
    basisSource: basisDollars === null ? 'ESTIMATED' : 'BROKER',
    acquisitionType: 'BUY',
  }).lot;
}

describe('unrealized gain', () => {
  it('an unknown basis yields unavailable, not zero', () => {
    const unknown = [lot('lot-unknown', '100', null)];

    const basis = costBasisOf(unknown, USD);
    expect(basis.status).toBe('unavailable');
    // The specific fabrication being refused: not `{ available, $0.00 }`.
    expect(basis).not.toMatchObject({ status: 'available' });
    expect(basis).toEqual({ status: 'unavailable', lotIds: ['lot-unknown'] });

    const gain = unrealizedGainOf(unknown, price('250.00'), { scale: 2 });
    expect(gain.status).toBe('unavailable');
    if (gain.status !== 'unavailable') throw new Error('unreachable');
    expect(gain.reason).toBe('basis_unknown');
    expect(gain.lotIds).toEqual(['lot-unknown']);
    // 07 §6.2 requires the warning to be *visible*, so it travels with the
    // answer rather than being something a caller has to know to ask for.
    expect(gain.warning).toBe(UNKNOWN_BASIS_WARNING);
    expect(gain.warning.length).toBeGreaterThan(0);

    // There is no `gain` field to read at all — which is the point of the
    // union. A `{ gain, known: false }` shape would render as $25,000.
    expect('gain' in gain).toBe(false);
    expect('costBasis' in gain).toBe(false);
  });

  it('a lot with unknown basis reports unrealized gain as unavailable, never zero', () => {
    // The same rule stated over a *mixed* position, which is the case the R6
    // verdict makes routine: Coinbase v3 gives an exact fill for one lot and
    // nothing at all for the deposit that created the other three.
    const mixed = [
      lot('lot-broker', '1', '30000.00'),
      lot('lot-deposit', '0.5', null),
      lot('lot-staking', '0.01', null),
    ];

    const gain = unrealizedGainOf(mixed, price('60000.00'), { scale: 2 });
    expect(gain.status).toBe('unavailable');
    if (gain.status !== 'unavailable') throw new Error('unreachable');
    expect(gain.reason).toBe('basis_unknown');
    // Both unknown lots are named, so the UI can tell the user which two
    // deposits to supply a basis for rather than declaring the portfolio
    // unknowable.
    expect([...gain.lotIds].sort()).toEqual(['lot-deposit', 'lot-staking']);

    // The known lot's $30,000 gain is *not* reported as the position's gain.
    // Summing only the knowable part yields a smaller number that is
    // indistinguishable from a complete one — the specific failure 04 §5.5
    // names.
    expect(gain).not.toMatchObject({ status: 'available' });

    // Market value is still reported, because the position's *worth* is
    // knowable even when its cost is not. 1.51 × $60,000 = $90,600.
    expect(gain.marketValue).toEqual(usd('90600.00'));

    expect(lotsWithoutBasis(mixed)).toEqual(['lot-deposit', 'lot-staking']);
  });

  it('a fully known position reports a real gain', () => {
    const known = [lot('lot-a', '10', '1000.00'), lot('lot-b', '10', '3000.00')];
    const gain = unrealizedGainOf(known, price('250.00'), { scale: 2 });
    expect(gain).toEqual({
      status: 'available',
      marketValue: usd('5000.00'),
      costBasis: usd('4000.00'),
      gain: usd('1000.00'),
    });
  });

  it('a missing price is its own unavailable, and reports no market value either', () => {
    const known = [lot('lot-a', '10', '1000.00')];
    const gain = unrealizedGainOf(known, null, { scale: 2 });
    expect(gain.status).toBe('unavailable');
    if (gain.status !== 'unavailable') throw new Error('unreachable');
    expect(gain.reason).toBe('price_unknown');
    expect(gain.warning).toBe(PRICE_UNKNOWN_WARNING);
    // A portfolio valued at a price nobody has is not valued.
    expect(gain.marketValue).toBeNull();
  });

  it('a closed lot contributes neither basis nor market value', () => {
    const lots = [lot('lot-open', '10', '1000.00'), lot('lot-sold', '10', '9999.00')];
    const afterSale = matchDisposal(lots, {
      accountId: ACCOUNT,
      securityId: SECURITY,
      date: DateOnly.parse('2025-01-01'),
      quantity: Quantity.of('10'),
      proceeds: usd('10000.00'),
      specificLotIds: ['lot-sold'],
      method: 'SPECIFIC_ID',
    });
    const gain = unrealizedGainOf(afterSale.lots, price('200.00'), { scale: 2 });
    expect(gain).toEqual({
      status: 'available',
      marketValue: usd('2000.00'),
      costBasis: usd('1000.00'),
      gain: usd('1000.00'),
    });
  });

  it('an unknown basis on a *closed* lot does not poison an otherwise known position', () => {
    // Symmetry with the test above: `costBasisOf` filters to open lots, so a
    // fully-disposed unknown lot in the history does not make today's position
    // unreportable. The rule is about what you hold, not what you held.
    const lots = [lot('lot-open', '10', '1000.00'), lot('lot-gone', '10', null)];
    const afterSale = matchDisposal(lots, {
      accountId: ACCOUNT,
      securityId: SECURITY,
      date: DateOnly.parse('2025-01-01'),
      quantity: Quantity.of('10'),
      proceeds: usd('10000.00'),
      specificLotIds: ['lot-gone'],
      method: 'SPECIFIC_ID',
    });
    expect(unrealizedGainOf(afterSale.lots, price('200.00'), { scale: 2 }).status).toBe(
      'available',
    );
  });
});

describe('market value arithmetic', () => {
  it('multiplies an 18-decimal quantity by a 10-decimal price without a float', () => {
    // 0.00000001 BTC at $63,214.5678901234 is $0.00063214…, which rounds to a
    // zero-cent market value — and rounds there *once*, at the boundary into
    // minor units, rather than through a `number` that lost the eighth decimal
    // before the multiplication started.
    expect(marketValueOf(Quantity.of('0.00000001'), price('63214.5678901234'), 2)).toEqual(
      usd('0.00'),
    );
    // 3.33333333 × 63214.5678901234 = 210715.226089696107032922 exactly, so
    // the position is worth $210,715.23 — the full product is carried and
    // rounded once, not truncated at some intermediate width.
    expect(marketValueOf(Quantity.of('3.33333333'), price('63214.5678901234'), 2)).toEqual(
      Money.of(21_071_523n, USD),
    );
  });

  it('rounds half to even, once, at the minor-unit boundary', () => {
    // $0.125 → $0.12 and $0.135 → $0.14: banker's rounding, so a long series
    // of prices does not drift upward the way half-up does.
    expect(marketValueOf(Quantity.of('1'), price('0.125'), 2)).toEqual(Money.of(12n, USD));
    expect(marketValueOf(Quantity.of('1'), price('0.135'), 2)).toEqual(Money.of(14n, USD));
  });

  it('respects a currency whose minor unit is not two digits', () => {
    // JPY has no minor unit. Assuming 2 is the bug 04 §2.3 names by name.
    const jpy: LotPrice = { amount: Quantity.of('150.5'), currency: currency('JPY') };
    expect(marketValueOf(Quantity.of('10'), jpy, 0)).toEqual(Money.of(1505n, currency('JPY')));
  });
});
