// SPDX-License-Identifier: MIT
/**
 * The two ways a Monte Carlo year is drawn — 07 §5.3.
 *
 *   * **B. Stationary block bootstrap — the default** (07 §5.3; dispatch §6 Q2).
 *     Contiguous runs of *real monthly* returns resampled from history, block
 *     lengths geometric with `p_stay = 1 − 1/12` so E[block] = 12 months
 *     (Politis & Romano 1994; 07 §5.4's pseudocode, line for line). One month
 *     draws equity, bonds and CPI **together**, so their cross-correlation,
 *     fat tails and autocorrelation come from the data "for free" — and
 *     inflation stays correlated with returns, which 04 §5.6 asks for so the
 *     engine does not "generate impossible worlds".
 *   * **A. Parametric multivariate lognormal — for sensitivity.** Correlated
 *     through a Cholesky factor of WP 4.2's 8 × 8 matrix, written out by hand
 *     below (dispatch §4 item 10: "a Cholesky over an 8×8 correlation matrix is
 *     twenty lines and a dependency here is a dependency in the hot loop").
 *
 * ## What is stored, and what is applied later (common random numbers)
 *
 * A draw here is a **shock**, not a return. For the bootstrap it is the year's
 * sum of *demeaned* monthly log real returns; for the lognormal it is a
 * correlated standard normal. The plan's expected returns and the assumption
 * file's volatilities are applied on top, per year, in `montecarlo.ts`. So two
 * what-ifs with the same seed share every shock exactly, and a lever — a
 * savings rate, an expected-return shift, a volatility override — moves the
 * outcome and never the noise (07 §5.4 detail 1).
 *
 * ## Re-centring the bootstrap on the assumptions
 *
 * History's own mean (S&P real ≈ 6.9 %/yr since 1871) is not WP 4.2's cited,
 * user-overridable 6.5 % nominal. A bootstrap that kept history's mean would
 * silently ignore the assumptions file — an override of the equity return would
 * change the deterministic path and do nothing to the default engine, which
 * breaks dispatch §1's "assumptions visible, editable, cited". So each series is
 * demeaned in log space and the plan's expectation is added back:
 *
 *     annual real gross = exp(Σ₁₂ (x_m − x̄) + ln(1 + m) − 12 s² / 2)
 *
 * where `x_m = ln(1 + r_m)`, `x̄` and `s²` are the series' monthly log mean and
 * variance, and `m` is the plan's expected annual real return. The `− 12 s²/2`
 * is the lognormal correction under an i.i.d. approximation, so that
 * E[gross] ≈ 1 + m; the block structure makes it approximate, and the evidence
 * reports the realised mean beside the target. Shape, tails, autocorrelation
 * and cross-correlation are history's; the level is the file's.
 *
 * Interior module: `number` only.
 */
import {
  nextDouble,
  nextIndex,
  nextNormal,
  type Xoshiro,
} from './prng.ts';

/** 07 §5.4: `p_stay = 1 − 1/12`, so E[block] = 12 months. */
export const P_STAY = 1 - 1 / 12;
export const MONTHS_PER_YEAR = 12;

/**
 * Real monthly returns, one row per month, the three columns drawn together.
 * Produced by `data/returns/series.ts` from the fetched Shiller file and
 * checked against its pinned SHA-256; structured-cloneable, so it crosses into
 * the worker as-is.
 */
export interface ReturnSeries {
  /** e.g. `shiller-ie_data/1871-02..2024-12`. Recorded on the result. */
  readonly id: string;
  /** SHA-256 of the canonical CSV the arrays were parsed from. */
  readonly sha256: string;
  /** The first row's month, `YYYY-MM`. */
  readonly firstMonth: string;
  /** S&P Composite total return (dividends reinvested), deflated by CPI-U. */
  readonly equityReal: Float64Array;
  /** Shiller's 10-year Treasury total return, deflated by CPI-U. */
  readonly bondReal: Float64Array;
  /** CPI-U month-on-month change. */
  readonly inflation: Float64Array;
}

/** The series in log space, demeaned, with the moments the re-centring needs. Built once per job. */
export interface PreparedSeries {
  readonly months: number;
  /** `ln(1 + r) − mean`, per column. */
  readonly equity: Float64Array;
  readonly bond: Float64Array;
  readonly inflation: Float64Array;
  /** Monthly log variance per column (population). */
  readonly equityVariance: number;
  readonly bondVariance: number;
  readonly inflationVariance: number;
}

function demeanedLogs(column: Float64Array): { readonly logs: Float64Array; readonly variance: number } {
  const n = column.length;
  const logs = new Float64Array(n);
  let sum = 0;
  for (let i = 0; i < n; i += 1) {
    const x = Math.log1p(column[i] ?? 0);
    logs[i] = x;
    sum += x;
  }
  const mean = sum / n;
  let squares = 0;
  for (let i = 0; i < n; i += 1) {
    const d = (logs[i] ?? 0) - mean;
    logs[i] = d;
    squares += d * d;
  }
  return { logs, variance: squares / n };
}

export function prepareSeries(series: ReturnSeries): PreparedSeries {
  const months = series.equityReal.length;
  if (months < MONTHS_PER_YEAR || series.bondReal.length !== months || series.inflation.length !== months) {
    throw new RangeError('a return series needs three equal columns of at least twelve months');
  }
  for (const column of [series.equityReal, series.bondReal, series.inflation]) {
    for (let i = 0; i < months; i += 1) {
      const r = column[i] ?? Number.NaN;
      if (!Number.isFinite(r) || r <= -1) throw new RangeError(`series row ${String(i)} is not a return`);
    }
  }
  const equity = demeanedLogs(series.equityReal);
  const bond = demeanedLogs(series.bondReal);
  const inflation = demeanedLogs(series.inflation);
  return {
    months,
    equity: equity.logs,
    bond: bond.logs,
    inflation: inflation.logs,
    equityVariance: equity.variance,
    bondVariance: bond.variance,
    inflationVariance: inflation.variance,
  };
}

/**
 * Where a path is in the series. `index < 0` means "not started": the first
 * month of a path is a uniform draw, with no stay/jump coin (07 §5.4, `m > 0`).
 */
export interface BootstrapCursor {
  index: number;
}

/** Year shocks: the sums of twelve demeaned monthly logs. Written by `drawBootstrapYear`. */
export interface YearShock {
  equity: number;
  bond: number;
  inflation: number;
}

/**
 * Twelve months of the stationary bootstrap, summed. Per month: with
 * probability `1 − p_stay` jump to a uniform month, otherwise step to the next
 * one, wrapping at the end (the circular variant, so every month is equally
 * likely to be drawn). Allocates nothing.
 */
export function drawBootstrapYear(
  g: Xoshiro,
  series: PreparedSeries,
  cursor: BootstrapCursor,
  out: YearShock,
): void {
  let equity = 0;
  let bond = 0;
  let inflation = 0;
  let index = cursor.index;
  const months = series.months;
  for (let m = 0; m < MONTHS_PER_YEAR; m += 1) {
    if (index < 0) {
      index = nextIndex(g, months);
    } else if (nextDouble(g) > P_STAY) {
      index = nextIndex(g, months);
    } else {
      index += 1;
      if (index === months) index = 0;
    }
    equity += series.equity[index] ?? 0;
    bond += series.bond[index] ?? 0;
    inflation += series.inflation[index] ?? 0;
  }
  cursor.index = index;
  out.equity = equity;
  out.bond = bond;
  out.inflation = inflation;
}

// ---------------------------------------------------------------------------
// The lognormal engine's Cholesky
// ---------------------------------------------------------------------------

/**
 * The assets the lognormal engine draws, in factor order: US equity, bonds,
 * crypto first, so their correlated normals need only the first three
 * independent normals (the leading block of a Cholesky factor is the factor of
 * the leading block). The remaining five are still factored, so a matrix that
 * is not positive definite anywhere is refused, not partly used.
 */
export const LOGNORMAL_ORDER = ['USEQ', 'BOND', 'CRYPTO', 'INTL', 'EM', 'TIPS', 'REIT', 'CASH'] as const;

/**
 * `A = L Lᵀ` for a symmetric positive-definite `A`, lower-triangular `L`, row
 * major. The textbook Cholesky–Banachiewicz loop. Throws on a matrix that is
 * not positive definite (a non-positive pivot) rather than returning NaN.
 */
export function cholesky(matrix: readonly (readonly number[])[]): Float64Array {
  const n = matrix.length;
  const factor = new Float64Array(n * n);
  for (let i = 0; i < n; i += 1) {
    const row = matrix[i];
    if (row?.length !== n) throw new RangeError('the correlation matrix is not square');
    for (let j = 0; j <= i; j += 1) {
      let sum = row[j] ?? 0;
      for (let k = 0; k < j; k += 1) sum -= (factor[i * n + k] ?? 0) * (factor[j * n + k] ?? 0);
      if (i === j) {
        if (!(sum > 0)) {
          throw new RangeError(
            `the correlation matrix is not positive definite (pivot ${String(i)} is ${String(sum)})`,
          );
        }
        factor[i * n + i] = Math.sqrt(sum);
      } else {
        factor[i * n + j] = sum / (factor[j * n + j] ?? 1);
      }
    }
  }
  return factor;
}

/** Reorder a named correlation matrix into `LOGNORMAL_ORDER`. */
export function reorderCorrelation(
  assets: readonly string[],
  matrix: readonly (readonly number[])[],
): number[][] {
  const at = LOGNORMAL_ORDER.map((name) => {
    const index = assets.indexOf(name);
    if (index < 0) throw new RangeError(`the correlation matrix has no ${name} row`);
    return index;
  });
  return at.map((i) => at.map((j) => matrix[i]?.[j] ?? Number.NaN));
}

/**
 * One year of correlated standard normals for (equity, bond) plus the
 * independent inflation normal. `factor` is the 8 × 8 Cholesky factor in
 * `LOGNORMAL_ORDER`; `z` receives the three independent normals the crypto
 * draw reuses (see `montecarlo.ts`).
 */
export function drawLognormalYear(
  g: Xoshiro,
  factor: Float64Array,
  out: YearShock,
  z: Float64Array,
): void {
  const z0 = nextNormal(g);
  const z1 = nextNormal(g);
  const zInflation = nextNormal(g);
  z[0] = z0;
  z[1] = z1;
  out.equity = (factor[0] ?? 0) * z0;
  out.bond = (factor[8] ?? 0) * z0 + (factor[9] ?? 0) * z1;
  out.inflation = zInflation;
}
