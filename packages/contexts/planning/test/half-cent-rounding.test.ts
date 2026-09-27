// SPDX-License-Identifier: MIT
/**
 * Phase 3 gate C-11 (G3-6, LOW; `docs/evidence/phase-3/gate-security-review.md`
 * §6): `net-worth.ts`'s `toMinorUnits` — the one place `quantity x price` is
 * rounded to the account currency's minor units — rounded half-up away from
 * zero, the one rounding call in this app that disagreed with
 * `docs/CONVENTIONS.md`'s "rounding is banker's (half-even) by default".
 *
 * A single-position, single-account world, isolated from
 * `test/fixtures/hand-computation.json` (that fixture's own investment
 * position does not land on a rounding boundary, so it cannot tell half-up
 * from half-even apart — this file exists precisely because it needs a
 * number that does). `quantity "12.5" x price "0.01"` is exactly `0.125`:
 * the third decimal digit is a bare `5` with nothing behind it, so half-up
 * and half-even disagree — up rounds to $0.13, even rounds to $0.12 (12 is
 * already even) — and every other digit in this file is chosen so nothing
 * else about the computation is in question.
 */
import { describe, expect, it } from 'vitest';
import { computeNetWorth } from '../src/net-worth.ts';
import { portsOf, type FakeWorld } from './fakes.ts';

const USER = '01920000-0000-7000-8000-00000000a001';
const ACCOUNT = 'a1000000-0000-4000-8000-00000000c001';
const SECURITY = 's1000000-0000-4000-8000-00000000c001';
const AS_OF = '2026-06-15';

function worldWith(quantity: string, close: string): FakeWorld {
  return {
    accounts: [
      {
        accountId: ACCOUNT,
        name: 'Half-cent brokerage',
        kind: 'investment',
        side: 'asset',
        currency: 'USD',
        flags: { onBudget: false, inNetWorth: true, isLiquid: false, isInvestable: true },
      },
    ],
    balances: [],
    holdings: [{ accountId: ACCOUNT, securityId: SECURITY, quantity, asOfDate: AS_OF }],
    prices: [{ securityId: SECURITY, date: AS_OF, close, currency: 'USD' }],
  };
}

describe('net worth rounds quantity x price half-even, never half-up (Phase 3 gate C-11)', () => {
  it('12.5 shares at $0.01 is exactly $0.125 — half-even rounds to $0.12 (12 is already even)', async () => {
    const snapshot = await computeNetWorth(portsOf(worldWith('12.5', '0.01')), {
      userId: USER,
      asOfDate: AS_OF,
      baseCurrency: 'USD',
    });
    expect(snapshot.assetsMinor).toBe(12n);
    expect(snapshot.netWorthMinor).toBe(12n);
  });

  it('13.5 shares at $0.01 is exactly $0.135 — half-even rounds to $0.14 (14 is the even neighbour of 13)', async () => {
    const snapshot = await computeNetWorth(portsOf(worldWith('13.5', '0.01')), {
      userId: USER,
      asOfDate: AS_OF,
      baseCurrency: 'USD',
    });
    expect(snapshot.assetsMinor).toBe(14n);
  });

  it('a value strictly past the halfway point still rounds up regardless of parity', async () => {
    // 12.51 -> $0.1251: past half, not a tie, so both half-up and half-even
    // agree here — a control that only ever tests the tie case would not
    // catch a rounding function that always rounds down, say.
    const snapshot = await computeNetWorth(portsOf(worldWith('12.51', '0.01')), {
      userId: USER,
      asOfDate: AS_OF,
      baseCurrency: 'USD',
    });
    expect(snapshot.assetsMinor).toBe(13n);
  });

  it('a value strictly before the halfway point always rounds down', async () => {
    const snapshot = await computeNetWorth(portsOf(worldWith('12.49', '0.01')), {
      userId: USER,
      asOfDate: AS_OF,
      baseCurrency: 'USD',
    });
    expect(snapshot.assetsMinor).toBe(12n);
  });
});
