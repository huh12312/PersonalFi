// SPDX-License-Identifier: MIT
/**
 * Which overridable assumptions the projection engines actually read
 * (WP 9.7, O-5).
 *
 * `GET /assumptions` lists seventeen `overridablePaths`. Eight of them are
 * validated, hashed into the cache key and then read by nothing: an override on
 * `intlDevelopedEquity`, `emergingEquity`, `tips` or `cash` produced a new run
 * with the same number to the cent (Phase 4 gate, O-5). The panel offers an
 * edit control only for a path in this table and says "not used by the current
 * engine" beside the others.
 *
 * The table is read off the engine's own boundary: `engine/boundary.ts`'s
 * `toEnginePlan` reads the return and inflation nodes both engines share, and
 * `monteCarloMarketFrom` adds the volatilities and the crypto sleeve for Monte
 * Carlo only. `engine-read-paths.test.ts` extracts the `market.<node>.<leaf>`
 * reads from that file and fails when this table and the engine disagree, so an
 * engine that starts reading `tips` fails a test instead of staying silently
 * un-editable.
 */
export type EngineReads = 'both' | 'monte_carlo';

export const ENGINE_READ_PATHS: Readonly<Record<string, EngineReads>> = Object.freeze({
  'capitalMarket.usEquity.expectedReturn': 'both',
  'capitalMarket.usAggregateBonds.expectedReturn': 'both',
  'capitalMarket.inflation.mean': 'both',
  'capitalMarket.wageGrowth.spreadOverInflation': 'both',
  'capitalMarket.usEquity.volatility': 'monte_carlo',
  'capitalMarket.usAggregateBonds.volatility': 'monte_carlo',
  'capitalMarket.inflation.volatility': 'monte_carlo',
  'capitalMarket.crypto.expectedReturn': 'monte_carlo',
  'capitalMarket.crypto.volatility': 'monte_carlo',
});

export function engineReads(path: string): EngineReads | null {
  return ENGINE_READ_PATHS[path] ?? null;
}
