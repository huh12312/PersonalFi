// SPDX-License-Identifier: MIT
/**
 * The alert budget and the cooldown ladder, as pure functions.
 *
 * 02-phase-2-dispatch.md §6 question 4's default: 5 on the dashboard, 20 in the
 * list, $50 minimum annual impact; 30 days after one dismissal, 90 after two,
 * permanent after three. The database half of the ladder —
 * `insight_dismissals`, the constraint that makes "permanent" unreachable
 * except by three dismissals — is `test/db/dedupe-cooldown.test.ts`.
 */
import { Money } from '@core/kernel';
import { describe, expect, it } from 'vitest';
import {
  ALERT_BUDGET,
  applyAlertBudget,
  belowFloor,
  effectiveImpactMinor,
  rank,
  type RankableInsight,
} from '../src/policy/alert-budget.ts';
import {
  COOLDOWN_LADDER_DAYS,
  PERMANENT_AFTER_DISMISSALS,
  afterDismissal,
  afterSnooze,
  cooldownKey,
  isSuppressed,
  rungFor,
} from '../src/policy/cooldown.ts';
import {
  CONSECUTIVE_FAILURE_LIMIT,
  decideRun,
  shouldQuarantine,
} from '../src/policy/kill-switches.ts';

const usd = (minor: bigint) => Money.of(minor, 'USD');

function insight(overrides: Partial<RankableInsight> = {}): RankableInsight {
  return {
    key: 'k',
    severity: 'notable',
    confidence: 1,
    annualizedImpact: usd(120_000n),
    oneTimeImpact: null,
    ...overrides,
  };
}

describe('the alert budget', () => {
  it('shows five on the dashboard and twenty in the list, and withholds the rest', () => {
    const rows = Array.from({ length: 30 }, (_value, index) =>
      insight({
        key: `insight-${String(index).padStart(2, '0')}`,
        annualizedImpact: usd(BigInt(1_000_000 - index * 1000)),
      }),
    );
    const feed = applyAlertBudget(rows, (row) => row, 'USD');
    expect(feed.dashboard).toHaveLength(ALERT_BUDGET.dashboard);
    expect(feed.list).toHaveLength(ALERT_BUDGET.list);
    expect(feed.overflow).toHaveLength(10);
    // Withheld, not deleted: every row is still in exactly one slice.
    expect(feed.list.length + feed.overflow.length + feed.belowFloor.length).toBe(rows.length);
    // The dashboard is the head of the list, not a different selection.
    expect(feed.list.slice(0, ALERT_BUDGET.dashboard)).toEqual(feed.dashboard);
  });

  it('withholds an insight that claims less than $50 a year', () => {
    expect(belowFloor(insight({ annualizedImpact: usd(4999n) }), 'USD')).toBe(true);
    expect(belowFloor(insight({ annualizedImpact: usd(5000n) }), 'USD')).toBe(false);
  });

  it('never floors out an insight that claims no impact', () => {
    // "A direct debit failed" has no annualised saving and is the most urgent
    // thing this app can say. The floor is a filter on advice about money left
    // on the table, not on advice.
    const urgent = insight({ severity: 'urgent', annualizedImpact: null, oneTimeImpact: null });
    expect(belowFloor(urgent, 'USD')).toBe(false);
    expect(effectiveImpactMinor(urgent)).toBeNull();

    const feed = applyAlertBudget([urgent, insight()], (row) => row, 'USD');
    expect(feed.belowFloor).toEqual([]);
    // And it leads, because severity is the dominant term.
    expect(feed.dashboard[0]).toBe(urgent);
  });

  it('counts a one-time saving at half a recurring one of equal size', () => {
    expect(
      effectiveImpactMinor(insight({ annualizedImpact: null, oneTimeImpact: usd(20_000n) })),
    ).toBe(10_000n);
    // Which means a $60 one-off is below the $50 floor and a $120 one-off is not.
    expect(belowFloor(insight({ annualizedImpact: null, oneTimeImpact: usd(6000n) }), 'USD')).toBe(
      true,
    );
    expect(
      belowFloor(insight({ annualizedImpact: null, oneTimeImpact: usd(12_000n) }), 'USD'),
    ).toBe(false);
  });

  it('orders stably, so the feed does not reshuffle when nothing changed', () => {
    const tied = ['b', 'a', 'c'].map((key) => insight({ key }));
    const first = applyAlertBudget(tied, (row) => row, 'USD').list.map((row) => row.key);
    const second = applyAlertBudget([...tied].reverse(), (row) => row, 'USD').list.map(
      (row) => row.key,
    );
    expect(first).toEqual(['a', 'b', 'c']);
    expect(second).toEqual(first);
  });

  it('lets severity beat size', () => {
    const big = insight({ severity: 'info', annualizedImpact: usd(5_000_000n) });
    const urgent = insight({ key: 'z', severity: 'urgent', annualizedImpact: usd(6000n) });
    expect(rank(urgent)).toBeGreaterThan(rank(big));
  });
});

describe('the cooldown ladder', () => {
  const now = new Date('2026-09-19T09:00:00.000Z');

  it('is 30, then 90, then permanent', () => {
    expect([...COOLDOWN_LADDER_DAYS]).toEqual([30, 90]);
    expect(PERMANENT_AFTER_DISMISSALS).toBe(3);
    expect(rungFor(0)).toEqual({ days: 0, permanent: false });
    expect(rungFor(1)).toEqual({ days: 30, permanent: false });
    expect(rungFor(2)).toEqual({ days: 90, permanent: false });
    expect(rungFor(3)).toEqual({ days: null, permanent: true });
    expect(rungFor(9)).toEqual({ days: null, permanent: true });
  });

  it('walks the rungs one dismissal at a time', () => {
    const first = afterDismissal(null, now);
    expect(first.dismissCount).toBe(1);
    expect(first.suppressedUntil?.toISOString()).toBe('2026-10-19T09:00:00.000Z');

    const second = afterDismissal(first, now);
    expect(second.dismissCount).toBe(2);
    expect(second.suppressedUntil?.toISOString()).toBe('2026-12-18T09:00:00.000Z');

    const third = afterDismissal(second, now);
    expect(third).toEqual({ dismissCount: 3, suppressedUntil: null, permanent: true });
  });

  it('is a pure function of (previous, now), so a replay does not skip a rung', () => {
    const first = afterDismissal(null, now);
    expect(afterDismissal(null, now)).toEqual(first);
  });

  it('a snooze silences without advancing the ladder', () => {
    // Snoozing three times is not the same statement as refusing three times,
    // so no amount of snoozing reaches the permanent rung.
    const until = new Date('2026-09-26T09:00:00.000Z');
    let state = afterSnooze(null, until);
    state = afterSnooze(state, until);
    state = afterSnooze(state, until);
    expect(state.dismissCount).toBe(0);
    expect(state.permanent).toBe(false);
    expect(isSuppressed(state, now)).toBe(true);
  });

  it('a permanent suppression has no date to expire', () => {
    const permanent = { dismissCount: 3, suppressedUntil: null, permanent: true };
    expect(isSuppressed(permanent, now)).toBe(true);
    expect(isSuppressed(permanent, new Date('2099-01-01T00:00:00.000Z'))).toBe(true);
  });

  it('a timed suppression expires exactly when it says', () => {
    const state = afterDismissal(null, now);
    expect(isSuppressed(state, new Date('2026-10-18T09:00:00.000Z'))).toBe(true);
    expect(isSuppressed(state, new Date('2026-10-19T09:00:00.000Z'))).toBe(false);
  });

  it('keys on the finding, with a separator neither half can contain', () => {
    expect(cooldownKey('a', 'b')).toBe('a|b');
    // The schemas forbid `|` in both halves, so `a:b`+`c` and `a`+`b:c` cannot
    // collide the way they would under a `:` separator.
    expect(cooldownKey('a:b', 'c')).not.toBe(cooldownKey('a', 'b:c'));
  });
});

describe('the kill switches', () => {
  const on = {
    advisorsEnabled: true,
    moduleEnabled: true,
    advisorEnabled: true,
    quarantinedAt: null,
  };

  it('any one of the three is enough to stop a run', () => {
    expect(decideRun(on)).toEqual({ run: true });
    expect(decideRun({ ...on, advisorsEnabled: false })).toEqual({
      run: false,
      refusal: 'advisors_disabled',
    });
    expect(decideRun({ ...on, moduleEnabled: false })).toEqual({
      run: false,
      refusal: 'module_disabled',
    });
    expect(decideRun({ ...on, advisorEnabled: false })).toEqual({
      run: false,
      refusal: 'advisor_disabled',
    });
    expect(decideRun({ ...on, quarantinedAt: new Date() })).toEqual({
      run: false,
      refusal: 'advisor_quarantined',
    });
  });

  it('records the broadest reason that applies', () => {
    // "Everything is off" and "this one advisor is quarantined" are very
    // different operational situations, and the log should not report the
    // second when the first is true.
    expect(
      decideRun({
        advisorsEnabled: false,
        moduleEnabled: false,
        advisorEnabled: false,
        quarantinedAt: new Date(),
      }),
    ).toEqual({ run: false, refusal: 'advisors_disabled' });
  });

  it('trips the breaker on a failure streak', () => {
    expect(shouldQuarantine({ consecutiveFailures: 4, accepted: 0, rejected: 0 })).toBeNull();
    expect(
      shouldQuarantine({
        consecutiveFailures: CONSECUTIVE_FAILURE_LIMIT,
        accepted: 0,
        rejected: 0,
      }),
    ).toBe('consecutive_failures');
  });

  it('trips the breaker on a run whose output was mostly refused', () => {
    // An advisor that times out is obviously broken. One that returns
    // beautifully-formed JSON in which every number is invented is worse, and
    // it never throws.
    expect(shouldQuarantine({ consecutiveFailures: 0, accepted: 1, rejected: 1 })).toBeNull();
    expect(shouldQuarantine({ consecutiveFailures: 0, accepted: 2, rejected: 2 })).toBe(
      'rejection_rate',
    );
    expect(shouldQuarantine({ consecutiveFailures: 0, accepted: 8, rejected: 2 })).toBeNull();
  });
});
