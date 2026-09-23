// SPDX-License-Identifier: MIT
/**
 * The §5 exit criterion: the engine agrees with a person holding a calculator.
 *
 * `test/fixtures/hand-computation.json` carries both halves — the world, and
 * every total worked out from it by hand *before* `computeNetWorth` was ever run
 * against it. That ordering is the whole value of the test. A fixture generated
 * from the engine's own output would pass forever and prove nothing; this one
 * fails the moment the engine and the arithmetic disagree, whichever of them is
 * wrong.
 *
 * The roster is deliberately awkward: a liability and a manual asset (the two
 * the criterion names), a non-USD account so D4's conversion runs, an investment
 * account so quantity x price runs, and one account that is liquid but excluded
 * from net worth — which is what makes `liquidMinor` and `assetsMinor`
 * different numbers rather than the same number computed twice.
 */
import { describe, expect, it } from 'vitest';
import { computeNetWorth } from '../src/net-worth.ts';
import { portsOf, type FakeWorld } from './fakes.ts';
import fixture from './fixtures/hand-computation.json' with { type: 'json' };

const world = fixture.world as unknown as FakeWorld;
const expected = fixture.expected;

const USER = '01920000-0000-7000-8000-00000000u001'.replace('u', 'a');

describe('net worth reconciliation', () => {
  it('net worth reconciles to a hand computation across every account type including a manual asset and a liability', async () => {
    const snapshot = await computeNetWorth(portsOf(world), {
      userId: USER,
      asOfDate: fixture.asOfDate,
      baseCurrency: fixture.baseCurrency,
    });

    // Line by line first, so a failure says *which* account disagrees rather
    // than only that a total is off by some amount.
    const byName = new Map(world.accounts.map((account) => [account.accountId, account.name]));
    const actualLines = snapshot.breakdown.map((entry) => ({
      account: byName.get(entry.accountId),
      baseMinor: entry.baseMinor,
    }));
    for (const line of expected.lines) {
      expect(actualLines, `${line.account}: ${line.workedByHand}`).toContainEqual({
        account: line.account,
        baseMinor: line.baseMinor,
      });
    }
    expect(actualLines).toHaveLength(expected.lines.length);

    // Then the six totals, each against its own hand-worked string.
    expect(snapshot.assetsMinor.toString(), expected.assetsWorkedByHand).toBe(expected.assetsMinor);
    expect(snapshot.liabilitiesMinor.toString(), expected.liabilitiesWorkedByHand).toBe(
      expected.liabilitiesMinor,
    );
    expect(snapshot.netWorthMinor.toString(), expected.netWorthWorkedByHand).toBe(
      expected.netWorthMinor,
    );
    expect(snapshot.liquidMinor.toString(), expected.liquidWorkedByHand).toBe(expected.liquidMinor);
    expect(snapshot.investableMinor.toString(), expected.investableWorkedByHand).toBe(
      expected.investableMinor,
    );
    expect(snapshot.onBudgetMinor.toString(), expected.onBudgetWorkedByHand).toBe(
      expected.onBudgetMinor,
    );

    expect(snapshot.source).toBe(expected.source);
    expect(snapshot.stalePrice).toBe(expected.stalePrice);
    expect(snapshot.accountsCounted).toBe(expected.accountsCounted);
    expect(snapshot.accountsUnvalued).toBe(expected.accountsUnvalued);
  });

  it('carries D4 provenance on every breakdown entry, including the domestic ones', async () => {
    const snapshot = await computeNetWorth(portsOf(world), {
      userId: USER,
      asOfDate: fixture.asOfDate,
      baseCurrency: fixture.baseCurrency,
    });

    for (const entry of snapshot.breakdown) {
      // The shape `net_worth_breakdown_is_well_formed` enforces in the database,
      // asserted here too so a violation is a unit-test failure rather than a
      // 23514 from a migration-level CHECK at the end of a job.
      expect(entry.fxRate, entry.accountId).toMatch(/^[0-9]+(\.[0-9]+)?$/);
      expect(entry.fxRateDate, entry.accountId).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(typeof entry.nativeMinor).toBe('string');
      expect(typeof entry.baseMinor).toBe('string');
    }

    // The CAD account carries the *observation's* date, not the date asked for:
    // recording 2026-06-15 would make a Friday rate claim to be a Monday one.
    const cad = snapshot.breakdown.find((entry) => entry.currency === 'CAD');
    expect(cad?.fxRate).toBe('0.7350');
    expect(cad?.fxRateDate).toBe('2026-06-12');
    expect(cad?.nativeMinor).toBe('1000000');
    expect(cad?.baseMinor).toBe('735000');
  });

  it('counts an unvaluable account rather than calling it zero', async () => {
    // An in-net-worth account that never reported. "Net worth is $X across 6 of
    // 7 accounts" and "net worth is $X" are different claims; a zero would
    // silently make them the same one, and the wrong one.
    const withGap: FakeWorld = {
      ...world,
      accounts: [
        ...world.accounts,
        {
          accountId: 'a1000000-0000-4000-8000-000000000099',
          name: 'Just linked, never synced',
          kind: 'cash',
          side: 'asset',
          currency: 'USD',
          flags: { onBudget: true, inNetWorth: true, isLiquid: true, isInvestable: false },
        },
      ],
    };

    const snapshot = await computeNetWorth(portsOf(withGap), {
      userId: USER,
      asOfDate: fixture.asOfDate,
      baseCurrency: fixture.baseCurrency,
    });

    expect(snapshot.accountsUnvalued).toBe(1);
    expect(snapshot.unvalued[0]?.reason).toBe('no_balance');
    // And the totals did not move, which is the point.
    expect(snapshot.netWorthMinor.toString()).toBe(expected.netWorthMinor);
  });

  it('keeps a closed account out of the day it closed on', async () => {
    const withClosed: FakeWorld = {
      ...world,
      accounts: world.accounts.map((account) =>
        account.name === 'Everyday Checking' ? { ...account, closedAt: '2026-06-01' } : account,
      ),
    };

    const snapshot = await computeNetWorth(portsOf(withClosed), {
      userId: USER,
      asOfDate: fixture.asOfDate,
      baseCurrency: fixture.baseCurrency,
    });

    expect(snapshot.accountsCounted).toBe(expected.accountsCounted - 1);
    expect(snapshot.assetsMinor.toString()).toBe(
      (BigInt(expected.assetsMinor) - 423517n).toString(),
    );
  });
});
