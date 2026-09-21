// SPDX-License-Identifier: MIT
import { DateOnly, Money } from '@core/kernel';
import { describe, expect, it } from 'vitest';
import {
  generateCardMigration,
  generateCreditOverspend,
  generateDuplicateService,
} from './phase2-scenarios.ts';

const START = DateOnly.of(2025, 1, 1);

describe('generateCardMigration', () => {
  it('is deterministic for the same seed', () => {
    const a = generateCardMigration(7, START);
    const b = generateCardMigration(7, START);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('differs for a different seed', () => {
    const a = generateCardMigration(7, START);
    const b = generateCardMigration(8, START);
    expect(a.accounts[0].id).not.toBe(b.accounts[0].id);
  });

  it('bills the same merchant on two different accounts, with a one-period gap', () => {
    const scenario = generateCardMigration(1, START);
    const [oldCard, newCard] = scenario.accounts;
    expect(oldCard.id).not.toBe(newCard.id);
    expect(oldCard.type).toBe('credit_card');
    expect(newCard.type).toBe('credit_card');

    const before = scenario.transactions.filter((t) => t.accountId === oldCard.id);
    const after = scenario.transactions.filter((t) => t.accountId === newCard.id);
    expect(before).toHaveLength(6);
    expect(after).toHaveLength(6);
    // Same merchant throughout — a real card migration, not two subscriptions.
    for (const t of scenario.transactions) expect(t.merchantId).toBe(scenario.merchant.id);

    // The gap: the last charge before migration and the first charge after it
    // are more than one month apart (the reissue month itself is skipped).
    const lastBefore = before.at(-1);
    const firstAfter = after[0];
    if (lastBefore === undefined || firstAfter === undefined) throw new Error('missing rows');
    const gapDays = DateOnly.differenceInDays(lastBefore.postedOn, firstAfter.postedOn);
    expect(gapDays).toBeGreaterThan(31);
    expect(gapDays).toBeLessThan(62);
  });

  it('labels exactly the transactions on each side of the migration', () => {
    const scenario = generateCardMigration(1, START);
    expect(scenario.labels.transactionIdsBeforeMigration).toHaveLength(6);
    expect(scenario.labels.transactionIdsAfterMigration).toHaveLength(6);
    const allIds = new Set(scenario.transactions.map((t) => t.id));
    for (const id of [
      ...scenario.labels.transactionIdsBeforeMigration,
      ...scenario.labels.transactionIdsAfterMigration,
    ]) {
      expect(allIds.has(id)).toBe(true);
    }
    expect(scenario.labels.fromAccountId).toBe(scenario.accounts[0].id);
    expect(scenario.labels.toAccountId).toBe(scenario.accounts[1].id);
  });
});

describe('generateDuplicateService', () => {
  it('is deterministic for the same seed', () => {
    const a = generateDuplicateService(3, START);
    const b = generateDuplicateService(3, START);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('produces two concurrently active subscriptions in one category', () => {
    const scenario = generateDuplicateService(1, START);
    const [merchantA, merchantB] = scenario.merchants;
    expect(merchantA.category).toBe(scenario.labels.category);
    expect(merchantB.category).toBe(scenario.labels.category);

    const monthsA = scenario.transactions.filter((t) => t.merchantId === merchantA.id);
    const monthsB = scenario.transactions.filter((t) => t.merchantId === merchantB.id);
    expect(monthsA).toHaveLength(6);
    expect(monthsB).toHaveLength(6);

    // Concurrent, not sequential: both merchants bill in every one of the
    // same six calendar months.
    const monthKey = (d: (typeof scenario.transactions)[number]['postedOn']) =>
      `${String(DateOnly.year(d))}-${String(DateOnly.month(d))}`;
    const monthsSetA = new Set(monthsA.map((t) => monthKey(t.postedOn)));
    const monthsSetB = new Set(monthsB.map((t) => monthKey(t.postedOn)));
    expect(monthsSetA).toEqual(monthsSetB);
  });

  it("labels the cheaper merchant, and the annual impact is the OTHER one's cost, annualised (07 §2.9)", () => {
    const scenario = generateDuplicateService(1, START);
    const cheaper = scenario.merchants.find((m) => m.id === scenario.labels.cheaperMerchantId);
    expect(cheaper).toBeDefined();
    // "Keeping only the cheapest frees the rest" — the impact is the cost of
    // every OTHER stream, not the one being kept.
    const other = scenario.merchants.find((m) => m.id !== scenario.labels.cheaperMerchantId);
    expect(other).toBeDefined();
    const cheaperTxns = scenario.transactions.filter((t) => t.merchantId === cheaper?.id);
    const otherTxns = scenario.transactions.filter((t) => t.merchantId === other?.id);
    const cheaperMinor = Money.absolute(Money.fromJSON(cheaperTxns[0]!.amount)).minor;
    const otherMinor = Money.absolute(Money.fromJSON(otherTxns[0]!.amount)).minor;
    expect(cheaperMinor < otherMinor).toBe(true);

    const oneMonth = Money.fromJSON(otherTxns[0]!.amount);
    const annualImpact = Money.multiplyByInteger(oneMonth, 12n);
    expect(Money.absolute(annualImpact).minor.toString()).toBe(scenario.labels.annualImpactMinor);
  });
});

describe('generateCreditOverspend', () => {
  it('is deterministic for the same seed', () => {
    const a = generateCreditOverspend(4, START);
    const b = generateCreditOverspend(4, START);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('produces one charge far larger than the account’s own typical month', () => {
    const scenario = generateCreditOverspend(1, START);
    const overspendTxn = scenario.transactions.find(
      (t) => t.id === scenario.labels.overspendTransactionId,
    );
    expect(overspendTxn).toBeDefined();
    const overspendMinor = Money.absolute(Money.fromJSON(overspendTxn!.amount)).minor;
    const typicalMinor = BigInt(scenario.labels.typicalMonthlyMinor);
    expect(overspendMinor > typicalMinor * 4n).toBe(true);
    expect(overspendMinor.toString()).toBe(scenario.labels.overspendMinor);

    // Every other transaction is the ordinary, small, monthly pattern.
    const ordinary = scenario.transactions.filter((t) => t.id !== overspendTxn?.id);
    expect(ordinary).toHaveLength(6);
    for (const t of ordinary) {
      expect(Money.absolute(Money.fromJSON(t.amount)).minor.toString()).toBe(
        scenario.labels.typicalMonthlyMinor,
      );
    }
  });
});
