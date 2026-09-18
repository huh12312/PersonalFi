// SPDX-License-Identifier: MIT
/**
 * Stage 1 and Stage 2 as a **partition**.
 *
 * Every usable row lands in exactly one stream: none is dropped, none is
 * counted twice. That is not a nicety. A dropped row is a charge missing from a
 * subscription's history and from the forecast; a duplicated one inflates
 * maturity, coverage and the annual-impact figure that ends up in a
 * notification. Neither failure is visible from the outside — the streams still
 * look plausible — which is exactly the shape of bug a property test is for.
 */

import { DateOnly, Money, fixedClock } from '@core/kernel';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { detectRecurring } from './detect.ts';
import { buildSegments, groupCoarse, signOf } from './grouping.ts';
import type { RecurringInput } from './types.ts';

const arbitraryInput = fc
  .record({
    transactionId: fc.integer({ min: 0, max: 100_000 }),
    merchantId: fc.constantFrom('m1', 'm2', 'm3'),
    accountId: fc.constantFrom('a1', 'a2'),
    minor: fc.integer({ min: -50_000, max: 50_000 }).filter((value) => value !== 0),
    dayOffset: fc.integer({ min: 0, max: 1_000 }),
    pending: fc.boolean(),
    isTransfer: fc.boolean(),
  })
  .map((raw): RecurringInput => ({
    transactionId: `t-${raw.transactionId}`,
    merchantId: raw.merchantId,
    accountId: raw.accountId,
    amount: Money.of(BigInt(raw.minor), 'USD'),
    date: DateOnly.addDays(DateOnly.parse('2024-01-01'), raw.dayOffset),
    pending: raw.pending,
    isTransfer: raw.isTransfer,
  }));

const arbitraryLedger = fc.array(arbitraryInput, { minLength: 1, maxLength: 60 }).map((rows) => {
  // Transaction ids are unique in the ledger; the generator may repeat them.
  const seen = new Set<string>();
  return rows.filter((row) => {
    if (seen.has(row.transactionId)) return false;
    seen.add(row.transactionId);
    return true;
  });
});

describe('grouping', () => {
  it('stage 1 groups on merchant, sign and currency — and nothing else', () => {
    const rows: RecurringInput[] = [
      {
        transactionId: 't-1',
        merchantId: 'm1',
        accountId: 'old-card',
        amount: Money.of(-1299n, 'USD'),
        date: DateOnly.parse('2026-01-05'),
        pending: false,
        isTransfer: false,
      },
      {
        transactionId: 't-2',
        merchantId: 'm1',
        accountId: 'new-card',
        amount: Money.of(-1299n, 'USD'),
        date: DateOnly.parse('2026-02-05'),
        pending: false,
        isTransfer: false,
      },
      {
        transactionId: 't-3',
        merchantId: 'm1',
        accountId: 'old-card',
        amount: Money.of(500n, 'USD'),
        date: DateOnly.parse('2026-02-09'),
        pending: false,
        isTransfer: false,
      },
    ];
    const groups = groupCoarse(rows);
    // Two accounts, one group: keying on the account is what makes a reissued
    // card look like a cancellation. The refund is a separate group by sign.
    expect(groups).toHaveLength(2);
    expect(groups.map((group) => group.sign).sort()).toEqual(['INFLOW', 'OUTFLOW']);
    expect(groups.find((group) => group.sign === 'OUTFLOW')?.inputs).toHaveLength(2);
  });

  it('one merchant can host several streams at different prices', () => {
    // iCloud $2.99 and Apple TV+ $12.99 on the same merchant, 07 §2.2.
    const rows: RecurringInput[] = [];
    for (let month = 0; month < 8; month += 1) {
      for (const [index, minor] of [299n, 1299n].entries()) {
        rows.push({
          transactionId: `t-${month}-${index}`,
          merchantId: 'm1',
          accountId: 'a1',
          amount: Money.of(-minor, 'USD'),
          date: DateOnly.addMonths(DateOnly.parse('2025-02-04'), month),
          pending: false,
          isTransfer: false,
        });
      }
    }
    const segments = buildSegments(groupCoarse(rows)[0]!);
    expect(segments).toHaveLength(2);
    expect(segments.map((segment) => segment.amount.typical.minor).sort()).toEqual([-1299n, -299n]);
  });
});

describe('grouping properties', () => {
  it('grouping is a partition of the usable rows', () => {
    fc.assert(
      fc.property(arbitraryLedger, (rows) => {
        const usable = rows.filter((row) => !row.pending && !row.isTransfer);

        const groups = groupCoarse(usable);
        const grouped = groups.flatMap((group) => group.inputs.map((row) => row.transactionId));
        expect(grouped.length).toBe(usable.length);
        expect(new Set(grouped).size).toBe(usable.length);

        // Every group is internally consistent on the key it was built from.
        for (const group of groups) {
          for (const row of group.inputs) {
            expect(row.merchantId).toBe(group.merchantId);
            expect(signOf(row)).toBe(group.sign);
            expect(row.amount.currency).toBe(group.currency);
          }
        }
      }),
      { numRuns: 200 },
    );
  });

  it('every usable row ends in exactly one stream, and no other row does', () => {
    fc.assert(
      fc.property(arbitraryLedger, (rows) => {
        const result = detectRecurring(rows, {
          clock: fixedClock('2027-01-01T12:00:00Z'),
          timeZone: 'UTC',
        });
        const usable = rows.filter((row) => !row.pending && !row.isTransfer);
        const assigned = result.streams.flatMap((stream) => stream.transactionIds);

        expect(assigned.length).toBe(usable.length);
        expect(new Set(assigned)).toEqual(new Set(usable.map((row) => row.transactionId)));
        expect(result.diagnostics.skippedPending).toBe(rows.filter((row) => row.pending).length);
        expect(result.diagnostics.skippedTransfers).toBe(
          rows.filter((row) => !row.pending && row.isTransfer).length,
        );
      }),
      { numRuns: 100 },
    );
  });

  it('detection is independent of input order', () => {
    fc.assert(
      fc.property(arbitraryLedger, fc.integer({ min: 1, max: 5_000 }), (rows, seed) => {
        const options = {
          clock: fixedClock('2027-01-01T12:00:00Z'),
          timeZone: 'UTC',
        } as const;
        const shuffled = [...rows].sort(
          (a, b) =>
            ((seed * a.transactionId.length) % 7) - ((seed * b.transactionId.length) % 7) ||
            a.transactionId.localeCompare(b.transactionId) * (seed % 2 === 0 ? 1 : -1),
        );
        const left = detectRecurring(rows, options);
        const right = detectRecurring(shuffled, options);
        expect(right.streams.map((stream) => stream.streamKey)).toEqual(
          left.streams.map((stream) => stream.streamKey),
        );
        expect(right.streams.map((stream) => stream.confidence)).toEqual(
          left.streams.map((stream) => stream.confidence),
        );
      }),
      { numRuns: 60 },
    );
  });
});
