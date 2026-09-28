// SPDX-License-Identifier: MIT
/**
 * The client projection Web Worker — `docs/plan/04-phase-4-dispatch.md` §3
 * "WP 4.11", `docs/research/05-frontend-architecture.md` §5.7. Exposed over
 * **Comlink**, spun up on route entry (not on first drag) by
 * `./projection-client.ts`, which also owns the `requestIdleCallback`
 * warm-up.
 *
 * Runs `./kernel/montecarlo.ts` — the scoped, byte-for-byte port of the
 * server's Monte Carlo kernel (see that directory's `prng.ts`/
 * `deterministic.ts` headers for the port-not-import decision and its scope
 * cuts: lognormal engine only, no crypto, `constant_real` policy only, no
 * Social Security/pension/other income). **The output crossing this worker's
 * boundary is percentile bands only, as a transferable `Float32Array` — never
 * the underlying paths** (dispatch §3: "never paths across the boundary").
 * `runMonteCarlo`'s `Float64Array` bands are narrowed to `Float32Array` here,
 * at the boundary, for exactly that reason: a caller holding this worker's
 * reply cannot reconstruct a single simulated path from it, only the summary
 * bands the fan-chart-style preview needs.
 *
 * `warmUp()` is the `requestIdleCallback` target: a throwaway 8-path, 2-year
 * run that primes the JIT before the first real drag needs it (05 §5.7).
 */
import * as Comlink from 'comlink';

import type { EnginePlan, ExtraContribution } from './kernel/deterministic.ts';
import { runMonteCarlo, type EngineCorrelation } from './kernel/montecarlo.ts';

/** What the worker receives — structured-cloneable, the seed included (dispatch §3). */
export interface ProjectionWorkerJob {
  readonly plan: EnginePlan;
  readonly volatility: {
    readonly equity: number;
    readonly bond: number;
    readonly inflation: number;
  };
  readonly correlation: EngineCorrelation;
  readonly seed: bigint;
  readonly paths: number;
  readonly extra: ExtraContribution;
}

/** What the worker replies — bands only, never paths. */
export interface ProjectionBands {
  readonly levels: readonly number[];
  readonly years: number;
  readonly startAge: number;
  readonly retireAge: number;
  readonly startYear: number;
  readonly paths: number;
  readonly successCount: number;
  /** `[level * years + year]`, `Float32Array`, transferred (not copied) by `run`. */
  readonly bands: Float32Array;
}

// A separate, explicitly-typed const: an object literal passed straight into a generic call
// (`Object.freeze` below) does not always get full contextual typing on nested fields, and
// `glidepaths`' `kind: 'static'` would otherwise widen to `string` and fail `EngineGlidepath`.
const WARM_UP_PLAN: EnginePlan = {
  startAge: 40,
  retireAge: 41,
  endAge: 42,
  startYear: 2026,
  wealth0: [10_000, 0, 0, 0],
  contribution0: [1_000, 0, 0, 0],
  glidepaths: [
    { kind: 'static', equityShare: 0.6 },
    { kind: 'static', equityShare: 0.6 },
    { kind: 'static', equityShare: 0.6 },
    { kind: 'static', equityShare: 0.6 },
  ],
  contributionGrowth: 0,
  spending: 5_000,
  inflation: 0.025,
  equityNominal: 0.065,
  bondNominal: 0.045,
  taxDeferredRate: 0.15,
  withdrawalOrder: [0, 1, 2, 3],
  policy: { kind: 'constant_real' },
  extraBucket: 0,
};

const WARM_UP_JOB: ProjectionWorkerJob = Object.freeze({
  plan: WARM_UP_PLAN,
  volatility: { equity: 0.17, bond: 0.06, inflation: 0.015 },
  // The default correlation block, `packages/contexts/planning/data/assumptions.ts`'s own row
  // order (`reorderCorrelation` looks each asset up by name, so this can be any order) — copied
  // verbatim rather than hand-reordered, since this warm-up run's only job is to prime the JIT
  // with a *valid* (positive-definite) job, never to be read for its numbers.
  correlation: {
    assets: ['USEQ', 'INTL', 'EM', 'BOND', 'TIPS', 'REIT', 'CASH', 'CRYPTO'],
    matrix: [
      [1, 0.85, 0.75, 0.1, 0, 0.7, -0.05, 0.4],
      [0.85, 1, 0.85, 0.1, 0.05, 0.65, -0.05, 0.35],
      [0.75, 0.85, 1, 0.05, 0.05, 0.6, -0.05, 0.4],
      [0.1, 0.1, 0.05, 1, 0.7, 0.25, 0.2, 0.05],
      [0, 0.05, 0.05, 0.7, 1, 0.25, 0.25, 0.05],
      [0.7, 0.65, 0.6, 0.25, 0.25, 1, 0, 0.3],
      [-0.05, -0.05, -0.05, 0.2, 0.25, 0, 1, 0],
      [0.4, 0.35, 0.4, 0.05, 0.05, 0.3, 0, 1],
    ],
  },
  seed: 1n,
  paths: 8,
  extra: { annual: 0, untilAge: 0 },
});

/**
 * Exported for `./projection.worker.test.ts`'s
 * `'the worker's own reply carries bands sized levels × years, never a
 * per-path array'` — the direct, sabotage-testable form of dispatch §3's
 * "never paths across the boundary": this is the exact function `run`/
 * `warmUp` call, so a change that made it leak per-path data would be
 * caught here without needing a real `Worker`/Comlink round trip.
 */
export function toBands(job: ProjectionWorkerJob): ProjectionBands {
  const result = runMonteCarlo(job);
  return {
    levels: result.levels,
    years: result.years,
    startAge: result.startAge,
    retireAge: result.retireAge,
    startYear: result.startYear,
    paths: result.paths,
    successCount: result.successCount,
    bands: Float32Array.from(result.bands),
  };
}

const api = {
  /** The `requestIdleCallback` warm-up target — throwaway, its result is discarded. */
  warmUp(): void {
    toBands(WARM_UP_JOB);
  },
  /** One preview run: `paths` is 250 while dragging, 5,000 on pointer-up (dispatch §3). */
  run(job: ProjectionWorkerJob): ProjectionBands {
    const bands = toBands(job);
    return Comlink.transfer(bands, [bands.bands.buffer]);
  },
};

export type ProjectionWorkerApi = typeof api;

Comlink.expose(api);
