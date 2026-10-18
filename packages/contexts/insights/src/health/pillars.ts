// SPDX-License-Identifier: MIT
/**
 * The health score's six components as **pillars** (WP 10.12, V5): each one either scored — its value,
 * band, weight and score exactly as `computeHealthScore` produced them — or withheld with the reason and
 * what would unlock it. Never a zero for a pillar with no data (09 ADV-7, WP 5.8's own rule).
 *
 * This file adds presentation only: it never changes a band, a weight or the overall score. What it adds
 * is **the data each pillar is built from**, read from the same `AdvisorSnapshot` blocks `score.ts` reads,
 * so every number on the Health screen is traceable to a stated input; and, on the emergency-fund pillar,
 * the living-expenses cover (`living-expenses.ts`), shown beside the scored figure and not scored.
 */
import { Money, type MoneyJson } from '@core/kernel';
import type { AdvisorSnapshot } from '../contract/snapshot.ts';
import * as D from '../validate/decimal.ts';
import { divideHalfEvenMinor, type LivingExpenses } from './living-expenses.ts';
import { computeHealthScore, type HealthScoreResult } from './score.ts';
import {
  HEALTH_COMPONENT_IDS,
  classifyDecimal,
  type HealthBand,
  type HealthComponentId,
} from './thresholds.ts';

export type PillarInputKind = 'money' | 'months' | 'ratio' | 'count' | 'text';

export interface PillarInput {
  readonly key: string;
  readonly label: string;
  readonly kind: PillarInputKind;
  /** A decimal string, a count as a string, words, or `{minor, currency}` — never a JSON number. */
  readonly value: string | MoneyJson;
}

export type LivingCover =
  | {
      readonly status: 'computed';
      /** Cash ÷ living expenses per month, one decimal, as a string. */
      readonly months: string;
      /** The emergency-fund ladder applied to this figure — shown, not scored. */
      readonly band: HealthBand;
      readonly livingExpenses: Extract<LivingExpenses, { status: 'computed' }>;
    }
  | { readonly status: 'withheld'; readonly reason: string; readonly unlock: string };

export type HealthPillar =
  | {
      readonly component: HealthComponentId;
      readonly status: 'scored';
      readonly value: string | MoneyJson;
      readonly band: HealthBand;
      /** Decimal string, renormalised over the scored pillars. */
      readonly weight: string;
      /** 0-100, `BAND_SCORE[band]`. */
      readonly score: number;
      readonly inputs: readonly PillarInput[];
      readonly livingCover?: LivingCover;
    }
  | {
      readonly component: HealthComponentId;
      readonly status: 'withheld';
      /** `computeHealthScore`'s own exclusion reason, verbatim. */
      readonly reason: string;
      /** What would let this pillar be scored, in plain words. */
      readonly unlock: string;
      readonly inputs: readonly PillarInput[];
      readonly livingCover?: LivingCover;
    };

export interface HealthSnapshotRecord {
  /** `computeHealthScore(snapshot).overall`, untouched. */
  readonly score: number | null;
  readonly pillars: readonly HealthPillar[];
}

/** What would unlock a withheld pillar, per component. */
export const PILLAR_UNLOCK: Readonly<Record<HealthComponentId, string>> = Object.freeze({
  emergency_fund_months:
    'Link a checking or savings account and let a few months of spending arrive, so your cash can be ' +
    'measured against what a month costs.',
  savings_rate: 'Let at least one month of income and spending arrive.',
  debt_to_income:
    'Let at least one month of income arrive, and link your loans and cards so their minimum payments ' +
    'are known.',
  subscription_load:
    'Let a few months of transactions arrive so recurring charges can be found, and a month of income.',
  diversification: 'Link an investment account whose holdings have prices.',
  fee_drag: 'Let a few months of transactions arrive so fees can be found.',
});

const NO_LONGER_CHARGING = new Set(['CANCELED', 'LIKELY_CANCELED', 'MIGRATED']);

function money(minor: bigint, currency: string): MoneyJson {
  return { minor: minor.toString(), currency };
}

function input(
  key: string,
  label: string,
  kind: PillarInputKind,
  value: string | MoneyJson,
): PillarInput {
  return { key, label, kind, value };
}

/** Σ income and spending over `cashflow_monthly`, and the month count — what three pillars state. */
function cashflowTotals(snapshot: AdvisorSnapshot) {
  const cashflow = snapshot.cashflow_monthly;
  if (cashflow === undefined || cashflow.months.length === 0) return null;
  let income = 0n;
  let expense = 0n;
  for (const month of cashflow.months) {
    income += Money.fromJSON(month.income).minor;
    expense += Money.fromJSON(month.expense).minor;
  }
  return { income, expense, months: cashflow.months.length, currency: cashflow.currency };
}

function inputsFor(component: HealthComponentId, snapshot: AdvisorSnapshot): PillarInput[] {
  const totals = cashflowTotals(snapshot);
  const monthlyIncome =
    totals === null ? null : divideHalfEvenMinor(totals.income, BigInt(totals.months));
  switch (component) {
    case 'emergency_fund_months': {
      const cash = snapshot.cash_summary;
      if (cash === undefined) return [];
      const out = [
        input('cash_total', 'Cash in checking and savings', 'money', cash.total),
        input('cash_accounts', 'Cash accounts', 'count', String(cash.account_count)),
      ];
      // `snapshot/builder.ts`: cash ÷ the average of the last six months that had spending.
      const months = snapshot.cashflow_monthly?.months.slice(-6).filter((m) => {
        return BigInt(m.expense.minor) > 0n;
      });
      if (months !== undefined && months.length > 0 && snapshot.cashflow_monthly !== undefined) {
        let sum = 0n;
        for (const month of months) sum += BigInt(month.expense.minor);
        out.push(
          input(
            'monthly_spending',
            `Average monthly spending (last ${String(months.length)} month${months.length === 1 ? '' : 's'} with spending)`,
            'money',
            money(sum / BigInt(months.length), snapshot.cashflow_monthly.currency),
          ),
        );
      }
      return out;
    }
    case 'savings_rate': {
      const observed = snapshot.plan_projection?.savings_rate?.observed;
      if (observed !== undefined) {
        return [input('plan_observed', "Your plan's observed savings rate", 'ratio', observed)];
      }
      if (totals === null) return [];
      return [
        input(
          'income_total',
          `Income over ${String(totals.months)} months`,
          'money',
          money(totals.income, totals.currency),
        ),
        input(
          'spending_total',
          `Spending over ${String(totals.months)} months`,
          'money',
          money(totals.expense, totals.currency),
        ),
      ];
    }
    case 'debt_to_income': {
      const liabilities = snapshot.liabilities_terms;
      const out: PillarInput[] = [];
      if (liabilities !== undefined) {
        let minimum = 0n;
        let withMinimum = 0;
        for (const liability of liabilities.liabilities) {
          if (liability.minimum_payment === null) continue;
          minimum += BigInt(liability.minimum_payment.minor);
          withMinimum += 1;
        }
        out.push(
          input(
            'minimum_payments',
            'Minimum payments per month',
            'money',
            money(minimum, liabilities.currency),
          ),
          input('debts_with_minimum', 'Debts with a minimum payment', 'count', String(withMinimum)),
        );
      }
      if (monthlyIncome !== null && totals !== null) {
        out.push(
          input(
            'monthly_income',
            `Average monthly income (${String(totals.months)} months)`,
            'money',
            money(monthlyIncome, totals.currency),
          ),
        );
      }
      return out;
    }
    case 'subscription_load': {
      const recurring = snapshot.recurring_list;
      const out: PillarInput[] = [];
      if (recurring !== undefined) {
        let annual: D.Decimal = 0n;
        let count = 0;
        for (const stream of recurring.streams) {
          if (stream.type !== 'SUBSCRIPTION' || NO_LONGER_CHARGING.has(stream.status)) continue;
          const typical = D.parseDecimal(
            Money.formatAmount(Money.fromJSON(stream.typical_amount)).replace(/[^0-9.-]/g, ''),
          );
          const periods = D.fromNumber(stream.periods_per_year);
          if (typical === null || periods === null) continue;
          const annualised = D.multiply(typical, periods);
          if (annualised === null) continue;
          annual = D.add(annual, annualised) ?? annual;
          count += 1;
        }
        const annualText = D.render(annual, 2) ?? '0.00';
        out.push(
          input(
            'subscriptions_annual',
            'Subscriptions still charging, per year',
            'money',
            Money.toJSON(Money.parseAmount(annualText, recurring.currency)),
          ),
          input('subscriptions_count', 'Subscriptions still charging', 'count', String(count)),
        );
      }
      if (monthlyIncome !== null && totals !== null) {
        out.push(
          input(
            'annual_income',
            'Take-home income per year (average month × 12)',
            'money',
            money(monthlyIncome * 12n, totals.currency),
          ),
        );
      }
      return out;
    }
    case 'diversification': {
      const holdings = snapshot.holdings_aggregate;
      if (holdings === undefined) return [];
      const out = [
        input('investable_total', 'Investable holdings', 'money', holdings.investable_total),
      ];
      const top = [...holdings.top_positions].sort((a, b) => b.weight - a.weight)[0];
      if (top !== undefined) {
        out.push(input('largest_position', 'Largest single holding', 'text', top.symbol));
      }
      return out;
    }
    case 'fee_drag': {
      const fees = snapshot.fees_summary;
      if (fees === undefined) return [];
      let avoidable = 0n;
      for (const row of fees.by_type) if (row.avoidable) avoidable += BigInt(row.total.minor);
      const out = [
        input(
          'avoidable_fees',
          `Avoidable fees over ${String(fees.window_months)} months`,
          'money',
          money(avoidable, fees.currency),
        ),
      ];
      out.push(
        fees.expense_ratio_drag === null
          ? input('expense_ratio_drag', 'Fund expense ratios per year', 'text', 'not available')
          : input(
              'expense_ratio_drag',
              'Fund expense ratios per year',
              'money',
              fees.expense_ratio_drag,
            ),
      );
      return out;
    }
  }
}

/** Cash ÷ living expenses, one decimal, half-even, in exact integer arithmetic. */
export function livingCoverOf(
  snapshot: AdvisorSnapshot,
  living: LivingExpenses | undefined,
): LivingCover | undefined {
  if (living === undefined) return undefined;
  if (living.status === 'withheld') {
    return { status: 'withheld', reason: living.reason, unlock: living.unlock };
  }
  const cash = snapshot.cash_summary;
  if (cash === undefined) {
    return {
      status: 'withheld',
      reason: 'No cash balance was available to measure against your living expenses.',
      unlock: PILLAR_UNLOCK.emergency_fund_months,
    };
  }
  const cashMinor = BigInt(cash.total.minor);
  const monthlyMinor = BigInt(living.monthly.minor);
  const tenths = cashMinor <= 0n ? 0n : divideHalfEvenMinor(cashMinor * 10n, monthlyMinor);
  const months = `${String(tenths / 10n)}.${String(tenths % 10n)}`;
  const figure = D.parseDecimal(months);
  const band =
    figure === null
      ? 'poor'
      : classifyDecimal(
          'emergency_fund_months',
          (text) => D.parseDecimal(text),
          (a, b) => (a < b ? -1 : a > b ? 1 : 0),
          figure,
        );
  return { status: 'computed', months, band, livingExpenses: living };
}

/**
 * The pillars of a computed score. `result` is `computeHealthScore`'s own output, never re-derived here: a
 * scored pillar copies its value, band, weight and score; a withheld one copies the exclusion reason.
 */
export function pillarsOf(
  result: HealthScoreResult,
  snapshot: AdvisorSnapshot,
  living?: LivingExpenses,
): HealthPillar[] {
  return HEALTH_COMPONENT_IDS.map((component): HealthPillar => {
    const inputs = inputsFor(component, snapshot);
    const cover =
      component === 'emergency_fund_months' ? livingCoverOf(snapshot, living) : undefined;
    const extra = cover === undefined ? {} : { livingCover: cover };
    const scored = result.components.find((entry) => entry.component === component);
    if (scored !== undefined) {
      return {
        component,
        status: 'scored',
        value: scored.value,
        band: scored.band,
        weight: scored.weight,
        score: scored.score,
        inputs,
        ...extra,
      };
    }
    const excluded = result.excluded.find((entry) => entry.component === component);
    return {
      component,
      status: 'withheld',
      reason: excluded?.reason ?? 'not computed',
      unlock: PILLAR_UNLOCK[component],
      inputs,
      ...extra,
    };
  });
}

/** The whole day's record: the unchanged score and its pillars. */
export function healthSnapshotRecordOf(
  snapshot: AdvisorSnapshot,
  living?: LivingExpenses,
): HealthSnapshotRecord {
  const result = computeHealthScore(snapshot, null);
  return { score: result.overall, pillars: pillarsOf(result, snapshot, living) };
}
