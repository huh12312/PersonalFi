// SPDX-License-Identifier: MIT
/**
 * `investing.allocation`, `.drift`, `.concentration`, `.costs`,
 * `.tax_location`, `limits.contribution_room` and `recurring.waste`
 * (WP 11.5b).
 *
 * The investing functions read `holdings.aggregate` / `holdings.detail` — the
 * snapshot's projection of WP 3.3's allocation, drift, concentration and fee
 * reports — and run the investing built-ins over the same snapshot, so a
 * figure here and a finding in the Brief come from one read. I12 (asset
 * location) has no engine yet, and `investing.tax_location` says so.
 */
import { DateOnly, Money } from '@core/kernel';
import { z } from 'zod';
import { DRIFT_BAND } from '../../advisors/builtin/investing/allocation.ts';
import {
  CONCENTRATION_THRESHOLD,
  EMPLOYER_STOCK_THRESHOLD,
} from '../../advisors/builtin/investing/concentration.ts';
import * as decimal from '../../validate/decimal.ts';
import { defineFunction, notAvailable, ok } from '../definition.ts';
import {
  DecimalFigureSchema,
  MoneyFigureSchema,
  decimalFigure,
  decimalText,
  moneyFigure,
  parseDecimalOrThrow,
  ref,
  snapshotInputs,
} from '../figures.ts';
import { CONTRIBUTION_ACCOUNT_KINDS, type ContributionAccountKind } from '../ports.ts';
import { FindingSchema, findingsOf, readParameter, scopesOfRules } from './shared.ts';

/** A snapshot ratio (decimalised to a string, or an integer 0/1 left a number) as a scale-6 decimal. */
function ratioOf(value: unknown): decimal.Decimal {
  return parseDecimalOrThrow(String(value));
}

function thresholdText(value: number): string {
  const parsed = decimal.fromNumber(value);
  if (parsed === null) throw new Error('a threshold the catalogue cannot carry');
  return decimalText(parsed);
}

// ---------------------------------------------------------------------------
// investing.allocation
// ---------------------------------------------------------------------------

export const investingAllocation = defineFunction({
  name: 'investing.allocation',
  summary: 'What the investable portfolio holds, by asset class, with the share no class covers.',
  description:
    'Weights and values per asset class over the investable total (07 §4.1), the unclassified ' +
    'share 07 §4.3 requires beside every allocation figure, and the account-type mix.',
  backing: 'WP 3.3’s allocation report, through holdings.aggregate (snapshot/builder.ts)',
  scopes: ['holdings.aggregate'],
  scopeRule: 'all',
  args: z.strictObject({}),
  result: z.strictObject({
    investable_total: MoneyFigureSchema,
    unclassified_share: DecimalFigureSchema,
    classes: z.array(
      z.strictObject({
        asset_class: z.string(),
        weight: DecimalFigureSchema,
        value: MoneyFigureSchema,
      }),
    ),
    account_type_mix: z.array(
      z.strictObject({ account_type: z.string(), share: DecimalFigureSchema }),
    ),
  }),
  async run(context, _args, scopes) {
    const snapshot = await context.snapshot(scopes);
    const inputs: Record<string, unknown> = { ...snapshotInputs(snapshot), args: {} };
    const aggregate = snapshot.holdings_aggregate;
    const decimals = inputs['holdings_aggregate'] as
      | {
          unclassified_pct: unknown;
          by_asset_class: { weight: unknown }[];
          account_type_mix: Record<string, unknown>;
        }
      | undefined;
    if (aggregate === undefined || decimals === undefined) {
      return notAvailable(inputs, 'no_holdings', 'No investment holdings are on record.');
    }
    return ok(inputs, {
      investable_total: moneyFigure(aggregate.investable_total, [
        ref('holdings_aggregate.investable_total'),
      ]),
      unclassified_share: decimalFigure(String(decimals.unclassified_pct), 'ratio', [
        ref('holdings_aggregate.unclassified_pct'),
      ]),
      classes: aggregate.by_asset_class.map((row, index) => ({
        asset_class: row.asset_class,
        weight: decimalFigure(String(decimals.by_asset_class[index]?.weight), 'ratio', [
          ref(`holdings_aggregate.by_asset_class[${String(index)}].weight`),
        ]),
        value: moneyFigure(row.value, [
          ref(`holdings_aggregate.by_asset_class[${String(index)}].value`),
        ]),
      })),
      account_type_mix: Object.keys(aggregate.account_type_mix)
        .filter((key) => /^[A-Za-z0-9_]+$/.test(key))
        .map((key) => ({
          account_type: key,
          share: decimalFigure(String(decimals.account_type_mix[key]), 'ratio', [
            ref(`holdings_aggregate.account_type_mix.${key}`),
          ]),
        })),
    });
  },
});

// ---------------------------------------------------------------------------
// investing.drift
// ---------------------------------------------------------------------------

export const investingDrift = defineFunction({
  name: 'investing.drift',
  summary:
    'Each asset class’s weight against your target, the gap, and the dollars that would close it.',
  description:
    'Per asset class in the target or the portfolio: the actual weight, the target weight, the ' +
    'drift (actual − target) and the dollars that would bring it to target ((target − actual) × ' +
    'the investable total; positive means more is needed). Not available with no target set: ' +
    'an unset target never becomes an implied 60/40. I1’s 5-point band is reported, and I1’s ' +
    'own finding when it fires.',
  backing: 'I1 (builtin.investing.drift) and WP 3.3’s drift report, through holdings.aggregate',
  scopes: scopesOfRules(['I1']),
  scopeRule: 'all',
  args: z.strictObject({}),
  result: z.strictObject({
    investable_total: MoneyFigureSchema,
    unclassified_share: DecimalFigureSchema,
    band: DecimalFigureSchema,
    classes: z.array(
      z.strictObject({
        asset_class: z.string(),
        actual: DecimalFigureSchema,
        target: DecimalFigureSchema,
        drift: DecimalFigureSchema,
        outside_band: z.boolean(),
        amount_to_target: MoneyFigureSchema,
      }),
    ),
    findings: z.array(FindingSchema),
  }),
  async run(context, _args, scopes) {
    const snapshot = await context.snapshot(scopes);
    const inputs: Record<string, unknown> = {
      ...snapshotInputs(snapshot),
      args: {},
      thresholds: {
        drift_band: thresholdText(DRIFT_BAND),
        source: 'builtin.investing.drift (07 I1)',
      },
    };
    const aggregate = snapshot.holdings_aggregate;
    const decimals = inputs['holdings_aggregate'] as
      | {
          unclassified_pct: unknown;
          by_asset_class: { weight: unknown }[];
          target_allocation: { weight: unknown }[];
        }
      | undefined;
    if (aggregate === undefined || decimals === undefined) {
      return notAvailable(inputs, 'no_holdings', 'No investment holdings are on record.');
    }
    if (aggregate.target_allocation.length === 0) {
      return notAvailable(
        inputs,
        'no_target',
        'No target allocation is set, so there is nothing to drift from.',
      );
    }
    const band = ratioOf(thresholdText(DRIFT_BAND));
    const classes = [
      ...aggregate.target_allocation.map((row) => row.asset_class),
      ...aggregate.by_asset_class
        .map((row) => row.asset_class)
        .filter((name) => !aggregate.target_allocation.some((row) => row.asset_class === name)),
    ];
    const totalRef = ref('holdings_aggregate.investable_total');
    return ok(inputs, {
      investable_total: moneyFigure(aggregate.investable_total, [totalRef]),
      unclassified_share: decimalFigure(String(decimals.unclassified_pct), 'ratio', [
        ref('holdings_aggregate.unclassified_pct'),
      ]),
      band: decimalFigure(thresholdText(DRIFT_BAND), 'ratio', [ref('thresholds.drift_band')]),
      classes: classes.map((name) => {
        const actualIndex = aggregate.by_asset_class.findIndex((row) => row.asset_class === name);
        const targetIndex = aggregate.target_allocation.findIndex(
          (row) => row.asset_class === name,
        );
        const actualRef =
          actualIndex === -1
            ? ref('holdings_aggregate.by_asset_class')
            : ref(`holdings_aggregate.by_asset_class[${String(actualIndex)}].weight`);
        const targetRef =
          targetIndex === -1
            ? ref('holdings_aggregate.target_allocation')
            : ref(`holdings_aggregate.target_allocation[${String(targetIndex)}].weight`);
        const actual =
          actualIndex === -1 ? 0n : ratioOf(decimals.by_asset_class[actualIndex]?.weight);
        const target =
          targetIndex === -1 ? 0n : ratioOf(decimals.target_allocation[targetIndex]?.weight);
        const drift = actual - target;
        const toTarget = Money.multiplyByDecimal(
          Money.fromJSON(aggregate.investable_total),
          decimalText(target - actual),
        );
        const refs = [actualRef, targetRef];
        return {
          asset_class: name,
          actual: decimalFigure(decimalText(actual), 'ratio', [actualRef]),
          target: decimalFigure(decimalText(target), 'ratio', [targetRef]),
          drift: decimalFigure(decimalText(drift), 'ratio', refs),
          outside_band: (drift < 0n ? -drift : drift) > band,
          amount_to_target: moneyFigure(Money.toJSON(toTarget), [...refs, totalRef]),
        };
      }),
      findings: findingsOf(['I1'], snapshot, context),
    });
  },
});

// ---------------------------------------------------------------------------
// investing.concentration
// ---------------------------------------------------------------------------

export const investingConcentration = defineFunction({
  name: 'investing.concentration',
  summary:
    'The largest positions’ shares of the portfolio, against the single-position and employer-stock lines.',
  description:
    'The top positions by weight with their values, whether each is above I4’s 20% line, and the ' +
    'combined share of positions tagged as employer stock against I5’s 10% line, with I4’s and ' +
    'I5’s own findings when they fire. A symbol is a fact about a holding, never a recommendation.',
  backing:
    'I4 and I5 (builtin.investing.concentration, .employer_stock) and WP 3.3’s concentration report',
  scopes: scopesOfRules(['I4', 'I5']),
  scopeRule: 'all',
  args: z.strictObject({}),
  result: z.strictObject({
    single_position_line: DecimalFigureSchema,
    employer_stock_line: DecimalFigureSchema,
    positions: z.array(
      z.strictObject({
        symbol: z.string(),
        asset_class: z.string(),
        weight: DecimalFigureSchema,
        value: MoneyFigureSchema,
        employer_stock: z.boolean(),
        above_single_position_line: z.boolean(),
      }),
    ),
    employer_stock_share: DecimalFigureSchema,
    findings: z.array(FindingSchema),
  }),
  async run(context, _args, scopes) {
    const snapshot = await context.snapshot(scopes);
    const inputs: Record<string, unknown> = {
      ...snapshotInputs(snapshot),
      args: {},
      thresholds: {
        single_position: thresholdText(CONCENTRATION_THRESHOLD),
        employer_stock: thresholdText(EMPLOYER_STOCK_THRESHOLD),
        source: 'builtin.investing.concentration and .employer_stock (07 I4, I5)',
      },
    };
    const aggregate = snapshot.holdings_aggregate;
    const decimals = inputs['holdings_aggregate'] as
      { top_positions: { weight: unknown }[] } | undefined;
    if (aggregate === undefined || decimals === undefined) {
      return notAvailable(inputs, 'no_holdings', 'No investment holdings are on record.');
    }
    const line = ratioOf(thresholdText(CONCENTRATION_THRESHOLD));
    const employerRefs: string[] = [];
    let employer = 0n;
    const positions = aggregate.top_positions.map((row, index) => {
      const weightRef = ref(`holdings_aggregate.top_positions[${String(index)}].weight`);
      const weight = ratioOf(decimals.top_positions[index]?.weight);
      if (row.employer_stock) {
        employer += weight;
        employerRefs.push(
          weightRef,
          ref(`holdings_aggregate.top_positions[${String(index)}].employer_stock`),
        );
      }
      return {
        symbol: row.symbol,
        asset_class: row.asset_class,
        weight: decimalFigure(decimalText(weight), 'ratio', [weightRef]),
        value: moneyFigure(row.value, [
          ref(`holdings_aggregate.top_positions[${String(index)}].value`),
        ]),
        employer_stock: row.employer_stock,
        above_single_position_line: weight > line,
      };
    });
    return ok(inputs, {
      single_position_line: decimalFigure(thresholdText(CONCENTRATION_THRESHOLD), 'ratio', [
        ref('thresholds.single_position'),
      ]),
      employer_stock_line: decimalFigure(thresholdText(EMPLOYER_STOCK_THRESHOLD), 'ratio', [
        ref('thresholds.employer_stock'),
      ]),
      positions,
      employer_stock_share: decimalFigure(
        decimalText(employer),
        'ratio',
        employerRefs.length === 0 ? [ref('holdings_aggregate.top_positions')] : employerRefs,
      ),
      findings: findingsOf(['I4', 'I5'], snapshot, context),
    });
  },
});

// ---------------------------------------------------------------------------
// investing.costs
// ---------------------------------------------------------------------------

export const investingCosts = defineFunction({
  name: 'investing.costs',
  summary: 'What each fund charges a year, against a comparable index fund where one is known.',
  description:
    'Per position with a known expense ratio: the ratio, a comparable fund’s where known, the ' +
    'annual cost (market value × ratio, rounded once upstream) and whether I2 calls it high; the ' +
    'total annual cost of the funds with a known ratio; I2’s own finding when it fires.',
  backing: 'I2 (builtin.investing.expense_ratio) and WP 3.3’s fee report, through holdings.detail',
  scopes: scopesOfRules(['I2']),
  scopeRule: 'all',
  args: z.strictObject({}),
  result: z.strictObject({
    funds: z.array(
      z.strictObject({
        symbol: z.string(),
        market_value: MoneyFigureSchema,
        expense_ratio: DecimalFigureSchema,
        peer_expense_ratio: DecimalFigureSchema.nullable(),
        annual_cost: MoneyFigureSchema.nullable(),
        high_fee: z.boolean(),
      }),
    ),
    total_annual_cost: MoneyFigureSchema.nullable(),
    findings: z.array(FindingSchema),
  }),
  async run(context, _args, scopes) {
    const snapshot = await context.snapshot(scopes);
    const inputs: Record<string, unknown> = { ...snapshotInputs(snapshot), args: {} };
    const detail = snapshot.holdings_detail;
    const decimals = inputs['holdings_detail'] as
      { positions: { expense_ratio: unknown; peer_expense_ratio: unknown }[] } | undefined;
    if (detail === undefined || decimals === undefined) {
      return notAvailable(inputs, 'no_holdings', 'No investment holdings are on record.');
    }
    const costRefs: string[] = [];
    let total: ReturnType<typeof Money.zero> | null = null;
    const funds = detail.positions.flatMap((row, index) => {
      if (row.expense_ratio === null) return [];
      const base = `holdings_detail.positions[${String(index)}]`;
      const ratios = decimals.positions[index];
      if (row.annual_fee_cost !== null) {
        const cost = Money.fromJSON(row.annual_fee_cost);
        total = total === null ? cost : Money.add(total, cost);
        costRefs.push(ref(`${base}.annual_fee_cost`));
      }
      return [
        {
          symbol: row.symbol,
          market_value: moneyFigure(row.market_value, [ref(`${base}.market_value`)]),
          expense_ratio: decimalFigure(String(ratios?.expense_ratio), 'ratio', [
            ref(`${base}.expense_ratio`),
          ]),
          peer_expense_ratio:
            row.peer_expense_ratio === null
              ? null
              : decimalFigure(String(ratios?.peer_expense_ratio), 'ratio', [
                  ref(`${base}.peer_expense_ratio`),
                ]),
          annual_cost:
            row.annual_fee_cost === null
              ? null
              : moneyFigure(row.annual_fee_cost, [ref(`${base}.annual_fee_cost`)]),
          high_fee: row.high_fee,
        },
      ];
    });
    const summed = total as ReturnType<typeof Money.zero> | null;
    return ok(inputs, {
      funds,
      total_annual_cost: summed === null ? null : moneyFigure(Money.toJSON(summed), costRefs),
      findings: findingsOf(['I2'], snapshot, context),
    });
  },
});

// ---------------------------------------------------------------------------
// investing.tax_location
// ---------------------------------------------------------------------------

export const investingTaxLocation = defineFunction({
  name: 'investing.tax_location',
  summary: 'Asset location (07 I12): not available — no engine computes it yet.',
  description:
    'Always answers not_available with the reason. 07 I12 (bonds or high-dividend holdings in ' +
    'taxable while tax-advantaged space holds equities) is in the rule catalogue but not built, ' +
    'and the catalogue does not invent a finding to stand in for it.',
  backing:
    'none yet — I12 is listed in CATALOGUE_GAPS-style terms in the playbook’s tax-location page',
  scopes: ['holdings.detail'],
  scopeRule: 'all',
  args: z.strictObject({}),
  result: z.strictObject({}),
  async run() {
    return notAvailable(
      { args: {} },
      'engine_not_built',
      'Asset location (07 rule I12) has no engine in this build: nothing computes which holdings ' +
        'sit in which kind of account against where they would be taxed least. The figure is not ' +
        'estimated here.',
    );
  },
});

// ---------------------------------------------------------------------------
// limits.contribution_room
// ---------------------------------------------------------------------------

interface LimitKeys {
  readonly limit: string;
  readonly catchUps: readonly { readonly key: string; readonly applies: string }[];
  readonly caveat: string;
}

const LIMIT_KEYS: Readonly<Record<ContributionAccountKind, LimitKeys>> = Object.freeze({
  ira: {
    limit: 'retirement.ira_contribution',
    catchUps: [{ key: 'retirement.ira_catch_up_age_50', applies: 'from age fifty' }], // gitleaks:allow — a parameter key, not a secret
    caveat:
      'One limit is shared across traditional and Roth IRAs, and a year’s contributions can be ' +
      'made until the filing deadline the following April.',
  },
  workplace_deferral: {
    limit: 'retirement.elective_deferral',
    catchUps: [
      { key: 'retirement.catch_up_age_50', applies: 'from age fifty' }, // gitleaks:allow — a parameter key, not a secret
      {
        key: 'retirement.catch_up_age_60_to_63', // gitleaks:allow — a parameter key, not a secret
        applies: 'ages sixty to sixty-three, in place of the above',
      },
    ],
    caveat:
      'The deferral limit covers the holder’s own deferrals. An employer contribution recorded ' +
      'as a contribution in the account is counted here too and does not count against it.',
  },
  hsa_self_only: {
    limit: 'hsa.self_only',
    catchUps: [{ key: 'hsa.catch_up_age_55', applies: 'from age fifty-five' }],
    caveat:
      'Self-only coverage; contributions through payroll are counted only if the account records them.',
  },
  hsa_family: {
    limit: 'hsa.family',
    catchUps: [{ key: 'hsa.catch_up_age_55', applies: 'from age fifty-five' }],
    caveat:
      'Family coverage; contributions through payroll are counted only if the account records them.',
  },
});

export const limitsContributionRoom = defineFunction({
  name: 'limits.contribution_room',
  summary:
    'A year’s contribution limit for an account kind, what has gone in, what is left and the days left.',
  description:
    'The limit is read from the parameter store for exactly the year asked; a year the store does ' +
    'not hold is refused (catalogue.year_unavailable), never answered from another year. What has ' +
    'gone in is the ledger’s investment activity classified as a contribution (WP 10.3’s ' +
    'classifier) into accounts of that kind, by month; transfers and rollovers are not counted. ' +
    'Catch-up amounts are listed, not added: the holder’s age is not read.',
  backing:
    'WP 4.2’s parameter store (tax.us.<year>.retirement.* / hsa.*, via parameterByKey) and the ' +
    'investment activity classifier (classifyActivity, GET /investments/transactions)',
  scopes: ['cashflow.monthly'],
  scopeRule: 'all',
  args: z.strictObject({
    year: z.int().min(2000).max(2100),
    account_kind: z.enum(CONTRIBUTION_ACCOUNT_KINDS),
  }),
  result: z.strictObject({
    year: DecimalFigureSchema,
    account_kind: z.enum(CONTRIBUTION_ACCOUNT_KINDS),
    limit: MoneyFigureSchema,
    catch_ups: z.array(z.strictObject({ applies: z.string(), amount: MoneyFigureSchema })),
    contributed: MoneyFigureSchema,
    remaining: MoneyFigureSchema,
    over_limit: MoneyFigureSchema,
    days_left: DecimalFigureSchema,
    caveats: z.array(z.string()),
  }),
  async run(context, args) {
    const keys = LIMIT_KEYS[args.account_kind];
    const limit = readParameter(context, `tax.us.${String(args.year)}.${keys.limit}`);
    if (limit === null || limit.kind !== 'money') {
      throw new Error(`the parameter store has no money node for ${keys.limit}`);
    }
    const catchUps = keys.catchUps.flatMap((entry) => {
      const parameter = readParameter(context, `tax.us.${String(args.year)}.${entry.key}`);
      return parameter === null || parameter.kind !== 'money'
        ? []
        : [{ parameter, applies: entry.applies }];
    });
    const limitMoney = limit.value as { minor: string; currency: string };
    const contributions = await context.ports.contributions.contributions({
      userId: context.userId,
      year: args.year,
      accountKind: args.account_kind,
    });
    let contributedMinor = 0n;
    for (const month of contributions.months) contributedMinor += BigInt(month.total.minor);
    const currency = limitMoney.currency;
    const money = (minor: bigint) => ({ minor: minor.toString(), currency });
    const inputs: Record<string, unknown> = {
      args: { year: args.year, account_kind: args.account_kind },
      as_of: context.today,
      parameters: [limit, ...catchUps.map((entry) => entry.parameter)],
      contributions: {
        currency: contributions.currency,
        accounts_counted: contributions.accountsCounted,
        months: contributions.months.map((month) => ({ month: month.month, total: month.total })),
        total: money(contributedMinor),
        excluded: contributions.excluded.map((row) => ({ reason: row.reason, count: row.count })),
        classifier:
          'classifyActivity (@ctx/investments, WP 10.3): kind contribution, cash flow only',
      },
    };
    if (contributions.currency !== currency) {
      return notAvailable(
        inputs,
        'currency_mismatch',
        `The contributions are in ${contributions.currency} and the limit in ${currency}; nothing is converted.`,
      );
    }
    const limitMinor = BigInt(limitMoney.minor);
    const remaining = limitMinor > contributedMinor ? limitMinor - contributedMinor : 0n;
    const over = contributedMinor > limitMinor ? contributedMinor - limitMinor : 0n;
    const thisYear = DateOnly.year(context.today);
    const daysLeft =
      args.year < thisYear
        ? 0
        : DateOnly.differenceInDays(context.today, DateOnly.of(args.year, 12, 31));
    const limitRef = ref('parameters[0].value');
    const usedRef = ref('contributions.total');
    return ok(inputs, {
      year: decimalFigure(String(args.year), 'year', [ref('args.year')]),
      account_kind: args.account_kind,
      limit: moneyFigure(limitMoney, [limitRef]),
      catch_ups: catchUps.map((entry, index) => ({
        applies: entry.applies,
        amount: moneyFigure(entry.parameter.value as { minor: string; currency: string }, [
          ref(`parameters[${String(index + 1)}].value`),
        ]),
      })),
      contributed: moneyFigure(money(contributedMinor), [usedRef]),
      remaining: moneyFigure(money(remaining), [limitRef, usedRef]),
      over_limit: moneyFigure(money(over), [limitRef, usedRef]),
      days_left: decimalFigure(String(Math.max(0, daysLeft)), 'days', [
        ref('args.year'),
        ref('as_of'),
      ]),
      caveats: [
        keys.caveat,
        'Catch-up amounts apply only at the ages shown and are not added to the limit here.',
      ],
    });
  },
});

// ---------------------------------------------------------------------------
// recurring.waste
// ---------------------------------------------------------------------------

/**
 * The U rules the catalogue runs: U2 (a confirmed price increase) and U7
 * (subscriptions against take-home). U3 (duplicate services) is built but reads
 * `transactions.raw` — row-level transactions, which is never a catalogue
 * scope — so it is not reachable here; its finding reaches the holder through
 * the Brief and `insights.current` instead.
 */
export const WASTE_RULES = ['U2', 'U7'] as const;

export const recurringWaste = defineFunction({
  name: 'recurring.waste',
  summary: 'Subscription findings with their annual cost: price rises and the share of income.',
  description:
    'Runs U2 (a confirmed price increase) and U7 (subscriptions against take-home) over the ' +
    'recurring streams and reports each finding with the annual figure the rule computed. U3 ' +
    '(duplicate services) reads row-level transactions, which no catalogue function may, and is ' +
    'reported through the Brief instead. U1, U4, U5, U6 and U8 are not built and are not ' +
    'estimated. Vendors cross as tokens, never names.',
  backing: 'U2 and U7 (advisors/rules-subscriptions.ts) over recurring.list and cashflow.monthly',
  scopes: scopesOfRules(WASTE_RULES),
  scopeRule: 'all',
  args: z.strictObject({}),
  result: z.strictObject({ findings: z.array(FindingSchema) }),
  async run(context, _args, scopes) {
    const snapshot = await context.snapshot(scopes);
    const inputs: Record<string, unknown> = { ...snapshotInputs(snapshot), args: {} };
    return ok(inputs, { findings: findingsOf(WASTE_RULES, snapshot, context) });
  },
});
