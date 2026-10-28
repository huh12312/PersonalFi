// SPDX-License-Identifier: MIT
/**
 * `situation.snapshot`, `cash.emergency_fund` and `debt.payoff_plan` (WP 11.5b).
 */
import { Money } from '@core/kernel';
import { z } from 'zod';
import { completeMonths } from '../../advisors/support.ts';
import { NARRATOR_SCOPES } from '../../advisors/local/manifest.ts';
import { scopeDefinition } from '../../contract/scopes.ts';
import { MoneyJsonSchema } from '../../contract/snapshot.ts';
import {
  computeLivingExpenses,
  divideHalfEvenMinor,
  livingExpensesReadWindow,
} from '../../health/living-expenses.ts';
import * as decimal from '../../validate/decimal.ts';
import {
  amortise,
  avalancheOrder,
  monthStart,
  snowballOrder,
  type AmortisationResult,
  type AmortisedDebt,
} from '../amortisation.ts';
import { defineFunction, notAvailable, ok } from '../definition.ts';
import {
  DateFigureSchema,
  DecimalFigureSchema,
  MoneyFigureSchema,
  dateFigure,
  decimalFigure,
  decimalText,
  moneyFigure,
  parseDecimalOrThrow,
  ratioText,
  ref,
  snapshotInputs,
} from '../figures.ts';
import { CatalogueRefusal } from '../ports.ts';
import { readParameter } from './shared.ts';

// ---------------------------------------------------------------------------
// situation.snapshot
// ---------------------------------------------------------------------------

export const situationSnapshot = defineFunction({
  name: 'situation.snapshot',
  summary: 'The minimised, scoped snapshot the advisors receive, under the scopes you granted.',
  description:
    'Returns the advisor snapshot (08 §4.2) built for the scopes the holder granted the narrator, ' +
    'minimised exactly as the advisors receive it: no account or institution name, merchants ' +
    'tokenised, net worth rounded to $100. The blocks are the inputs; the result lists them. ' +
    'Never includes row-level transactions.',
  backing: 'SnapshotBuilder (snapshot/builder.ts) under the holder’s narrator grant',
  scopes: NARRATOR_SCOPES,
  scopeRule: 'any',
  args: z.strictObject({}),
  result: z.strictObject({
    blocks: z.array(z.strictObject({ scope: z.string(), key: z.string() })),
  }),
  async run(context, _args, scopes) {
    const snapshot = await context.snapshot(scopes);
    const inputs: Record<string, unknown> = { ...snapshotInputs(snapshot), args: {} };
    const present = new Set(Object.keys(snapshot));
    const blocks = scopes
      .map((scope) => ({ scope, key: scopeDefinition(scope).key }))
      .filter((row) => present.has(row.key));
    return ok(inputs, { blocks });
  },
});

// ---------------------------------------------------------------------------
// cash.emergency_fund
// ---------------------------------------------------------------------------

/** C4's own target (`rules-cash.ts`): three months of recent spending. */
export const EMERGENCY_FUND_DEFAULT_TARGET_MONTHS = 3;
/** C1's cushion window: the last three complete months of spending. */
const SPENDING_WINDOW_MONTHS = 3;
/** The rate idle cash is compared against (07 Appendix A's market reference points). */
export const CASH_REFERENCE_RATE_KEY = 'assumptions.market_reference.treasury_bill_3_month';

const emergencyFundResult = z.strictObject({
  cash_held: MoneyFigureSchema,
  monthly_spending: MoneyFigureSchema,
  months_covered: DecimalFigureSchema,
  target_months: DecimalFigureSchema,
  target_amount: MoneyFigureSchema,
  shortfall: MoneyFigureSchema,
  excess: MoneyFigureSchema,
  /** What the cash earns now, across its accounts, balance-weighted. */
  blended_apy: DecimalFigureSchema,
  /** The reference rate minus what the cash earns: positive means the excess could earn more. */
  yield_spread: DecimalFigureSchema.nullable(),
  /** The excess × the spread, for a year: what the excess gives up (negative: it earns more). */
  annual_spread_on_excess: MoneyFigureSchema.nullable(),
  living_expenses: z
    .strictObject({
      monthly: MoneyFigureSchema,
      months_covered: DecimalFigureSchema,
    })
    .nullable(),
  living_expenses_withheld: z.string().nullable(),
});

export const cashEmergencyFund = defineFunction({
  name: 'cash.emergency_fund',
  summary:
    'Months of recent spending your cash covers, the gap to a target or the excess over it, and ' +
    'what the excess earns against a 3-month Treasury bill.',
  description:
    'Monthly spending is the average of the last three complete months (C1’s cushion window). ' +
    'The target defaults to three months (C4). The excess over the target is compared with the ' +
    'parameter store’s 3-month Treasury bill reference rate. When the Budget screen has ' +
    'categories classified fixed or non-monthly, living expenses (WP 10.12) are reported beside it.',
  backing:
    'C4 and C1 (advisors/rules-cash.ts) over cash.summary and cashflow.monthly; WP 10.12 living ' +
    'expenses (health/living-expenses.ts); the parameter assumptions.market_reference.treasury_bill_3_month',
  scopes: ['cash.summary', 'cashflow.monthly'],
  scopeRule: 'all',
  args: z.strictObject({
    target_months: z.int().min(1).max(24).default(EMERGENCY_FUND_DEFAULT_TARGET_MONTHS),
  }),
  result: emergencyFundResult,
  async run(context, args, scopes) {
    const snapshot = await context.snapshot(scopes);
    const inputs: Record<string, unknown> = {
      ...snapshotInputs(snapshot),
      args: { target_months: args.target_months },
    };
    const cash = snapshot.cash_summary;
    const flows = snapshot.cashflow_monthly;
    if (cash === undefined || flows === undefined) {
      return notAvailable(inputs, 'no_cash_data', 'No cash accounts or spending history to read.');
    }
    if (cash.total.currency !== flows.currency) {
      return notAvailable(
        inputs,
        'currency_mismatch',
        'Cash and spending are in different currencies; nothing is converted here.',
      );
    }
    const window = completeMonths(flows.months, context.today).slice(-SPENDING_WINDOW_MONTHS);
    if (window.length < SPENDING_WINDOW_MONTHS) {
      return notAvailable(
        inputs,
        'not_enough_history',
        'Fewer than three complete months of spending are on record.',
      );
    }
    const expenseRefs = window.map((month) =>
      ref(`cashflow_monthly.months[${String(flows.months.indexOf(month))}].expense`),
    );
    let spent = 0n;
    for (const month of window) spent += BigInt(month.expense.minor);
    const monthly = divideHalfEvenMinor(spent, BigInt(SPENDING_WINDOW_MONTHS));
    if (monthly <= 0n) {
      return notAvailable(
        inputs,
        'no_spending',
        'No spending was recorded in the last three months.',
      );
    }
    const currency = cash.total.currency;
    const held = BigInt(cash.total.minor);
    const target = monthly * BigInt(args.target_months);
    const shortfall = target > held ? target - held : 0n;
    const excess = held > target ? held - target : 0n;
    const cashRef = ref('cash_summary.total');
    const targetRef = ref('args.target_months');
    const money = (minor: bigint) => ({ minor: minor.toString(), currency });

    const reference = readParameter(context, CASH_REFERENCE_RATE_KEY);
    let yieldSpread = null;
    let annualOnExcess = null;
    const apyText = (inputs['cash_summary'] as { blended_apy: string }).blended_apy;
    if (reference !== null && reference.kind === 'rate' && typeof reference.value === 'string') {
      inputs['parameters'] = [reference];
      const spread = decimal.subtract(
        parseDecimalOrThrow(reference.value),
        parseDecimalOrThrow(String(apyText)),
      );
      if (spread !== null) {
        const spreadText = decimalText(spread);
        const spreadRefs = [ref('parameters[0].value'), ref('cash_summary.blended_apy')];
        yieldSpread = decimalFigure(spreadText, 'ratio', spreadRefs);
        annualOnExcess = moneyFigure(
          Money.toJSON(Money.multiplyByDecimal(Money.of(excess, currency), spreadText)),
          [cashRef, ...expenseRefs, targetRef, ...spreadRefs],
        );
      }
    }

    let living = null;
    let livingWithheld: string | null = null;
    const port = context.ports.livingExpenses;
    if (port !== undefined) {
      const source = await port({
        userId: context.userId,
        window: livingExpensesReadWindow(context.today),
      });
      const computed = computeLivingExpenses(source, context.today);
      if (computed.status === 'computed' && computed.monthly.currency === currency) {
        inputs['living_expenses'] = {
          monthly: computed.monthly,
          fixed_monthly_average: computed.fixedMonthlyAverage,
          non_monthly_monthly_share: computed.nonMonthlyMonthlyShare,
          fixed_category_count: computed.fixedCategoryCount,
          non_monthly_category_count: computed.nonMonthlyCategoryCount,
          fixed_window: computed.fixedWindow,
          non_monthly_window: computed.nonMonthlyWindow,
        };
        living = {
          monthly: moneyFigure(computed.monthly, [ref('living_expenses.monthly')]),
          months_covered: decimalFigure(
            ratioText(held, BigInt(computed.monthly.minor), 2),
            'months',
            [cashRef, ref('living_expenses.monthly')],
          ),
        };
      } else if (computed.status === 'withheld') {
        livingWithheld = computed.reason;
      }
    }

    return ok(inputs, {
      cash_held: moneyFigure(cash.total, [cashRef]),
      monthly_spending: moneyFigure(money(monthly), expenseRefs),
      months_covered: decimalFigure(ratioText(held, monthly, 2), 'months', [
        cashRef,
        ...expenseRefs,
      ]),
      target_months: decimalFigure(String(args.target_months), 'months', [targetRef]),
      target_amount: moneyFigure(money(target), [...expenseRefs, targetRef]),
      shortfall: moneyFigure(money(shortfall), [cashRef, ...expenseRefs, targetRef]),
      excess: moneyFigure(money(excess), [cashRef, ...expenseRefs, targetRef]),
      blended_apy: decimalFigure(String(apyText), 'ratio', [ref('cash_summary.blended_apy')]),
      yield_spread: yieldSpread,
      annual_spread_on_excess: annualOnExcess,
      living_expenses: living,
      living_expenses_withheld: livingWithheld,
    });
  },
});

// ---------------------------------------------------------------------------
// debt.payoff_plan
// ---------------------------------------------------------------------------

export const PAYOFF_ORDERS = ['avalanche', 'snowball', 'custom'] as const;

const planSchema = z.strictObject({
  order: z.enum(PAYOFF_ORDERS),
  /** The liability refs in the order the extra goes to them. */
  sequence: z.array(z.string()),
  status: z.enum(['paid_off', 'not_paid_off']),
  months: DecimalFigureSchema.nullable(),
  payoff_month: DateFigureSchema.nullable(),
  total_interest: MoneyFigureSchema,
  total_paid: MoneyFigureSchema,
  debts: z.array(
    z.strictObject({
      liability_ref: z.string(),
      payoff_month: DateFigureSchema.nullable(),
      interest: MoneyFigureSchema,
    }),
  ),
});

const payoffResult = z.strictObject({
  chosen: z.enum(PAYOFF_ORDERS),
  included: z.array(
    z.strictObject({
      liability_ref: z.string(),
      kind: z.string(),
      balance: MoneyFigureSchema,
      apr: DecimalFigureSchema,
      promo_apr: DecimalFigureSchema.nullable(),
      promo_apr_end: DateFigureSchema.nullable(),
      minimum_payment: MoneyFigureSchema,
    }),
  ),
  excluded: z.array(
    z.strictObject({
      liability_ref: z.string(),
      reason: z.enum(['no_apr', 'no_minimum_payment', 'currency_mismatch']),
    }),
  ),
  monthly_budget: MoneyFigureSchema,
  plans: z.array(planSchema),
  /** The chosen plan against each other order: interest and months, chosen − other. */
  differences: z.array(
    z.strictObject({
      chosen: z.enum(PAYOFF_ORDERS),
      other: z.enum(PAYOFF_ORDERS),
      interest: MoneyFigureSchema,
      months: DecimalFigureSchema.nullable(),
    }),
  ),
});

export const debtPayoffPlan = defineFunction({
  name: 'debt.payoff_plan',
  summary:
    'Payoff date and total interest for paying debts in avalanche, snowball or your own order, ' +
    'side by side, and the difference in dollars.',
  description:
    'A month-by-month schedule in integer cents: interest accrues on each balance at its rate ' +
    '(a promotional rate while it lasts), every minimum is paid, and the rest of a fixed monthly ' +
    'budget (all minimums plus the extra) goes to one debt at a time in the chosen order; a ' +
    'cleared debt’s minimum rolls to the next. A debt with no rate or no minimum on record is ' +
    'left out and named. A schedule not clear in fifty years is reported as not paid off.',
  backing:
    'D1–D5’s inputs (liabilities.terms); the amortisation in catalogue/amortisation.ts, new in ' +
    'WP 11.5b because D1 states the ordering and not the cost',
  scopes: ['liabilities.terms'],
  scopeRule: 'all',
  args: z.strictObject({
    order: z.enum(PAYOFF_ORDERS),
    extra_monthly: MoneyJsonSchema,
    custom_order: z.array(z.string().min(1).max(64)).max(64).optional(),
  }),
  result: payoffResult,
  async run(context, args, scopes) {
    if (BigInt(args.extra_monthly.minor) < 0n) {
      throw new CatalogueRefusal(
        'catalogue.invalid_arguments',
        400,
        'extra_monthly cannot be negative',
      );
    }
    if (args.order === 'custom' && (args.custom_order ?? []).length === 0) {
      throw new CatalogueRefusal(
        'catalogue.invalid_arguments',
        400,
        'a custom order names at least one liability_ref in custom_order',
      );
    }
    const snapshot = await context.snapshot(scopes);
    const inputs: Record<string, unknown> = {
      ...snapshotInputs(snapshot),
      args: {
        order: args.order,
        extra_monthly: args.extra_monthly,
        ...(args.custom_order === undefined ? {} : { custom_order: [...args.custom_order] }),
      },
    };
    const terms = snapshot.liabilities_terms;
    const decimalTerms = inputs['liabilities_terms'] as
      { liabilities: { apr: string | null; promo_apr: string | null }[] } | undefined;
    if (terms === undefined || decimalTerms === undefined) {
      return notAvailable(inputs, 'no_debts', 'No liabilities are on record.');
    }
    const currency = terms.currency;
    if (args.extra_monthly.currency !== currency) {
      throw new CatalogueRefusal(
        'catalogue.invalid_arguments',
        400,
        `extra_monthly must be in ${currency}, the liabilities’ currency`,
      );
    }
    const included: AmortisedDebt[] = [];
    const rows: { index: number; kind: string }[] = [];
    const excluded: {
      liability_ref: string;
      reason: 'no_apr' | 'no_minimum_payment' | 'currency_mismatch';
    }[] = [];
    for (const [index, liability] of terms.liabilities.entries()) {
      if (BigInt(liability.current_balance.minor) <= 0n) continue;
      const decimalRow = decimalTerms.liabilities[index];
      const apr = decimalRow?.apr ?? null;
      if (liability.current_balance.currency !== currency) {
        excluded.push({ liability_ref: liability.liability_ref, reason: 'currency_mismatch' });
      } else if (apr === null) {
        excluded.push({ liability_ref: liability.liability_ref, reason: 'no_apr' });
      } else if (
        liability.minimum_payment === null ||
        BigInt(liability.minimum_payment.minor) <= 0n
      ) {
        excluded.push({ liability_ref: liability.liability_ref, reason: 'no_minimum_payment' });
      } else {
        const promoApr = decimalRow?.promo_apr ?? null;
        included.push({
          ref: liability.liability_ref,
          balanceMinor: BigInt(liability.current_balance.minor),
          apr,
          promo:
            promoApr !== null && liability.promo_apr_end_date !== null
              ? { apr: promoApr, endDate: liability.promo_apr_end_date }
              : null,
          minimumMinor: BigInt(liability.minimum_payment.minor),
        });
        rows.push({ index, kind: liability.kind });
      }
    }
    if (included.length === 0) {
      return notAvailable(
        inputs,
        'no_amortisable_debt',
        'No debt with a balance, a rate and a minimum payment is on record.',
      );
    }

    const refsOfDebt = (position: number): string[] => {
      const index = rows[position]?.index ?? 0;
      const debt = included[position];
      const base = `liabilities_terms.liabilities[${String(index)}]`;
      return [
        ref(`${base}.current_balance`),
        ref(`${base}.apr`),
        ref(`${base}.minimum_payment`),
        ...(debt?.promo === null || debt === undefined
          ? []
          : [ref(`${base}.promo_apr`), ref(`${base}.promo_apr_end_date`)]),
      ];
    };
    const allDebtRefs = included.flatMap((_debt, position) => refsOfDebt(position));
    const extraRef = ref('args.extra_monthly');
    const orderRef = ref('args.order');
    const startMonth = terms.as_of.slice(0, 7);
    const money = (minor: bigint) => ({ minor: minor.toString(), currency });

    const avalanche = avalancheOrder(included);
    const known = new Set(included.map((debt) => debt.ref));
    const sequences: { order: (typeof PAYOFF_ORDERS)[number]; sequence: readonly string[] }[] = [
      { order: 'avalanche', sequence: avalanche },
      { order: 'snowball', sequence: snowballOrder(included) },
    ];
    if (args.order === 'custom') {
      const named = (args.custom_order ?? []).filter(
        (entry, position, all) => all.indexOf(entry) === position,
      );
      const unknown = named.filter((entry) => !known.has(entry));
      if (unknown.length > 0) {
        throw new CatalogueRefusal(
          'catalogue.invalid_arguments',
          400,
          `custom_order names a liability_ref that is not an included debt: ${unknown.join(', ')}`,
        );
      }
      const rest = avalanche.filter((entry) => !named.includes(entry));
      sequences.push({ order: 'custom', sequence: [...named, ...rest] });
      (inputs['args'] as Record<string, unknown>)['custom_order'] = [...named];
    }

    const planRefs = [...allDebtRefs, extraRef];
    const plans = sequences.map(({ order, sequence }) => {
      const schedule: AmortisationResult = amortise({
        debts: included,
        extraMinor: BigInt(args.extra_monthly.minor),
        order: sequence,
        startMonth,
      });
      const refs = [...planRefs, ...(order === 'custom' ? [ref('args.custom_order')] : [])];
      const monthOf = (index: number | null) =>
        index === null
          ? null
          : dateFigure(monthStart(startMonth, index).slice(0, 7), [
              ...refs,
              ref('liabilities_terms.as_of'),
            ]);
      return {
        order,
        sequence: [...sequence],
        status: schedule.status,
        months:
          schedule.months === null ? null : decimalFigure(String(schedule.months), 'months', refs),
        payoff_month: monthOf(schedule.months),
        total_interest: moneyFigure(money(schedule.totalInterestMinor), refs),
        total_paid: moneyFigure(money(schedule.totalPaidMinor), refs),
        debts: schedule.debts.map((debt) => ({
          liability_ref: debt.ref,
          payoff_month: monthOf(debt.payoffMonthIndex),
          interest: moneyFigure(money(debt.interestMinor), refs),
        })),
        schedule,
      };
    });
    const chosen = plans.find((plan) => plan.order === args.order) ?? plans[0];
    if (chosen === undefined) throw new Error('no plan was computed');
    const differences = plans
      .filter((plan) => plan.order !== chosen.order)
      .map((plan) => ({
        chosen: chosen.order,
        other: plan.order,
        interest: moneyFigure(
          money(chosen.schedule.totalInterestMinor - plan.schedule.totalInterestMinor),
          [...planRefs, orderRef],
        ),
        months:
          chosen.schedule.months === null || plan.schedule.months === null
            ? null
            : decimalFigure(String(chosen.schedule.months - plan.schedule.months), 'months', [
                ...planRefs,
                orderRef,
              ]),
      }));

    return ok(inputs, {
      chosen: args.order,
      included: included.map((debt, position) => {
        const index = rows[position]?.index ?? 0;
        const base = `liabilities_terms.liabilities[${String(index)}]`;
        return {
          liability_ref: debt.ref,
          kind: rows[position]?.kind ?? 'other',
          balance: moneyFigure(money(debt.balanceMinor), [ref(`${base}.current_balance`)]),
          apr: decimalFigure(debt.apr, 'ratio', [ref(`${base}.apr`)]),
          promo_apr:
            debt.promo === null
              ? null
              : decimalFigure(debt.promo.apr, 'ratio', [ref(`${base}.promo_apr`)]),
          promo_apr_end:
            debt.promo === null
              ? null
              : dateFigure(debt.promo.endDate, [ref(`${base}.promo_apr_end_date`)]),
          minimum_payment: moneyFigure(money(debt.minimumMinor), [ref(`${base}.minimum_payment`)]),
        };
      }),
      excluded,
      monthly_budget: moneyFigure(money(chosen.schedule.monthlyBudgetMinor), planRefs),
      plans: plans.map(({ schedule: _schedule, ...plan }) => plan),
      differences,
    });
  },
});
