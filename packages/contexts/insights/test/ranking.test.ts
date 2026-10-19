// SPDX-License-Identifier: MIT
/**
 * Ranking (07 §3.2) and the alert budget on top of it (07 §7.4, 02 §6 Q4).
 *
 * Two properties are load-bearing and are asserted separately from the
 * arithmetic:
 *
 *   * **The catalogue's ranking is a multiplier over the platform's.** With
 *     every catalogue-only factor at its neutral value, `rankBuiltin` and
 *     WP 2.6's `rank` return the same number — so an advisor with no catalogue
 *     entry (a Phase 6 sidecar) is not ranked on a different scale from ours.
 *   * **The budget withholds, it does not delete.** Every slice is returned, so
 *     "and 14 more" and "why is this not in my feed?" both have answers in the
 *     return value.
 */
import { describe, expect, it } from 'vitest';
import { Money } from '@core/kernel';
import {
  ACTIONABILITY,
  URGENCY_MULTIPLIER,
  actionabilityOf,
  applyCatalogueBudget,
  rankBuiltin,
  rankableBuiltinOf,
  urgencyOf,
  type RankableBuiltin,
} from '../src/advisors/ranking.ts';
import { ALERT_BUDGET, effectiveImpactMinor, rank } from '../src/policy/alert-budget.ts';
import { rankFeed, type InsightView } from '../src/read.ts';

const USD = 'USD';

function row(overrides: Partial<RankableBuiltin> = {}): RankableBuiltin {
  return {
    key: 'k',
    severity: 'notable',
    confidence: 1,
    annualizedImpact: null,
    oneTimeImpact: null,
    horizon: 'this_year',
    actionKinds: ['suggest_only'],
    dismissRate: 0,
    ...overrides,
  };
}

describe('ranking', () => {
  it('a one-time saving ranks at half a recurring one of equal size', () => {
    const size = Money.of(120_000n, USD);
    const recurring = row({ key: 'recurring', annualizedImpact: size });
    const oneTime = row({ key: 'one-time', oneTimeImpact: size });

    // The halving happens where the money is weighed, exactly once.
    expect(effectiveImpactMinor(oneTime)).toBe((effectiveImpactMinor(recurring) ?? 0n) / 2n);
    expect(effectiveImpactMinor(oneTime)).toBe(60_000n);

    // And it carries through the whole score, with everything else equal.
    expect(rankBuiltin(oneTime)).toBeLessThan(rankBuiltin(recurring));

    // A recurring saving of half the size ranks exactly where the one-time does.
    const halfRecurring = row({ key: 'one-time', annualizedImpact: Money.of(60_000n, USD) });
    expect(rankBuiltin(oneTime)).toBe(rankBuiltin(halfRecurring));
  });

  it('is the platform ranking multiplied by the three catalogue factors', () => {
    const neutral = row({
      annualizedImpact: Money.of(40_000n, USD),
      actionKinds: [],
      horizon: 'this_year',
      dismissRate: 0,
    });
    // Actionability is 0.4 for an insight with no action, so the neutral case
    // is stated explicitly rather than assumed.
    expect(rankBuiltin(neutral)).toBeCloseTo(rank(neutral) * ACTIONABILITY.informational, 10);

    const urgent = row({ annualizedImpact: Money.of(40_000n, USD), horizon: 'immediate' });
    expect(rankBuiltin(urgent)).toBeCloseTo(
      rank(urgent) * ACTIONABILITY.doItYourself * URGENCY_MULTIPLIER.deadline,
      10,
    );

    const dismissed = row({ annualizedImpact: Money.of(40_000n, USD), dismissRate: 1 });
    expect(rankBuiltin(dismissed)).toBeCloseTo(
      rank(dismissed) * ACTIONABILITY.doItYourself * 0.5,
      10,
    );
  });

  it('reads actionability and urgency off the insight, not off a table', () => {
    expect(actionabilityOf([])).toBe(ACTIONABILITY.informational);
    expect(actionabilityOf(['suggest_only'])).toBe(ACTIONABILITY.doItYourself);
    expect(actionabilityOf(['open_url'])).toBe(ACTIONABILITY.doItYourself);
    expect(actionabilityOf(['suggest_only', 'create_rule_draft'])).toBe(ACTIONABILITY.oneClick);
    expect(actionabilityOf(['create_goal_draft'])).toBe(ACTIONABILITY.oneClick);
    // An action kind the contract does not have cannot buy a tier.
    expect(actionabilityOf(['execute'])).toBe(ACTIONABILITY.informational);

    expect(urgencyOf('immediate')).toBe(URGENCY_MULTIPLIER.deadline);
    expect(urgencyOf('this_period')).toBe(URGENCY_MULTIPLIER.none);
  });

  it('an urgent finding with no dollar figure outranks a large saving', () => {
    const overdraft = row({ key: 'overdraft', severity: 'urgent', horizon: 'immediate' });
    const saving = row({ key: 'saving', annualizedImpact: Money.of(4_000_000n, USD) });
    expect(rankBuiltin(overdraft)).toBeGreaterThan(rankBuiltin(saving));
  });

  it('projects a feed row without the feed importing the ranking types', () => {
    const projected = rankableBuiltinOf(
      {
        key: 'k',
        severity: 'warning',
        confidence: 0.8,
        annualizedImpact: Money.of(10_000n, USD),
        oneTimeImpact: null,
        horizon: 'immediate',
        actions: [{ kind: 'create_rule_draft' }],
      },
      0.25,
    );
    expect(projected.actionKinds).toEqual(['create_rule_draft']);
    expect(projected.dismissRate).toBe(0.25);
  });
});

describe('the alert budget', () => {
  /** Twenty-five qualifying insights, every one above the $50 floor. */
  function ladder(): readonly RankableBuiltin[] {
    return Array.from({ length: 25 }, (_, index) =>
      row({
        key: `k${String(index).padStart(2, '0')}`,
        // $300 down to $60, in $10 steps. Descending, so index is rank order.
        annualizedImpact: Money.of(BigInt(30_000 - index * 1_000), USD),
      }),
    );
  }

  it('the alert budget caps dashboard/list counts and drops by lowest impact', () => {
    const rows = ladder();
    const feed = applyCatalogueBudget(rows, (item) => item, USD);

    expect(feed.dashboard).toHaveLength(ALERT_BUDGET.dashboard);
    expect(feed.list).toHaveLength(ALERT_BUDGET.list);
    expect(feed.overflow).toHaveLength(rows.length - ALERT_BUDGET.list);
    expect(feed.belowFloor).toEqual([]);

    // The dashboard is the top of the list, not a separate selection.
    expect(feed.list.slice(0, ALERT_BUDGET.dashboard)).toEqual(feed.dashboard);

    // Highest impact first, and the five dropped are the five smallest.
    expect(feed.dashboard.map((item) => item.key)).toEqual(['k00', 'k01', 'k02', 'k03', 'k04']);
    expect(feed.overflow.map((item) => item.key)).toEqual(['k20', 'k21', 'k22', 'k23', 'k24']);

    // Withheld, not deleted: every row is in exactly one slice.
    const seen = [...feed.list, ...feed.overflow, ...feed.belowFloor].map((item) => item.key);
    expect(new Set(seen).size).toBe(rows.length);
  });

  it('withholds below the $50 floor, and exempts an insight that claims nothing', () => {
    const rows = [
      row({ key: 'tiny', annualizedImpact: Money.of(300n, USD) }),
      row({ key: 'big', annualizedImpact: Money.of(40_000n, USD) }),
      row({ key: 'overdraft', severity: 'urgent', horizon: 'immediate' }),
    ];
    const feed = applyCatalogueBudget(rows, (item) => item, USD);

    expect(feed.belowFloor.map((item) => item.key)).toEqual(['tiny']);
    // The no-impact insight is not measured against the floor, and leads.
    expect(feed.dashboard.map((item) => item.key)).toEqual(['overdraft', 'big']);
  });

  it('orders stably when two insights score identically', () => {
    const rows = [
      row({ key: 'bravo', annualizedImpact: Money.of(40_000n, USD) }),
      row({ key: 'alpha', annualizedImpact: Money.of(40_000n, USD) }),
    ];
    const once = applyCatalogueBudget(rows, (item) => item, USD);
    const twice = applyCatalogueBudget([...rows].reverse(), (item) => item, USD);
    expect(once.list.map((item) => item.key)).toEqual(['alpha', 'bravo']);
    expect(twice.list.map((item) => item.key)).toEqual(['alpha', 'bravo']);
  });
});

/**
 * WP 5.9: `read.ts:307` composed `applyAlertBudget` (`policy/alert-budget.ts`'s
 * `rank()`, no catalogue factors at all) rather than `applyCatalogueBudget`
 * over `rankBuiltin`, so 07 §3.2's learned `(1 − 0.5·dismiss_rate)` penalty —
 * proved correct just above, in `rankBuiltin`'s own tests — was never read on
 * the feed a holder actually sees (found while writing
 * 05-phase-5-dispatch.md, §2's row). `rankFeed` is `read.ts`'s fix; this
 * describes it as `insightFeed` will call it, over `InsightView`s rather than
 * bare `RankableBuiltin` rows.
 */
describe('the feed applies the learned dismiss penalty (WP 5.9)', () => {
  function view(overrides: Partial<InsightView> = {}): InsightView {
    return {
      id: overrides.key ?? 'id',
      advisorId: 'builtin.example',
      advisorVersion: '1.0.0',
      key: 'k',
      period: 'all_time',
      type: 'example.finding',
      severity: 'notable',
      severityClamped: false,
      title: 't',
      summaryMd: 's',
      confidence: 1,
      confidenceBasis: 'deterministic',
      horizon: 'this_year',
      status: 'pending_review',
      annualizedImpact: Money.of(40_000n, USD),
      oneTimeImpact: null,
      impactBasis: 'b',
      caveats: [],
      inputDigest: 'sha256:' + '0'.repeat(64),
      firstProposedAt: new Date('2026-09-01T00:00:00.000Z'),
      lastProposedAt: new Date('2026-09-01T00:00:00.000Z'),
      expiresAt: null,
      evidence: [],
      actions: [],
      bookmarkedAt: null,
      feedback: null,
      feedbackReason: null,
      ...overrides,
    };
  }

  it('the feed ranks with the learned dismiss penalty, and a rule with no history ranks on its merits', () => {
    const heavy = view({
      id: 'heavy',
      key: 'heavy',
      advisorId: 'builtin.heavy_dismisser',
    });
    const fresh = view({
      id: 'fresh',
      key: 'fresh',
      advisorId: 'builtin.never_dismissed',
    });

    const rates = new Map<string, number>([['builtin.heavy_dismisser', 0.9]]);
    const feed = rankFeed([heavy, fresh], (advisorId) => rates.get(advisorId) ?? 0, USD);

    // Same impact, same everything but the learned history — the
    // heavily-dismissed rule ranks behind the one with no history at all.
    expect(feed.list.map((row) => row.advisorId)).toEqual([
      'builtin.never_dismissed',
      'builtin.heavy_dismisser',
    ]);

    // And it is not a second formula: it matches rankBuiltin's own arithmetic.
    const heavyRow = rankableBuiltinOf({ ...heavy, actions: [] }, 0.9);
    const freshRow = rankableBuiltinOf({ ...fresh, actions: [] }, 0);
    expect(rankBuiltin(heavyRow)).toBeLessThan(rankBuiltin(freshRow));
  });

  it('an advisor absent from the dismiss-rate lookup ranks as if it had never been dismissed', () => {
    const untouched = view({ id: 'u', key: 'u', advisorId: 'builtin.brand_new' });
    const feed = rankFeed([untouched], () => 0, USD);
    expect(feed.dashboard).toHaveLength(1);
    expect(feed.dashboard[0]?.advisorId).toBe('builtin.brand_new');
  });
});
