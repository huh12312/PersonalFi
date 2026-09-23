// SPDX-License-Identifier: MIT
/**
 * 08 §3.7: *"If prices fail, net worth still seals using the last known price,
 * flagged `stale_price = true`."*
 *
 * The instinct — refuse to seal a day we could not price freshly — is wrong, and
 * expensively so: tomorrow's prices can never make yesterday fresh, so a day
 * left unsealed because a provider was down stays unsealed forever and leaves a
 * permanent hole in the series. The series is what the whole table exists for.
 *
 * So the day seals on the last known price and says so. Both of the two
 * independent staleness signals flag it, and neither implies the other:
 *
 *   * `staleness === 'STALE'` — 07 §6.1's 24-hour clock rule, computed at read
 *     time against `observed_at`.
 *   * `rung === 'last_known'` — the ladder had no observation for the date and
 *     carried an earlier one forward.
 *
 * A price can be carried forward and still fresh (yesterday's close, fetched an
 * hour ago) or on-the-date and stale (a row written three days ago for a date
 * that has since arrived), which is exactly why the engine checks both.
 */
import { describe, expect, it } from 'vitest';
import { computeNetWorth } from '../src/net-worth.ts';
import { portsOf, type FakeWorld } from './fakes.ts';

const USER = 'a1920000-0000-7000-8000-00000000a001';
const BROKERAGE = 'a1000000-0000-4000-8000-000000000005';
const CHECKING = 'a1000000-0000-4000-8000-000000000001';
const VTI = '5e000000-0000-4000-8000-0000000000f1';
const DATE = '2026-06-15';

function worldWithPrice(price: FakeWorld['prices']): FakeWorld {
  return {
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
    balances: [{ accountId: CHECKING, date: DATE, currentMinor: '423517', currency: 'USD' }],
    holdings: [{ accountId: BROKERAGE, securityId: VTI, quantity: '10', asOfDate: DATE }],
    ...(price === undefined ? {} : { prices: price }),
  };
}

describe('a price outage', () => {
  it('a price outage still seals the day, flagged stale', async () => {
    // The refresh could not reach the provider today, so the newest observation
    // is three days old. 08 §3.7: value it, seal it, flag it.
    const snapshot = await computeNetWorth(
      portsOf(
        worldWithPrice([
          {
            securityId: VTI,
            date: '2026-06-12',
            close: '268.40',
            currency: 'USD',
            staleness: 'STALE',
            rung: 'last_known',
          },
        ]),
      ),
      { userId: USER, asOfDate: DATE, baseCurrency: 'USD' },
    );

    // The day exists. It has a number. Both accounts are in it.
    expect(snapshot.accountsCounted).toBe(2);
    expect(snapshot.accountsUnvalued).toBe(0);
    // 10 x 268.40 = 2684.00, plus the checking account.
    expect(snapshot.assetsMinor.toString()).toBe((423517n + 268400n).toString());

    // And it is labelled, at the row and at the account.
    expect(snapshot.stalePrice).toBe(true);
    const brokerage = snapshot.breakdown.find((entry) => entry.accountId === BROKERAGE);
    expect(brokerage?.stalePrice).toBe(true);
    // The *cash* account is not implicated by somebody else's price outage.
    const checking = snapshot.breakdown.find((entry) => entry.accountId === CHECKING);
    expect(checking?.stalePrice).toBe(false);
  });

  it('flags a carried-forward price even when the clock still calls it fresh', async () => {
    // The two signals are independent. A price fetched an hour ago for
    // yesterday's close is FRESH by 07 §6.1's clock rule and still not an
    // observation of *this* day, so the day is flagged.
    const snapshot = await computeNetWorth(
      portsOf(
        worldWithPrice([
          {
            securityId: VTI,
            date: '2026-06-14',
            close: '268.40',
            currency: 'USD',
            staleness: 'FRESH',
            rung: 'tiingo',
          },
        ]),
      ),
      { userId: USER, asOfDate: DATE, baseCurrency: 'USD' },
    );

    expect(snapshot.stalePrice).toBe(true);
    expect(snapshot.accountsCounted).toBe(2);
  });

  it('does not flag a day every one of whose prices is a fresh observation', async () => {
    // The mirror-image bug: a flag that is always true is no flag at all, and a
    // test that only ever asserted `true` would have shipped one.
    const snapshot = await computeNetWorth(
      portsOf(
        worldWithPrice([
          {
            securityId: VTI,
            date: DATE,
            close: '268.40',
            currency: 'USD',
            staleness: 'FRESH',
            rung: 'tiingo',
          },
        ]),
      ),
      { userId: USER, asOfDate: DATE, baseCurrency: 'USD' },
    );

    expect(snapshot.stalePrice).toBe(false);
    expect(snapshot.source).toBe('observed');
  });

  it('counts an account with no price at all rather than valuing it at zero', async () => {
    // A total outage on a security nobody has ever priced. The day still seals —
    // the checking account is real — but the brokerage is reported as a hole,
    // not as zero, because "net worth is $4,235.17" and "net worth is $4,235.17
    // across 1 of 2 accounts" are different claims.
    const snapshot = await computeNetWorth(portsOf(worldWithPrice([])), {
      userId: USER,
      asOfDate: DATE,
      baseCurrency: 'USD',
    });

    expect(snapshot.accountsCounted).toBe(1);
    expect(snapshot.accountsUnvalued).toBe(1);
    expect(snapshot.unvalued[0]).toEqual({
      accountId: BROKERAGE,
      reason: 'no_priced_holding',
    });
    expect(snapshot.assetsMinor.toString()).toBe('423517');
  });
});
