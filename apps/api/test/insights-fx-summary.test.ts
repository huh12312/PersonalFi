// SPDX-License-Identifier: MIT
/**
 * Phase 3 gate C-10 (G3-13, MEDIUM; `docs/evidence/phase-3/gate-security-review.md`
 * §3.13, §6): `SnapshotBuilder`'s `networth.summary`/`cash.summary` threw
 * `CurrencyMismatchError` the moment one open account's currency differed
 * from the snapshot's base currency — `#netWorth` at `builder.ts:364`,
 * `#cash` at `:396` in the reviewed tree — and because the throw happened
 * inside `build()`'s scope loop, it took the *whole* snapshot down: an
 * advisor granted `cashflow.monthly` alone got nothing on an install with one
 * foreign-currency account. The gate found this latent (no production caller
 * writes a grant yet — WP 4.8 is the first) and MUST land before that WP.
 *
 * No database is needed: `SnapshotBuilder` never touches one, so this is
 * `test/*.test.ts` (the `api` project), not `test/db/`. Every port here is
 * `@ctx/insights`'s own published fake — the real `SnapshotBuilder`, not a
 * reimplementation, per this gate round's evidence standard (`personalfi-gate-lessons`:
 * "a fake they have to re-implement is a fake that will differ from this one
 * in whichever direction makes the proof pass").
 *
 * Reproduced red first: with `packages/contexts/insights/src/snapshot/builder.ts`
 * restored to its pre-fix shape (`Money.add(assets, account.balance)` with no
 * conversion), this file's CAD cases throw `CurrencyMismatchError` out of
 * `build()` and the `it.each` below fails on both. Sabotage recorded in
 * `docs/evidence/phase-4/wp4.12b-gate-conditions.md` C-10.
 */
import { CurrencyMismatchError, DateOnly, Money } from '@core/kernel';
import {
  CashSummarySchema,
  NetWorthSummarySchema,
  SnapshotBuilder,
  deriveTokenKey,
  emptyPorts,
  inMemoryFxPort,
  inMemoryLedgerPort,
  type InsightsAccount,
} from '@ctx/insights';
import { describe, expect, it } from 'vitest';

const TODAY = DateOnly.parse('2026-09-26');
const USER_ID = '01930000-0000-7000-8000-0000000000c1';
const TOKEN_KEY = deriveTokenKey('wp4.12b-c10', USER_ID);
const usd = (minor: bigint) => Money.of(minor, 'USD');
const cad = (minor: bigint) => Money.of(minor, 'CAD');

const USD_CHECKING: InsightsAccount = {
  id: 'acct-usd-checking',
  type: 'checking',
  isCash: true,
  balance: usd(500_000n), // $5,000.00
  apy: 0.01,
  closed: false,
};

const CAD_SAVINGS: InsightsAccount = {
  id: 'acct-cad-savings',
  type: 'savings',
  isCash: true,
  balance: cad(708_000n), // CAD 7,080.00 — the gate's own live-walk figure (§3.12)
  apy: 0.02,
  closed: false,
};

function builderWithAccounts(accounts: readonly InsightsAccount[], fx?: Parameters<typeof inMemoryFxPort>[0]) {
  const ports = {
    ...emptyPorts(),
    ledger: inMemoryLedgerPort({ accounts }),
    ...(fx === undefined ? {} : { fx: inMemoryFxPort(fx) }),
  };
  return new SnapshotBuilder(ports);
}

describe('SnapshotBuilder — networth.summary / cash.summary over a non-USD account (Phase 3 gate C-10)', () => {
  it('an all-USD portfolio is unaffected: no excluded_currencies, exact totals', async () => {
    const builder = builderWithAccounts([USD_CHECKING]);
    const { snapshot } = await builder.build({
      userId: USER_ID,
      kind: 'builtin',
      grantedScopes: ['networth.summary', 'cash.summary'],
      today: TODAY,
      baseCurrency: 'USD',
      tokenKey: TOKEN_KEY,
    });

    const netWorth = NetWorthSummarySchema.parse(snapshot.networth_summary);
    expect(netWorth.excluded_currencies).toBeUndefined();
    expect(netWorth.net_worth).toEqual({ minor: '500000', currency: 'USD' });

    const cash = CashSummarySchema.parse(snapshot.cash_summary);
    expect(cash.excluded_currencies).toBeUndefined();
    expect(cash.total).toEqual({ minor: '500000', currency: 'USD' });
  });

  it('never throws CurrencyMismatchError on a CAD account, with or without an FX port', async () => {
    const withoutFx = builderWithAccounts([USD_CHECKING, CAD_SAVINGS]);
    await expect(
      withoutFx.build({
        userId: USER_ID,
        kind: 'builtin',
        grantedScopes: ['networth.summary', 'cash.summary'],
        today: TODAY,
        baseCurrency: 'USD',
        tokenKey: TOKEN_KEY,
      }),
    ).resolves.not.toThrow();

    const withFx = builderWithAccounts([USD_CHECKING, CAD_SAVINGS], { 'CAD/USD': '0.7400' });
    await expect(
      withFx.build({
        userId: USER_ID,
        kind: 'builtin',
        grantedScopes: ['networth.summary', 'cash.summary'],
        today: TODAY,
        baseCurrency: 'USD',
        tokenKey: TOKEN_KEY,
      }),
    ).resolves.not.toThrow();
  });

  it('with no FX port: the CAD account is excluded and named, never folded in at par', async () => {
    const builder = builderWithAccounts([USD_CHECKING, CAD_SAVINGS]);
    const { snapshot } = await builder.build({
      userId: USER_ID,
      kind: 'builtin',
      grantedScopes: ['networth.summary', 'cash.summary'],
      today: TODAY,
      baseCurrency: 'USD',
      tokenKey: TOKEN_KEY,
    });

    const netWorth = NetWorthSummarySchema.parse(snapshot.networth_summary);
    // Only the USD account counted — a par fold would report 500000 + 708000.
    expect(netWorth.assets).toEqual({ minor: '500000', currency: 'USD' });
    expect(netWorth.excluded_currencies).toEqual(['CAD']);

    const cash = CashSummarySchema.parse(snapshot.cash_summary);
    expect(cash.total).toEqual({ minor: '500000', currency: 'USD' });
    expect(cash.excluded_currencies).toEqual(['CAD']);
    // The per-account row still carries the CAD account, in its own currency —
    // 08 §4.2's minimisation is about identity, not about hiding a balance.
    expect(cash.accounts.map((a) => a.balance)).toEqual(
      expect.arrayContaining([{ minor: '708000', currency: 'CAD' }]),
    );
  });

  it('with an FX port and a rate: the CAD account converts into the total, no exclusion', async () => {
    const builder = builderWithAccounts([USD_CHECKING, CAD_SAVINGS], { 'CAD/USD': '0.7400' });
    const { snapshot } = await builder.build({
      userId: USER_ID,
      kind: 'builtin',
      grantedScopes: ['networth.summary', 'cash.summary'],
      today: TODAY,
      baseCurrency: 'USD',
      tokenKey: TOKEN_KEY,
    });

    // 708000 * 0.74 = 523920 (matching the gate's own live-walk conversion,
    // §3.12) plus 500000 USD = 1023920, then `networth.summary`'s own $100
    // rounding (08 §4.2, `scopes.ts` `roundMonetaryToMinor: 10_000`) to
    // 1020000 — the rounding this block has always applied, unrelated to C-10.
    const netWorth = NetWorthSummarySchema.parse(snapshot.networth_summary);
    expect(netWorth.excluded_currencies).toBeUndefined();
    expect(netWorth.assets).toEqual({ minor: '1020000', currency: 'USD' });
    expect(netWorth.net_worth).toEqual({ minor: '1020000', currency: 'USD' });

    const cash = CashSummarySchema.parse(snapshot.cash_summary);
    expect(cash.excluded_currencies).toBeUndefined();
    expect(cash.total).toEqual({ minor: '1023920', currency: 'USD' });
  });

  it('a same-currency Money.add would have thrown CurrencyMismatchError — the defect this closes', () => {
    // Documents the exact exception `build()` used to let escape (G3-13), so a
    // future revert of the fix is legible from this file alone rather than
    // only from the diff.
    expect(() => Money.add(usd(0n), cad(0n))).toThrow(CurrencyMismatchError);
  });
});
