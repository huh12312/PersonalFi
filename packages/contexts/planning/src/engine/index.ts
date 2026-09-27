// SPDX-License-Identifier: MIT
/**
 * The projection engine's public surface (WP 4.4). `src/index.ts` re-exports
 * this with one `export * from './engine/index.ts'` line.
 *
 * Two audiences:
 *
 *   * **Money callers** (WP 4.6's service, WP 4.8's routes): `projectDeterministic`
 *     and `solveRequiredSavings`, which take `Money` / `DateOnly` / decimal
 *     strings and return `Money` — never a float.
 *   * **WP 4.5's Monte Carlo**, which must run *this* recursion rather than a
 *     second one: `toEnginePlan` + `preparePlan` once, then `newPathState` and
 *     `stepYear` per path and year with drawn `MarketYear`s, then
 *     `fromEngineAmount` for whatever re-enters as Money.
 */
export {
  DEFAULT_WITHDRAWAL_ORDER,
  MAX_PLAN_AGE,
  PROJECTION_BUCKETS,
  ProjectionInputRefused,
  ageOn,
  fromEngineAmount,
  fromEngineRatio,
  isProjectionInputRefused,
  socialSecurityRulesFrom,
  toEngineAmount,
  toEnginePlan,
  toEngineRate,
  wholeYearsFrom,
  type AssumptionsLike,
  type BucketPlan,
  type ClaimAge,
  type DisplayBasis,
  type EngineDollars,
  type GlidepathChoice,
  type IncomePlan,
  type PensionColaChoice,
  type PensionPlan,
  type ProjectionBucket,
  type ProjectionBucketYear,
  type ProjectionPlan,
  type ProjectionRefusalCode,
  type ProjectionResult,
  type ProjectionYear,
  type SocialSecurityPlan,
  type SocialSecuritySummary,
  type WithdrawalPolicyChoice,
} from './boundary.ts';
export {
  ENGINE_VERSION,
  NO_EXTRA,
  expectedMarket,
  newPathState,
  preparePlan,
  realRate,
  runDeterministic,
  runPath,
  stepYear,
  type EnginePlan,
  type EnginePolicy,
  type ExtraContribution,
  type MarketYear,
  type PathResult,
  type PathState,
  type PreparedPlan,
  type YearRecord,
} from './deterministic.ts';
export {
  AGE_BASED_RULE,
  RISING_EQUITY_RULE,
  TARGET_DATE_KNOTS,
  TARGET_DATE_SOURCE,
  glidepathFunction,
  type EngineGlidepath,
  type GlidepathFunction,
} from './glidepath.ts';
export {
  GUYTON_KLINGER,
  decisionNames as guardrailDecisionNames,
  type GuardrailRules,
} from './guardrails.ts';
export { projectDeterministic, type ProjectOptions } from './project.ts';
export {
  MAX_ITERATIONS as SOLVE_MAX_ITERATIONS,
  solveRequiredSavings,
  type BindingConstraint,
  type RequiredSavingsObjective,
  type RequiredSavingsRequest,
  type RequiredSavingsResult,
} from './solve.ts';

// --- WP 4.5: the Monte Carlo, run in a worker_thread ----------------------------
// Money callers use the worker-host entry points (envelope → worker → Money);
// the kernel's own exports are for the stored run's metadata and byte form.
export { type ReturnSeries } from './bootstrap.ts';
export {
  DEFAULT_PATHS as MONTE_CARLO_DEFAULT_PATHS,
  MONTE_CARLO_VERSION,
  PERCENTILE_LEVELS as MONTE_CARLO_PERCENTILE_LEVELS,
  serialiseResult as serialiseMonteCarloResult,
  type EngineKind as MonteCarloEngineKind,
  type MonteCarloResult,
} from './montecarlo.ts';
export {
  DEFAULT_DEADLINE_MS as MONTE_CARLO_DEADLINE_MS,
  DEFAULT_SOLVE_DEADLINE_MS as MONTE_CARLO_SOLVE_DEADLINE_MS,
  DEFAULT_SUCCESS_TARGET,
  MONTE_CARLO_ENVELOPE,
  MonteCarloRefused,
  MonteCarloTimeout,
  MonteCarloWorkerFailed,
  WORKER_RESOURCE_LIMITS as MONTE_CARLO_RESOURCE_LIMITS,
  runMonteCarloInWorker,
  solveProbabilityInWorker,
  toMonteCarloJob,
  toMonteCarloSummary,
  type HostOptions as MonteCarloHostOptions,
  type MonteCarloRefusalCode,
  type MonteCarloRequest,
  type MonteCarloRun,
  type MonteCarloSummary,
  type MoneyBand,
  type ProbabilitySavingsRequest,
  type ProbabilitySavingsResult,
  type SequenceDecile,
} from './worker-host.ts';
// The historical series: fetched on first run and checksum-pinned, never vendored
// (data/returns/PROVENANCE.md). The composition root decides whether a download is allowed.
export {
  FETCH_COMMAND as RETURN_SERIES_FETCH_COMMAND,
  ReturnSeriesRefused,
  ensureReturnSeries,
  loadReturnSeries,
  type EnsureOptions as ReturnSeriesOptions,
  type ReturnSeriesRefusalCode,
} from '../../data/returns/series.ts';
