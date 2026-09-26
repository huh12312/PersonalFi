// SPDX-License-Identifier: MIT
/**
 * Contribution plans (WP 4.1): how much goes towards a goal, how often, and how
 * it steps up each year.
 *
 * **A plan, not a ledger.** What actually moved is `@ctx/ledger`'s, and the
 * rolling-12-month derivation of what *has* been contributed is WP 4.3's. A row
 * here says "$500 a month from March, rising 3% a year" and is either typed by
 * the holder (`USER`) or written from that derivation (`DERIVED`, with the
 * `as_of` of the window it was taken over — 09 GOAL-4 requires the difference
 * be visible).
 *
 * ## D3, at the one place a rate meets an amount
 *
 * `amount` is `Money`. `escalationPct` is a **decimal string** in percentage
 * points (`'3.25'` = 3.25% a year) and never a `number` — not at the API, not
 * in this module, not on the way to or from `NUMERIC(7,4)`. The only arithmetic
 * that combines the two is `escalatedAmount`, and it is exact:
 *
 *     amount × (1 + p/100)^n  =  amount × (10^k + u)^n / 10^(k·n)
 *
 * where `p = u / 10^(k−2)` is the percentage with its `k − 2` decimal places
 * written as the integer `u`. The factor is built as a decimal *string* of
 * `(10^k + u)^n` with the point placed `k·n` digits from the right, and handed
 * to `Money.multiplyByDecimal`, which rounds **once**, half-even. There is no
 * intermediate rounding per year, so year 30's amount does not carry 30 years
 * of accumulated cent drift, and no IEEE-754 double is ever formed —
 * `test/goals.test.ts`'s fast-check property is what holds that to be true
 * for amounts up to 10^15 minor units.
 */
import { DateOnly, Money, type Brand } from '@core/kernel';
import {
  CONTRIBUTION_CADENCES,
  CONTRIBUTION_SOURCES,
  type ContributionCadence,
  type ContributionSource,
} from '../schema/goals.ts';
import { PlanningError } from './errors.ts';

// ---------------------------------------------------------------------------
// The escalation rate
// ---------------------------------------------------------------------------

/** Percentage points as a canonical decimal string: `'3.25'`, `'0'`, `'100'`. */
export type EscalationPct = Brand<string, 'EscalationPct'>;

/** NUMERIC(7,4): at most three integer digits and four decimal places. */
const ESCALATION_PATTERN = /^(\d{1,3})(?:\.(\d{1,4}))?$/;

export const MAX_ESCALATION_PCT = '100';

/**
 * Parse and canonicalise an escalation rate.
 *
 * Takes `unknown` and refuses anything that is not a string **before** looking
 * at it, so a JSON body carrying `"escalationPct": 3.25` is a typed refusal and
 * not a value that happened to survive. Canonical form strips trailing
 * fractional zeros and leading integer zeros, so `'3.2500'` (what `NUMERIC(7,4)`
 * reads back as) and `'3.25'` are the same value and compare equal as strings.
 */
export function parseEscalationPct(value: unknown): EscalationPct {
  if (typeof value !== 'string') {
    throw new PlanningError(
      'planning.contribution_escalation_invalid',
      `escalation_pct must be a decimal string, got ${typeof value}; a number is refused ` +
        'rather than converted (D3)',
    );
  }
  const match = ESCALATION_PATTERN.exec(value.trim());
  if (match === null) {
    throw new PlanningError(
      'planning.contribution_escalation_invalid',
      `escalation_pct ${JSON.stringify(value)} is not a plain decimal with at most three ` +
        'integer digits and four decimal places',
    );
  }
  const integer = BigInt(match[1] ?? '0').toString();
  const fraction = (match[2] ?? '').replace(/0+$/, '');
  const canonical = fraction === '' ? integer : `${integer}.${fraction}`;
  const { unscaled, places } = unscaledOf(canonical);
  if (unscaled > 100n * 10n ** BigInt(places)) {
    throw new PlanningError(
      'planning.contribution_escalation_invalid',
      `escalation_pct ${canonical} exceeds ${MAX_ESCALATION_PCT} percentage points a year`,
    );
  }
  return canonical as EscalationPct;
}

function unscaledOf(canonical: string): { readonly unscaled: bigint; readonly places: number } {
  const [integer = '0', fraction = ''] = canonical.split('.');
  return { unscaled: BigInt(`${integer}${fraction}`), places: fraction.length };
}

/**
 * `(1 + p/100)^years` as an exact decimal string.
 *
 * With `p = u / 10^d` the factor is `(10^(d+2) + u)^years / 10^((d+2)·years)`.
 * The numerator is a `bigint`; the string places the decimal point. For the
 * widest case this module permits (four decimal places, 100 years) the
 * numerator has ~600 digits, which `bigint` does not notice.
 */
export function escalationFactor(escalationPct: EscalationPct, years: number): string {
  if (!Number.isSafeInteger(years) || years < 0 || years > 100) {
    throw new PlanningError(
      'planning.contribution_invalid',
      `years must be a whole number from 0 to 100, got ${String(years)}`,
    );
  }
  const { unscaled, places } = unscaledOf(escalationPct);
  const shift = places + 2;
  const base = 10n ** BigInt(shift) + unscaled;
  const numerator = (base ** BigInt(years)).toString();
  const decimals = shift * years;
  if (decimals === 0) return numerator;
  const padded = numerator.padStart(decimals + 1, '0');
  return `${padded.slice(0, padded.length - decimals)}.${padded.slice(padded.length - decimals)}`;
}

/**
 * The per-cadence amount after `years` whole years of escalation, exact until a
 * single half-even rounding to minor units.
 */
export function escalatedAmount(amount: Money, escalationPct: EscalationPct, years: number): Money {
  return Money.multiplyByDecimal(amount, escalationFactor(escalationPct, years), 'half-even');
}

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

/** Periods per year, as a `bigint` so an annual total is `Money.multiplyByInteger`. */
export const CADENCE_PERIODS_PER_YEAR: Readonly<Record<ContributionCadence, bigint>> =
  Object.freeze({
    weekly: 52n,
    biweekly: 26n,
    semimonthly: 24n,
    monthly: 12n,
    quarterly: 4n,
    annually: 1n,
  });

export interface ContributionPlanInput {
  readonly cadence: ContributionCadence;
  readonly amount: Money;
  /** Percentage points as a decimal string. Omitted means `'0'`. */
  readonly escalationPct?: unknown;
  readonly startsOn: string;
  readonly endsOn?: string | null;
  readonly source: ContributionSource;
  /** Required when `source` is `DERIVED`, refused when it is `USER`. */
  readonly derivedAsOf?: string | null;
}

export interface ContributionPlan {
  readonly id: string;
  readonly goalId: string;
  readonly cadence: ContributionCadence;
  readonly amount: Money;
  readonly escalationPct: EscalationPct;
  readonly startsOn: DateOnly;
  readonly endsOn: DateOnly | null;
  readonly source: ContributionSource;
  readonly derivedAsOf: DateOnly | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** A plan that has passed every check and is ready to be written. */
export type ValidContributionPlan = Omit<
  ContributionPlan,
  'id' | 'goalId' | 'createdAt' | 'updatedAt'
>;

function invalid(message: string): never {
  throw new PlanningError('planning.contribution_invalid', message);
}

function dateOf(field: string, value: unknown): DateOnly {
  if (typeof value !== 'string' || !DateOnly.is(value)) {
    invalid(`${field} must be a YYYY-MM-DD date`);
  }
  return value;
}

/**
 * Pure validation against the goal it funds. The amount must be in the goal's
 * own currency: a EUR plan against a USD goal is a
 * `planning.contribution_currency_mismatch`, never a conversion — which rate,
 * and as of when, is a projection question and not a storage one.
 */
export function validateContributionPlan(
  input: ContributionPlanInput,
  goal: { readonly target: Money },
): ValidContributionPlan {
  if (!CONTRIBUTION_CADENCES.includes(input.cadence)) {
    invalid(`cadence must be one of ${CONTRIBUTION_CADENCES.join(', ')}`);
  }
  if (!CONTRIBUTION_SOURCES.includes(input.source)) {
    invalid(`source must be one of ${CONTRIBUTION_SOURCES.join(', ')}`);
  }
  if (typeof input.amount.minor !== 'bigint') {
    invalid('amount must be Money with bigint minor units');
  }
  if (input.amount.minor <= 0n) invalid('a contribution amount must be positive');
  if (input.amount.currency !== goal.target.currency) {
    throw new PlanningError(
      'planning.contribution_currency_mismatch',
      `the plan is in ${input.amount.currency} and the goal is in ${goal.target.currency}`,
    );
  }
  const escalationPct = parseEscalationPct(input.escalationPct ?? '0');
  const startsOn = dateOf('startsOn', input.startsOn);
  const endsOn =
    input.endsOn === undefined || input.endsOn === null ? null : dateOf('endsOn', input.endsOn);
  if (endsOn !== null && DateOnly.isBefore(endsOn, startsOn)) {
    invalid(`endsOn ${endsOn} is before startsOn ${startsOn}`);
  }
  const hasAsOf = input.derivedAsOf !== undefined && input.derivedAsOf !== null;
  if (input.source === 'DERIVED' && !hasAsOf) {
    invalid('a DERIVED plan names the as_of of the window it was derived from');
  }
  if (input.source === 'USER' && hasAsOf) {
    invalid('a USER plan has no derivation date');
  }
  const derivedAsOf = hasAsOf ? dateOf('derivedAsOf', input.derivedAsOf) : null;
  return Object.freeze({
    cadence: input.cadence,
    amount: input.amount,
    escalationPct,
    startsOn,
    endsOn,
    source: input.source,
    derivedAsOf,
  });
}

/** Whole years from `startsOn` to `on`, counting a year only once its anniversary has passed. */
export function wholeYearsBetween(startsOn: DateOnly, on: DateOnly): number {
  if (DateOnly.isBefore(on, startsOn)) return 0;
  let years = DateOnly.year(on) - DateOnly.year(startsOn);
  if (DateOnly.isBefore(on, DateOnly.addYears(startsOn, years))) years -= 1;
  return Math.max(0, years);
}

/**
 * The per-cadence amount the plan calls for on a date, or `null` outside its
 * window. The step-up happens on each anniversary of `startsOn`.
 */
export function amountOn(
  plan: Pick<ContributionPlan, 'amount' | 'escalationPct' | 'startsOn' | 'endsOn'>,
  on: DateOnly,
): Money | null {
  if (DateOnly.isBefore(on, plan.startsOn)) return null;
  if (plan.endsOn !== null && DateOnly.isAfter(on, plan.endsOn)) return null;
  return escalatedAmount(plan.amount, plan.escalationPct, wholeYearsBetween(plan.startsOn, on));
}

/** A full plan year's total: the escalated per-cadence amount times the periods in a year. */
export function annualAmount(
  plan: Pick<ContributionPlan, 'amount' | 'escalationPct' | 'cadence'>,
  yearIndex: number,
): Money {
  return Money.multiplyByInteger(
    escalatedAmount(plan.amount, plan.escalationPct, yearIndex),
    CADENCE_PERIODS_PER_YEAR[plan.cadence],
  );
}
