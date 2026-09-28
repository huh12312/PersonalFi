// SPDX-License-Identifier: MIT
/**
 * 07 §8.5's release gate item — *"MC golden-value tests drift > 0.5pp"* —
 * wired as a CI assertion (dispatch §3 WP 4.14):
 * `packages/contexts/planning/test/engine/golden-drift.test.ts →
 * 'a golden Monte Carlo value drifting more than 0.5 percentage points
 * fails'`.
 *
 * ## Why this file lives at `test/golden-drift.test.ts`, not
 * `test/engine/golden-drift.test.ts`
 *
 * Same reason as `test/reference.test.ts` (see that file's header for the
 * full argument): the `planning` vitest project's `include` is
 * `src/**\/*.test.ts` and `test/*.test.ts` (`vitest.config.ts`), a single
 * `*`, not `**`, so a spec under `test/engine/` is collected but one under
 * a hypothetical `test/engine/golden-drift.test.ts` would collide with
 * nothing — the actual hazard is the dispatch's literal path implies a
 * *new* subdirectory nesting depth (`test/reference/reference.test.ts`) that
 * `vitest list --project planning` empirically does not collect; this file
 * stays at the `test/` root where `reference.test.ts` already had to move.
 *
 * ## What this is, and what it is not
 *
 * This is drift of the *server* engine's own Monte Carlo success probability
 * against a **committed baseline**, run to run, across code changes — a
 * regression control, not a correctness control. Correctness against an
 * independent source is `test/reference.test.ts`'s job (deterministic
 * projection vs. a spreadsheet model); this file never checks a plan's
 * probability against anything outside the engine itself, only against its
 * own past output.
 *
 * It is also a **different control** from WP 4.11's
 * `test/fixtures/golden-vector.json` (the client projection worker vs. the
 * server engine, over the *same* seed — a parity control across two
 * implementations) — the two are not merged here. This file's "golden"
 * values are one engine's own history; WP 4.11's are two engines' agreement
 * at one instant.
 *
 * One golden row per `EngineKind` (07 §8.4's "both engines" instruction):
 * `'lognormal'` (parametric, needs no series) and `'bootstrap'` against the
 * synthetic series (`test/engine/fixtures/synthetic-series.ts` — never the
 * fetched Shiller cache, so a fresh clone and CI reproduce it exactly, WP
 * 4.5's and WP 4.13's own precedent for the same reason). Both rows share
 * one plan and one seed so the two numbers stay a legible pair rather than
 * two unrelated magic numbers.
 *
 * The golden percentage for each row was read from this exact
 * plan/seed/engine/path combination on 2026-09-28 (`b78c76d`'s tree plus
 * this WP's changes), by running this file once against a placeholder golden
 * constant, reading the `PROBE … current …` line vitest prints to stderr for
 * each engine, and pasting each printed `current` value back in as the
 * committed `goldenPct` — the same "confirm before asserting" discipline
 * `test/reference.test.ts`'s control test documents for its own sabotage. A
 * future *intentional* engine change (a corrected formula, a re-derived
 * assumption default) moves these two numbers in the same commit as the
 * change, with a note on why — 07 §7.3's "why did it say $720" standard,
 * applied to the engine's own regression baseline rather than a user's
 * saved plan.
 */
import { describe, expect, it } from 'vitest';
import { DateOnly } from '@core/kernel';
import { applyOverrides, diffOverrides, loadAssumptions } from '../src/assumptions.ts';
import type { ProjectionPlan } from '../src/engine/boundary.ts';
import type { EngineKind } from '../src/engine/montecarlo.ts';
import { BASE, usd } from './engine/support.ts';
import { syntheticSeries } from './engine/fixtures/synthetic-series.ts';
import { successCountFor } from './reference/invariants.ts';

const assumptions = loadAssumptions();
const series = syntheticSeries();

/**
 * A balanced saver whose success probability sits away from both 0% and
 * 100% under both engines (checked empirically when the golden values below
 * were recorded) — a plan pinned at either rail cannot show a drift in the
 * direction that rail forbids, which would make half of "drift > 0.5pp"
 * untestable by construction.
 */
const PLAN: ProjectionPlan = {
  ...BASE,
  buckets: [
    { bucket: 'TAX_DEFERRED', startingBalance: usd('250000'), annualContribution: usd('12000') },
  ],
  contributionGrowth: 'wage',
  glidepath: { kind: 'static', equityShare: '0.6' },
  annualSpending: usd('68000'),
  socialSecurity: {
    kind: 'statement',
    monthlyPia: usd('2500'),
    claimAge: { years: 67, months: 0 },
    stressAfter2034: false,
  },
};

const PATHS = 3_000;
const SEED = 20_260_928n;

interface GoldenRow {
  readonly engine: EngineKind;
  /** Success probability in percentage points, this exact plan/seed/paths, recorded 2026-09-28. */
  readonly goldenPct: number;
}

const GOLDEN: readonly GoldenRow[] = [
  { engine: 'lognormal', goldenPct: 56.433_333_333_333_34 },
  { engine: 'bootstrap', goldenPct: 57.433_333_333_333_34 },
];

function successPct(engine: EngineKind, currentAssumptions = assumptions): number {
  const count = successCountFor(
    PLAN,
    currentAssumptions,
    SEED,
    engine,
    PATHS,
    engine === 'bootstrap' ? series : null,
  );
  return (count / PATHS) * 100;
}

describe('07 §8.5 release gate: MC golden-value drift', () => {
  it.each(GOLDEN)(
    '$engine: the success probability has not drifted more than 0.5 percentage points from the committed golden value',
    ({ engine, goldenPct }) => {
      const current = successPct(engine);
      const drift = Math.abs(current - goldenPct);
      console.error('PROBE', engine, 'current', current, 'golden', goldenPct, 'drift', drift);
      expect(
        drift,
        `current ${String(current)}% vs golden ${String(goldenPct)}%`,
      ).toBeLessThanOrEqual(0.5);
    },
  );

  it('a golden Monte Carlo value drifting more than 0.5 percentage points fails — the control', () => {
    // Sabotage through the same override path a real assumptions change
    // would use, never by editing engine source: the US equity expected
    // return, the same single most-leveraged constant
    // `test/reference.test.ts`'s control sabotages, reused here because a
    // 0.065 -> 0.30 return shift moves a Monte Carlo success rate by tens of
    // points on this plan, not fractions of one — the control's baseline
    // (the clean run against the golden value) is itself green first.
    const golden = GOLDEN.find((row) => row.engine === 'lognormal');
    if (golden === undefined) throw new Error('no lognormal golden row');

    const cleanDrift = Math.abs(successPct('lognormal') - golden.goldenPct);
    expect(cleanDrift).toBeLessThanOrEqual(0.5); // the control's baseline is itself green.

    const deltas = diffOverrides(assumptions, { 'capitalMarket.usEquity.expectedReturn': '0.30' });
    const sabotaged = applyOverrides(assumptions, deltas, DateOnly.parse('2026-01-01'));
    const dirty = successPct('lognormal', sabotaged);
    const dirtyDrift = Math.abs(dirty - golden.goldenPct);
    console.error('PROBE sabotage dirty', dirty, 'drift', dirtyDrift);
    expect(
      dirtyDrift,
      'a 0.065 -> 0.30 equity-return sabotage produced no measurable drift from the golden value — the 0.5pp gate is not doing anything',
    ).toBeGreaterThan(0.5);
  });
});
