// SPDX-License-Identifier: MIT
import { Money } from '@core/kernel';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { generateDemoData } from './generate.ts';

describe('generateDemoData determinism', () => {
  it('produces byte-identical JSON for the same seed', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 100_000 }), (seed) => {
        const a = generateDemoData(seed, { monthCount: 6 });
        const b = generateDemoData(seed, { monthCount: 6 });
        expect(JSON.stringify(a)).toBe(JSON.stringify(b));
      }),
      { numRuns: 20 },
    );
  });

  it('produces a different dataset for a different seed', () => {
    const a = generateDemoData(1, { monthCount: 6 });
    const b = generateDemoData(2, { monthCount: 6 });
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
    expect(a.userId).not.toBe(b.userId);
  });

  it('is stable across the full 24-month default window', () => {
    const a = generateDemoData(7);
    const b = generateDemoData(7);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.monthCount).toBe(24);
  });
});

describe('generateDemoData transfer pairs', () => {
  it('every transfer pair nets to zero', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1_000 }), (seed) => {
        const dataset = generateDemoData(seed, { monthCount: 12 });
        const byId = new Map(dataset.transactions.map((t) => [t.id, t]));

        for (const pair of dataset.labels.transfers) {
          const from = byId.get(pair.fromTransactionId);
          const to = byId.get(pair.toTransactionId);
          expect(from).toBeDefined();
          expect(to).toBeDefined();
          if (from === undefined || to === undefined) continue;

          const fromAmount = Money.fromJSON(from.amount);
          const toAmount = Money.fromJSON(to.amount);
          expect(Money.isNegative(fromAmount)).toBe(true);
          expect(Money.isPositive(toAmount)).toBe(true);
          expect(Money.add(fromAmount, toAmount)).toEqual(Money.zero(fromAmount.currency));
        }
      }),
      { numRuns: 15 },
    );
  });

  it('generates at least one transfer over a 12-month window', () => {
    const dataset = generateDemoData(1, { monthCount: 12 });
    expect(dataset.labels.transfers.length).toBeGreaterThan(0);
  });
});

describe('generateDemoData recurring series', () => {
  const dataset = generateDemoData(1, { monthCount: 24 });

  it('every series transaction id resolves to a real transaction on the right account', () => {
    const byId = new Map(dataset.transactions.map((t) => [t.id, t]));
    for (const series of dataset.labels.recurringSeries) {
      expect(series.transactionIds.length).toBeGreaterThan(0);
      for (const id of series.transactionIds) {
        const txn = byId.get(id);
        expect(txn).toBeDefined();
        expect(txn?.accountId).toBe(series.accountId);
        expect(txn?.merchantId).toBe(series.merchantId);
      }
    }
  });

  it('includes exactly one price-increase series and one dormant series', () => {
    const withIncrease = dataset.labels.recurringSeries.filter((s) => s.priceIncrease !== null);
    const dormant = dataset.labels.recurringSeries.filter((s) => s.dormantAfter !== null);
    expect(withIncrease).toHaveLength(1);
    expect(dormant).toHaveLength(1);
  });

  it('covers monthly, biweekly, and annual cadences', () => {
    const cadences = new Set(dataset.labels.recurringSeries.map((s) => s.cadence));
    expect(cadences).toEqual(new Set(['monthly', 'biweekly', 'annual']));
  });
});

describe('generateDemoData refunds', () => {
  const dataset = generateDemoData(1, { monthCount: 24 });

  it('every refund link resolves to a purchase and a refund transaction', () => {
    const byId = new Map(dataset.transactions.map((t) => [t.id, t]));
    for (const link of dataset.labels.refunds) {
      const purchase = byId.get(link.purchaseTransactionId);
      const refund = byId.get(link.refundTransactionId);
      expect(purchase?.kind).toBe('purchase');
      expect(refund?.kind).toBe('refund');
      if (purchase === undefined || refund === undefined) continue;
      const purchaseAmount = Money.fromJSON(purchase.amount);
      const refundAmount = Money.fromJSON(refund.amount);
      expect(Money.isNegative(purchaseAmount)).toBe(true);
      expect(Money.isPositive(refundAmount)).toBe(true);
      // A refund never exceeds what was actually paid.
      expect(refundAmount.minor).toBeLessThanOrEqual(-purchaseAmount.minor);
    }
  });
});

describe('generateDemoData pending/posted lifecycle', () => {
  it('has both pending and posted transactions', () => {
    const dataset = generateDemoData(1, { monthCount: 24 });
    const statuses = new Set(dataset.transactions.map((t) => t.status));
    expect(statuses.has('posted')).toBe(true);
    expect(statuses.has('pending')).toBe(true);
  });

  it('never dates a transaction after the window ends', () => {
    const dataset = generateDemoData(1, { monthCount: 24 });
    const today = dataset.transactions.reduce(
      (latest, t) => (t.postedOn > latest ? t.postedOn : latest),
      dataset.startMonth,
    );
    for (const txn of dataset.transactions) {
      expect(txn.postedOn <= today).toBe(true);
    }
  });
});
