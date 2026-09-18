// SPDX-License-Identifier: MIT
/**
 * The engine's vocabulary: what goes in, what comes out, and nothing else.
 *
 * ## What the engine is allowed to know (decision D25)
 *
 * A `merchants` row means "a payee was involved". `@ctx/ledger` decides that,
 * with a named, enumerable gate, and the answer is a `merchantId`. **This engine
 * receives that id and never a descriptor.** There is no `payee`, no
 * `merchantName`, no `rawDescriptor` and no normalisation step anywhere under
 * `src/`: `test/no-merchant-writes.test.ts` asserts it three ways, including by
 * running a whole detection pass with every input behind a `Proxy` that throws
 * if the engine reads a key the contract does not name.
 *
 * That is not fastidiousness. A detector that minted merchant identity from
 * descriptors would put `TRANSFER TO SAVINGS` and `CHECK 1234` back into the
 * merchant table — as *subscriptions*, with budget lines and price-change
 * alerts hanging off them — and would do it silently.
 *
 * ## What the engine cannot know from shape alone
 *
 * A $2,400 fixed monthly outflow is a mortgage, and it has exactly the shape of
 * a subscription. Nothing in the dates or the amounts distinguishes them, so
 * pretending otherwise would be dishonest. Two defences, both declared here:
 * `MerchantFacts.class` (what the *caller* knows about the payee — a loan
 * servicer, a P2P app, a retailer) and `subscriptionMonthlyCeiling` (no consumer
 * subscription costs $1,000/month). Each one is recorded on the stream as a
 * named `StreamSuppression`, so "why is my mortgage not a subscription?" has an
 * answer that is not "read the thresholds".
 */

import type { DateOnly, Money } from '@core/kernel';

/** The eight cadences of 07 §2.3, plus the honest answer. */
export type Cadence =
  | 'WEEKLY'
  | 'BIWEEKLY'
  | 'SEMIMONTHLY'
  | 'MONTHLY'
  | 'BIMONTHLY'
  | 'QUARTERLY'
  | 'SEMIANNUAL'
  | 'ANNUAL';

export type CadenceOrUnknown = Cadence | 'UNKNOWN';

/** 07 §2.3 amount model. `IRREGULAR` is never a subscription. */
export type AmountModel = 'FIXED' | 'VARIABLE' | 'IRREGULAR';

/**
 * 07 §2.3 stream typing, plus `LOAN_PAYMENT` (07 §2.12's adversarial set asks
 * for it by name: "mortgage/auto-pay — recurring but should be typed
 * LOAN_PAYMENT, not SUBSCRIPTION").
 */
export type StreamType =
  | 'SUBSCRIPTION'
  | 'RECURRING_BILL'
  | 'RECURRING_INCOME'
  | 'LOAN_PAYMENT'
  | 'FREQUENT_MERCHANT'
  | 'ONE_OFF';

/** 07 §2.4 (`EARLY_DETECTION`) and §2.8 (the dormancy ladder). */
export type StreamStatus =
  'EARLY_DETECTION' | 'ACTIVE' | 'AT_RISK' | 'MIGRATED' | 'LIKELY_CANCELED' | 'CANCELED';

export type Sign = 'OUTFLOW' | 'INFLOW';

/**
 * What the caller knows about a payee, expressed without naming it.
 *
 * `class` feeds 07 §2.4's `merchant_prior` (x4) *and* gates stream typing.
 * `serviceNode` is a node in 07 §2.9's taxonomy (`media/video`, `cloud/storage`)
 * — a taxonomy key, not a merchant name; the engine only ever compares two of
 * them for equality.
 */
export type MerchantClass =
  'SUBSCRIPTION' | 'UTILITY' | 'LOAN' | 'TAX' | 'P2P' | 'RETAIL' | 'PAYROLL' | 'UNKNOWN';

export interface MerchantFacts {
  readonly class: MerchantClass;
  /** 07 §2.9 service-taxonomy node, e.g. `'media/video'`. */
  readonly serviceNode?: string | null;
  /**
   * 07 §2.9 refinement (a): this price matches a known bundle SKU
   * (Disney+/Hulu/ESPN), so a duplicate-service finding would be wrong.
   */
  readonly bundleSku?: string | null;
  /** 07 §2.9 refinement (b): the user said this one is for somebody else. */
  readonly forSomeoneElse?: boolean;
}

/**
 * One ledger row, as the engine sees it.
 *
 * WP 2.3 adapts `@ctx/ledger` rows into this through a port; `@ctx/recurring`
 * never imports the ledger (the boundary lint enforces it). Every field here is
 * a fact about *shape*, not about identity — except `merchantId`, which is the
 * identity the ledger already decided.
 */
export interface RecurringInput {
  readonly transactionId: string;
  /** D25 merchant identity. Rows whose identity was refused are not passed in. */
  readonly merchantId: string;
  readonly accountId: string;
  /** House sign convention: negative = outflow, positive = inflow. */
  readonly amount: Money;
  /** The date the stream is anchored on — the ledger's budget date. */
  readonly date: DateOnly;
  /** Pending rows are dropped: the posted row arrives later with its own id. */
  readonly pending: boolean;
  /** Paired internal transfers are not spending and never a subscription. */
  readonly isTransfer: boolean;
}

/** One matched hit on a stream's schedule. */
export interface Occurrence {
  readonly transactionId: string;
  readonly accountId: string;
  readonly date: DateOnly;
  readonly amount: Money;
  /** Signed days from the predicted slot; `null` when the slot is unexplained. */
  readonly residualDays: number | null;
  /** A second charge on a date the schedule already explains (07 §2.12). */
  readonly duplicateOf: string | null;
}

/** Why this stream is not the thing its shape suggests. Precision, made legible. */
export interface StreamSuppression {
  readonly reason:
    | 'merchant_class_loan'
    | 'merchant_class_tax'
    | 'merchant_class_p2p'
    | 'merchant_class_utility'
    | 'merchant_class_retail'
    | 'amount_above_subscription_ceiling'
    | 'amount_model_irregular'
    | 'cadence_below_recurring_floor'
    | 'refund_side_of_outflow_stream'
    | 'too_few_occurrences';
  readonly detail: string;
}

export interface NextDue {
  readonly date: DateOnly;
  /** 07 §2.5: `ceil(1.5 × MAD(residuals))`, clamped to `[1, tolerance]`. */
  readonly uncertaintyDays: number;
  readonly expectedAmount: Money;
}

export interface PriceChange {
  readonly streamKey: string;
  readonly direction: 'INCREASE' | 'DECREASE';
  readonly effectiveDate: DateOnly;
  readonly from: Money;
  readonly to: Money;
  readonly delta: Money;
  /** `delta × periodsPerYear(cadence)`. Exact bigint arithmetic. */
  readonly annualImpact: Money;
  /**
   * 07 §2.6's guard: a change is P1 only once the *next* occurrence confirms it,
   * unless the jump is larger than 15% of the baseline.
   */
  readonly confirmed: boolean;
  readonly priorTransactionIds: readonly string[];
  readonly recentTransactionIds: readonly string[];
}

/** 07 §2.2: a card was reissued; propose the merge *before* crying cancellation. */
export interface MergeProposal {
  readonly reason: 'CARD_MIGRATION';
  readonly fromAccountId: string;
  readonly toAccountId: string;
  readonly gapDays: number;
  /** 07 §2.2: `confidence *= 0.9` for a proposed, unconfirmed merge. */
  readonly confidenceFactor: number;
  readonly segmentKeys: readonly string[];
}

export interface RecurringStream {
  /**
   * Deterministic and content-derived: `merchantId:sign:currency:bucket`. The
   * engine mints no uuids — identity is WP 2.3's to assign and persist.
   */
  readonly streamKey: string;
  readonly merchantId: string;
  readonly sign: Sign;
  readonly currency: string;
  readonly accountIds: readonly string[];
  readonly transactionIds: readonly string[];
  readonly occurrences: readonly Occurrence[];

  readonly cadence: CadenceOrUnknown;
  /** 07 §2.3 `score_cadence`, normalised so a flawless schedule scores 1.0. */
  readonly cadenceScore: number;
  readonly anchorDate: DateOnly;
  /** Set only for `SEMIMONTHLY`: the two days of the month that host it. */
  readonly dayOfMonthPair: readonly [number, number] | null;

  readonly amountModel: AmountModel;
  readonly typicalAmount: Money;
  readonly amountMad: Money;
  /** Coefficient of variation. A float, and it never reaches a `*_minor` value. */
  readonly amountCv: number;

  readonly type: StreamType;
  readonly status: StreamStatus;
  readonly confidence: number;
  /** 07 §2.4: an `EARLY_DETECTION` stream never drives a `$`-impact insight. */
  readonly eligibleForImpact: boolean;

  readonly firstSeen: DateOnly;
  readonly lastSeen: DateOnly;
  readonly missedPeriods: number;
  readonly coverage: number;
  readonly nextDue: NextDue | null;

  readonly priceChanges: readonly PriceChange[];
  readonly mergeProposal: MergeProposal | null;
  readonly suppressions: readonly StreamSuppression[];
}

export interface DuplicateServiceFinding {
  readonly kind: 'SAME_SERVICE' | 'CROSS_SERVICE';
  /** The taxonomy node, or the shared `merchantId` for a same-service pair. */
  readonly node: string;
  readonly streamKeys: readonly string[];
  /** 07 §2.9: the sum of all but the cheapest, annualised. */
  readonly annualImpact: Money;
}

export interface DetectionDiagnostics {
  readonly inputs: number;
  readonly skippedPending: number;
  readonly skippedTransfers: number;
  readonly coarseGroups: number;
  readonly amountBuckets: number;
  readonly streams: number;
  readonly today: DateOnly;
}

export interface DetectionResult {
  readonly streams: readonly RecurringStream[];
  readonly priceChanges: readonly PriceChange[];
  readonly duplicateServices: readonly DuplicateServiceFinding[];
  readonly diagnostics: DetectionDiagnostics;
}
