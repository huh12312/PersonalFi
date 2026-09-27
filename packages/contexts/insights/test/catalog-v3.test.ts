// SPDX-License-Identifier: MIT
/**
 * WP 4.9's catalogue — the retirement wave — held to the properties WP 2.7's
 * and WP 3.10's were, under the dispatch's own test names.
 *
 * `catalog.test.ts` already runs the catalogue-wide assertions over all
 * thirty-seven rules and so covers these six too. This file exists anyway, for
 * the reason `catalog-v2.test.ts` gives: a reviewer looking for *'every R rule
 * produces at least one resolvable evidence ref on the seed'* should find it,
 * and the two suites fail differently. It adds what is specific to the wave:
 * each rule silent when **its own** input is absent (not only on an empty
 * snapshot), the refusals R2 makes, R5 recorded as a gap rather than written
 * over a default, and the impact ceiling on the one rule that claims a figure.
 */
import { describe, expect, it } from 'vitest';
import {
  BUILTIN_CATALOGUE,
  CATALOGUE_GAPS,
  WP_3_10_SCOPE,
  WP_4_9_SCOPE,
  WP_4_9_URGENT_RULE_IDS,
  wp49Catalogue,
} from '../src/advisors/catalogue.ts';
import { ADVISORY_DISCLAIMER } from '../src/advisors/builtin/retirement/index.ts';
import { IMPACT_CEILING_MAJOR, contextOf } from '../src/advisors/support.ts';
import { resolveLimits } from '../src/contract/manifest.ts';
import type { AdvisorScope } from '../src/contract/scopes.ts';
import type { AdvisorSnapshot } from '../src/contract/snapshot.ts';
import { resolveSourceRef } from '../src/validate/evidence.ts';
import { validateResponse } from '../src/validate/pipeline.ts';
import {
  EMPTY_SNAPSHOT,
  TODAY,
  USD,
  requestFor,
  seedSnapshot,
  type SeedCase,
} from './advisors/seed.ts';

const R_RULES = wp49Catalogue();
const FIRING_CASES: readonly SeedCase[] = ['drift', 'tight'];

type Entry = (typeof BUILTIN_CATALOGUE)[number];

function evaluate(entry: Entry, snapshot: AdvisorSnapshot) {
  return entry.rule.evaluate(contextOf(requestFor(entry.rule.manifest, snapshot)));
}

function rule(ruleId: string): Entry {
  const entry = R_RULES.find((item) => item.ruleId === ruleId);
  if (entry === undefined) throw new Error(`no ${ruleId}`);
  return entry;
}

/** The drift snapshot with one `plan_projection` sub-block removed. */
async function driftWithout(field: string): Promise<AdvisorSnapshot> {
  const snapshot = await seedSnapshot('drift');
  const block = { ...(snapshot.plan_projection as Record<string, unknown>) };
  delete block[field];
  return { ...snapshot, plan_projection: block as AdvisorSnapshot['plan_projection'] };
}

describe('the WP 4.9 catalogue — R1 to R7', () => {
  it('every R rule produces at least one resolvable evidence ref on the seed', async () => {
    expect(R_RULES.map((entry) => entry.ruleId)).toEqual(['R1', 'R2', 'R3', 'R4', 'R6', 'R7']);
    const snapshots = await Promise.all(FIRING_CASES.map((name) => seedSnapshot(name)));

    for (const entry of R_RULES) {
      let fired = 0;
      for (const snapshot of snapshots) {
        for (const insight of evaluate(entry, snapshot).insights) {
          fired += 1;
          expect(insight.evidence.length, `${entry.ruleId} ${insight.key}`).toBeGreaterThan(0);
          for (const row of insight.evidence) {
            expect(row.source_ref, `${entry.ruleId} ${insight.key}`).not.toBeNull();
            const resolution = resolveSourceRef(snapshot, row.source_ref ?? '');
            expect(resolution.ok, `${entry.ruleId} ${String(row.source_ref)}`).toBe(true);
          }
        }
      }
      expect(fired, `${entry.ruleId} never fired on the seed`).toBeGreaterThan(0);
    }
  });

  it('every R rule returns zero insights when its inputs are absent', async () => {
    // 1. Nothing at all: no planning block of any kind.
    for (const entry of R_RULES) {
      const output = entry.rule.evaluate({
        snapshot: EMPTY_SNAPSHOT,
        today: TODAY,
        period: '2026-09',
        baseCurrency: USD,
      });
      expect(output.insights, entry.ruleId).toEqual([]);
      expect(output.warnings, entry.ruleId).toEqual([]);
    }

    // 2. The block present, and only this rule's own input removed. The harder
    //    half: a rule that fell back on a default when its sub-block was
    //    missing would pass (1) and fail here.
    const ownInput: readonly (readonly [string, string])[] = [
      ['R2', 'success_probability'],
      ['R3', 'rmd'],
      ['R4', 'social_security'],
      ['R7', 'guardrail'],
    ];
    for (const [ruleId, field] of ownInput) {
      const output = evaluate(rule(ruleId), await driftWithout(field));
      expect(output.insights, `${ruleId} without ${field}`).toEqual([]);
      expect(output.warnings, `${ruleId} without ${field}`).toEqual([]);
    }
    const tight = await seedSnapshot('tight');
    const noSavings = { ...(tight.plan_projection as Record<string, unknown>) };
    delete noSavings['savings_rate'];
    expect(
      evaluate(rule('R1'), {
        ...tight,
        plan_projection: noSavings as AdvisorSnapshot['plan_projection'],
      }).insights,
    ).toEqual([]);
    const drift = await seedSnapshot('drift');
    const { goals_list: _dropped, ...noGoals } = drift;
    expect(evaluate(rule('R6'), noGoals).insights).toEqual([]);
  });

  it('every R insight passes the WP 2.6 pipeline unchanged', async () => {
    const signal = new AbortController().signal;
    let accepted = 0;
    for (const name of FIRING_CASES) {
      const snapshot = await seedSnapshot(name);
      for (const entry of R_RULES) {
        const request = requestFor(entry.rule.manifest, snapshot);
        const body = await entry.advisor.run(request, signal);
        const outcome = validateResponse({
          request,
          manifest: entry.rule.manifest,
          limits: resolveLimits(entry.rule.manifest),
          body,
        });
        expect(outcome.ok, `${name}/${entry.ruleId}`).toBe(true);
        if (!outcome.ok) continue;
        expect(outcome.rejected, `${name}/${entry.ruleId}`).toEqual([]);
        for (const row of outcome.accepted) {
          expect(row.status).toBe('pending_review');
          expect(row.severityClamped, `${entry.ruleId} ${row.insight.key}`).toBe(false);
        }
        accepted += outcome.accepted.length;
      }
    }
    expect(accepted).toBeGreaterThanOrEqual(R_RULES.length);
  });

  it('every R rule reads only the scopes its manifest declares', async () => {
    for (const name of FIRING_CASES) {
      const full = await seedSnapshot(name);
      for (const entry of R_RULES) {
        const narrow = await seedSnapshot(
          name,
          entry.rule.manifest.requires_scopes as readonly AdvisorScope[],
        );
        expect(evaluate(entry, narrow), `${name}/${entry.ruleId}`).toEqual(evaluate(entry, full));
      }
    }
  });

  it('every R insight carries 07 §7.2’s disclaimer, verbatim', async () => {
    expect(ADVISORY_DISCLAIMER.length).toBeLessThanOrEqual(240);
    for (const name of FIRING_CASES) {
      const snapshot = await seedSnapshot(name);
      for (const entry of R_RULES) {
        for (const insight of evaluate(entry, snapshot).insights) {
          expect(insight.caveats, `${entry.ruleId} ${insight.key}`).toContain(ADVISORY_DISCLAIMER);
        }
      }
    }
  });

  it('R2 and R7 are the urgent ones, and nothing else in the wave claims the ceiling', async () => {
    expect([...WP_4_9_URGENT_RULE_IDS]).toEqual(['R2', 'R7']);
    const urgent = R_RULES.filter(
      (entry) => entry.rule.manifest.capabilities.max_severity === 'urgent',
    ).map((entry) => entry.ruleId);
    expect(urgent.sort()).toEqual(['R2', 'R7']);

    const drift = await seedSnapshot('drift');
    for (const ruleId of WP_4_9_URGENT_RULE_IDS) {
      const produced = evaluate(rule(ruleId), drift).insights;
      expect(produced.length, ruleId).toBeGreaterThan(0);
      for (const insight of produced) expect(insight.severity, ruleId).toBe('urgent');
    }

    // R7 below its band is the prosperity case — good news — and says so at
    // `info`, not at the P0 07 gives the rule.
    const below = await seedSnapshot('drift');
    const rails = below.plan_projection?.guardrail;
    expect(rails).toBeDefined();
    const lowered = {
      ...below,
      plan_projection: {
        ...(below.plan_projection as NonNullable<AdvisorSnapshot['plan_projection']>),
        guardrail: { ...(rails as object), withdrawal_rate: '0.03', position: 'below' as const },
      },
    } as AdvisorSnapshot;
    const quiet = evaluate(rule('R7'), lowered).insights;
    expect(quiet.map((insight) => insight.severity)).toEqual(['info']);
  });

  it('R2 refuses a deterministic run and a stale one', async () => {
    const drift = await seedSnapshot('drift');
    const block = drift.plan_projection as NonNullable<AdvisorSnapshot['plan_projection']>;
    expect(evaluate(rule('R2'), drift).insights.length).toBe(1);
    for (const variant of [
      { method: 'deterministic' as const, paths: 1, success_probability: '0' },
      { stale: true },
    ]) {
      const snapshot = { ...drift, plan_projection: { ...block, ...variant } } as AdvisorSnapshot;
      expect(evaluate(rule('R2'), snapshot).insights, JSON.stringify(variant)).toEqual([]);
    }
  });

  it('R1 is silent when the plan’s contributions were derived, however the rates compare', async () => {
    const tight = await seedSnapshot('tight');
    const block = tight.plan_projection as NonNullable<AdvisorSnapshot['plan_projection']>;
    const derived = {
      ...tight,
      plan_projection: {
        ...block,
        savings_rate: { plan: '0.15', observed: '0.085', plan_source: 'derived' as const },
      },
    } as AdvisorSnapshot;
    // The same two rates that fire R1 when stated. Derived means the plan *is*
    // the observation, so any gap is rounding between two views of one number.
    expect(evaluate(rule('R1'), tight).insights.length).toBe(1);
    expect(evaluate(rule('R1'), derived).insights).toEqual([]);
  });

  it('every rule in the WP 4.9 brief is implemented or has a stated reason, and R5 is a gap', () => {
    const implemented = new Set(BUILTIN_CATALOGUE.map((entry) => entry.ruleId));
    const gaps = new Map(CATALOGUE_GAPS.map((gap) => [gap.ruleId, gap]));
    for (const ruleId of WP_4_9_SCOPE) {
      const inCatalogue = implemented.has(ruleId);
      const gap = gaps.get(ruleId);
      expect(inCatalogue || gap !== undefined, `${ruleId} is in neither list`).toBe(true);
      expect(inCatalogue && gap !== undefined, `${ruleId} is in both lists`).toBe(false);
    }
    expect(WP_4_9_SCOPE.filter((ruleId) => !implemented.has(ruleId))).toEqual(['R5']);

    // R5 names the fields it would need — never an effort — and cites the
    // decision that leaves it unbuilt.
    const r5 = gaps.get('R5');
    expect(r5?.reason).toMatch(/year-to-date/u);
    expect(r5?.reason).toMatch(/true/u);
    expect(r5?.reason).toMatch(/§6 Q4/u);

    // And the Phase 3 gaps §6 Q4 also decides stay gaps: no plan terms were
    // entered, so none of them was written over a default either.
    expect(WP_3_10_SCOPE.filter((ruleId) => !implemented.has(ruleId))).toEqual([
      'I7',
      'I8',
      'I9',
      'I10',
      'X4',
    ]);
  });

  it('R6 withholds an impact over the ceiling rather than clamping it', async () => {
    const drift = await seedSnapshot('drift');
    const goals = drift.goals_list?.goals ?? [];
    const first = goals[0];
    expect(first?.pace?.status).toBe('off_track');
    if (first === undefined || first.pace === undefined) return;
    // $50,000 a month needed, nothing planned: $600,000 a year, six times the
    // ceiling. A data bug of exactly the kind 07 §3.2's ceiling is for.
    const poisoned = {
      ...drift,
      goals_list: {
        goals: [
          {
            ...first,
            pace: {
              ...first.pace,
              required_monthly: { minor: '5000000', currency: USD },
              planned_monthly: { minor: '0', currency: USD },
            },
          },
        ],
      },
    } as AdvisorSnapshot;
    const output = evaluate(rule('R6'), poisoned);
    expect(output.insights.length).toBe(1);
    const insight = output.insights[0];
    expect(insight?.impact.annualized).toBeNull();
    expect(insight?.impact.derivation_id).toBeNull();
    // Withheld: the real figure goes to the operator's channel, a caveat says
    // so in words, and the ceiling itself is never printed as if it were the
    // figure (WP 2.7's ruling in `support.ts`' `clampImpact`).
    expect(output.warnings.join(' ')).toContain('60000000.00 minor units');
    expect(insight?.caveats.join(' ')).toContain('withheld');
    const ceiling = IMPACT_CEILING_MAJOR.toLocaleString('en-US');
    expect(insight?.summary_md).not.toContain(ceiling);
  });
});
