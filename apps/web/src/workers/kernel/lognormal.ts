// SPDX-License-Identifier: MIT
/**
 * The lognormal engine's Cholesky and per-year draw — a port of the relevant
 * half of `packages/contexts/planning/src/engine/bootstrap.ts` (WP 4.5). See
 * `prng.ts`'s header for why this is a port rather than an import.
 *
 * **Not ported: the block bootstrap.** `drawBootstrapYear` and
 * `prepareSeries` need Shiller's vendored monthly return series
 * (`packages/contexts/planning/data/returns/**`, fetched and checksum-pinned
 * server-side) — porting the *algorithm* is 30 lines, but porting the
 * *data* into a client bundle is a different decision (bundle size, and a
 * second copy of a licensed dataset to keep in sync) that this WP does not
 * make unilaterally. The slider preview always runs the lognormal engine;
 * `docs/evidence/phase-4/wp4.11-client-worker.md` records this as an open
 * item for the orchestrator. The golden vector is a lognormal-engine
 * scenario for the same reason.
 *
 * **Not ported: the crypto coupling.** `tCorrelationFactor`,
 * `nextChiSquare2` and the Student-t sleeve exist only when `crypto.holding
 * > 0`; the worker's `MonteCarloJob` (`montecarlo.ts`) has no crypto field at
 * all, so there is nothing to couple.
 */
import { nextNormal, type Xoshiro } from './prng.ts';

/** Asset order a correlation matrix must be reordered into (server's `LOGNORMAL_ORDER`). */
export const LOGNORMAL_ORDER = [
  'USEQ',
  'BOND',
  'CRYPTO',
  'INTL',
  'EM',
  'TIPS',
  'REIT',
  'CASH',
] as const;

export interface YearShock {
  equity: number;
  bond: number;
  inflation: number;
}

/** `A = L Lᵀ`, lower-triangular `L`, row major. Throws on a non-positive-definite matrix. */
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

/** One year of correlated (equity, bond) standard normals plus an independent inflation normal. */
export function drawLognormalYear(g: Xoshiro, factor: Float64Array, out: YearShock): void {
  const z0 = nextNormal(g);
  const z1 = nextNormal(g);
  const zInflation = nextNormal(g);
  out.equity = (factor[0] ?? 0) * z0;
  out.bond = (factor[8] ?? 0) * z0 + (factor[9] ?? 0) * z1;
  out.inflation = zInflation;
}
