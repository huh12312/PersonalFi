// SPDX-License-Identifier: MIT
/**
 * WP 4.5 — crypto is its own asset class (07 §6.4), in the Monte Carlo.
 *
 *   * `'crypto is drawn from its own distribution and a 70% sigma never enters
 *     the equity draw'` — three separate claims, each checked on both engines:
 *     (a) the market shocks (equity, bonds, inflation) are **byte-identical**
 *     whether the plan holds crypto or not and whatever crypto's σ is — the
 *     crypto draw has its own PRNG stream and only *reads* the equity shock;
 *     (b) the four tax buckets' wealth never sees crypto: the dual projection's
 *     crypto-at-zero bands are byte-identical under σ = 70 % and σ = 5 %, and to
 *     a plan that holds no crypto at all — this is the check that goes red when
 *     crypto is folded into the equity *return* rather than the equity *shock*;
 *     (c) the crypto draw is Student-t, not lognormal — its tails are several
 *     times a normal's, a lognormal can never lose more than 100 % and this
 *     draw does (which the sleeve books as a total loss), and its correlation
 *     with the equity shock lands on the file's 0.40.
 *   * `'the dual projection reports the plan with crypto at zero'` — 07 §6.4
 *     treatment 2: the plan is also run with crypto valued at $0 **over the same
 *     shocks**, so the difference is exactly what crypto rescued; the summary
 *     carries that probability, that median and the file's disclaimer.
 */
import { describe, expect, it } from 'vitest';
import { DateOnly } from '@core/kernel';
import { applyOverrides, loadAssumptions } from '../assumptions.ts';
import { referencePlan, usd } from '../../test/engine/support.ts';
import { syntheticSeries } from '../../test/engine/fixtures/synthetic-series.ts';
import type { ProjectionPlan } from './boundary.ts';
import { drawShocks, runMonteCarlo, serialiseResult, type EngineKind } from './montecarlo.ts';
import {
  runMonteCarloInWorker,
  toMonteCarloJob,
  toMonteCarloSummary,
  type MonteCarloRequest,
} from './worker-host.ts';

const assumptions = loadAssumptions();
const series = syntheticSeries();
const ENGINES: readonly EngineKind[] = ['bootstrap', 'lognormal'];

function request(
  plan: ProjectionPlan,
  engine: EngineKind,
  extra: Partial<MonteCarloRequest> = {},
): MonteCarloRequest {
  return { plan, assumptions, seed: 6_400n, engine, paths: 4_000, series, ...extra };
}

function bytesOf(array: Float64Array): Buffer {
  return Buffer.from(array.buffer, array.byteOffset, array.byteLength);
}

function correlation(xs: Float64Array, ys: Float64Array): number {
  const n = xs.length;
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < n; i += 1) {
    sx += xs[i] ?? 0;
    sy += ys[i] ?? 0;
  }
  const mx = sx / n;
  const my = sy / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = (xs[i] ?? 0) - mx;
    const dy = (ys[i] ?? 0) - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  return sxy / Math.sqrt(sxx * syy);
}

describe('crypto, its own class (07 §6.4)', () => {
  it('crypto is drawn from its own distribution and a 70% sigma never enters the equity draw', () => {
    const quiet = applyOverrides(
      assumptions,
      { 'capitalMarket.crypto.volatility': '0.05' },
      DateOnly.parse('2026-09-26'),
    );
    const plan = referencePlan('B');
    for (const engine of ENGINES) {
      const held = toMonteCarloJob(request(plan, engine, { cryptoHolding: usd('50000') }));
      const heldQuiet = toMonteCarloJob(
        request(plan, engine, { cryptoHolding: usd('50000'), assumptions: quiet }),
      );
      const none = toMonteCarloJob(request(plan, engine));
      // The file's σ is the one under test.
      expect(held.crypto.volatility).toBe(0.7);
      expect(held.crypto.degreesOfFreedom).toBe(3);
      expect(heldQuiet.crypto.volatility).toBe(0.05);
      expect(none.crypto.holding).toBe(0);

      // (a) The market shocks do not know crypto exists.
      const withCrypto = drawShocks(held);
      const withoutCrypto = drawShocks(none);
      const withQuietCrypto = drawShocks(heldQuiet);
      for (const column of ['equity', 'bond', 'inflation'] as const) {
        expect(
          bytesOf(withCrypto[column]).equals(bytesOf(withoutCrypto[column])),
          `${engine} ${column}`,
        ).toBe(true);
        expect(
          bytesOf(withQuietCrypto[column]).equals(bytesOf(withoutCrypto[column])),
          `${engine} ${column}`,
        ).toBe(true);
      }
      expect(withCrypto.crypto.length).toBe(withCrypto.equity.length);
      expect(withoutCrypto.crypto.length).toBe(0);
      // Crypto's σ scales the return later; the standardised shock itself is σ-free.
      expect(bytesOf(withCrypto.crypto).equals(bytesOf(withQuietCrypto.crypto))).toBe(true);

      // (b) The four buckets never see crypto: crypto-at-zero is the same, byte for byte, under a
      // 70% σ, a 5% σ, and a plan with no crypto at all.
      const loud = runMonteCarlo(held);
      const soft = runMonteCarlo(heldQuiet);
      const plain = runMonteCarlo(none);
      if (loud.withoutCrypto === null || soft.withoutCrypto === null)
        throw new Error('no dual projection');
      expect(
        bytesOf(loud.withoutCrypto.bands).equals(bytesOf(plain.bands)),
        `${engine}: 70% σ reached the buckets`,
      ).toBe(true);
      expect(bytesOf(soft.withoutCrypto.bands).equals(bytesOf(plain.bands))).toBe(true);
      expect(loud.withoutCrypto.successCount).toBe(plain.successCount);
      // …while the sleeve itself does feel its own σ.
      expect(bytesOf(loud.bands).equals(bytesOf(soft.bands))).toBe(false);

      // (c) Student-t(3), not lognormal. Unit variance, so a normal would put 0.27% beyond ±3;
      // a unit-variance t(3) puts ≈ 1.4% there.
      const draws = withCrypto.crypto;
      let beyondThree = 0;
      let totalLosses = 0;
      for (let i = 0; i < draws.length; i += 1) {
        const x = draws[i] ?? 0;
        if (Math.abs(x) > 3) beyondThree += 1;
        // The nominal return the sleeve is booked at: mean + σ × shock. Below −100% is impossible
        // for a lognormal; the engine books it as a total loss of the sleeve.
        if (held.crypto.expectedNominal + held.crypto.volatility * x < -1) totalLosses += 1;
      }
      const tail = beyondThree / draws.length;
      const lossShare = totalLosses / draws.length;
      const equityStandardised = withCrypto.equity;
      const rho = correlation(draws, equityStandardised);
      console.log(
        `[crypto] ${engine}: ${String(draws.length)} draws; P(|x| > 3) = ${(tail * 100).toFixed(3)}% ` +
          `(normal 0.270%); years below −100% nominal = ${(lossShare * 100).toFixed(2)}%; ` +
          `corr(crypto, equity shock) = ${rho.toFixed(4)} (file 0.40)`,
      );
      expect(tail).toBeGreaterThan(0.008);
      expect(lossShare).toBeGreaterThan(0.01);
      expect(rho).toBeGreaterThan(0.35);
      expect(rho).toBeLessThan(0.45);
    }
  }, 60_000);

  it('the dual projection reports the plan with crypto at zero', async () => {
    // Underfunded, so crypto has something to rescue.
    const plan: ProjectionPlan = { ...referencePlan('B'), annualSpending: usd('72000') };
    for (const engine of ENGINES) {
      const heldRequest = request(plan, engine, { cryptoHolding: usd('150000') });
      const noneRequest = request(plan, engine);
      const held = runMonteCarlo(toMonteCarloJob(heldRequest));
      const none = runMonteCarlo(toMonteCarloJob(noneRequest));
      if (held.withoutCrypto === null)
        throw new Error('a plan holding crypto must carry the crypto-at-zero run');
      expect(none.withoutCrypto).toBeNull();
      // Crypto at zero is the no-crypto plan over the same shocks: equal success, equal bands.
      expect(held.withoutCrypto.successCount).toBe(none.successCount);
      expect(bytesOf(held.withoutCrypto.bands).equals(bytesOf(none.bands))).toBe(true);
      // Crypto funds last and only adds: never fewer successes; here strictly more.
      expect(held.successCount).toBeGreaterThan(held.withoutCrypto.successCount);

      const summary = toMonteCarloSummary(held, heldRequest);
      const plain = toMonteCarloSummary(none, noneRequest);
      expect(plain.crypto).toBeNull();
      const median = plain.bands.find((band) => band.level === '0.5');
      expect(summary.crypto).toEqual({
        withoutCryptoSuccessProbability: plain.successProbability,
        withoutCryptoMedianTerminal: median?.byYear[median.byYear.length - 1],
        disclaimer: assumptions.file.capitalMarket.crypto.disclaimer.value,
      });
      console.log(
        `[crypto] ${engine}: success with crypto ${summary.successProbability}, ` +
          `with crypto at $0 ${summary.crypto?.withoutCryptoSuccessProbability ?? 'n/a'}`,
      );
    }
    // And through the worker thread: the dual projection crosses the clone intact.
    const heldRequest = request(plan, 'bootstrap', { cryptoHolding: usd('150000'), paths: 1_000 });
    const viaWorker = await runMonteCarloInWorker(heldRequest, { deadlineMs: 20_000 });
    const inProcess = runMonteCarlo(toMonteCarloJob(heldRequest));
    expect(
      Buffer.from(serialiseResult(viaWorker.result)).equals(
        Buffer.from(serialiseResult(inProcess)),
      ),
    ).toBe(true);
    expect(viaWorker.summary.crypto?.withoutCryptoSuccessProbability).toBeDefined();
  }, 60_000);
});
