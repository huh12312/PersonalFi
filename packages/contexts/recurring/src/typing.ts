// SPDX-License-Identifier: MIT
/**
 * Stream typing (07 §2.3's table), and the reasons a stream is refused the word
 * "subscription".
 *
 * | Type | Cadence score | Amount model | Example |
 * |---|---|---|---|
 * | `SUBSCRIPTION`      | ≥ 0.75 | FIXED    | Netflix $17.99/mo |
 * | `RECURRING_BILL`    | ≥ 0.70 | VARIABLE | PG&E, water, phone |
 * | `RECURRING_INCOME`  | ≥ 0.70 | any, inflow | paycheck |
 * | `LOAN_PAYMENT`      | ≥ 0.70 | FIXED    | mortgage autopay |
 * | `FREQUENT_MERCHANT` | < 0.70 | any      | coffee 3×/week — **never** a subscription |
 * | `ONE_OFF`           | n/a    | n/a      | everything else |
 *
 * ## Why a ceiling, and why a merchant class
 *
 * A $2,400 fixed monthly outflow is a mortgage. It has *exactly* the shape of a
 * subscription — the same cadence score, the same amount model, the same
 * regularity — and no arrangement of dates and amounts will ever separate them.
 * Pretending the shape is enough is how the adversarial set of 07 §2.12 eats a
 * detector alive. Two independent defences, either of which is sufficient:
 *
 *  * **`MerchantFacts.class`** — what the caller already knows: this payee is a
 *    loan servicer, a P2P app, a tax authority, a retailer. This is the *right*
 *    answer, and it is the caller's to supply.
 *  * **`subscriptionMonthlyCeiling`** — the shape-only backstop, defaulting to
 *    $1,000 of monthly-equivalent cost, because no consumer subscription costs
 *    that. It exists because the class will sometimes be `UNKNOWN`, and
 *    `golden-streams.test.ts` runs the whole adversarial corpus a second time
 *    with **every class forced to `UNKNOWN`** to prove the backstop alone still
 *    holds the line.
 *
 * Both record a named `StreamSuppression`, so the UI can answer "why is my
 * mortgage not listed as a subscription?" without anybody reading this file.
 */

import type { Money } from '@core/kernel';
import { periodsPerYear } from './cadence.ts';
import type {
  AmountModel,
  CadenceOrUnknown,
  MerchantClass,
  Sign,
  StreamSuppression,
  StreamType,
} from './types.ts';

/** 07 §2.3: below this a stream is a habit, not a schedule. */
export const RECURRING_FLOOR = 0.7;
export const SUBSCRIPTION_FLOOR = 0.75;
/** A merchant seen this often with no schedule is a `FREQUENT_MERCHANT`. */
export const FREQUENT_MERCHANT_MIN_OCCURRENCES = 4;
/** $1,000/month equivalent, in minor units of the stream's currency. */
export const DEFAULT_SUBSCRIPTION_MONTHLY_CEILING_MAJOR = 1_000n;

export interface TypingInputs {
  readonly sign: Sign;
  readonly cadence: CadenceOrUnknown;
  readonly cadenceScore: number;
  readonly amountModel: AmountModel;
  readonly typicalAmount: Money;
  readonly occurrences: number;
  readonly merchantClass: MerchantClass;
  /** This merchant also has an outflow stream, so an inflow is a refund. */
  readonly hasOutflowSibling: boolean;
  readonly subscriptionMonthlyCeilingMinor: bigint;
}

export interface TypingOutcome {
  readonly type: StreamType;
  readonly suppressions: readonly StreamSuppression[];
}

function magnitude(value: bigint): bigint {
  return value < 0n ? -value : value;
}

/** What this stream costs per month, whatever its cadence. Exact integer maths. */
export function monthlyEquivalentMinor(amount: Money, cadence: CadenceOrUnknown): bigint {
  if (cadence === 'UNKNOWN') return magnitude(amount.minor);
  return (magnitude(amount.minor) * BigInt(periodsPerYear(cadence))) / 12n;
}

export function typeStream(inputs: TypingInputs): TypingOutcome {
  const suppressions: StreamSuppression[] = [];

  if (inputs.occurrences < 2 || inputs.cadence === 'UNKNOWN') {
    suppressions.push({
      reason: 'too_few_occurrences',
      detail: `${inputs.occurrences} occurrence(s); a schedule needs at least two`,
    });
    return { type: 'ONE_OFF', suppressions };
  }

  if (inputs.cadenceScore < RECURRING_FLOOR) {
    suppressions.push({
      reason: 'cadence_below_recurring_floor',
      detail: `cadence score ${inputs.cadenceScore.toFixed(3)} < ${RECURRING_FLOOR}`,
    });
    return {
      type:
        inputs.occurrences >= FREQUENT_MERCHANT_MIN_OCCURRENCES ? 'FREQUENT_MERCHANT' : 'ONE_OFF',
      suppressions,
    };
  }

  if (inputs.sign === 'INFLOW') {
    if (inputs.merchantClass !== 'PAYROLL' && inputs.hasOutflowSibling) {
      suppressions.push({
        reason: 'refund_side_of_outflow_stream',
        detail: 'this merchant also bills the account; inflows here are refunds, not income',
      });
      return { type: 'ONE_OFF', suppressions };
    }
    return { type: 'RECURRING_INCOME', suppressions };
  }

  if (inputs.merchantClass === 'LOAN') {
    suppressions.push({
      reason: 'merchant_class_loan',
      detail: 'the caller classifies this payee as a loan servicer',
    });
    return { type: 'LOAN_PAYMENT', suppressions };
  }

  if (inputs.merchantClass === 'TAX') {
    suppressions.push({
      reason: 'merchant_class_tax',
      detail: 'the caller classifies this payee as a tax authority',
    });
    return { type: 'RECURRING_BILL', suppressions };
  }

  if (inputs.merchantClass === 'UTILITY') {
    // 07 §2.3 files utilities as RECURRING_BILL whatever their amount model: a
    // flat-rate internet plan is still a utility, and the insight catalogue
    // treats "cancel it" advice very differently for the two.
    suppressions.push({
      reason: 'merchant_class_utility',
      detail: 'the caller classifies this payee as a utility',
    });
    return { type: 'RECURRING_BILL', suppressions };
  }

  if (inputs.merchantClass === 'P2P') {
    suppressions.push({
      reason: 'merchant_class_p2p',
      detail: 'a person-to-person payment app is a conduit, not a service',
    });
    return { type: 'RECURRING_BILL', suppressions };
  }

  if (inputs.merchantClass === 'RETAIL') {
    // A shop you choose to visit weekly is a habit with a schedule, not a bill.
    // 07 §2.3 keys `FREQUENT_MERCHANT` on the cadence score alone; that misses
    // the grocery run that really is every Saturday at 10am, which scores like a
    // subscription and is nothing of the kind.
    suppressions.push({
      reason: 'merchant_class_retail',
      detail: 'the caller classifies this payee as retail; a habit, not a bill',
    });
    return {
      type:
        inputs.occurrences >= FREQUENT_MERCHANT_MIN_OCCURRENCES ? 'FREQUENT_MERCHANT' : 'ONE_OFF',
      suppressions,
    };
  }

  const monthly = monthlyEquivalentMinor(inputs.typicalAmount, inputs.cadence);
  if (monthly > inputs.subscriptionMonthlyCeilingMinor) {
    suppressions.push({
      reason: 'amount_above_subscription_ceiling',
      detail: `${monthly} minor units per month exceeds the ${inputs.subscriptionMonthlyCeilingMinor} ceiling`,
    });
    return { type: 'RECURRING_BILL', suppressions };
  }

  if (inputs.amountModel === 'IRREGULAR') {
    suppressions.push({
      reason: 'amount_model_irregular',
      detail: 'amounts vary too much for a priced plan',
    });
    return { type: 'RECURRING_BILL', suppressions };
  }

  if (inputs.amountModel === 'FIXED' && inputs.cadenceScore >= SUBSCRIPTION_FLOOR) {
    return { type: 'SUBSCRIPTION', suppressions };
  }

  return { type: 'RECURRING_BILL', suppressions };
}

/** Types that mean "this will happen again" — the set the P/R harness scores. */
export const RECURRING_TYPES: ReadonlySet<StreamType> = new Set<StreamType>([
  'SUBSCRIPTION',
  'RECURRING_BILL',
  'RECURRING_INCOME',
  'LOAN_PAYMENT',
]);
