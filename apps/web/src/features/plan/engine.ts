// SPDX-License-Identifier: MIT
/**
 * Which engine produced a projection, and what that lets the screen say about
 * it (WP 9.7, G4-13).
 *
 * A Monte Carlo run is a share of simulated paths that did not run out of money:
 * "82% of simulated paths succeed" is a true sentence about it. A deterministic
 * run is one path with no randomness. Its `successProbability` can only be `0`
 * or `1`, and "100% of plans succeed" is a false sentence about it — the install
 * that has not run the operator's return-series fetch shows only this engine
 * (`planning.monte_carlo_unavailable`), so the false sentence was the one every
 * fresh install read. The table below is keyed by the contract's own `method`
 * enum; adding a method to the contract is a compile error here until it says
 * which of the two phrasings it gets.
 */
import type { ProjectionRun } from '../../api/generated/types.gen.ts';

export type EngineMethod = ProjectionRun['method'];

/** `probability`: the run samples many paths and may be phrased as a share of them. `single_path`: it may not. */
export type EnginePhrasing = 'probability' | 'single_path';

export interface EngineDescription {
  /** The section heading. */
  readonly heading: string;
  /** What the engine is, in a phrase. */
  readonly name: string;
  readonly phrasing: EnginePhrasing;
}

export const ENGINES: Readonly<Record<EngineMethod, EngineDescription>> = {
  monte_carlo: {
    heading: 'Monte Carlo fan chart',
    name: 'Monte Carlo simulation',
    phrasing: 'probability',
  },
  deterministic: {
    heading: 'Deterministic projection',
    name: 'Deterministic projection (one path, no randomness)',
    phrasing: 'single_path',
  },
};

/** A method this build does not know (a newer server): named as such, and never phrased as a probability. */
const UNKNOWN_ENGINE: EngineDescription = {
  heading: 'Projection',
  name: 'An engine this version of the app does not recognise',
  phrasing: 'single_path',
};

export function describeEngine(method: string | undefined): EngineDescription {
  if (method === undefined) return { ...UNKNOWN_ENGINE, name: 'No projection yet' };
  return (ENGINES as Readonly<Record<string, EngineDescription>>)[method] ?? UNKNOWN_ENGINE;
}

export function isProbabilistic(run: Pick<ProjectionRun, 'method'>): boolean {
  return describeEngine(run.method).phrasing === 'probability';
}

/** What a one-path run says about the plan: it lasts to the end, it does not, or the stored figure is neither. */
export type SinglePathOutcome = 'lasts' | 'runs_out' | 'unclassified';

export function singlePathOutcome(
  run: Pick<ProjectionRun, 'successProbability'>,
): SinglePathOutcome {
  const value = Number(run.successProbability);
  if (value === 1) return 'lasts';
  if (value === 0) return 'runs_out';
  return 'unclassified';
}

export const SINGLE_PATH_OUTCOME_WORDS: Readonly<Record<SinglePathOutcome, string>> = {
  lasts: 'lasts to the end of the plan',
  runs_out: 'runs out of money before the plan ends',
  unclassified: 'has no outcome this screen can state for it',
};

/** The one line that dates and names a run: engine, size, assumptions, engine version, and the day it started from. */
export function describeRunSource(run: ProjectionRun): string {
  const engine = describeEngine(run.method);
  const size =
    engine.phrasing === 'probability'
      ? `${run.paths.toLocaleString('en-US')} simulated paths`
      : 'a single path';
  const day = `${run.asOfDate} (${run.balancesSealed ? 'a sealed day' : 'an open day, not sealed'})`;
  return `${engine.name}, ${size}. Assumptions version ${run.assumptionsVersion}, engine ${run.engineVersion}. Starting balances from ${day}.`;
}
