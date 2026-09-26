// SPDX-License-Identifier: MIT
/**
 * WP 4.7 — idle-cash dwell, derived from `holdings_snapshots` rather than
 * hardcoded (`createInsightsInvestmentsPort` currently reads `idleCash: null`
 * with the comment "no dwell history exists to measure idleness against" —
 * docs/evidence/phase-3/wp3.10a-snapshot-readers.md §7.2).
 *
 * `idleDaysOf` and `cashPositionFor` are pure; `test/db/` is where a real
 * `holdings_snapshots` row would be proven, and this package's WP does not
 * add one (§3 "WP 4.7" names no `test/db/dwell.test.ts`) — the composition
 * this suite proves is exactly the one `cashSnapshotHistory` feeds in
 * production, just with the history supplied as a fixture instead of a query.
 */
import { DateOnly, Money, currency } from '@core/kernel';
import { describe, expect, it } from 'vitest';
import { idleCash } from '../src/analytics/cash.ts';
import { cashPositionFor, idleDaysOf, type CashSnapshot } from '../src/dwell.ts';

const USD = currency('USD');
const TODAY = DateOnly.parse('2026-09-24');

function day(offset: number): ReturnType<typeof DateOnly.parse> {
  return DateOnly.addDays(TODAY, offset);
}

function snapshot(offset: number, dollars: string): CashSnapshot {
  return { asOfDate: day(offset), cash: Money.parseAmount(dollars, USD) };
}

describe('idleDaysOf', () => {
  it('counts back from asOfDate while the balance stays at or above its current level', () => {
    // Flat at $12,000 for 20 days, then today.
    const history: readonly CashSnapshot[] = [
      snapshot(-20, '12000.00'),
      snapshot(-15, '12000.00'),
      snapshot(-10, '12000.00'),
      snapshot(-5, '12000.00'),
      snapshot(0, '12000.00'),
    ];
    expect(idleDaysOf(history, TODAY)).toBe(20);
  });

  it('stops counting at the day the balance was below where it is now', () => {
    // $8,000 fourteen days ago, topped up to $12,000 six days ago.
    const history: readonly CashSnapshot[] = [
      snapshot(-14, '8000.00'),
      snapshot(-6, '12000.00'),
      snapshot(0, '12000.00'),
    ];
    expect(idleDaysOf(history, TODAY)).toBe(6);
  });

  it('returns 0 with no history — no information is never treated as long-idle', () => {
    expect(idleDaysOf([], TODAY)).toBe(0);
  });

  it('ignores a row after asOfDate', () => {
    const history: readonly CashSnapshot[] = [snapshot(-5, '1000.00'), snapshot(3, '999999.00')];
    expect(idleDaysOf(history, TODAY)).toBe(5);
  });

  it('is insensitive to the order history arrives in', () => {
    const forward: readonly CashSnapshot[] = [
      snapshot(-20, '500.00'),
      snapshot(-10, '500.00'),
      snapshot(0, '500.00'),
    ];
    const shuffled = [forward[2], forward[0], forward[1]] as readonly CashSnapshot[];
    expect(idleDaysOf(shuffled, TODAY)).toBe(idleDaysOf(forward, TODAY));
  });
});

describe('cashPositionFor', () => {
  const account = (overrides: {
    readonly history: readonly CashSnapshot[];
    readonly earmarkedAmount?: ReturnType<typeof Money.zero>;
  }) =>
    cashPositionFor(
      {
        accountId: 'acct-1',
        asOfDate: TODAY,
        cash: Money.parseAmount('12000.00', USD),
        accountValue: Money.parseAmount('50000.00', USD),
        earmarkedAmount: overrides.earmarkedAmount ?? Money.zero(USD),
      },
      overrides.history,
    );

  it('idleDays is measured from holdings_snapshots and an earmarked balance is never idle', () => {
    const history: readonly CashSnapshot[] = [
      snapshot(-20, '12000.00'),
      snapshot(-10, '12000.00'),
      snapshot(0, '12000.00'),
    ];

    // No earmark: the position is idle by I3's rule (over the $1,000 floor,
    // more than 14 days, not earmarked).
    const idlePosition = account({ history });
    expect(idlePosition.idleDays).toBe(20);
    expect(idlePosition.earmarked).toBe(false);
    const idleReport = idleCash([idlePosition], { currency: USD });
    expect(idleReport.rows[0]?.idle).toBe(true);
    expect(Money.isZero(idleReport.idleTotal)).toBe(false);

    // Sabotage-tested: with `Money.isZero` in `cashPositionFor` replaced by a
    // function that always returns `true`, this earmarked branch goes red —
    // observed, reverted; docs/evidence/phase-4/wp4.7-gap-fields.md records it.
    const earmarkedPosition = account({
      history,
      earmarkedAmount: Money.parseAmount('6000.00', USD),
    });
    // Dwell is unaffected by the earmark — it is still measured from the same
    // history — but the balance is never idle once earmarked.
    expect(earmarkedPosition.idleDays).toBe(20);
    expect(earmarkedPosition.earmarked).toBe(true);
    const earmarkedReport = idleCash([earmarkedPosition], { currency: USD });
    expect(earmarkedReport.rows[0]?.idle).toBe(false);
    expect(Money.isZero(earmarkedReport.idleTotal)).toBe(true);
  });

  it('a balance under fourteen days old is not idle even with no earmark', () => {
    const history: readonly CashSnapshot[] = [snapshot(-5, '12000.00')];
    const position = account({ history });
    expect(position.idleDays).toBe(5);
    const report = idleCash([position], { currency: USD });
    expect(report.rows[0]?.idle).toBe(false);
  });

  it('a one-cent earmark is still an earmark — the whole balance reads earmarked', () => {
    const history: readonly CashSnapshot[] = [snapshot(-20, '12000.00')];
    const position = account({ history, earmarkedAmount: Money.parseAmount('0.01', USD) });
    expect(position.earmarked).toBe(true);
  });
});
