// SPDX-License-Identifier: MIT
/**
 * 04 §5.4's refusal: an investment account cannot be reconstructed by
 * subtracting transactions.
 *
 * Transaction subtraction assumes every change in a balance is a transaction.
 * For a checking account that is true by construction. For a brokerage account
 * it is false on most days — the balance moved because the market moved, and
 * there is no transaction to subtract — so running the cash path over it yields
 * a portfolio that never changed value except on the days something was traded.
 * That line is smooth, confident, and fiction.
 *
 * The strong form of the test is the third one: a whole snapshot run over a
 * *recording* port that fails if `transactionsTotalOn` is so much as called for
 * an investment account. A policy table can be consulted and then ignored; a
 * call that never happens cannot be.
 */
import { describe, expect, it } from 'vitest';
import { computeNetWorth } from '../src/net-worth.ts';
import {
  INTERPOLATION_POLICY,
  InterpolationRefused,
  backfillByTransactionSubtraction,
  interpolateQuantity,
  methodFor,
} from '../src/interpolate.ts';
import { recordingPorts, type FakeWorld } from './fakes.ts';

const USER = 'a1920000-0000-7000-8000-00000000a001';
const BROKERAGE = 'a1000000-0000-4000-8000-000000000005';
const CHECKING = 'a1000000-0000-4000-8000-000000000001';
const VTI = '5e000000-0000-4000-8000-0000000000f1';

describe('interpolation policy', () => {
  it('an investment account is never backfilled by the transaction-subtraction path', async () => {
    // 1. The policy says so.
    expect(methodFor('investment')).toBe('quantity_times_price');
    expect(INTERPOLATION_POLICY.investment).not.toBe('transaction_subtraction');

    // 2. The path itself refuses, by name, with the reason in the message.
    const refused = backfillByTransactionSubtraction(
      {
        kind: 'investment',
        userId: USER,
        accountId: BROKERAGE,
        knownDate: '2026-06-15',
        knownMinor: 641500n,
        targetDate: '2026-06-10',
      },
      async () => 0n,
    );
    await expect(refused).rejects.toThrow(InterpolationRefused);
    const error = (await refused.catch((caught: unknown) => caught)) as InterpolationRefused;
    expect(error.accountKind).toBe('investment');
    expect(error.attemptedMethod).toBe('transaction_subtraction');
    expect(error.message).toContain('quantity_times_price');

    // 3. The claim that actually matters: a real snapshot of a past day, with a
    //    brokerage and a checking account side by side and transactions
    //    available for both, never asks for the brokerage's transactions.
    const world: FakeWorld = {
      accounts: [
        {
          accountId: CHECKING,
          name: 'Everyday Checking',
          kind: 'cash',
          side: 'asset',
          currency: 'USD',
          flags: { onBudget: true, inNetWorth: true, isLiquid: true, isInvestable: false },
        },
        {
          accountId: BROKERAGE,
          name: 'Brokerage',
          kind: 'investment',
          side: 'asset',
          currency: 'USD',
          flags: { onBudget: false, inNetWorth: true, isLiquid: false, isInvestable: true },
        },
      ],
      // Both accounts have only a *later* balance, which is the ordinary shape
      // on a fresh install: a provider backfills 90 days of transactions and one
      // current balance. This is exactly when the backfill path runs.
      balances: [
        { accountId: CHECKING, date: '2026-06-15', currentMinor: '423517', currency: 'USD' },
        { accountId: BROKERAGE, date: '2026-06-15', currentMinor: '641500', currency: 'USD' },
      ],
      transactions: {
        [`${CHECKING}|2026-06-15`]: '10000',
        [`${CHECKING}|2026-06-14`]: '-2500',
        // Deliberately present. If the engine reaches for these, the assertion
        // below catches it rather than the numbers quietly looking plausible.
        [`${BROKERAGE}|2026-06-15`]: '50000',
        [`${BROKERAGE}|2026-06-14`]: '-1000',
      },
      holdings: [
        { accountId: BROKERAGE, securityId: VTI, quantity: '10', asOfDate: '2026-06-10' },
        { accountId: BROKERAGE, securityId: VTI, quantity: '20', asOfDate: '2026-06-20' },
      ],
      prices: [
        {
          securityId: VTI,
          date: '2026-06-13',
          close: '268.40',
          currency: 'USD',
          staleness: 'FRESH',
          rung: 'tiingo',
        },
      ],
    };

    const { ports, calls } = recordingPorts(world);
    const snapshot = await computeNetWorth(ports, {
      userId: USER,
      asOfDate: '2026-06-13',
      baseCurrency: 'USD',
    });

    const brokerageCalls = calls.transactionsTotalOn.filter((call) => call.startsWith(BROKERAGE));
    expect(brokerageCalls, 'the brokerage must never reach the subtraction path').toEqual([]);

    // The checking account, by contrast, was backfilled exactly as 04 §5.4 says:
    // 423517 - (transactions of the 15th) - (of the 14th) = 423517 - 10000 + 2500.
    expect(calls.transactionsTotalOn).toContain(`${CHECKING}|2026-06-15`);
    expect(calls.transactionsTotalOn).toContain(`${CHECKING}|2026-06-14`);
    const checking = snapshot.breakdown.find((entry) => entry.accountId === CHECKING);
    expect(checking?.baseMinor).toBe('416017');
    expect(checking?.valuation).toBe('transaction_subtraction');

    // And the brokerage was rebuilt from quantity x price with a labelled
    // interpolation: 10 shares on the 10th, 20 on the 20th, so 13 shares on the
    // 13th — 3/10 of the way along — at 268.40 = 3489.20.
    const brokerage = snapshot.breakdown.find((entry) => entry.accountId === BROKERAGE);
    expect(brokerage?.valuation).toBe('quantity_times_price');
    expect(brokerage?.baseMinor).toBe('348920');
    expect(brokerage?.between).toEqual(['2026-06-10', '2026-06-20']);

    // A day with any reconstruction in it is `interpolated`, never `observed`.
    expect(snapshot.source).toBe('interpolated');
  });

  it('labels every quantity it produces, and never extrapolates backwards', () => {
    const before = {
      accountId: BROKERAGE,
      securityId: VTI,
      quantity: '10',
      asOfDate: '2026-06-10',
    };
    const after = { accountId: BROKERAGE, securityId: VTI, quantity: '20', asOfDate: '2026-06-20' };

    // On the observation itself.
    expect(interpolateQuantity('2026-06-10', before, after)?.label).toBe('observed');

    // Between two observations: straight-line on the share count, labelled.
    const middle = interpolateQuantity('2026-06-15', before, after);
    expect(middle?.label).toBe('interpolated');
    expect(middle?.quantity).toBe('15');
    expect(middle?.between).toEqual(['2026-06-10', '2026-06-20']);

    // After the last observation: carried forward. A position you have not been
    // told about is a position you still hold.
    const later = interpolateQuantity('2026-06-25', after, null);
    expect(later?.label).toBe('carried_forward');
    expect(later?.quantity).toBe('20');

    // Before the first observation: **nothing**. "You held 10 shares on the
    // 10th" says nothing about the 1st, and inventing a position the user had
    // not opened yet is how a backfill produces a portfolio from before the
    // account existed.
    expect(interpolateQuantity('2026-06-01', null, before)).toBeNull();
  });

  it('names a method for every account class, with no default branch to fall into', () => {
    // A new account class must declare its method here before it can be valued
    // at all, rather than silently inheriting whichever branch came last.
    expect(Object.keys(INTERPOLATION_POLICY).sort()).toEqual([
      'cash',
      'credit',
      'investment',
      'loan',
      'manual_asset',
      'other',
    ]);
    expect(methodFor('manual_asset')).toBe('carry_forward');
    expect(methodFor('credit')).toBe('transaction_subtraction');
    expect(methodFor('loan')).toBe('transaction_subtraction');
  });

  it('refuses to walk the subtraction path forwards', async () => {
    // A future balance is a projection, and a projection is not a snapshot.
    await expect(
      backfillByTransactionSubtraction(
        {
          kind: 'cash',
          userId: USER,
          accountId: CHECKING,
          knownDate: '2026-06-10',
          knownMinor: 100n,
          targetDate: '2026-06-15',
        },
        async () => 0n,
      ),
    ).rejects.toThrow(InterpolationRefused);
  });
});
