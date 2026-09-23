// SPDX-License-Identifier: MIT
/**
 * `@ctx/planning` — Planning.
 *
 * Goals, assumptions, scenarios, deterministic projection, and Monte Carlo are
 * Phase 4. What exists today is WP 3.8: **the sole writer of the
 * `net_worth_daily` read model**, which is why that table lives here even
 * though every one of its inputs comes from Ledger or Investments.
 *
 * This file is the context's *only* public surface. Everything else under
 * `src/` is internal, and no other context may import from it.
 *
 * ## What WP 3.8 ships
 *
 *   * `computeNetWorth(ports, …)` — one day, every account, **four independent
 *     totals** over 07 §4.1's four booleans, with a per-account breakdown
 *     carrying D4's native amount, base amount, `fxRate` and `fxRateDate`.
 *   * `runSnapshot(executor, ports, context)` — seal what has closed, recompute
 *     the one day that may still move, emit `planning.NetWorthSnapshotTaken`.
 *   * The four ports it reads its world through (`src/ports.ts`), declared here
 *     and adapted in `apps/api/src/domain.ts`. This context holds no handle on
 *     `accounts`, `holdings`, `prices` or `fx_rates`.
 *   * The 04:00 job `planning.net_worth_snapshot` and the consumer that marks
 *     today dirty when a balance, a holding or a price lands.
 *
 * ## Three rules travel with the surface, because every caller inherits them
 *
 *   * **A sealed day is never updated.** 08 §3.5. A correction is a new
 *     revision carrying `supersedes_id` and `correction_reason`; `correctDay`
 *     is the only path, and there is no unguarded update anywhere in `src/`.
 *   * **A missing FX rate is `FxRateUnavailable`, never 1.0.** D4 and 08 §6.6.
 *     It propagates out of `computeNetWorth` and the day is not written for
 *     that account — a plausible par conversion would be wrong by the whole
 *     spread and invisible.
 *   * **An investment account is never backfilled by transaction subtraction.**
 *     04 §5.4. `INTERPOLATION_POLICY` is the statement of the rule and
 *     `InterpolationRefused` is what enforces it.
 */

/** Stable identifier used by feature flags (`module.planning`) and event metadata. */
export const CONTEXT_ID = 'planning' as const;

// --- events ----------------------------------------------------------------
export { NetWorthSnapshotTaken, PLANNING_EVENTS } from './events.ts';

// --- the ports the composition root implements -----------------------------
export {
  ACCOUNT_KINDS,
  defaultFlagsFor,
  type AccountFlags,
  type AccountKind,
  type AccountSide,
  type BalanceObservation,
  type BalancesReader,
  type FxQuote,
  type FxReader,
  type HoldingObservation,
  type HoldingsReader,
  type PlanningAccount,
  type PriceQuote,
  type PriceReader,
  type SnapshotPorts,
} from './ports.ts';

// --- the aggregate ---------------------------------------------------------
export {
  computeNetWorth,
  type BreakdownEntry,
  type ComputeInput,
  type NetWorthSnapshot,
  type UnvaluedAccount,
  type ValuationMethod,
} from './net-worth.ts';

// --- D4 on the aggregate ---------------------------------------------------
export {
  FxRateUnavailable,
  assertRateIsAnObservation,
  convertToBase,
  isFxRateUnavailable,
  type ConvertedAmount,
} from './fx.ts';

// --- 04 §5.4's interpolation policy ----------------------------------------
export {
  INTERPOLATION_METHODS,
  INTERPOLATION_POLICY,
  InterpolationRefused,
  backfillByTransactionSubtraction,
  interpolateQuantity,
  methodFor,
  type InterpolatedQuantity,
  type InterpolationMethod,
} from './interpolate.ts';

// --- 08 §3.5's seal --------------------------------------------------------
export {
  SEAL_HOUR_LOCAL,
  SealedRowImmutable,
  assertSealable,
  isSealable,
  localHourIn,
  openDateIn,
  sealableDates,
} from './seal.ts';

// --- persistence (this context's own table, and nobody else's) -------------
export {
  currentRow,
  markDirty,
  openDays,
  platformOf,
  readSeries,
  sealDay,
  upsertOpenDay,
  writeCorrection,
  type NetWorthRow,
  type PlanningDatabase,
  type PlanningExecutor,
} from './store.ts';

// --- the snapshotter -------------------------------------------------------
export { correctDay, runSnapshot, type SnapshotContext, type SnapshotResult } from './snapshot.ts';

// --- wiring: the consumer, the job, the schedule ---------------------------
export {
  CONSUMED_EVENT_TYPES as NET_WORTH_CONSUMED_EVENT_TYPES,
  CONSUMER_NAME as NET_WORTH_CONSUMER_NAME,
  createNetWorthConsumer,
  type PlanningConsumerOptions,
} from './consumer.ts';
export {
  SNAPSHOT_CRON,
  SNAPSHOT_JOB_KIND,
  SNAPSHOT_SCHEDULE_NAME,
  netWorthSnapshotJobHandler,
  registerNetWorthSnapshotSchedule,
  type SnapshotJobDependencies,
} from './jobs.ts';
