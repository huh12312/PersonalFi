// SPDX-License-Identifier: MIT
/**
 * The deterministic projection's Money-facing entry point.
 *
 * Three lines, on purpose: convert once (`toEnginePlan`), run the interior
 * (`runDeterministic` → `stepYear`, the step WP 4.5 shares), convert back once
 * (`toProjectionResult`). It lives in its own file so `deterministic.ts` stays
 * pure interior — no import of the boundary, and therefore no import cycle
 * between the recursion and the module that owns its units.
 *
 * `display` is a presentation toggle: it chooses which series fills
 * `displayedEndWealth`. It never reaches the recursion and it changes nothing
 * in `years`, which is the real series WP 4.6 stores.
 */
import {
  toEnginePlan,
  toProjectionResult,
  type AssumptionsLike,
  type DisplayBasis,
  type ProjectionPlan,
  type ProjectionResult,
} from './boundary.ts';
import { preparePlan, runDeterministic } from './deterministic.ts';

export interface ProjectOptions {
  readonly display?: DisplayBasis;
}

export function projectDeterministic(
  plan: ProjectionPlan,
  assumptions: AssumptionsLike,
  options: ProjectOptions = {},
): ProjectionResult {
  const prepared = preparePlan(toEnginePlan(plan, assumptions));
  const path = runDeterministic(prepared);
  return toProjectionResult(path, prepared, plan, assumptions, options.display ?? 'real');
}
