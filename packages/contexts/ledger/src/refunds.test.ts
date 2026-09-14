// SPDX-License-Identifier: MIT
/**
 * Refund hinting is advisory, so its invariants are about restraint: never point
 * a refund at a purchase it could not have reversed, and never let one purchase
 * back two refunds. A wrong hint is visible and dismissible; a wrong *net* would
 * not be, which is why nothing here nets anything.
 */
import { DateOnly } from '@core/kernel';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { proposeRefundHints, type RefundLeg } from './refunds.ts';

const MERCHANTS = ['m-coffee', 'm-books', null] as const;
const ACCOUNTS = ['acct-a', 'acct-b'] as const;

const legArb: fc.Arbitrary<RefundLeg> = fc.record({
  id: fc.uuid(),
  accountId: fc.constantFrom(...ACCOUNTS),
  merchantId: fc.constantFrom(...MERCHANTS),
  date: fc.integer({ min: 20_000, max: 20_120 }).map((day) => DateOnly.fromEpochDay(day)),
  amountMinor: fc.bigInt({ min: -50_000n, max: 50_000n }).filter((value) => value !== 0n),
  currency: fc.constant('USD'),
  name: fc.constantFrom('BLUE BOTTLE', 'REFUND BLUE BOTTLE', 'POWELLS BOOKS'),
});

const ledgerArb = fc.array(legArb, { maxLength: 30 }).map((legs) => {
  const seen = new Map<string, RefundLeg>();
  for (const leg of legs) seen.set(leg.id, leg);
  return [...seen.values()];
});

describe('proposeRefundHints', () => {
  it('only points a refund at an earlier, larger charge from the same payee', () => {
    fc.assert(
      fc.property(ledgerArb, (legs) => {
        const byId = new Map(legs.map((leg) => [leg.id, leg]));
        for (const hint of proposeRefundHints(legs)) {
          const refund = byId.get(hint.refundTransactionId);
          const purchase = byId.get(hint.purchaseTransactionId);
          if (refund === undefined || purchase === undefined) throw new Error('unknown leg');
          expect(refund.amountMinor).toBeGreaterThan(0n);
          expect(purchase.amountMinor).toBeLessThan(0n);
          expect(refund.accountId).toBe(purchase.accountId);
          expect(refund.merchantId).toBe(purchase.merchantId);
          expect(refund.merchantId).not.toBeNull();
          // A refund larger than the purchase is not a refund; a refund *before*
          // the purchase is a coincidence.
          expect(refund.amountMinor).toBeLessThanOrEqual(-purchase.amountMinor);
          expect(DateOnly.differenceInDays(purchase.date, refund.date)).toBeGreaterThanOrEqual(0);
          expect(DateOnly.differenceInDays(purchase.date, refund.date)).toBeLessThanOrEqual(90);
        }
      }),
    );
  });

  it('never lets one purchase back two refunds', () => {
    fc.assert(
      fc.property(ledgerArb, (legs) => {
        const claimed = new Set<string>();
        for (const hint of proposeRefundHints(legs)) {
          expect(claimed.has(hint.purchaseTransactionId)).toBe(false);
          claimed.add(hint.purchaseTransactionId);
        }
      }),
    );
  });

  it('is deterministic', () => {
    fc.assert(
      fc.property(ledgerArb, (legs) => {
        expect(proposeRefundHints(legs)).toEqual(proposeRefundHints(legs));
      }),
    );
  });

  it('matches a full refund of a coffee two days later', () => {
    const hints = proposeRefundHints([
      leg('purchase', '2026-03-01', -1_200n),
      leg('refund', '2026-03-03', 1_200n, 'REFUND BLUE BOTTLE'),
    ]);
    expect(hints).toHaveLength(1);
    expect(hints[0]?.purchaseTransactionId).toBe('purchase');
    expect(hints[0]?.full).toBe(true);
    expect(hints[0]?.confidence).toBeGreaterThan(0.9);
  });

  it('scores a partial refund lower than a full one', () => {
    const [full] = proposeRefundHints([
      leg('p1', '2026-03-01', -1_200n),
      leg('r1', '2026-03-03', 1_200n),
    ]);
    const [partial] = proposeRefundHints([
      leg('p2', '2026-03-01', -1_200n),
      leg('r2', '2026-03-03', 900n),
    ]);
    expect(partial?.confidence).toBeLessThan(full?.confidence ?? 0);
    expect(partial?.full).toBe(false);
  });

  it('ignores a credit from a payee that was never paid', () => {
    expect(
      proposeRefundHints([
        leg('purchase', '2026-03-01', -1_200n, 'BLUE BOTTLE', 'm-coffee'),
        leg('income', '2026-03-03', 1_200n, 'ACME PAYROLL', 'm-payroll'),
      ]),
    ).toHaveLength(0);
  });

  it('ignores a credit outside the refund window', () => {
    expect(
      proposeRefundHints([
        leg('purchase', '2026-01-01', -1_200n),
        leg('refund', '2026-06-01', 1_200n),
      ]),
    ).toHaveLength(0);
  });
});

function leg(
  id: string,
  date: string,
  amountMinor: bigint,
  name = 'BLUE BOTTLE',
  merchantId = 'm-coffee',
): RefundLeg {
  return {
    id,
    accountId: 'acct-a',
    merchantId,
    date: DateOnly.parse(date),
    amountMinor,
    currency: 'USD',
    name,
  };
}
