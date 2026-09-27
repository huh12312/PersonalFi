// SPDX-License-Identifier: MIT
/**
 * The Monte Carlo kernel — 07 §5.3–5.4, 08 §7.2. Pure: no I/O, no clock, no
 * `Math.random()`. It runs **WP 4.4's `stepYear`**, the same per-year recursion
 * the deterministic engine runs, with a drawn `MarketYear` instead of the
 * expected one — so 07 §8.4 invariant 1 ("zero volatility ⇒ Monte Carlo median
 * == deterministic path") holds by construction, not by two implementations
 * agreeing.
 *
 * ## The pipeline, per job
 *
 * 1. `drawShocks` — for every (path, year) a market shock and, when the plan
 *    holds crypto, a crypto shock, into flat `Float64Array`s. Path *i*'s shocks
 *    depend only on (seed, i, year, engine, series/correlation): never on the
 *    plan's levers, the path count, or crypto's presence (`prng.ts`, streams).
 *    **This is the common-random-numbers matrix** (07 §5.4 detail 1).
 * 2. `simulate` — per path, `stepYear` for every year, the plan's expectations
 *    and the file's volatilities applied on top of the shocks. Wealth at every
 *    year-end is retained (the checkpoints); nothing monthly is kept.
 *    **Failure does not stop a path** (detail 2): `stepYear` keeps paying from
 *    Social Security and pensions and accumulates the unfunded spending.
 * 3. `summarise` — percentiles by partial sort over the retained checkpoints
 *    only (08 §7.2's ≤ 100 ms line), success, shortfall magnitude, the
 *    guardrail cut, and **success by first-five-retirement-year return decile**
 *    (detail 3).
 *
 * No step allocates inside the year loop: shocks, checkpoints and per-path
 * outcomes are preallocated per job; `stepYear` allocates nothing when not
 * recording; the path state is reset in place, not rebuilt.
 *
 * ## Crypto — its own class (07 §6.4), never folded into equity
 *
 * Crypto is a separate sleeve with its own draw from its own PRNG stream:
 * Student-t(ν) with the file's ν (3), mean and σ (6.5 % / 70 %), **not
 * lognormal**. Its normal numerator is coupled to the equity *shock* so that
 * corr(crypto, equity) is the matrix's 0.40 — the equity shock is read, never
 * written, so no crypto draw can move an equity draw and a 70 % σ never enters
 * the equity return (`crypto.test.ts`). A t-variate's correlation with a
 * normal is ρ·κ with κ = E[√(ν/W)] / √(ν/(ν−2)) (≈ 0.798 at ν = 3), so the
 * numerator uses ρ/κ to land on ρ.
 *
 * The sleeve takes no contributions and funds spending **last**, only when the
 * four tax buckets cannot: `stepYear` runs first and reports a shortfall, and
 * the sleeve is sold to cover it. That ordering makes 07 §6.4 treatment 2 —
 * "plan success with crypto at the modelled return, and with crypto valued at
 * $0" — a clean comparison over the same shocks: the difference is exactly
 * what crypto rescued. A year's nominal crypto return below −100 % is a total
 * loss of the sleeve, never a negative balance.
 *
 * Interior module: `number` only.
 */
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
import {
  cholesky,
  drawBootstrapYear,
  drawLognormalYear,
  prepareSeries,
  reorderCorrelation,
  type BootstrapCursor,
  type PreparedSeries,
  type ReturnSeries,
  type YearShock,
} from './bootstrap.ts';
import {
  CRYPTO_STREAM,
  MARKET_STREAM,
  newXoshiro,
  nextChiSquare2,
  nextNormal,
  seedHalves,
  seedStream,
} from './prng.ts';

/** Recorded beside `ENGINE_VERSION` on every run. Bump on any change to draws, simulation or summary. */
export const MONTE_CARLO_VERSION = 'personalfi.montecarlo/1';

/** 07 §5.3: "Paths: 10,000." */
export const DEFAULT_PATHS = 10_000;

/** WP 4.6's `projection_percentiles` columns: p5 / p10 / p25 / p50 / p75 / p90 / p95. */
export const PERCENTILE_LEVELS: readonly number[] = Object.freeze([
  0.05, 0.1, 0.25, 0.5, 0.75, 0.9, 0.95,
]);

/** 07 §5.4 detail 3: "success conditional on the first-5-years return decile". */
export const SEQUENCE_WINDOW_YEARS = 5;
export const SEQUENCE_DECILES = 10;
/** Columns of the sequence table, per decile. */
export const SEQUENCE_COLUMNS = 4; // lowest return, highest return, paths, successes

export type EngineKind = 'bootstrap' | 'lognormal';

export interface EngineCorrelation {
  /** Asset codes, WP 4.2's order (`USEQ`, `INTL`, …, `CRYPTO`). */
  readonly assets: readonly string[];
  readonly matrix: readonly (readonly number[])[];
}

/** Crypto, in engine units. `holding` 0 = the plan holds none; no crypto shocks are drawn. */
export interface EngineCrypto {
  /** Today's dollars at the start of the plan. */
  readonly holding: number;
  readonly expectedNominal: number;
  readonly volatility: number;
  readonly degreesOfFreedom: number;
}

/** Everything the kernel needs, structured-cloneable: what the worker receives. */
export interface MonteCarloJob {
  readonly plan: EnginePlan;
  readonly engine: EngineKind;
  /** Required for `bootstrap`; ignored by `lognormal`. */
  readonly series: ReturnSeries | null;
  /** Annual σ, from WP 4.2's file (the lognormal engine only; the bootstrap's σ is history's). */
  readonly volatility: { readonly equity: number; readonly bond: number; readonly inflation: number };
  readonly correlation: EngineCorrelation;
  readonly crypto: EngineCrypto;
  readonly seed: bigint;
  readonly paths: number;
  readonly extra: ExtraContribution;
}

// ---------------------------------------------------------------------------
// 1. Shocks — the common-random-numbers matrix
// ---------------------------------------------------------------------------

/** Shocks, path-major: `[path × years + year]`. */
export interface ShockMatrix {
  readonly engine: EngineKind;
  readonly paths: number;
  readonly years: number;
  readonly equity: Float64Array;
  readonly bond: Float64Array;
  readonly inflation: Float64Array;
  /** Standardised Student-t (unit variance), or empty when the plan holds no crypto. */
  readonly crypto: Float64Array;
  /** The series in log space, when bootstrapping (its moments set the re-centring). */
  readonly series: PreparedSeries | null;
}

/** κ(ν) = E[√(ν/W)] / √(ν/(ν−2)), W ~ χ²_ν, for integer ν ≥ 3. */
export function tCorrelationFactor(nu: number): number {
  if (!Number.isInteger(nu) || nu < 3) throw new RangeError('ν must be an integer ≥ 3');
  // r(ν) = Γ((ν−1)/2) / Γ(ν/2); r(3) = 2/√π, r(4) = √π/2, r(ν+2) = ((ν−1)/ν) r(ν).
  let ratio = nu % 2 === 1 ? 2 / Math.sqrt(Math.PI) : Math.sqrt(Math.PI) / 2;
  for (let v = nu % 2 === 1 ? 3 : 4; v < nu; v += 2) ratio *= (v - 1) / v;
  // E[W^(−1/2)] = r / √2, so E[√(ν/W)] = √ν · r / √2; divide by √(ν/(ν−2)).
  return (Math.sqrt(nu - 2) * ratio) / Math.SQRT2;
}

/** The years a plan runs. */
export function yearsOf(plan: EnginePlan): number {
  return plan.endAge - plan.startAge;
}

/**
 * Draw every shock for `paths × years`. Path *i* is seeded from (seed, i) alone,
 * so a longer horizon or a larger path count only appends shocks.
 */
export function drawShocks(job: MonteCarloJob): ShockMatrix {
  const years = yearsOf(job.plan);
  const paths = job.paths;
  const cells = paths * years;
  const equity = new Float64Array(cells);
  const bond = new Float64Array(cells);
  const inflation = new Float64Array(cells);
  const withCrypto = job.crypto.holding > 0;
  const crypto = new Float64Array(withCrypto ? cells : 0);

  const ordered = reorderCorrelation(job.correlation.assets, job.correlation.matrix);
  const factor = cholesky(ordered);
  let series: PreparedSeries | null = null;
  if (job.engine === 'bootstrap') {
    if (job.series === null) throw new RangeError('the bootstrap engine needs a return series');
    series = prepareSeries(job.series);
  }

  // Crypto coupling. Lognormal: the matrix's crypto row over (equity, bond);
  // bootstrap: equity only, through the standardised equity shock. Both ÷ κ.
  const nu = job.crypto.degreesOfFreedom;
  const kappa = withCrypto ? tCorrelationFactor(nu) : 1;
  const tScale = withCrypto ? Math.sqrt((nu - 2) / nu) : 1;
  let loadEquity = 0;
  let loadBond = 0;
  if (withCrypto) {
    if (job.engine === 'lognormal') {
      loadEquity = (factor[16] ?? 0) / kappa;
      loadBond = (factor[17] ?? 0) / kappa;
    } else {
      loadEquity = (ordered[0]?.[2] ?? 0) / kappa;
    }
  }
  const loadOwn = Math.sqrt(1 - loadEquity * loadEquity - loadBond * loadBond);
  if (!Number.isFinite(loadOwn)) {
    throw new RangeError('crypto correlations too large for a Student-t coupling at this ν');
  }
  const equityShockSd =
    series === null ? 1 : Math.sqrt(12 * series.equityVariance) || 1;

  const market = newXoshiro();
  const own = newXoshiro();
  const [seedHi, seedLo] = seedHalves(job.seed);
  const cursor: BootstrapCursor = { index: -1 };
  const shock: YearShock = { equity: 0, bond: 0, inflation: 0 };
  const z = new Float64Array(2);

  for (let i = 0; i < paths; i += 1) {
    seedStream(market, seedHi, seedLo, i, MARKET_STREAM);
    if (withCrypto) seedStream(own, seedHi, seedLo, i, CRYPTO_STREAM);
    cursor.index = -1;
    const base = i * years;
    for (let t = 0; t < years; t += 1) {
      if (series !== null) {
        drawBootstrapYear(market, series, cursor, shock);
      } else {
        drawLognormalYear(market, factor, shock, z);
      }
      equity[base + t] = shock.equity;
      bond[base + t] = shock.bond;
      inflation[base + t] = shock.inflation;
      if (withCrypto) {
        const numerator =
          series !== null
            ? loadEquity * (shock.equity / equityShockSd) + loadOwn * nextNormal(own)
            : loadEquity * (z[0] ?? 0) + loadBond * (z[1] ?? 0) + loadOwn * nextNormal(own);
        // χ²_ν as ⌊ν/2⌋ Box-Muller radii (χ²₂ = −2 ln u, no angle needed) plus one
        // squared normal when ν is odd — for ν = 3, the spare half of the pair above.
        let chiSquare = 0;
        for (let k = 0; k + 1 < nu; k += 2) chiSquare += nextChiSquare2(own);
        if (nu % 2 === 1) {
          const n = nextNormal(own);
          chiSquare += n * n;
        }
        crypto[base + t] = (numerator / Math.sqrt(chiSquare / nu)) * tScale;
      }
    }
  }
  return { engine: job.engine, paths, years, equity, bond, inflation, crypto, series };
}

// ---------------------------------------------------------------------------
// 2. Simulation — WP 4.4's stepYear over the shocks
// ---------------------------------------------------------------------------

/** Per-job constants that turn a shock into a real return. Levers live here, never in the shocks. */
interface ShockTransform {
  readonly bootstrap: boolean;
  readonly equityMean: number;
  readonly bondMean: number;
  readonly inflationMean: number;
  /** Bootstrap: log offsets. Lognormal: log σ. */
  readonly equityShift: number;
  readonly bondShift: number;
  readonly inflationShift: number;
  readonly equityLogSigma: number;
  readonly bondLogSigma: number;
  readonly inflationSigma: number;
}

function logSigma(sigma: number, mean: number): number {
  return Math.sqrt(Math.log1p((sigma * sigma) / ((1 + mean) * (1 + mean))));
}

function transformFor(job: MonteCarloJob, shocks: ShockMatrix): ShockTransform {
  const plan = job.plan;
  const equityMean = realRate(plan.equityNominal, plan.inflation);
  const bondMean = realRate(plan.bondNominal, plan.inflation);
  const inflationMean = plan.inflation;
  const series = shocks.series;
  const equityLogSigma = logSigma(job.volatility.equity, equityMean);
  const bondLogSigma = logSigma(job.volatility.bond, bondMean);
  return {
    bootstrap: series !== null,
    equityMean,
    bondMean,
    inflationMean,
    // Bootstrap re-centring (bootstrap.ts header): ln(1 + m) − 12 s² / 2.
    equityShift:
      series === null
        ? -0.5 * equityLogSigma * equityLogSigma
        : Math.log1p(equityMean) - 6 * series.equityVariance,
    bondShift:
      series === null
        ? -0.5 * bondLogSigma * bondLogSigma
        : Math.log1p(bondMean) - 6 * series.bondVariance,
    inflationShift: series === null ? 0 : Math.log1p(inflationMean) - 6 * series.inflationVariance,
    equityLogSigma,
    bondLogSigma,
    inflationSigma: job.volatility.inflation,
  };
}

/** A `MarketYear` the loop overwrites in place. */
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
  if (f.bootstrap) {
    into.equityReal = Math.expm1(e + f.equityShift);
    into.bondReal = Math.expm1(b + f.bondShift);
    into.inflation = Math.expm1(i + f.inflationShift);
  } else {
    // 1 + R = (1 + m) exp(σ_l z − σ_l²/2): E[R] = m, and at σ = 0 exactly m.
    into.equityReal = f.equityMean + (1 + f.equityMean) * Math.expm1(f.equityLogSigma * e + f.equityShift);
    into.bondReal = f.bondMean + (1 + f.bondMean) * Math.expm1(f.bondLogSigma * b + f.bondShift);
    into.inflation = f.inflationMean + f.inflationSigma * i;
  }
}

/**
 * Reset a path state in place to what `newPathState(plan)` returns — so 10,000
 * paths reuse one state instead of allocating 10,000. The reset is pinned
 * against a fresh `newPathState` in `invariants.test.ts`, field by field, so a
 * field WP 4.4 adds later cannot be silently carried from one path to the next.
 */
export function resetPathState(state: PathState, plan: EnginePlan): void {
  for (let b = 0; b < state.wealth.length; b += 1) state.wealth[b] = plan.wealth0[b] ?? 0;
  state.guard.initialSpending = 0;
  state.guard.initialRate = 0;
  state.guard.spending = 0;
  state.guard.worstCut = 0;
  state.lastNominalReturn = 0;
  state.lastInflation = plan.inflation;
  state.inflationIndex = 1;
  state.depletedAtAge = -1;
  state.shortfallTotal = 0;
  state.retiredYears = 0;
  state.scratchReturn.fill(0);
  state.scratchWithdrawal.fill(0);
}

/** Per-path outcomes and the retained checkpoints. Allocated once per job, reused by the solver. */
export interface SimulationBuffers {
  /** Year-end total real wealth, year-major: `[year × paths + path]`. The only thing retained per year. */
  readonly checkpoints: Float64Array;
  readonly depletedAtAge: Float64Array;
  readonly shortfallTotal: Float64Array;
  readonly worstCut: Float64Array;
  /** Annualised real portfolio return over the sequence window, or NaN when there is no window. */
  readonly sequenceReturn: Float64Array;
}

export function newSimulationBuffers(paths: number, years: number): SimulationBuffers {
  return {
    checkpoints: new Float64Array(paths * years),
    depletedAtAge: new Float64Array(paths),
    shortfallTotal: new Float64Array(paths),
    worstCut: new Float64Array(paths),
    sequenceReturn: new Float64Array(paths),
  };
}

/** The first retirement year's index and the window's length; length 0 when the plan ends first. */
export function sequenceWindow(plan: EnginePlan): { readonly start: number; readonly length: number } {
  const years = yearsOf(plan);
  const start = Math.max(0, plan.retireAge - plan.startAge);
  return { start, length: Math.max(0, Math.min(SEQUENCE_WINDOW_YEARS, years - start)) };
}

/**
 * Run every path through `stepYear`. Returns the number of paths with no
 * unfunded year (the success count). `cryptoHolding` is separate from the job
 * so the dual projection can re-run the same shocks with crypto at zero.
 */
export function simulate(
  prepared: PreparedPlan,
  job: MonteCarloJob,
  shocks: ShockMatrix,
  extra: ExtraContribution,
  cryptoHolding: number,
  out: SimulationBuffers,
): number {
  const plan = prepared.plan;
  const years = shocks.years;
  const paths = shocks.paths;
  const f = transformFor(job, shocks);
  const state = newPathState(plan);
  const market: MutableMarket = { equityReal: 0, bondReal: 0, inflation: 0 };
  const view: MarketYear = market;
  const window = sequenceWindow(plan);
  const windowEnd = window.start + window.length;
  const cryptoMean = job.crypto.expectedNominal;
  const cryptoSigma = job.crypto.volatility;
  const holdsCrypto = cryptoHolding > 0 && shocks.crypto.length === paths * years;
  let successes = 0;

  for (let i = 0; i < paths; i += 1) {
    resetPathState(state, plan);
    let sleeve = holdsCrypto ? cryptoHolding : 0;
    let windowGross = 1;
    const base = i * years;
    for (let t = 0; t < years; t += 1) {
      const cell = base + t;
      fillMarket(market, shocks, cell, f);
      const shortBefore = state.shortfallTotal;
      const depletedBefore = state.depletedAtAge;
      stepYear(prepared, state, t, view, extra, false);
      if (sleeve > 0) {
        // Crypto funds last: only what the four buckets could not.
        const short = state.shortfallTotal - shortBefore;
        if (short > 0) {
          if (sleeve >= short) {
            sleeve -= short;
            state.shortfallTotal = shortBefore;
            state.depletedAtAge = depletedBefore;
          } else {
            state.shortfallTotal = shortBefore + (short - sleeve);
            sleeve = 0;
          }
        }
        let nominal = cryptoMean + cryptoSigma * (shocks.crypto[cell] ?? 0);
        if (nominal < -1) nominal = -1; // a total loss, never a negative sleeve
        sleeve = (sleeve * (1 + nominal)) / (1 + market.inflation);
      }
      const w = state.wealth;
      out.checkpoints[t * paths + i] = (w[0] ?? 0) + (w[1] ?? 0) + (w[2] ?? 0) + (w[3] ?? 0) + sleeve;
      if (t >= window.start && t < windowEnd) {
        windowGross *= (1 + state.lastNominalReturn) / (1 + market.inflation);
      }
    }
    out.depletedAtAge[i] = state.depletedAtAge;
    out.shortfallTotal[i] = state.shortfallTotal;
    out.worstCut[i] = state.guard.worstCut;
    out.sequenceReturn[i] =
      window.length > 0 ? windowGross ** (1 / window.length) - 1 : Number.NaN;
    if (state.depletedAtAge < 0) successes += 1;
  }
  return successes;
}

// ---------------------------------------------------------------------------
// 3. Summary — percentiles by partial sort
// ---------------------------------------------------------------------------

/**
 * Hoare quickselect, iterative, median-of-three pivot: afterwards `a[k]` is the
 * k-th smallest of `a[lo..hi]`, everything left of it ≤ and right of it ≥.
 */
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

/**
 * Type-7 (linear interpolation) quantiles of `a[0..n)` at ascending `levels`,
 * partially sorting `a` in place. Written to `out[offset + stride × l]`.
 */
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
  /** Medians over failing paths only; NaN when none failed. */
  readonly medianDepletionAge: number;
  /** Years from depletion to the plan's end (07 §5.4 detail 2's "shortfall years"). */
  readonly medianShortfallYears: number;
  /** Unfunded real spending over the path, today's dollars. */
  readonly medianShortfallTotal: number;
}

export interface SequenceTable {
  /** Age at the start of the window: the first retirement year, or today when already retired. */
  readonly startAge: number;
  readonly years: number;
  /** `SEQUENCE_DECILES × SEQUENCE_COLUMNS`: lowest annualised real return, highest, paths, successes. */
  readonly deciles: Float64Array;
}

export interface MonteCarloResult {
  readonly monteCarloVersion: string;
  readonly engineVersion: string;
  readonly engine: EngineKind;
  readonly seriesId: string | null;
  readonly seriesSha256: string | null;
  readonly seed: bigint;
  readonly paths: number;
  readonly years: number;
  readonly startAge: number;
  readonly retireAge: number;
  readonly startYear: number;
  readonly levels: readonly number[];
  /** Real year-end wealth at each level: `[level × years + year]`. Bands, never paths. */
  readonly bands: Float64Array;
  readonly successCount: number;
  readonly failure: FailureSummary;
  /** 07 §5.6: the real spending cut exceeded by only 5 % of paths (0 without guardrails). */
  readonly worstCutP95: number;
  readonly sequence: SequenceTable | null;
  /** 07 §6.4 treatment 2: the same shocks with crypto valued at zero; null when the plan holds none. */
  readonly withoutCrypto: { readonly successCount: number; readonly bands: Float64Array } | null;
}

function bandsOf(buffers: SimulationBuffers, paths: number, years: number, scratch: Float64Array): Float64Array {
  const bands = new Float64Array(PERCENTILE_LEVELS.length * years);
  for (let t = 0; t < years; t += 1) {
    scratch.set(buffers.checkpoints.subarray(t * paths, (t + 1) * paths));
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

function failureOf(buffers: SimulationBuffers, plan: EnginePlan, paths: number, scratch: Float64Array): FailureSummary {
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
  return { count, medianDepletionAge, medianShortfallYears, medianShortfallTotal: medianOf(scratch, count) };
}

function sequenceOf(buffers: SimulationBuffers, plan: EnginePlan, paths: number): SequenceTable | null {
  const window = sequenceWindow(plan);
  if (window.length === 0 || paths < SEQUENCE_DECILES) return null;
  const r = buffers.sequenceReturn;
  const order = new Uint32Array(paths);
  for (let i = 0; i < paths; i += 1) order[i] = i;
  // A total order (return, then path index), so the ranking is deterministic however the sort is implemented.
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

/** The whole job: shocks, simulation (twice when crypto is held), summary. */
export function runMonteCarlo(job: MonteCarloJob): MonteCarloResult {
  const prepared = preparePlan(job.plan);
  const shocks = drawShocks(job);
  const { paths, years } = shocks;
  const buffers = newSimulationBuffers(paths, years);
  const scratch = new Float64Array(paths);

  let withoutCrypto: MonteCarloResult['withoutCrypto'] = null;
  if (job.crypto.holding > 0) {
    const successCount = simulate(prepared, job, shocks, job.extra, 0, buffers);
    withoutCrypto = { successCount, bands: bandsOf(buffers, paths, years, scratch) };
  }
  const successCount = simulate(prepared, job, shocks, job.extra, job.crypto.holding, buffers);
  const bands = bandsOf(buffers, paths, years, scratch);
  const failure = failureOf(buffers, job.plan, paths, scratch);
  scratch.set(buffers.worstCut);
  const cut = new Float64Array(1);
  quantilesInPlace(scratch, paths, [0.95], cut, 0, 1);

  return {
    monteCarloVersion: MONTE_CARLO_VERSION,
    engineVersion: ENGINE_VERSION,
    engine: job.engine,
    seriesId: job.engine === 'bootstrap' ? (job.series?.id ?? null) : null,
    seriesSha256: job.engine === 'bootstrap' ? (job.series?.sha256 ?? null) : null,
    seed: job.seed,
    paths,
    years,
    startAge: job.plan.startAge,
    retireAge: job.plan.retireAge,
    startYear: job.plan.startYear,
    levels: PERCENTILE_LEVELS,
    bands,
    successCount,
    failure,
    worstCutP95: cut[0] ?? 0,
    sequence: sequenceOf(buffers, job.plan, paths),
    withoutCrypto,
  };
}

// ---------------------------------------------------------------------------
// 4. The probability-targeted solver (09 GOAL-7: 80 % by default)
// ---------------------------------------------------------------------------

export type SuccessObjective =
  | { readonly kind: 'sustain' }
  | { readonly kind: 'wealth_at'; readonly yearIndex: number; readonly target: number };

export interface SuccessTarget {
  readonly objective: SuccessObjective;
  /** Paths that must meet the objective: ⌈target ratio × paths⌉, computed by the host from a decimal string. */
  readonly requiredCount: number;
  /** The most the household can add per year (engine dollars). */
  readonly ceilingAnnual: number;
}

export type SuccessSolveOutcome =
  | { readonly kind: 'already_met'; readonly metCount: number }
  | {
      readonly kind: 'required';
      /** Whole cents per month, verified: the amount the engine ran and saw meet the target. */
      readonly monthlyCents: number;
      readonly annual: number;
      readonly metCount: number;
      readonly iterations: number;
    }
  | { readonly kind: 'unreachable'; readonly constraint: 'no_contribution_window'; readonly untilAge: number }
  | {
      readonly kind: 'unreachable';
      readonly constraint: 'monthly_ceiling';
      readonly ceilingAnnual: number;
      readonly metCountAtCeiling: number;
    };

/** Bisection stops when the bracket is narrower than a dollar a month. MC noise is far wider; CRN makes it stable. */
export const SUCCESS_SOLVE_TOLERANCE = 12;
export const SUCCESS_SOLVE_MAX_ITERATIONS = 100;
const VERIFY_STEPS = 3;

function metCount(
  prepared: PreparedPlan,
  job: MonteCarloJob,
  shocks: ShockMatrix,
  objective: SuccessObjective,
  extra: ExtraContribution,
  buffers: SimulationBuffers,
): number {
  const successes = simulate(prepared, job, shocks, extra, job.crypto.holding, buffers);
  if (objective.kind === 'sustain') return successes;
  let met = 0;
  const from = objective.yearIndex * shocks.paths;
  for (let i = 0; i < shocks.paths; i += 1) {
    if ((buffers.checkpoints[from + i] ?? 0) >= objective.target) met += 1;
  }
  return met;
}

/**
 * The additional contribution at which at least `requiredCount` of the paths
 * meet the objective, by bisection **over one shock matrix** — every candidate
 * amount sees the same markets, so the success count is a step function of the
 * amount alone and the answer does not move between re-runs (common random
 * numbers, 07 §5.4 detail 1). The answer is rounded up to a whole cent a month
 * and re-simulated before it is returned, the WP 4.4 solver's rule.
 */
export function solveForSuccess(job: MonteCarloJob, target: SuccessTarget): SuccessSolveOutcome {
  const prepared = preparePlan(job.plan);
  const shocks = drawShocks(job);
  const buffers = newSimulationBuffers(shocks.paths, shocks.years);
  const plan = job.plan;
  const untilAge =
    target.objective.kind === 'wealth_at'
      ? Math.min(plan.retireAge, plan.startAge + target.objective.yearIndex + 1)
      : plan.retireAge;
  const at = (annual: number) =>
    metCount(prepared, job, shocks, target.objective, { annual, untilAge }, buffers);

  const atZero = at(0);
  if (atZero >= target.requiredCount) return { kind: 'already_met', metCount: atZero };
  if (untilAge <= plan.startAge) {
    return { kind: 'unreachable', constraint: 'no_contribution_window', untilAge };
  }
  const atCeiling = at(target.ceilingAnnual);
  if (atCeiling < target.requiredCount) {
    return {
      kind: 'unreachable',
      constraint: 'monthly_ceiling',
      ceilingAnnual: target.ceilingAnnual,
      metCountAtCeiling: atCeiling,
    };
  }
  let lo = 0;
  let hi = target.ceilingAnnual;
  let iterations = 0;
  while (hi - lo > SUCCESS_SOLVE_TOLERANCE && iterations < SUCCESS_SOLVE_MAX_ITERATIONS) {
    const mid = (lo + hi) / 2;
    if (at(mid) >= target.requiredCount) hi = mid;
    else lo = mid;
    iterations += 1;
  }
  // Whole cents a month, then the float the host will rebuild from that Money: (cents / 100) × 12.
  let monthlyCents = Math.ceil((hi / 12) * 100 - 1e-9);
  for (let step = 0; step <= VERIFY_STEPS; step += 1) {
    const annual = (monthlyCents / 100) * 12;
    const met = at(annual);
    if (met >= target.requiredCount) {
      return { kind: 'required', monthlyCents, annual, metCount: met, iterations };
    }
    monthlyCents += 1;
  }
  throw new Error(
    'solveForSuccess: the bisected amount did not verify after rounding; refusing to return a ' +
      'number that does not meet the target',
  );
}

// ---------------------------------------------------------------------------
// 5. The worker protocol — one request in, one reply out, both cloneable
// ---------------------------------------------------------------------------

export type WorkerRequest =
  | { readonly kind: 'run'; readonly job: MonteCarloJob }
  | { readonly kind: 'solve'; readonly job: MonteCarloJob; readonly target: SuccessTarget }
  /** What the thread was given: its environment keys, execArgv and resource limits. */
  | { readonly kind: 'probe' };

export type WorkerReply =
  | { readonly kind: 'run'; readonly result: MonteCarloResult }
  | { readonly kind: 'solve'; readonly outcome: SuccessSolveOutcome }
  | {
      readonly kind: 'probe';
      readonly envKeys: readonly string[];
      readonly execArgv: readonly string[];
      readonly resourceLimits: Readonly<Record<string, number | undefined>>;
      readonly heapUsedMb: number;
    };

// ---------------------------------------------------------------------------
// 6. Canonical bytes — what "identical seed ⇒ identical bytes" compares
// ---------------------------------------------------------------------------

const MAGIC = 'PFMC1\n';

/**
 * The result as bytes: a magic line, a JSON header with sorted keys (the seed
 * as a decimal string), then every float array as little-endian IEEE-754
 * doubles in a fixed order. Timing is not in it — a duration is not a result.
 */
export function serialiseResult(result: MonteCarloResult): Uint8Array {
  const arrays: readonly (readonly [string, Float64Array])[] = [
    ['bands', result.bands],
    ['sequence', result.sequence?.deciles ?? new Float64Array(0)],
    ['withoutCryptoBands', result.withoutCrypto?.bands ?? new Float64Array(0)],
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
    withoutCryptoSuccessCount: result.withoutCrypto?.successCount ?? null,
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

/** A double as text that round-trips exactly (JSON would print NaN as null). */
function exactText(x: number): string {
  return Number.isNaN(x) ? 'NaN' : String(x);
}
