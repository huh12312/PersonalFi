// SPDX-License-Identifier: MIT
/**
 * The `number` boundary, on this package's side of it.
 *
 * D3 is irreversible and the Phase 1 incident is the reason: `toFixed(18)`
 * manufactured seventeen digits of garbage out of `268.4`. Portfolio maths
 * multiplies quantity × price and then *sums across the portfolio*, so the
 * error compounds in the one place nobody audits — the total.
 *
 * The companion to this file is `test/db/quantity.test.ts`, which carries the
 * dispatch's exit test `'0.00000001 BTC survives a database round trip'`
 * against a real `NUMERIC(38,18)` column. That one needs Postgres and so lives
 * in the `investments-db` project; this one proves the in-process half — that
 * the lot engine never converts to a float on the way to or from the database —
 * and runs in milliseconds with nothing installed.
 */
import { DateOnly, Money, Quantity, currency } from '@core/kernel';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { carryLotsOnTransfer, matchDisposal, openLot, quantityWeight } from './lots.ts';

const USD = currency('USD');
const WALLET = 'wallet-coinbase';
const BTC = 'sec-btc';

/** One satoshi. The smallest thing the app must not lose. */
const ONE_SATOSHI = '0.00000001';

function btcLot(id: string, quantity: string, basisMinor: bigint | null) {
  return openLot({
    id,
    accountId: WALLET,
    securityId: BTC,
    openDate: DateOnly.parse('2024-02-01'),
    quantity: Quantity.of(quantity),
    basis: basisMinor === null ? null : Money.of(basisMinor, USD),
    currency: USD,
    basisSource: basisMinor === null ? 'ESTIMATED' : 'BROKER',
    acquisitionType: 'BUY',
  }).lot;
}

describe('the quantity boundary', () => {
  it('a satoshi survives the lot engine at full 18-decimal scale', () => {
    const lot = btcLot('lot-sat', ONE_SATOSHI, 63_214n);
    // The database string is fixed at scale 18 — which is what a
    // `NUMERIC(38,18)` column stores, so the value written is the value held.
    expect(Quantity.toDatabaseString(lot.quantity)).toBe('0.000000010000000000');
    expect(Quantity.toDatabaseString(lot.quantityRemaining)).toBe('0.000000010000000000');
    expect(Quantity.isZero(lot.quantity)).toBe(false);
  });

  it('the eighteenth decimal is not rounded away by a disposal', () => {
    // 1e-18 is the smallest representable quantity. A float would have lost it
    // before the subtraction even started.
    const lot = btcLot('lot-wei', '0.000000000000000002', 1n);
    const sale = matchDisposal([lot], {
      accountId: WALLET,
      securityId: BTC,
      date: DateOnly.parse('2025-01-01'),
      quantity: Quantity.of('0.000000000000000001'),
      proceeds: Money.of(1n, USD),
    });
    expect(Quantity.toDatabaseString(sale.matches[0]?.quantity ?? Quantity.zero)).toBe(
      '0.000000000000000001',
    );
    expect(Quantity.toDatabaseString(sale.lots[0]?.quantityRemaining ?? Quantity.zero)).toBe(
      '0.000000000000000001',
    );
  });

  it('a self-transfer moves a satoshi without rounding it to zero', () => {
    const { carried } = carryLotsOnTransfer([btcLot('lot-sat', ONE_SATOSHI, 63_214n)], {
      fromAccountId: WALLET,
      toAccountId: 'wallet-ledger',
      securityId: BTC,
      newLotId: () => 'lot-sat-moved',
    });
    expect(Quantity.toDatabaseString(carried[0]?.quantity ?? Quantity.zero)).toBe(
      '0.000000010000000000',
    );
  });

  it('quantityWeight is an exact integer of 1e-18 units, with no float in the path', () => {
    // The bridge between `Quantity` and `Money.allocate`'s bigint weights, and
    // the one place a `Number()` would be tempting. One satoshi is exactly
    // 10,000,000,000 units of 1e-18.
    expect(quantityWeight(Quantity.of(ONE_SATOSHI))).toBe(10_000_000_000n);
    expect(quantityWeight(Quantity.of('1'))).toBe(1_000_000_000_000_000_000n);
    expect(quantityWeight(Quantity.of('0.000000000000000001'))).toBe(1n);
  });

  it('round-trips any 18-decimal quantity through the weight and back', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 1n, max: 10n ** 30n }), (units) => {
        const asString = units.toString().padStart(19, '0');
        const value = Quantity.of(`${asString.slice(0, -18)}.${asString.slice(-18)}`);
        expect(quantityWeight(value)).toBe(units);
      }),
      { numRuns: 500 },
    );
  });

  it('proceeds split across satoshi-sized lots conserve every cent', () => {
    // Three dust lots and one $1.00 sale. `Money.allocate`'s largest-remainder
    // rule has to give out exactly 100 cents — a per-lot `Math.round` would
    // give out 99 or 101 and nobody would ever notice which.
    const lots = [
      btcLot('lot-1', ONE_SATOSHI, 1n),
      btcLot('lot-2', '0.00000002', 2n),
      btcLot('lot-3', '0.00000004', 4n),
    ];
    const sale = matchDisposal(lots, {
      accountId: WALLET,
      securityId: BTC,
      date: DateOnly.parse('2025-01-01'),
      quantity: Quantity.of('0.00000007'),
      proceeds: Money.of(100n, USD),
    });
    const distributed = sale.matches.reduce((sum, match) => sum + match.proceeds.minor, 0n);
    expect(distributed).toBe(100n);
  });

  it('no `number` appears in a quantity that reached the engine', () => {
    // A structural check rather than a value check: every quantity the engine
    // hands back is a string, so a `number` cannot have survived in one. The
    // gate greps the diff for the same thing at the column boundaries.
    const lot = btcLot('lot-sat', ONE_SATOSHI, 63_214n);
    expect(typeof lot.quantity).toBe('string');
    expect(typeof lot.quantityRemaining).toBe('string');
    expect(typeof lot.basis?.minor).toBe('bigint');
    expect(typeof lot.basisConsumed.minor).toBe('bigint');
    expect(typeof lot.washSaleAdjustment.minor).toBe('bigint');
  });
});
