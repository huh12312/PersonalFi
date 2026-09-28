// SPDX-License-Identifier: MIT
/**
 * The Monte Carlo kernel — a **scoped port** of
 * `packages/contexts/planning/src/engine/montecarlo.ts` (WP 4.5). See
 * `prng.ts`'s header for why this is a port rather than an import, and
 * `deterministic.ts`'s header for what this worker does and does not model.
 *
 * Scope, on top of `deterministic.ts`'s cuts: **lognormal engine only** (no
 * block bootstrap — `lognormal.ts`'s header), **no crypto sleeve** (the
 * `MonteCarloJob` below has no crypto field at all — there is nothing to
 * couple or draw). Everything else — the shock draw, `stepYear` per path and
 * year, the checkpoint retention, the type-7 partial-sort quantiles, the
 * failure and sequence summaries, and `serialiseResult`'s exact byte format —
 * is transcribed from the server file so the two are provably byte-identical
 * for the fixture `../projection.worker.test.ts` and
 * `packages/contexts/planning/test/golden-vector.test.ts` both assert
 * against (`packages/contexts/planning/test/fixtures/golden-vector.json`).
 */
import {
  newXoshiro,
  nextDouble,
  canonicalSeed,
  seedHalves,
  seedStream,
  MARKET_STREAM,
  type Xoshiro,
} from './prng.ts';
import { cholesky, drawLognormalYear, reorderCorrelation, type YearShock } from './lognormal.ts';
import {
  ENGINE_VERSION,
  preparePlan,
  stepYear,
  newPathState,
  realRate,
  type EnginePlan,
  type ExtraContribution,
  type MarketYear,
  type PathState,
  type PreparedPlan,
} from './deterministic.ts';

void nextDouble; // re-exported indirectly through drawLognormalYear/prng — kept imported for clarity of the dependency

export const MONTE_CARLO_VERSION = 'personalfi.montecarlo/1';

export const PERCENTILE_LEVELS: readonly number[] = Object.freeze([
  0.05, 0.1, 0.25, 0.5, 0.75, 0.9, 0.95,
]);

export const SEQUENCE_WINDOW_YEARS = 5;
export const SEQUENCE_DECILES = 10;
export const SEQUENCE_COLUMNS = 4;

export interface EngineCorrelation {
  readonly assets: readonly string[];
  readonly matrix: readonly (readonly number[])[];
}

/** Everything the worker's kernel needs. No `series` (no bootstrap), no `crypto` (no sleeve). */
export interface MonteCarloJob {
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

export interface ShockMatrix {
  readonly paths: number;
  readonly years: number;
  readonly equity: Float64Array;
  readonly bond: Float64Array;
  readonly inflation: Float64Array;
}

export function yearsOf(plan: EnginePlan): number {
  return plan.endAge - plan.startAge;
}

export function drawShocks(job: MonteCarloJob): ShockMatrix {
  const years = yearsOf(job.plan);
  const paths = job.paths;
  const cells = paths * years;
  const equity = new Float64Array(cells);
  const bond = new Float64Array(cells);
  const inflation = new Float64Array(cells);

  const ordered = reorderCorrelation(job.correlation.assets, job.correlation.matrix);
  const factor = cholesky(ordered);

  const market: Xoshiro = newXoshiro();
  const [seedHi, seedLo] = seedHalves(job.seed);
  const shock: YearShock = { equity: 0, bond: 0, inflation: 0 };

  for (let i = 0; i < paths; i += 1) {
    seedStream(market, seedHi, seedLo, i, MARKET_STREAM);
    const base = i * years;
    for (let t = 0; t < years; t += 1) {
      drawLognormalYear(market, factor, shock);
      equity[base + t] = shock.equity;
      bond[base + t] = shock.bond;
      inflation[base + t] = shock.inflation;
    }
  }
  return { paths, years, equity, bond, inflation };
}

interface ShockTransform {
  readonly equityMean: number;
  readonly bondMean: number;
  readonly inflationMean: number;
  readonly equityShift: number;
  readonly bondShift: number;
  readonly equityLogSigma: number;
  readonly bondLogSigma: number;
  readonly inflationSigma: number;
}

function logSigma(sigma: number, mean: number): number {
  return Math.sqrt(Math.log1p((sigma * sigma) / ((1 + mean) * (1 + mean))));
}

function transformFor(job: MonteCarloJob): ShockTransform {
  const plan = job.plan;
  const equityMean = realRate(plan.equityNominal, plan.inflation);
  const bondMean = realRate(plan.bondNominal, plan.inflation);
  const inflationMean = plan.inflation;
  const equityLogSigma = logSigma(job.volatility.equity, equityMean);
  const bondLogSigma = logSigma(job.volatility.bond, bondMean);
  return {
    equityMean,
    bondMean,
    inflationMean,
    equityShift: -0.5 * equityLogSigma * equityLogSigma,
    bondShift: -0.5 * bondLogSigma * bondLogSigma,
    equityLogSigma,
    bondLogSigma,
    inflationSigma: job.volatility.inflation,
  };
}

interface MutableMarket {
  equityReal: number;
  bondReal: number;
  inflation: number;
}

function fillMarket(
  into: MutableMarket,
  shocks: ShockMatrix,
  cell: number,
  f: ShockTransform,
): void {
  const e = shocks.equity[cell] ?? 0;
  const b = shocks.bond[cell] ?? 0;
  const i = shocks.inflation[cell] ?? 0;
  into.equityReal =
    f.equityMean + (1 + f.equityMean) * Math.expm1(f.equityLogSigma * e + f.equityShift);
  into.bondReal = f.bondMean + (1 + f.bondMean) * Math.expm1(f.bondLogSigma * b + f.bondShift);
  into.inflation = f.inflationMean + f.inflationSigma * i;
}

export function resetPathState(state: PathState, plan: EnginePlan): void {
  for (let b = 0; b < state.wealth.length; b += 1) state.wealth[b] = plan.wealth0[b] ?? 0;
  state.lastNominalReturn = 0;
  state.lastInflation = plan.inflation;
  state.inflationIndex = 1;
  state.depletedAtAge = -1;
  state.shortfallTotal = 0;
  state.scratchReturn.fill(0);
  state.scratchWithdrawal.fill(0);
}

export interface SimulationBuffers {
  readonly checkpoints: Float64Array;
  readonly depletedAtAge: Float64Array;
  readonly shortfallTotal: Float64Array;
  readonly sequenceReturn: Float64Array;
}

export function newSimulationBuffers(paths: number, years: number): SimulationBuffers {
  return {
    checkpoints: new Float64Array(paths * years),
    depletedAtAge: new Float64Array(paths),
    shortfallTotal: new Float64Array(paths),
    sequenceReturn: new Float64Array(paths),
  };
}

export function sequenceWindow(plan: EnginePlan): {
  readonly start: number;
  readonly length: number;
} {
  const years = yearsOf(plan);
  const start = Math.max(0, plan.retireAge - plan.startAge);
  return { start, length: Math.max(0, Math.min(SEQUENCE_WINDOW_YEARS, years - start)) };
}

export function simulate(
  prepared: PreparedPlan,
  job: MonteCarloJob,
  shocks: ShockMatrix,
  extra: ExtraContribution,
  out: SimulationBuffers,
): number {
  const plan = prepared.plan;
  const years = shocks.years;
  const paths = shocks.paths;
  const f = transformFor(job);
  const state = newPathState(plan);
  const market: MutableMarket = { equityReal: 0, bondReal: 0, inflation: 0 };
  const view: MarketYear = market;
  const window = sequenceWindow(plan);
  const windowEnd = window.start + window.length;
  let successes = 0;

  for (let i = 0; i < paths; i += 1) {
    resetPathState(state, plan);
    let windowGross = 1;
    const base = i * years;
    for (let t = 0; t < years; t += 1) {
      const cell = base + t;
      fillMarket(market, shocks, cell, f);
      stepYear(prepared, state, t, view, extra);
      const w = state.wealth;
      const buckets = (w[0] ?? 0) + (w[1] ?? 0) + (w[2] ?? 0) + (w[3] ?? 0);
      out.checkpoints[t * paths + i] = buckets;
      if (t >= window.start && t < windowEnd) {
        windowGross *= (1 + state.lastNominalReturn) / (1 + market.inflation);
      }
    }
    out.depletedAtAge[i] = state.depletedAtAge;
    out.shortfallTotal[i] = state.shortfallTotal;
    out.sequenceReturn[i] = window.length > 0 ? windowGross ** (1 / window.length) - 1 : Number.NaN;
    if (state.depletedAtAge < 0) successes += 1;
  }
  return successes;
}

export function selectInPlace(a: Float64Array, lo: number, hi: number, k: number): void {
  let left = lo;
  let right = hi;
  while (right > left) {
    const mid = (left + right) >>> 1;
    const pivot = median3(a[left] ?? 0, a[mid] ?? 0, a[right] ?? 0);
    let i = left;
    let j = right;
    while (i <= j) {
      while ((a[i] ?? 0) < pivot) i += 1;
      while ((a[j] ?? 0) > pivot) j -= 1;
      if (i <= j) {
        const swap = a[i] ?? 0;
        a[i] = a[j] ?? 0;
        a[j] = swap;
        i += 1;
        j -= 1;
      }
    }
    if (k <= j) right = j;
    else if (k >= i) left = i;
    else return;
  }
}

function median3(x: number, y: number, z: number): number {
  if (x < y) {
    if (y < z) return y;
    return x < z ? z : x;
  }
  if (x < z) return x;
  return y < z ? z : y;
}

export function quantilesInPlace(
  a: Float64Array,
  n: number,
  levels: readonly number[],
  out: Float64Array,
  offset: number,
  stride: number,
): void {
  let lo = 0;
  for (let l = 0; l < levels.length; l += 1) {
    const h = (n - 1) * (levels[l] ?? 0);
    const k = Math.floor(h);
    selectInPlace(a, lo, n - 1, k);
    const below = a[k] ?? 0;
    let above = below;
    if (k + 1 < n && h > k) {
      above = a[k + 1] ?? 0;
      for (let m = k + 2; m < n; m += 1) {
        const v = a[m] ?? 0;
        if (v < above) above = v;
      }
    }
    out[offset + stride * l] = below + (h - k) * (above - below);
    lo = k;
  }
}

export interface FailureSummary {
  readonly count: number;
  readonly medianDepletionAge: number;
  readonly medianShortfallYears: number;
  readonly medianShortfallTotal: number;
}

export interface SequenceTable {
  readonly startAge: number;
  readonly years: number;
  readonly deciles: Float64Array;
}

export interface MonteCarloResult {
  readonly monteCarloVersion: string;
  readonly engineVersion: string;
  readonly engine: 'lognormal';
  readonly seriesId: null;
  readonly seriesSha256: null;
  readonly seed: bigint;
  readonly paths: number;
  readonly years: number;
  readonly startAge: number;
  readonly retireAge: number;
  readonly startYear: number;
  readonly levels: readonly number[];
  readonly bands: Float64Array;
  readonly successCount: number;
  readonly failure: FailureSummary;
  readonly worstCutP95: number;
  readonly sequence: SequenceTable | null;
  readonly withoutCrypto: null;
}

function bandsOf(
  checkpoints: Float64Array,
  paths: number,
  years: number,
  scratch: Float64Array,
): Float64Array {
  const bands = new Float64Array(PERCENTILE_LEVELS.length * years);
  for (let t = 0; t < years; t += 1) {
    scratch.set(checkpoints.subarray(t * paths, (t + 1) * paths));
    quantilesInPlace(scratch, paths, PERCENTILE_LEVELS, bands, t, years);
  }
  return bands;
}

function medianOf(scratch: Float64Array, n: number): number {
  if (n === 0) return Number.NaN;
  const out = new Float64Array(1);
  quantilesInPlace(scratch, n, [0.5], out, 0, 1);
  return out[0] ?? Number.NaN;
}

function failureOf(
  buffers: SimulationBuffers,
  plan: EnginePlan,
  paths: number,
  scratch: Float64Array,
): FailureSummary {
  let n = 0;
  for (let i = 0; i < paths; i += 1) {
    const age = buffers.depletedAtAge[i] ?? -1;
    if (age >= 0) scratch[n++] = age;
  }
  const count = n;
  const medianDepletionAge = medianOf(scratch, count);
  n = 0;
  for (let i = 0; i < paths; i += 1) {
    const age = buffers.depletedAtAge[i] ?? -1;
    if (age >= 0) scratch[n++] = plan.endAge - age;
  }
  const medianShortfallYears = medianOf(scratch, count);
  n = 0;
  for (let i = 0; i < paths; i += 1) {
    if ((buffers.depletedAtAge[i] ?? -1) >= 0) scratch[n++] = buffers.shortfallTotal[i] ?? 0;
  }
  return {
    count,
    medianDepletionAge,
    medianShortfallYears,
    medianShortfallTotal: medianOf(scratch, count),
  };
}

function sequenceOf(
  buffers: SimulationBuffers,
  plan: EnginePlan,
  paths: number,
): SequenceTable | null {
  const window = sequenceWindow(plan);
  if (window.length === 0 || paths < SEQUENCE_DECILES) return null;
  const r = buffers.sequenceReturn;
  const order = new Uint32Array(paths);
  for (let i = 0; i < paths; i += 1) order[i] = i;
  order.sort((a, b) => (r[a] ?? 0) - (r[b] ?? 0) || a - b);
  const deciles = new Float64Array(SEQUENCE_DECILES * SEQUENCE_COLUMNS);
  for (let d = 0; d < SEQUENCE_DECILES; d += 1) {
    const from = Math.floor((d * paths) / SEQUENCE_DECILES);
    const to = Math.floor(((d + 1) * paths) / SEQUENCE_DECILES);
    let successes = 0;
    for (let rank = from; rank < to; rank += 1) {
      if ((buffers.depletedAtAge[order[rank] ?? 0] ?? -1) < 0) successes += 1;
    }
    deciles[d * SEQUENCE_COLUMNS] = r[order[from] ?? 0] ?? Number.NaN;
    deciles[d * SEQUENCE_COLUMNS + 1] = r[order[to - 1] ?? 0] ?? Number.NaN;
    deciles[d * SEQUENCE_COLUMNS + 2] = to - from;
    deciles[d * SEQUENCE_COLUMNS + 3] = successes;
  }
  return { startAge: plan.startAge + window.start, years: window.length, deciles };
}

/** The whole job: shocks, one simulation pass, summary. Always the lognormal engine, never crypto. */
export function runMonteCarlo(job: MonteCarloJob): MonteCarloResult {
  const prepared = preparePlan(job.plan);
  const shocks = drawShocks(job);
  const { paths, years } = shocks;
  const buffers = newSimulationBuffers(paths, years);
  const scratch = new Float64Array(paths);

  const successCount = simulate(prepared, job, shocks, job.extra, buffers);
  const bands = bandsOf(buffers.checkpoints, paths, years, scratch);
  const failure = failureOf(buffers, job.plan, paths, scratch);
  scratch.fill(0);

  return {
    monteCarloVersion: MONTE_CARLO_VERSION,
    engineVersion: ENGINE_VERSION,
    engine: 'lognormal',
    seriesId: null,
    seriesSha256: null,
    seed: canonicalSeed(job.seed),
    paths,
    years,
    startAge: job.plan.startAge,
    retireAge: job.plan.retireAge,
    startYear: job.plan.startYear,
    levels: PERCENTILE_LEVELS,
    bands,
    successCount,
    failure,
    // The server's `worstCutP95` is the guardrail cut's p95 — always 0 with no guardrails
    // (`deterministic.ts`'s scope cut), which is also what the server reports for a
    // constant_real plan (`stepYear`'s `decisions`/`worstCut` never move off 0 in that branch).
    worstCutP95: 0,
    sequence: sequenceOf(buffers, job.plan, paths),
    withoutCrypto: null,
  };
}

// ---------------------------------------------------------------------------
// Canonical bytes — must match `serialiseMonteCarloResult`'s format exactly.
// ---------------------------------------------------------------------------

const MAGIC = 'PFMC1\n';

function exactText(x: number): string {
  return Number.isNaN(x) ? 'NaN' : String(x);
}

export function serialiseResult(result: MonteCarloResult): Uint8Array {
  const arrays: readonly (readonly [string, Float64Array])[] = [
    ['bands', result.bands],
    ['sequence', result.sequence?.deciles ?? new Float64Array(0)],
    ['withoutCryptoBands', new Float64Array(0)],
  ];
  const header = {
    arrays: arrays.map(([name, array]) => [name, array.length]),
    engine: result.engine,
    engineVersion: result.engineVersion,
    failure: [
      result.failure.count,
      result.failure.medianDepletionAge,
      result.failure.medianShortfallYears,
      result.failure.medianShortfallTotal,
    ].map(exactText),
    levels: result.levels.map(exactText),
    monteCarloVersion: result.monteCarloVersion,
    paths: result.paths,
    retireAge: result.retireAge,
    seed: result.seed.toString(),
    sequence: result.sequence === null ? null : [result.sequence.startAge, result.sequence.years],
    seriesId: result.seriesId,
    seriesSha256: result.seriesSha256,
    startAge: result.startAge,
    startYear: result.startYear,
    successCount: result.successCount,
    withoutCryptoSuccessCount: null,
    worstCutP95: exactText(result.worstCutP95),
    years: result.years,
  };
  const text = new TextEncoder().encode(`${MAGIC}${JSON.stringify(header)}\n`);
  let doubles = 0;
  for (const [, array] of arrays) doubles += array.length;
  const bytes = new Uint8Array(text.length + 8 * doubles);
  bytes.set(text, 0);
  const view = new DataView(bytes.buffer);
  let at = text.length;
  for (const [, array] of arrays) {
    for (let i = 0; i < array.length; i += 1) {
      view.setFloat64(at, array[i] ?? 0, true);
      at += 8;
    }
  }
  return bytes;
}
