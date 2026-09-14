// SPDX-License-Identifier: MIT
/**
 * Invariants of the transfer-pairing heuristic.
 *
 * A pairing bug is expensive in a specific way: a false positive silently
 * *removes* real spending from a budget total, and the user's only symptom is
 * that the numbers look slightly better than they should. That is exactly the
 * class of bug examples miss and properties catch, so the gates are asserted over
 * generated ledgers rather than over four hand-written pairs.
 */
import { DateOnly } from '@core/kernel';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { proposeTransferPairs, rejectionKey, type TransferLeg } from './transfers.ts';
import { grade } from './seed-loader.ts';

const ACCOUNTS = ['acct-a', 'acct-b', 'acct-c'] as const;

const legArb: fc.Arbitrary<TransferLeg> = fc.record({
  id: fc.uuid(),
  accountId: fc.constantFrom(...ACCOUNTS),
  date: fc.integer({ min: 20_000, max: 20_040 }).map((day) => DateOnly.fromEpochDay(day)),
  amountMinor: fc.bigInt({ min: -500_000n, max: 500_000n }).filter((value) => value !== 0n),
  currency: fc.constantFrom('USD', 'EUR'),
  name: fc.constantFrom('TRANSFER TO SAVINGS', 'BLUE BOTTLE', 'ACME PAYROLL', 'WIRE OUT'),
});

/**
 * A pair that *should* match: opposite signs, equal magnitude, two accounts, a
 * few days apart. Random legs alone practically never collide on an amount, so a
 * generator without planted pairs tests the "propose nothing" path forty thousand
 * times and the interesting path never.
 */
const plantedPairArb: fc.Arbitrary<TransferLeg[]> = fc
  .record({
    outId: fc.uuid(),
    inId: fc.uuid(),
    magnitude: fc.bigInt({ min: 1n, max: 500_000n }),
    day: fc.integer({ min: 20_000, max: 20_040 }),
    gap: fc.integer({ min: 0, max: 6 }),
    accounts: fc.constantFrom(['acct-a', 'acct-b'], ['acct-b', 'acct-c'], ['acct-a', 'acct-c']),
    currency: fc.constantFrom('USD', 'EUR'),
  })
  .map(({ outId, inId, magnitude, day, gap, accounts, currency }) => [
    {
      id: outId,
      accountId: accounts[0] ?? 'acct-a',
      date: DateOnly.fromEpochDay(day),
      amountMinor: -magnitude,
      currency,
      name: 'TRANSFER TO SAVINGS',
    },
    {
      id: inId,
      accountId: accounts[1] ?? 'acct-b',
      date: DateOnly.fromEpochDay(day + gap),
      amountMinor: magnitude,
      currency,
      name: 'TRANSFER FROM CHECKING',
    },
  ]);

const ledgerArb = fc
  .tuple(fc.array(plantedPairArb, { maxLength: 6 }), fc.array(legArb, { maxLength: 24 }))
  .map(([planted, noise]) => dedupeById([...planted.flat(), ...noise]));

function dedupeById(legs: readonly TransferLeg[]): TransferLeg[] {
  const seen = new Map<string, TransferLeg>();
  for (const leg of legs) seen.set(leg.id, leg);
  return [...seen.values()];
}

function legsById(legs: readonly TransferLeg[]): Map<string, TransferLeg> {
  return new Map(legs.map((leg) => [leg.id, leg]));
}

describe('proposeTransferPairs', () => {
  it('only ever pairs opposite signs across two different accounts', () => {
    fc.assert(
      fc.property(ledgerArb, (legs) => {
        const byId = legsById(legs);
        for (const proposal of proposeTransferPairs(legs, { windowDays: 5 })) {
          const outflow = byId.get(proposal.outflowId);
          const inflow = byId.get(proposal.inflowId);
          expect(outflow?.amountMinor).toBeLessThan(0n);
          expect(inflow?.amountMinor).toBeGreaterThan(0n);
          expect(outflow?.accountId).not.toBe(inflow?.accountId);
          expect(outflow?.currency).toBe(inflow?.currency);
        }
      }),
    );
  });

  it('respects the day window and the amount tolerance it was given', () => {
    fc.assert(
      fc.property(
        ledgerArb,
        fc.integer({ min: 0, max: 10 }),
        fc.bigInt({ min: 0n, max: 500n }),
        (legs, windowDays, toleranceMinor) => {
          const byId = legsById(legs);
          for (const proposal of proposeTransferPairs(legs, { windowDays, toleranceMinor })) {
            const outflow = byId.get(proposal.outflowId);
            const inflow = byId.get(proposal.inflowId);
            if (outflow === undefined || inflow === undefined) throw new Error('unknown leg');
            expect(proposal.dayGap).toBeLessThanOrEqual(windowDays);
            expect(proposal.dayGap).toBe(
              Math.abs(DateOnly.differenceInDays(outflow.date, inflow.date)),
            );
            const difference = inflow.amountMinor + outflow.amountMinor;
            expect(difference < 0n ? -difference : difference).toBeLessThanOrEqual(toleranceMinor);
          }
        },
      ),
    );
  });

  it('gives every leg to at most one pair', () => {
    fc.assert(
      fc.property(ledgerArb, (legs) => {
        const used = new Set<string>();
        for (const proposal of proposeTransferPairs(legs, { windowDays: 5 })) {
          // Two unique indexes enforce this in the database; violating it here
          // would mean the writer relies on a constraint violation to be correct.
          expect(used.has(proposal.outflowId)).toBe(false);
          expect(used.has(proposal.inflowId)).toBe(false);
          used.add(proposal.outflowId);
          used.add(proposal.inflowId);
        }
      }),
    );
  });

  it('never re-proposes a pair the user rejected', () => {
    fc.assert(
      fc.property(ledgerArb, (legs) => {
        const first = proposeTransferPairs(legs, { windowDays: 5 });
        fc.pre(first.length > 0);
        const dismissed = first[0];
        if (dismissed === undefined) return;
        const rejected = new Set([rejectionKey(dismissed.outflowId, dismissed.inflowId)]);
        for (const proposal of proposeTransferPairs(legs, { windowDays: 5, rejected })) {
          expect(rejectionKey(proposal.outflowId, proposal.inflowId)).not.toBe(
            rejectionKey(dismissed.outflowId, dismissed.inflowId),
          );
        }
      }),
    );
  });

  it('does not depend on the order the rows arrive in', () => {
    fc.assert(
      fc.property(ledgerArb, fc.integer({ min: 0, max: 1_000 }), (legs, rotation) => {
        const rotated = [
          ...legs.slice(rotation % (legs.length || 1)),
          ...legs.slice(0, rotation % (legs.length || 1)),
        ];
        const a = proposeTransferPairs(legs, { windowDays: 5 }).map(keyOf).sort();
        const b = proposeTransferPairs(rotated, { windowDays: 5 }).map(keyOf).sort();
        // A sync page's ordering is the provider's business, not ours. If the
        // answer moved with it, two runs over the same data would disagree.
        expect(b).toEqual(a);
      }),
    );
  });

  it('scores every proposal inside the range the database allows', () => {
    fc.assert(
      fc.property(ledgerArb, (legs) => {
        for (const proposal of proposeTransferPairs(legs, {
          windowDays: 5,
          tolerancePercent: 0.02,
          minConfidence: 0.01,
        })) {
          expect(proposal.confidence).toBeGreaterThan(0);
          expect(proposal.confidence).toBeLessThanOrEqual(1);
        }
      }),
    );
  });

  it('is most confident about an exact match on the same day', () => {
    const legs = pair('2026-03-01', '2026-03-01', -50_000n, 50_000n);
    const nearby = pair('2026-03-01', '2026-03-04', -50_000n, 50_000n, 'x');
    const [sameDay] = proposeTransferPairs(legs, { windowDays: 5 });
    const [nearDate] = proposeTransferPairs(nearby, { windowDays: 5 });
    expect(sameDay?.howMatched).toBe('exact_amount_same_day');
    expect(nearDate?.howMatched).toBe('exact_amount_near_date');
    expect(sameDay?.confidence).toBeGreaterThan(nearDate?.confidence ?? 1);
  });

  it('refuses a near-miss amount unless a tolerance was asked for', () => {
    const legs = pair('2026-03-01', '2026-03-01', -50_000n, 49_950n);
    expect(proposeTransferPairs(legs, { windowDays: 5 })).toHaveLength(0);
    const withTolerance = proposeTransferPairs(legs, { windowDays: 5, toleranceMinor: 100n });
    expect(withTolerance).toHaveLength(1);
    expect(withTolerance[0]?.howMatched).toBe('amount_within_tolerance');
  });

  it('never pairs a refund, which is same-account and opposite-sign', () => {
    const legs: TransferLeg[] = [
      leg('a', 'acct-a', '2026-03-01', -50_000n),
      leg('b', 'acct-a', '2026-03-03', 50_000n),
    ];
    expect(proposeTransferPairs(legs, { windowDays: 5 })).toHaveLength(0);
  });

  it('picks the closest of two equally-sized candidates', () => {
    const legs: TransferLeg[] = [
      leg('out', 'acct-a', '2026-03-01', -50_000n),
      leg('far', 'acct-b', '2026-03-04', 50_000n),
      leg('near', 'acct-b', '2026-03-01', 50_000n),
    ];
    const proposals = proposeTransferPairs(legs, { windowDays: 5 });
    expect(proposals).toHaveLength(1);
    expect(proposals[0]?.inflowId).toBe('near');
  });
});

describe('grade', () => {
  it('scores a perfect prediction 1.0 / 1.0, whichever way round the pairs are', () => {
    const result = grade(
      [
        ['a', 'b'],
        ['d', 'c'],
      ],
      [
        ['b', 'a'],
        ['c', 'd'],
      ],
    );
    expect(result.precision).toBe(1);
    expect(result.recall).toBe(1);
  });

  it('gives a do-nothing algorithm no credit for precision', () => {
    // Reporting 1.0 precision for zero predictions is the classic way a metric
    // gate passes an implementation that does nothing at all.
    const result = grade([], [['a', 'b']]);
    expect(result.precision).toBe(0);
    expect(result.recall).toBe(0);
    expect(result.falseNegatives).toBe(1);
  });

  it('separates a false positive from a false negative', () => {
    const result = grade(
      [
        ['a', 'b'],
        ['x', 'y'],
      ],
      [
        ['a', 'b'],
        ['p', 'q'],
      ],
    );
    expect(result.truePositives).toBe(1);
    expect(result.falsePositives).toBe(1);
    expect(result.falseNegatives).toBe(1);
    expect(result.precision).toBe(0.5);
    expect(result.recall).toBe(0.5);
    expect(result.falsePositivePairs).toEqual([['x', 'y']]);
  });
});

function keyOf(proposal: { outflowId: string; inflowId: string }): string {
  return `${proposal.outflowId}|${proposal.inflowId}`;
}

function leg(id: string, accountId: string, date: string, amountMinor: bigint): TransferLeg {
  return {
    id,
    accountId,
    date: DateOnly.parse(date),
    amountMinor,
    currency: 'USD',
    name: 'TRANSFER',
  };
}

function pair(
  outDate: string,
  inDate: string,
  outAmount: bigint,
  inAmount: bigint,
  suffix = '',
): TransferLeg[] {
  return [
    leg(`out${suffix}`, 'acct-a', outDate, outAmount),
    leg(`in${suffix}`, 'acct-b', inDate, inAmount),
  ];
}
