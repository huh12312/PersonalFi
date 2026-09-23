// SPDX-License-Identifier: MIT
/**
 * WP 3.3 — portfolio analytics, pure.
 *
 * No database, no I/O, no clock: every function here takes explicit inputs —
 * dated valuations, external flows, classified holdings with their prices and
 * staleness, targets — and returns a value. That is what makes the whole
 * module testable against a committed spreadsheet, and what lets WP 3.9 serve
 * `/investments/allocation`, `/drift` and `/performance` without any of this
 * arithmetic living in a route handler.
 *
 * The four rules a reader should know before calling anything:
 *
 *   1. **A TWR, an MWR and a dollar gain are three different shapes**
 *      (`types.ts`), so no response object can pair a return with a dollar
 *      amount or hang a benchmark off a money-weighted return. 07 §4.2's rule,
 *      enforced by `tsc`.
 *   2. **Nothing annualises a period under one year** — `annualized` is `null`
 *      and `annualizationWithheld` says why.
 *   3. **`unclassifiedPct` comes back beside every allocation, drift, fee and
 *      concentration number**, present even when zero (07 §4.3, normative).
 *   4. **`unavailable` and `STALE` propagate.** A missing basis makes a gain
 *      unavailable rather than zero; a price older than 24 hours leaves an
 *      "as of now" allocation entirely, and is named in `excluded` rather than
 *      being counted at a stale number.
 */
export {
  ALLOCATION_DIMENSIONS,
  UNCLASSIFIED_KEYS,
  allocationBy,
  allocationByAssetClass,
  allocationByRegion,
  allocationBySector,
  allocationOf,
  allocationReport,
  assertScaleMatches,
  totalWeightOf,
  valueHoldings,
  weightOf,
  type AllocationDimension,
  type AllocationReport,
  type AllocationSlice,
  type ValuationSet,
  type ValuedHolding,
} from './allocation.ts';

export {
  IDLE_CASH_ACCOUNT_SHARE,
  IDLE_CASH_FLOOR_MINOR,
  IDLE_CASH_MIN_DAYS,
  cashByAccount,
  cashWeightOf,
  idleCash,
  valueByAccount,
  type CashPosition,
  type IdleCashReport,
  type IdleCashRow,
} from './cash.ts';

export {
  CONCENTRATION_TRIGGER,
  EMPLOYER_STOCK_TRIGGER,
  concentration,
  concentrationOf,
  type ConcentrationReport,
  type SecurityPosition,
} from './concentration.ts';

export {
  DRIFT_BAND_POINTS,
  NO_DRIFT,
  UNCLASSIFIED_NOISE_THRESHOLD,
  driftAgainstTargets,
  type AllocationTarget,
  type DriftDirection,
  type DriftReport,
  type DriftRow,
  type RebalanceProposal,
} from './drift.ts';

export { HIGH_EXPENSE_RATIO, feeDrag, feeDragOf, type FeeDragReport, type FeeRow } from './fees.ts';

export { cashFlowsOf, moneyWeightedReturn, type MwrInput } from './mwr.ts';

export {
  annualizedOf,
  modifiedDietzReturn,
  timeWeightedReturn,
  type DatedValuation,
  type ExternalFlow,
  type TwrInput,
  type TwrOptions,
} from './twr.ts';

export {
  ANNUALIZATION_WITHHELD_REASONS,
  AnalyticsInputError,
  DAYS_PER_YEAR,
  EXCLUSION_REASONS,
  GAIN_UNAVAILABLE_REASONS,
  MAX_DECIMAL_EXPONENT,
  MIN_ANNUALIZATION_DAYS,
  MWR_UNAVAILABLE_REASONS,
  POINTS_SCALE,
  POINTS_ZERO,
  RATIO_ONE,
  RATIO_SCALE,
  RATIO_ZERO,
  TWR_WARNING_CODES,
  UNKNOWN_BASIS_PORTFOLIO_WARNING,
  UNKNOWN_PRICE_PORTFOLIO_WARNING,
  absolutePoints,
  addRatio,
  annualizationWithheldFor,
  compareRatio,
  comparePoints,
  decimalPow,
  growthFactor,
  multiplyRatio,
  points,
  pointsBetween,
  pointsToNumberApproximate,
  portfolioDollarGain,
  ratio,
  ratioOfMoney,
  ratioOfQuotient,
  ratioToNumberApproximate,
  ratioToPoints,
  roundDecimalString,
  scaleMoney,
  subtractRatio,
  sumRatios,
  yearsBetween,
  type AnalyticsHolding,
  type AnalyticsWarning,
  type AnnualizationWithheldReason,
  type DollarGain,
  type ExcludedHolding,
  type ExclusionReason,
  type GainUnavailableReason,
  type MoneyWeightedReturn,
  type MwrUnavailableReason,
  type PerformanceReport,
  type Points,
  type Ratio,
  type SubPeriodReturn,
  type TimeWeightedReturn,
  type TwrWarningCode,
  type ValuationBasis,
  type ValuationOptions,
  type ValuedPosition,
  type XirrDiagnostics,
  type XirrSolver,
} from './types.ts';

export {
  XIRR_BRACKET_HIGH,
  XIRR_BRACKET_LOW,
  XIRR_DEFAULT_GUESS,
  XIRR_DERIVATIVE_STEP,
  XIRR_MAX_BISECTION_ITERATIONS,
  XIRR_MAX_ITERATIONS,
  XIRR_TOLERANCE,
  newtonOnly,
  npvOf,
  xirr,
  type DatedCashFlow,
  type NewtonOnlyResult,
  type XirrOptions,
  type XirrOutcome,
} from './xirr.ts';
