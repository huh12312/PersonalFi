// SPDX-License-Identifier: MIT
/**
 * A **synthetic** monthly return series for WP 4.5's engine tests — not
 * history, and never used outside `src/engine/*.test.ts`.
 *
 * Why the tests do not use Shiller's series: it is fetched on first run and
 * git-ignored, not vendored (the licence position is in
 * `data/returns/PROVENANCE.md` and dispatch §6 Q3), so a fresh clone and CI
 * have no copy, and an engine test that silently skipped without it would be
 * no test. The bootstrap machinery does not care where the numbers came from;
 * what the tests prove — byte identity, the invariants, crypto's isolation,
 * the limits, the timing — holds for any series of this shape.
 *
 * Shape: 1,847 months, the length of the real 1871-02..2024-12 window, so the
 * perf test indexes a table of the real size. Each month draws correlated
 * normals for log real equity, bond and inflation from this package's own
 * xoshiro256++ at a fixed seed, with moments close to Shiller's (equity
 * ≈ 0.55 %/month, σ ≈ 4.1 %; bonds ≈ 0.19 %, σ ≈ 1.8 %; CPI ≈ 0.17 %, σ ≈ 0.6 %).
 * The text goes through the real `parseReturnSeries`, so the parser is
 * exercised too, and its SHA-256 is computed the way the loader computes one.
 */
import { newXoshiro, nextNormal, seedHalves, seedStream } from '../../../src/engine/prng.ts';
import type { ReturnSeries } from '../../../src/engine/bootstrap.ts';
import { CSV_HEADER } from '../../../data/returns/derive.ts';
import { parseReturnSeries, sha256Hex } from '../../../data/returns/series.ts';

export const SYNTHETIC_MONTHS = 1_847;
export const SYNTHETIC_SEED = 18_710_201n;

function fixed(ratio: number): string {
  return ratio.toFixed(12);
}

/** The synthetic series' canonical CSV text. */
export function syntheticCsv(months = SYNTHETIC_MONTHS, seed = SYNTHETIC_SEED): string {
  const g = newXoshiro();
  const [hi, lo] = seedHalves(seed);
  seedStream(g, hi, lo, 0, 0);
  const lines = [CSV_HEADER];
  for (let m = 0; m < months; m += 1) {
    const z0 = nextNormal(g);
    const z1 = nextNormal(g);
    const z2 = nextNormal(g);
    // (equity, bond) ρ ≈ 0.1; inflation ρ ≈ −0.15 with equity.
    const equityLog = 0.0055 + 0.041 * z0;
    const bondLog = 0.0019 + 0.018 * (0.1 * z0 + Math.sqrt(1 - 0.01) * z1);
    const inflationLog = 0.0017 + 0.006 * (-0.15 * z0 + Math.sqrt(1 - 0.0225) * z2);
    const year = 1871 + Math.floor((m + 1) / 12);
    const month = ((m + 1) % 12) + 1;
    lines.push(
      `${String(year)}-${String(month).padStart(2, '0')},${fixed(Math.expm1(equityLog))},` +
        `${fixed(Math.expm1(bondLog))},${fixed(Math.expm1(inflationLog))}`,
    );
  }
  return `${lines.join('\n')}\n`;
}

let cached: ReturnSeries | null = null;

/** The synthetic series, parsed by the production parser. */
export function syntheticSeries(): ReturnSeries {
  if (cached === null) {
    const csv = syntheticCsv();
    cached = parseReturnSeries(csv, sha256Hex(csv), `synthetic/${String(SYNTHETIC_MONTHS)}-months`);
  }
  return cached;
}
