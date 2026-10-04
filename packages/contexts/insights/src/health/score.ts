// SPDX-License-Identifier: MIT
/**
 * The health score — pure over an `AdvisorSnapshot` (05-phase-5-dispatch.md
 * §3 WP 5.8; 09 ADV-7, §4 benchmark row 20).
 *
 * Six named components, each with its value, band, weight, component score
 * and direction of travel against a previous week's components (an input,
 * not a side effect — `health/store.ts` is where "previous" means "the row
 * before this one in Postgres"; here it is just a map this function is given,
 * which is what keeps `computeHealthScore` pure and testable without a
 * database). A component with no data is **excluded and named**, never
 * scored as zero (09 TRD-6's own posture applied here too: an absent signal
 * is absent, not a zero that quietly drags the average down). The weights
 * renormalise over the computable components only, by construction: the last
 * computable component (in `HEALTH_COMPONENT_IDS` order) absorbs whatever
 * rounding the others' divisions left, so the renormalised weights always sum
 * to exactly `1.000000` — never approximately, which is what makes
 * `'the weights sum to one over the computable components'` assertable
 * without a tolerance.
 *
 * Reads only six blocks of `AdvisorSnapshot` — `cash_summary`,
 * `cashflow_monthly`, `plan_projection`, `liabilities_terms`, `recurring_list`,
 * `holdings_aggregate`, `fees_summary` — and nothing else. That is what keeps
 * a future sidecar's signals out of this score *by construction* (09 TRD-6):
 * a block this function never destructures cannot move the number, no matter
 * what else `AdvisorSnapshot` grows to carry later.
 *
 * "Income" and "take-home" are the same figure throughout this file:
 * `cashflow.monthly`'s average monthly net cash inflow. `plan.projection`
 * deliberately never exposes a raw income figure (its own header: "R1 reads
 * savings_rate — two rates over one income, so the income itself never
 * crosses"), so `cashflow.monthly` is the only block in the snapshot that
 * can supply one, and `debt_to_income` and `subscription_load` both need it.
 */
import { Money, type Money as MoneyType } from '@core/kernel';
import type { AdvisorSnapshot, MoneyJson } from '../contract/snapshot.ts';
import * as D from '../validate/decimal.ts';
import {
  BAND_SCORE,
  HEALTH_BAND_THRESHOLDS,
  HEALTH_COMPONENT_IDS,
  classifyDecimal,
  type HealthBand,
  type HealthComponentId,
} from './thresholds.ts';

/** Base weight, scale-6 `Decimal` (bigint). Sums to exactly `1_000_000n` — asserted by `test/health.test.ts`. */
const BASE_WEIGHT: Readonly<Record<HealthComponentId, D.Decimal>> = Object.freeze({
  emergency_fund_months: 200_000n,
  savings_rate: 200_000n,
  debt_to_income: 200_000n,
  subscription_load: 150_000n,
  diversification: 150_000n,
  fee_drag: 100_000n,
});

const ONE = 1_000_000n as D.Decimal;

export const HEALTH_SCORE_DIRECTIONS = [
  'improved',
  'worsened',
  'unchanged',
  'no_previous_data',
] as const;
export type HealthScoreDirection = (typeof HEALTH_SCORE_DIRECTIONS)[number];

export interface HealthComponentResult {
  readonly component: HealthComponentId;
  /** A decimal string (months, a ratio) or `MoneyJson` (`fee_drag`) — never a JSON number. */
  readonly value: string | MoneyJson;
  readonly band: HealthBand;
  /** A decimal string, renormalised over the computable components. */
  readonly weight: string;
  /** 0-100, from `BAND_SCORE`. */
  readonly score: number;
  readonly direction: HealthScoreDirection;
}

export interface HealthExcludedComponent {
  readonly component: HealthComponentId;
  readonly reason: string;
}

export interface HealthScoreResult {
  /** 0-100, the weighted average over computable components. `null` when every component is excluded. */
  readonly overall: number | null;
  readonly components: readonly HealthComponentResult[];
  readonly excluded: readonly HealthExcludedComponent[];
}

/** What `computeHealthScore` needs about a previously stored week, per component — never the whole row. */
export interface PreviousComponentScore {
  readonly score: number;
}

type ComputableFigure =
  | { readonly computable: true; readonly figure: D.Decimal; readonly value: string }
  | { readonly computable: true; readonly figure: MoneyType; readonly value: MoneyJson }
  | { readonly computable: false; readonly reason: string };

function excluded(reason: string): ComputableFigure {
  return { computable: false, reason };
}

function decimalRatioOf(numerator: D.Decimal, denominator: D.Decimal): D.Decimal | null {
  return D.divide(numerator, denominator);
}

/** `Money` → a scale-6 `Decimal` of the dollar amount (never a cross-currency comparison — this app is USD-only, confirmed throughout Phase 5). */
function moneyToDecimal(amount: MoneyType): D.Decimal | null {
  return D.parseDecimal(Money.formatAmount(amount).replace(/[^0-9.-]/g, ''));
}

// ---------------------------------------------------------------------------
// cash.summary — emergency_fund_months
// ---------------------------------------------------------------------------

function emergencyFundMonths(snapshot: AdvisorSnapshot): ComputableFigure {
  const cash = snapshot.cash_summary;
  if (cash === undefined) {
    return excluded('cash.summary was not granted, or had no source behind it');
  }
  if (cash.emergency_fund_months === null) {
    return excluded(
      'cash.summary.emergency_fund_months is null — it requires cashflow.monthly to also be ' +
        'granted (the builder divides cash by monthly expense, and will not derive one block from ' +
        'the other without both)',
    );
  }
  const figure = D.fromNumber(cash.emergency_fund_months);
  if (figure === null) {
    return excluded('cash.summary.emergency_fund_months was not a finite number');
  }
  const value = D.render(figure, 2);
  if (value === null) return excluded('emergency_fund_months did not render to a decimal string');
  return { computable: true, figure, value };
}

// ---------------------------------------------------------------------------
// cashflow.monthly — shared income/take-home helper
// ---------------------------------------------------------------------------

interface MonthlyIncome {
  readonly monthlyAverage: D.Decimal;
}

/** Average monthly net cash inflow over `cashflow_monthly.months`. `null` when there is nothing to average, or it averages to zero. */
function monthlyIncomeOf(snapshot: AdvisorSnapshot): MonthlyIncome | null {
  const cashflow = snapshot.cashflow_monthly;
  if (cashflow === undefined || cashflow.months.length === 0) return null;
  let totalIncome: MoneyType = Money.of(0n, cashflow.currency);
  for (const month of cashflow.months) {
    totalIncome = Money.add(totalIncome, Money.fromJSON(month.income));
  }
  const totalDecimal = moneyToDecimal(totalIncome);
  const count = D.fromNumber(cashflow.months.length);
  if (totalDecimal === null || count === null) return null;
  const monthlyAverage = D.divide(totalDecimal, count);
  if (monthlyAverage === null || monthlyAverage <= 0n) return null;
  return { monthlyAverage };
}

// ---------------------------------------------------------------------------
// plan.projection (preferred) or cashflow.monthly (fallback) — savings_rate
// ---------------------------------------------------------------------------

function savingsRate(snapshot: AdvisorSnapshot): ComputableFigure {
  const observed = snapshot.plan_projection?.savings_rate?.observed;
  if (observed !== undefined) {
    const figure = D.parseDecimal(observed);
    if (figure === null) {
      return excluded('plan.projection.savings_rate.observed did not parse as a decimal string');
    }
    const value = D.render(figure, 6);
    if (value === null) return excluded('savings_rate did not render to a decimal string');
    return { computable: true, figure, value };
  }

  const cashflow = snapshot.cashflow_monthly;
  if (cashflow === undefined) {
    return excluded(
      'neither plan.projection.savings_rate.observed nor cashflow.monthly was available to derive ' +
        'a savings rate from',
    );
  }
  if (cashflow.months.length === 0) {
    return excluded('cashflow.monthly had no months to derive a savings rate from');
  }
  let totalIncome: MoneyType = Money.of(0n, cashflow.currency);
  let totalExpense: MoneyType = Money.of(0n, cashflow.currency);
  for (const month of cashflow.months) {
    totalIncome = Money.add(totalIncome, Money.fromJSON(month.income));
    totalExpense = Money.add(totalExpense, Money.fromJSON(month.expense));
  }
  if (Money.isZero(totalIncome)) {
    return excluded('no income observed in cashflow.monthly to compute a savings rate against');
  }
  const net = Money.subtract(totalIncome, totalExpense);
  const incomeDecimal = moneyToDecimal(totalIncome);
  const netDecimal = moneyToDecimal(net);
  if (incomeDecimal === null || netDecimal === null) {
    return excluded('cashflow.monthly totals did not convert to a decimal ratio');
  }
  const figure = decimalRatioOf(netDecimal, incomeDecimal);
  if (figure === null) return excluded('savings rate did not divide cleanly');
  const value = D.render(figure, 6);
  if (value === null) return excluded('savings_rate did not render to a decimal string');
  return { computable: true, figure, value };
}

// ---------------------------------------------------------------------------
// liabilities.terms over cashflow.monthly's income — debt_to_income
// ---------------------------------------------------------------------------

function debtToIncome(snapshot: AdvisorSnapshot): ComputableFigure {
  const liabilities = snapshot.liabilities_terms;
  if (liabilities === undefined) {
    return excluded('liabilities.terms was not granted, or had no source behind it');
  }
  const income = monthlyIncomeOf(snapshot);
  if (income === null) {
    return excluded(
      'debt-to-income needs a monthly income, and cashflow.monthly was not available (or had no ' +
        'income) to supply one',
    );
  }
  let totalMinimum: D.Decimal = 0n;
  for (const liability of liabilities.liabilities) {
    if (liability.minimum_payment === null) continue;
    const minimum = moneyToDecimal(Money.fromJSON(liability.minimum_payment));
    if (minimum === null) continue;
    const added = D.add(totalMinimum, minimum);
    if (added !== null) totalMinimum = added;
  }
  const figure = decimalRatioOf(totalMinimum, income.monthlyAverage);
  if (figure === null) return excluded('debt-to-income did not divide cleanly against income');
  const value = D.render(figure, 6);
  if (value === null) return excluded('debt_to_income did not render to a decimal string');
  return { computable: true, figure, value };
}

// ---------------------------------------------------------------------------
// recurring.list over cashflow.monthly's take-home — subscription_load
// ---------------------------------------------------------------------------

function subscriptionLoad(snapshot: AdvisorSnapshot): ComputableFigure {
  const recurring = snapshot.recurring_list;
  if (recurring === undefined) {
    return excluded('recurring.list was not granted, or had no source behind it');
  }
  const income = monthlyIncomeOf(snapshot);
  if (income === null) {
    return excluded(
      'subscription load needs an annual take-home income, and cashflow.monthly was not ' +
        'available (or had no income) to supply one',
    );
  }
  const annualIncome = D.multiply(income.monthlyAverage, D.fromNumber(12) ?? 0n);
  if (annualIncome === null || annualIncome <= 0n) {
    return excluded('annualised take-home income did not compute cleanly from cashflow.monthly');
  }
  let annualSubscriptions: D.Decimal = 0n;
  for (const stream of recurring.streams) {
    const typical = moneyToDecimal(Money.fromJSON(stream.typical_amount));
    const periods = D.fromNumber(stream.periods_per_year);
    if (typical === null || periods === null) continue;
    const annualised = D.multiply(typical, periods);
    if (annualised === null) continue;
    const added = D.add(annualSubscriptions, annualised);
    if (added !== null) annualSubscriptions = added;
  }
  const figure = decimalRatioOf(annualSubscriptions, annualIncome);
  if (figure === null) return excluded('subscription load did not divide cleanly against income');
  const value = D.render(figure, 6);
  if (value === null) return excluded('subscription_load did not render to a decimal string');
  return { computable: true, figure, value };
}

// ---------------------------------------------------------------------------
// holdings.aggregate — diversification (top-position concentration)
// ---------------------------------------------------------------------------

function diversification(snapshot: AdvisorSnapshot): ComputableFigure {
  const holdings = snapshot.holdings_aggregate;
  if (holdings === undefined) {
    return excluded('holdings.aggregate was not granted, or had no source behind it');
  }
  if (holdings.top_positions.length === 0 || Money.isZero(Money.fromJSON(holdings.investable_total))) {
    return excluded('holdings.aggregate had no investable holdings to assess concentration over');
  }
  const topWeight = holdings.top_positions.reduce(
    (max, position) => Math.max(max, position.weight),
    0,
  );
  const figure = D.fromNumber(topWeight);
  if (figure === null) return excluded('the top position weight was not a finite number');
  const value = D.render(figure, 6);
  if (value === null) return excluded('diversification did not render to a decimal string');
  return { computable: true, figure, value };
}

// ---------------------------------------------------------------------------
// fees.summary — fee_drag (a Money value, not a ratio)
// ---------------------------------------------------------------------------

function feeDrag(snapshot: AdvisorSnapshot): ComputableFigure {
  const fees = snapshot.fees_summary;
  if (fees === undefined) {
    return excluded('fees.summary was not granted, or had no source behind it');
  }
  let total: MoneyType = Money.of(0n, fees.currency);
  for (const row of fees.by_type) {
    if (!row.avoidable) continue;
    total = Money.add(total, Money.fromJSON(row.total));
  }
  if (fees.expense_ratio_drag !== null) {
    total = Money.add(total, Money.fromJSON(fees.expense_ratio_drag));
  }
  return { computable: true, figure: total, value: Money.toJSON(total) };
}

// ---------------------------------------------------------------------------
// Weights, renormalised over the computable components
// ---------------------------------------------------------------------------

/**
 * Renormalise `BASE_WEIGHT` over exactly the computable components, in
 * `HEALTH_COMPONENT_IDS` order. Every weight but the last is `base ÷ sum`,
 * scale-6 half-even division (`validate/decimal.ts#divide`); the last
 * absorbs `1.000000 − (sum of the others)`, so the total is `1_000_000n`
 * exactly — a property of the construction, not of the rounding, and
 * `'the weights sum to one over the computable components'` asserts exactly
 * that bigint sum rather than a tolerance.
 */
export function renormalizeWeights(
  computableIds: readonly HealthComponentId[],
): ReadonlyMap<HealthComponentId, D.Decimal> {
  const result = new Map<HealthComponentId, D.Decimal>();
  if (computableIds.length === 0) return result;
  let sum: D.Decimal = 0n;
  for (const id of computableIds) {
    const added = D.add(sum, BASE_WEIGHT[id]);
    if (added !== null) sum = added;
  }
  let runningSum: D.Decimal = 0n;
  for (let index = 0; index < computableIds.length - 1; index += 1) {
    const id = computableIds[index];
    if (id === undefined) continue;
    const weight = D.divide(BASE_WEIGHT[id], sum) ?? 0n;
    result.set(id, weight);
    const added = D.add(runningSum, weight);
    if (added !== null) runningSum = added;
  }
  const last = computableIds[computableIds.length - 1];
  if (last !== undefined) {
    result.set(last, D.subtract(ONE, runningSum) ?? 0n);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Banding — Decimal-space components share one comparator; `fee_drag` compares `Money`
// ---------------------------------------------------------------------------

function decimalCompare(a: bigint, b: bigint): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function bandOf(componentId: HealthComponentId, figure: D.Decimal | MoneyType): HealthBand {
  if (componentId === 'fee_drag') {
    const money = figure as MoneyType;
    return classifyDecimal(
      componentId,
      (text) => Money.parseAmount(text, money.currency).minor,
      decimalCompare,
      money.minor,
    );
  }
  return classifyDecimal(componentId, (text) => D.parseDecimal(text), decimalCompare, figure as D.Decimal);
}

// ---------------------------------------------------------------------------
// The whole score
// ---------------------------------------------------------------------------

const EXTRACTORS: Readonly<Record<HealthComponentId, (snapshot: AdvisorSnapshot) => ComputableFigure>> =
  Object.freeze({
    emergency_fund_months: emergencyFundMonths,
    savings_rate: savingsRate,
    debt_to_income: debtToIncome,
    subscription_load: subscriptionLoad,
    diversification: diversification,
    fee_drag: feeDrag,
  });

function directionOf(
  componentId: HealthComponentId,
  score: number,
  previous: ReadonlyMap<HealthComponentId, PreviousComponentScore> | null,
): HealthScoreDirection {
  const previousScore = previous?.get(componentId);
  if (previousScore === undefined) return 'no_previous_data';
  if (score > previousScore.score) return 'improved';
  if (score < previousScore.score) return 'worsened';
  return 'unchanged';
}

/**
 * Pure: the same snapshot and the same previous-week map always yield the
 * same result (`'the same snapshot always yields the same score'`).
 * `previous` is `null` on a holder's first-ever computed week — every
 * component's `direction` then reads `'no_previous_data'`, which is the
 * first week saying so (`health/store.ts` is where that `null` actually
 * comes from a missing row; this function only needs to be told).
 */
export function computeHealthScore(
  snapshot: AdvisorSnapshot,
  previous: ReadonlyMap<HealthComponentId, PreviousComponentScore> | null,
): HealthScoreResult {
  const computable: { readonly component: HealthComponentId; readonly figure: ComputableFigure }[] = [];
  const excludedComponents: HealthExcludedComponent[] = [];

  for (const component of HEALTH_COMPONENT_IDS) {
    const figure = EXTRACTORS[component](snapshot);
    if (figure.computable) {
      computable.push({ component, figure });
    } else {
      excludedComponents.push({ component, reason: figure.reason });
    }
  }

  const weights = renormalizeWeights(computable.map((entry) => entry.component));
  const components: HealthComponentResult[] = [];
  let weightedSum: D.Decimal = 0n;

  for (const entry of computable) {
    if (!entry.figure.computable) continue;
    const band = bandOf(entry.component, entry.figure.figure);
    const score = BAND_SCORE[band];
    const weight = weights.get(entry.component) ?? 0n;
    const direction = directionOf(entry.component, score, previous);
    components.push({
      component: entry.component,
      value: entry.figure.value,
      band,
      weight: D.render(weight, 6) ?? '0.000000',
      score,
      direction,
    });
    const contribution = D.multiply(weight, D.fromNumber(score) ?? 0n);
    if (contribution !== null) {
      const added = D.add(weightedSum, contribution);
      if (added !== null) weightedSum = added;
    }
  }

  const overall = components.length === 0 ? null : Number(D.render(weightedSum, 2));

  return { overall, components, excluded: excludedComponents };
}

export { HEALTH_BAND_THRESHOLDS, HEALTH_COMPONENT_IDS };
export type { HealthBand, HealthComponentId };
