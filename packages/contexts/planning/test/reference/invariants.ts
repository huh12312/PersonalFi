// SPDX-License-Identifier: MIT
/**
 * 07 §8.4's engine invariants, factored into reusable, exported checks — the
 * dispatch's "07 §8.4's invariants as a shared property-test module both
 * engines run" (§3 WP 4.14).
 *
 * ## Why this exists beside `src/engine/invariants.test.ts`
 *
 * WP 4.5's `src/engine/invariants.test.ts` already implements 07 §8.4's three
 * invariants **inline**, and it already landed before this WP started. It is
 * outside WP 4.14's ownership (`docs/plan/04-phase-4-dispatch.md` §3 lists
 * `packages/contexts/planning/test/reference/**`, not `src/engine/`), so it
 * is not edited here — doing so would be an out-of-ownership change to
 * already-committed code, and risks a collision with a concurrent agent.
 *
 * Instead, this module factors each invariant's *computation* out as a pure,
 * side-effect-free function — no `expect` inside — so a **second** consumer
 * can run the same check the production engines are held to without
 * re-deriving the math. `test/reference.test.ts` is that second consumer: it
 * runs invariant 1 (`zeroVolatilityGap`) against WP 4.14's own cases D and E,
 * which did not exist when WP 4.5's suite was written and so are not covered
 * by it, and invariant 2 (`monotoneLeverCheck`) against case D over **both**
 * `EngineKind`s. Invariant 1 itself is `'lognormal'`-only, by construction,
 * not by an omission here: `montecarlo.ts`'s bootstrap draw takes its shock
 * size from the return series' own variance
 * (`equityShockSd = sqrt(12 * series.equityVariance)`), never from
 * `capitalMarket.*.volatility`, so `withZeroVolatility` overrides an
 * assumption `'bootstrap'` does not read and the invariant cannot hold there
 * — confirmed empirically (a multi-hundred-thousand-dollar gap, `successMatches`
 * false) before `test/reference.test.ts` was written to only claim
 * `'lognormal'` for it, matching `src/engine/invariants.test.ts`'s own choice.
 * Invariant 2 has no such constraint, which is where "both engines run" is
 * actually exercised, against the synthetic series for `'bootstrap'` (never
 * the fetched Shiller cache — the same reasoning WP 4.5's own suite and WP
 * 4.13's perf seed use, so this reproduces on a fresh clone and in CI).
 * `test/golden-drift.test.ts` is a further consumer, reusing `successCountFor`
 * rather than re-deriving a success count from `runMonteCarlo`/
 * `toMonteCarloJob` by hand. Every function here calls the same production
 * entry points WP 4.5 built (`runMonteCarlo`, `projectDeterministic`,
 * `toMonteCarloJob`, `toMonteCarloSummary`) — nothing here reimplements
 * engine math, which is the "not duplicating" half of the dispatch's
 * instruction. `series` is threaded through as an optional parameter
 * (default `null`, `'lognormal'`-safe) precisely so a `'bootstrap'` caller
 * does not hit `montecarlo.ts`'s `'the bootstrap engine needs a return
 * series'` guard — the gap this module had when the killed session left it:
 * every function below accepted an `EngineKind` but had no way to satisfy
 * `'bootstrap'`'s one hard requirement.
 *
 * A future landing that refactors `src/engine/invariants.test.ts` to import
 * from here (rather than keep its own inline copies) is the natural next
 * step and is recorded as an open item in `wp4.14-quality.md`.
 */
import { DateOnly } from '@core/kernel';
import { applyOverrides, type Assumptions } from '../../src/assumptions.ts';
import type { AssumptionsLike, ProjectionPlan } from '../../src/engine/boundary.ts';
import type { ReturnSeries } from '../../src/engine/bootstrap.ts';
import { projectDeterministic } from '../../src/engine/project.ts';
import { runMonteCarlo, type EngineKind } from '../../src/engine/montecarlo.ts';
import { toMonteCarloJob, type MonteCarloRequest } from '../../src/engine/worker-host.ts';

/** 07 §8.4 invariant 1's setup: every capital-market volatility pinned to zero. */
export function withZeroVolatility(assumptions: Assumptions, asOf: DateOnly): AssumptionsLike {
  return applyOverrides(
    assumptions,
    {
      'capitalMarket.usEquity.volatility': '0',
      'capitalMarket.usAggregateBonds.volatility': '0',
      'capitalMarket.inflation.volatility': '0',
    },
    asOf,
  );
}

export interface ZeroVolatilityGap {
  /** The largest |MC median − deterministic| across every year, in minor units. 0 when they agree exactly. */
  readonly maxAbsMinorDifference: bigint;
  readonly years: number;
  /** Whether the MC success flag (every path succeeds or none do, since there is no spread) matches the deterministic path's. */
  readonly successMatches: boolean;
}

/**
 * 07 §8.4 invariant 1: **"zero volatility ⇒ Monte Carlo median == deterministic
 * path (to floating tolerance)."** Runs both engines under
 * `withZeroVolatility` and reports the largest disagreement rather than
 * asserting one, so the caller decides the tolerance.
 */
export function zeroVolatilityGap(
  plan: ProjectionPlan,
  assumptions: Assumptions,
  options: {
    readonly seed: bigint;
    readonly paths: number;
    readonly engine: EngineKind;
    /** Required when `engine` is `'bootstrap'` (`montecarlo.ts` throws on `null`); ignored by `'lognormal'`. */
    readonly series?: ReturnSeries | null;
  },
): ZeroVolatilityGap {
  const still = withZeroVolatility(assumptions, DateOnly.parse('2026-09-26'));
  const request: MonteCarloRequest = {
    plan,
    assumptions: still,
    seed: options.seed,
    engine: options.engine,
    paths: options.paths,
    series: options.series ?? null,
  };
  const result = runMonteCarlo(toMonteCarloJob(request));
  const deterministic = projectDeterministic(plan, still);

  let maxAbsMinorDifference = 0n;
  deterministic.years.forEach((year, t) => {
    // `result.bands` is laid out percentile-major (07 §5.4's five levels); the
    // median (level index 2 of `PERCENTILE_LEVELS`, '0.5') is the third band.
    const medianAtYear = result.bands[2 * result.years + t] ?? Number.NaN;
    const asMinor = Math.round(medianAtYear * 10 ** 2); // USD only in this module's callers.
    const difference =
      BigInt(asMinor) > year.endWealth.minor
        ? BigInt(asMinor) - year.endWealth.minor
        : year.endWealth.minor - BigInt(asMinor);
    if (difference > maxAbsMinorDifference) maxAbsMinorDifference = difference;
  });

  return {
    maxAbsMinorDifference,
    years: deterministic.years.length,
    successMatches: (result.successCount === result.paths) === deterministic.success,
  };
}

/** 07 §8.4 invariant 2's atom: the Monte Carlo success count for one plan over one seed's shocks. */
export function successCountFor(
  plan: ProjectionPlan,
  assumptions: AssumptionsLike,
  seed: bigint,
  engine: EngineKind,
  paths: number,
  series: ReturnSeries | null = null,
): number {
  return runMonteCarlo(toMonteCarloJob({ plan, assumptions, seed, engine, paths, series }))
    .successCount;
}

export interface MonotoneCheck {
  readonly base: number;
  readonly lever: number;
  /** True when the lever moved success the direction 07 §8.4 invariant 2 requires. */
  readonly holds: boolean;
}

/**
 * 07 §8.4 invariant 2's atom, one lever at a time: does moving `leverPlan`'s
 * outcome the stated `direction` from `basePlan`'s hold, over the *same*
 * seed's shocks (common random numbers, so the comparison is exact even at a
 * small path count)?
 */
export function monotoneLeverCheck(
  basePlan: ProjectionPlan,
  leverPlan: ProjectionPlan,
  assumptions: AssumptionsLike,
  seed: bigint,
  engine: EngineKind,
  paths: number,
  direction: 'not_less' | 'not_more',
  series: ReturnSeries | null = null,
): MonotoneCheck {
  const base = successCountFor(basePlan, assumptions, seed, engine, paths, series);
  const lever = successCountFor(leverPlan, assumptions, seed, engine, paths, series);
  return {
    base,
    lever,
    holds: direction === 'not_less' ? lever >= base : lever <= base,
  };
}

export interface P5Stability {
  readonly worstRelativeSd: number;
  readonly years: number;
}

/**
 * 07 §8.4 invariant 3: **"p5 estimate stable to within 1% across seeds at
 * n=10,000."** Read as the ten-seed estimator's relative standard error (WP
 * 4.5's own reading, `src/engine/invariants.test.ts`), over whatever `seeds`
 * and `paths` the caller supplies — a caller wanting the full statistical
 * claim passes ten seeds at 10,000 paths; a caller wanting a cheap smoke
 * check (this module's own `reference.test.ts` exercise) passes fewer.
 */
export function p5RelativeStandardError(
  plan: ProjectionPlan,
  assumptions: AssumptionsLike,
  engine: EngineKind,
  seeds: readonly bigint[],
  paths: number,
  series: ReturnSeries | null = null,
): P5Stability {
  const p5ByYear: number[][] = seeds.map((seed) => {
    const result = runMonteCarlo(
      toMonteCarloJob({ plan, assumptions, seed, engine, paths, series }),
    );
    return Array.from(result.bands.subarray(0, result.years));
  });
  const years = p5ByYear[0]?.length ?? 0;
  let worstRelativeSd = 0;
  for (let t = 0; t < years; t += 1) {
    const column = p5ByYear.map((row) => row[t] ?? Number.NaN);
    const mean = column.reduce((sum, x) => sum + x, 0) / column.length;
    const variance = column.reduce((sum, x) => sum + (x - mean) ** 2, 0) / (column.length - 1);
    const relativeSd = mean === 0 ? 0 : Math.sqrt(variance) / mean;
    if (relativeSd > worstRelativeSd) worstRelativeSd = relativeSd;
  }
  return { worstRelativeSd, years };
}
