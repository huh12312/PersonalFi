// SPDX-License-Identifier: MIT
/**
 * `@ctx/budgeting` — Envelope-lite budgeting.
 *
 * Zero-based envelope math (07 §1.2–1.3) with rollover on, auto-assigned from
 * targets and non-nagging. The envelope ledger is the *substrate*, not one mode
 * among four: 07 §1.9 makes the case in one line — "you can render a target-only
 * UI on top of it; you cannot render an envelope UI on top of a target-only
 * ledger" — so `budgets.mode` changes presentation and auto-assign
 * aggressiveness and nothing else, and 50/30/20 is a derived layer over the same
 * rows rather than a second ledger.
 *
 * This file is the context's *only* public surface. Everything else under
 * `src/` is internal, and no other context may import from it.
 *
 * ## Wiring
 *
 * One entry in `apps/api/src/modules.ts` and one adapter in
 * `apps/api/src/domain.ts`; the exact lines are in
 * `docs/evidence/phase-2/wp2.1-budgeting.md` §7.
 *
 * ```ts
 * {
 *   flagKey: 'module.budgeting',
 *   events: BUDGETING_EVENTS,
 *   consumers: [
 *     createBudgetingConsumer({ database, port: createBudgetingLedgerPort(database) }),
 *   ],
 * }
 * ```
 *
 * ## The two invariants
 *
 * Identity I (07 §1.2, corrected — see `src/rta.ts` for the derivation):
 *
 * ```
 * Σ_{kind='category'} available(c, p) + RTA(p) + Σ_{p'>p} assigned = Σ_{on-budget} balance(a)
 * ```
 *
 * Identity II (this work package's, and the one with independent sides):
 *
 * ```
 * owed(card) = available(CCP[card]) + unfundedDebt(CCP[card])
 * ```
 *
 * Both are asserted inside the recompute transaction, before anything is
 * written: a budget that has noticed its own arithmetic is wrong fails loudly
 * and persists nothing.
 */

/** Stable identifier used by feature flags (`module.budgeting`) and event metadata. */
export const CONTEXT_ID = 'budgeting' as const;

// --- events ----------------------------------------------------------------
export {
  BUDGETING_EVENTS,
  BudgetLineAssigned,
  BudgetPeriodOpened,
  BudgetPeriodRolled,
  BudgetThresholdCrossed,
  ReadyToAssignChanged,
} from './events.ts';

// --- the consumer ----------------------------------------------------------
export {
  CONSUMED_EVENT_TYPES,
  CONSUMER_NAME,
  createBudgetingConsumer,
  transactionIdsOf,
} from './consumer.ts';

// --- the port (and its fake) -----------------------------------------------
export {
  createFakeLedger,
  onBudgetBalances,
  streamForBudget,
  type AccountRole,
  type BudgetAccount,
  type BudgetTransaction,
  type BudgetTransactionPage,
  type FakeLedger,
  type LedgerPort,
  type ListForBudgetInput,
} from './ledger-port.ts';

// --- the pure math ---------------------------------------------------------
export {
  absorbedByRta,
  available,
  neededThisPeriod,
  rolloverOut,
  runEnvelope,
  underfunded,
  type AvailableInput,
  type CardEffect,
  type EnvelopeResult,
  type EnvelopeTransaction,
  type FundingSource,
  type GoalInput,
} from './envelope.ts';
export {
  applyCardEffects,
  cardIdentityHolds,
  type CardOpening,
  type CardPeriodInput,
  type CardPeriodResult,
} from './credit.ts';
export { identityHolds, readyToAssign, type ReadyToAssignInput } from './rta.ts';
export {
  contains,
  currentPeriod,
  generatePeriods,
  nextPeriod,
  periodContaining,
  periodsRemainingInclusive,
  previousPeriod,
  type PeriodBounds,
  type PeriodGridSettings,
} from './periods.ts';
export {
  planAutoAssign,
  toStayOnTrack,
  type AutoAssignCandidate,
  type AutoAssignEntry,
  type AutoAssignPlan,
} from './auto-assign.ts';
export { computeActuals, type ActualsInput, type ActualsResult, type LineActivity } from './actuals.ts';

// --- services --------------------------------------------------------------
export {
  assign,
  dirtyPeriods,
  markDirtyFrom,
  openPeriod,
  recomputeDirty,
  recomputePeriod,
  rollPeriod,
  runAutoAssign,
  type AssignInput,
  type BudgetingDependencies,
  type OpenPeriodInput,
  type RecomputeResult,
  type RollResult,
} from './service.ts';
export { createBudget, type CreateBudgetInput } from './budget.ts';

// --- read models -----------------------------------------------------------
export {
  cardIdentityTermsOf,
  getPeriod,
  identityTermsOf,
  listBudgets,
  listPeriods,
  type BudgetLineView,
  type BudgetPeriodSummary,
  type BudgetPeriodView,
  type CardIdentityTerm,
  type IdentityTerms,
} from './read.ts';

// --- plumbing --------------------------------------------------------------
export type { BudgetingContext, BudgetingDatabase, BudgetingExecutor } from './db.ts';
export { BudgetingError, isBudgetingError, type BudgetingErrorCode } from './errors.ts';
