// SPDX-License-Identifier: MIT
/**
 * The alert budget applied **after the investing wave is released** — the
 * scenario 07 §7.4 exists for, run on real output rather than described.
 *
 * *"18 P0 rules means a wall of red on day one."* WP 3.10 adds seventeen rules
 * at once, and the question this file answers is what a user would actually see
 * the morning after somebody flipped `advisors.enabled` on all of them: five on
 * the dashboard, twenty in the list, the rest withheld rather than deleted, and
 * a $50 floor that the risk rules are exempt from because they claim nothing.
 *
 * The exemption is the part worth testing. Applied literally to everything, the
 * floor would suppress X1 — crypto at a fifth of net worth — because X1 claims
 * no dollar figure at all, and that is the single most urgent thing this wave
 * can say.
 */
import { describe, expect, it } from 'vitest';
import { BUILTIN_CATALOGUE, wp310Catalogue, wp49Catalogue } from '../src/advisors/catalogue.ts';
import { contextOf, moneyOf } from '../src/advisors/support.ts';
import { ALERT_BUDGET, applyAlertBudget, belowFloor } from '../src/policy/alert-budget.ts';
import type { Insight } from '../src/contract/response.ts';
import { requestFor, seedSnapshot } from './advisors/seed.ts';

interface Row {
  readonly ruleId: string;
  readonly insight: Insight;
}

type Feed = ReturnType<typeof applyAlertBudget<Row>>;

function project(row: Row) {
  return {
    key: row.insight.key,
    severity: row.insight.severity,
    confidence: row.insight.confidence,
    annualizedImpact: moneyOf(row.insight.impact.annualized),
    oneTimeImpact: moneyOf(row.insight.impact.one_time),
  };
}

async function releasedFeed(
  entries: readonly (typeof BUILTIN_CATALOGUE)[number][],
): Promise<readonly Row[]> {
  const snapshot = await seedSnapshot('drift');
  return entries.flatMap((entry) =>
    entry.rule
      .evaluate(contextOf(requestFor(entry.rule.manifest, snapshot)))
      .insights.map((insight) => ({ ruleId: entry.ruleId, insight })),
  );
}

describe('the alert budget after the investing wave', () => {
  it('shows five on the dashboard and withholds the rest rather than deleting them', async () => {
    const rows = await releasedFeed(wp310Catalogue());
    expect(rows.length, 'the wave should produce a genuine pile').toBeGreaterThan(15);

    const feed = applyAlertBudget(rows, project, 'USD');
    expect(feed.dashboard.length).toBe(ALERT_BUDGET.dashboard);
    expect(feed.list.length).toBeLessThanOrEqual(ALERT_BUDGET.list);

    // Nothing is lost. Every proposal is in exactly one of the four buckets,
    // and every one of them still lands in `insights` as `pending_review` with
    // its evidence — the budget decides what is *shown*.
    const seen = new Set(
      [...feed.list, ...feed.overflow, ...feed.belowFloor].map((row) => row.insight.key),
    );
    expect(seen.size).toBe(new Set(rows.map((row) => row.insight.key)).size);

    // The dashboard is the head of the list, not a separate selection.
    expect(feed.list.slice(0, ALERT_BUDGET.dashboard)).toEqual(feed.dashboard);
  });

  it('leads with the P0s, because severity beats size', async () => {
    const rows = await releasedFeed(wp310Catalogue());
    const feed = applyAlertBudget(rows, project, 'USD');

    // I4, I5 and X1 are the three `urgent` rules in this wave. They claim no
    // dollar figure between them, and they still come first: the severity term
    // in `rank()` is additive and dominant precisely so that an urgent finding
    // with no figure outranks a large but merely notable saving.
    const dashboardRules = feed.dashboard.map((row) => row.ruleId).sort();
    for (const ruleId of ['I4', 'I5', 'X1']) {
      expect(dashboardRules, `${ruleId} did not reach the dashboard`).toContain(ruleId);
    }
  });

  it('never floors out a risk finding that claims no impact', async () => {
    const rows = await releasedFeed(wp310Catalogue());

    for (const row of rows) {
      const claimsNothing =
        row.insight.impact.annualized === null && row.insight.impact.one_time === null;
      if (!claimsNothing) continue;
      // "An insight that claims $3 is withheld; an insight that claims nothing
      // is judged on what it is." X1 is the case that proves the exemption is
      // load-bearing rather than tidy.
      expect(belowFloor(project(row), 'USD'), `${row.ruleId} ${row.insight.key}`).toBe(false);
    }

    const feed = applyAlertBudget(rows, project, 'USD');
    expect(feed.belowFloor.map((row) => row.ruleId)).not.toContain('X1');
    expect(feed.belowFloor.map((row) => row.ruleId)).not.toContain('I4');
  });

  it('applies the $50 floor to the rules that do claim a figure', async () => {
    const rows = await releasedFeed(wp310Catalogue());
    const claiming = rows.filter((row) => row.insight.impact.annualized !== null);
    expect(claiming.length, 'no rule in this wave claimed a figure').toBeGreaterThan(0);

    for (const row of claiming) {
      const minor = BigInt(row.insight.impact.annualized?.minor ?? '0');
      const floored = belowFloor(project(row), 'USD');
      expect(floored, `${row.ruleId} ${row.insight.key}`).toBe(
        minor < BigInt(ALERT_BUDGET.minimumAnnualImpactMajor) * 100n,
      );
    }
  });

  it('orders stably, so the feed does not reshuffle between two reads', async () => {
    const rows = await releasedFeed(wp310Catalogue());
    const first = applyAlertBudget(rows, project, 'USD').list.map((row) => row.insight.key);
    const second = applyAlertBudget([...rows].reverse(), project, 'USD').list.map(
      (row) => row.insight.key,
    );
    expect(second).toEqual(first);
  });

  it('the whole catalogue released at once still fits the same budget', async () => {
    // The worst case somebody could actually configure: Phase 2's fourteen and
    // WP 3.10's seventeen, all on. The budget is the thing that makes that
    // survivable, and it is applied at read time so raising the ceiling needs
    // no re-run and lowering it loses nothing.
    const rows = await releasedFeed(BUILTIN_CATALOGUE);
    const feed = applyAlertBudget(rows, project, 'USD');
    expect(feed.dashboard.length).toBe(ALERT_BUDGET.dashboard);
    expect(feed.list.length).toBe(ALERT_BUDGET.list);
    expect(feed.overflow.length + feed.list.length + feed.belowFloor.length).toBe(rows.length);
  });
});

/**
 * WP 4.9 — 07 §7.4's week four, released on top of everything else.
 *
 * The dispatch: *"the alert budget is applied **after** the wave is released,
 * not before."* In production that is `read.ts`' `insightFeed`, which calls
 * `applyAlertBudget` once over every stored insight with no notion of a wave at
 * all — so a released wave competes for the same five and twenty slots rather
 * than arriving with its own. `releaseWave` below is that order, written as a
 * function so the evidence doc's sabotage (budget the existing feed first, then
 * append the wave) is a one-line change to one place.
 */
function releaseWave(existing: readonly Row[], wave: readonly Row[]): Feed {
  return applyAlertBudget([...existing, ...wave], project, 'USD');
}

describe('the alert budget after the retirement wave (WP 4.9)', () => {
  it('the alert budget is applied after the retirement wave is released, not before', async () => {
    const existing = await releasedFeed(
      BUILTIN_CATALOGUE.filter((entry) => entry.wave !== 'retirement'),
    );
    const wave = await releasedFeed(wp49Catalogue());
    expect(wave.map((row) => row.ruleId).sort()).toEqual(['R2', 'R3', 'R4', 'R6', 'R7']);

    const before = applyAlertBudget(existing, project, 'USD');
    const after = releaseWave(existing, wave);

    // The budget did not grow with the wave: five and twenty, before and after.
    expect(before.dashboard.length).toBe(ALERT_BUDGET.dashboard);
    expect(after.dashboard.length).toBe(ALERT_BUDGET.dashboard);
    expect(after.list.length).toBe(ALERT_BUDGET.list);

    // R2 and R7 — the wave's two urgents — reach the dashboard by competing
    // for it, and something that was there before the release is displaced to
    // the list rather than the dashboard gaining a sixth slot.
    const dashboard = after.dashboard.map((row) => row.ruleId);
    expect(dashboard).toContain('R2');
    expect(dashboard).toContain('R7');
    const displaced = before.dashboard.filter(
      (row) => !after.dashboard.some((kept) => kept.insight.key === row.insight.key),
    );
    expect(displaced.length, 'a release that displaced nothing was not budgeted').toBeGreaterThan(
      0,
    );
    for (const row of displaced) {
      expect(
        after.list.some((listed) => listed.insight.key === row.insight.key),
        `${row.ruleId} was deleted instead of moved down`,
      ).toBe(true);
    }

    // Nothing is lost: every proposal from both halves is in exactly one bucket.
    const total = after.list.length + after.overflow.length + after.belowFloor.length;
    expect(total).toBe(existing.length + wave.length);
    // R3 and R4 claim no figure and are `notable`: held in overflow, not floored.
    const overflow = after.overflow.map((row) => row.ruleId);
    expect(overflow).toContain('R3');
    expect(overflow).toContain('R4');
    expect(after.belowFloor.map((row) => row.ruleId)).not.toContain('R3');
  });

  it('the one retirement rule that claims a figure clears the floor on its own merits', async () => {
    const wave = await releasedFeed(wp49Catalogue());
    const claiming = wave.filter((row) => row.insight.impact.annualized !== null);
    expect(claiming.map((row) => row.ruleId)).toEqual(['R6']);
    for (const row of claiming) expect(belowFloor(project(row), 'USD')).toBe(false);
    for (const row of wave.filter((item) => item.insight.impact.annualized === null)) {
      expect(belowFloor(project(row), 'USD'), `${row.ruleId}`).toBe(false);
    }
  });
});
