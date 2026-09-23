// SPDX-License-Identifier: MIT
/**
 * 07 §4.1: *"get these four booleans right and every downstream rule's
 * denominator is unambiguous."*
 *
 * The bug this property test exists to catch is not a wrong total — it is a
 * *derived* total. `liquid = assets - investments` is true for whatever account
 * roster happens to be in front of you when you write it, and false the moment
 * somebody adds a money-market fund, an off-budget savings account, or a credit
 * card they pay from a different bank. It would pass every example test anybody
 * wrote at the time.
 *
 * So this is a property over all sixteen flag combinations, generated rather
 * than enumerated by hand: each of the four totals must respond **only** to its
 * own flag. Flip `isLiquid` on one account and `liquidMinor` moves by exactly
 * that account's contribution while the other three totals do not move at all.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { computeNetWorth } from '../src/net-worth.ts';
import { defaultFlagsFor, ACCOUNT_KINDS, type AccountFlags } from '../src/ports.ts';
import { portsOf, type FakeAccount, type FakeWorld } from './fakes.ts';

const USER = 'a1920000-0000-7000-8000-00000000a001';
const DATE = '2026-06-15';

const flagsArbitrary = fc.record({
  onBudget: fc.boolean(),
  inNetWorth: fc.boolean(),
  isLiquid: fc.boolean(),
  isInvestable: fc.boolean(),
});

function worldOf(
  accounts: readonly { flags: AccountFlags; minor: bigint; side: 'asset' | 'liability' }[],
): FakeWorld {
  const rows: FakeAccount[] = accounts.map((account, index) => ({
    accountId: `a1000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    name: `Account ${String(index)}`,
    kind: 'cash',
    side: account.side,
    currency: 'USD',
    flags: account.flags,
  }));
  return {
    accounts: rows,
    balances: rows.map((row, index) => ({
      accountId: row.accountId,
      date: DATE,
      currentMinor: (accounts[index]?.minor ?? 0n).toString(),
      currency: 'USD',
    })),
  };
}

describe('the account class booleans', () => {
  it('the four account booleans are independent', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            flags: flagsArbitrary,
            minor: fc.bigInt({ min: -1_000_000n, max: 1_000_000n }),
            side: fc.constantFrom<'asset' | 'liability'>('asset', 'liability'),
          }),
          { minLength: 1, maxLength: 6 },
        ),
        // Which account to flip, and which of the four flags.
        fc.nat({ max: 5 }),
        fc.constantFrom<keyof AccountFlags>('onBudget', 'inNetWorth', 'isLiquid', 'isInvestable'),
        async (accounts, rawIndex, flag) => {
          const index = rawIndex % accounts.length;
          const target = accounts[index];
          if (target === undefined) return;

          const before = await computeNetWorth(portsOf(worldOf(accounts)), {
            userId: USER,
            asOfDate: DATE,
            baseCurrency: 'USD',
          });

          const flipped = accounts.map((account, i) =>
            i === index
              ? { ...account, flags: { ...account.flags, [flag]: !account.flags[flag] } }
              : account,
          );
          const after = await computeNetWorth(portsOf(worldOf(flipped)), {
            userId: USER,
            asOfDate: DATE,
            baseCurrency: 'USD',
          });

          // The sign of the expected move: flipping a flag on adds the
          // account's contribution to that flag's total, flipping it off
          // removes it.
          const direction = target.flags[flag] ? -1n : 1n;
          const delta = direction * target.minor;

          const totals = {
            onBudget: [before.onBudgetMinor, after.onBudgetMinor] as const,
            isLiquid: [before.liquidMinor, after.liquidMinor] as const,
            isInvestable: [before.investableMinor, after.investableMinor] as const,
          };

          for (const [name, [was, now]] of Object.entries(totals)) {
            if (name === flag) {
              expect(now - was, `${name} must follow its own flag`).toBe(delta);
            } else {
              expect(now - was, `${name} must not follow ${flag}`).toBe(0n);
            }
          }

          // `inNetWorth` is the assets/liabilities denominator, and it splits by
          // the account's *side* rather than by the sign of its balance.
          const netDelta = after.netWorthMinor - before.netWorthMinor;
          expect(netDelta, 'net worth must follow only inNetWorth').toBe(
            flag === 'inNetWorth' ? delta : 0n,
          );

          // And the other three never move when inNetWorth alone is flipped:
          // an account excluded from net worth can still be liquid, which is
          // the case a single "counts?" boolean cannot express at all.
          if (flag === 'inNetWorth') {
            expect(after.liquidMinor - before.liquidMinor).toBe(0n);
            expect(after.investableMinor - before.investableMinor).toBe(0n);
            expect(after.onBudgetMinor - before.onBudgetMinor).toBe(0n);
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it('derives all four for every account class, since only one has a column today', () => {
    // 0004_ledger.sql gives `accounts` exactly one of the four:
    // `include_in_net_worth`. `on_budget` is @ctx/budgeting's exclusion list and
    // `is_liquid`/`is_investable` do not exist anywhere. This is the derivation
    // the composition root owes, kept in one place so there is one thing to
    // delete when @ctx/ledger grows the columns. Evidence §7 records the gap.
    for (const kind of ACCOUNT_KINDS) {
      const flags = defaultFlagsFor(kind);
      expect(Object.keys(flags).sort()).toEqual([
        'inNetWorth',
        'isInvestable',
        'isLiquid',
        'onBudget',
      ]);
    }

    // The two that carry 07 §4.1's actual content, spelled out so a change to
    // the class table is a deliberate edit here.
    expect(defaultFlagsFor('cash')).toEqual({
      onBudget: true,
      inNetWorth: true,
      isLiquid: true,
      isInvestable: false,
    });
    expect(defaultFlagsFor('investment')).toEqual({
      onBudget: false,
      inNetWorth: true,
      isLiquid: false,
      isInvestable: true,
    });
    // Liquid and investable are never the same boolean wearing two names.
    expect(defaultFlagsFor('cash').isInvestable).toBe(false);
    expect(defaultFlagsFor('investment').isLiquid).toBe(false);

    // `inNetWorth` is the one with a column, so it is the one a caller may
    // override from stored state.
    expect(defaultFlagsFor('cash', false).inNetWorth).toBe(false);
    expect(defaultFlagsFor('cash', false).isLiquid).toBe(true);
  });
});
