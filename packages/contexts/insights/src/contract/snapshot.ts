// SPDX-License-Identifier: MIT
/**
 * `AdvisorSnapshot` v1 — the only thing that crosses the boundary inbound.
 *
 * Read-only, versioned, and **minimised before it is built, not after**. Every
 * block below corresponds to exactly one row of `scopes.ts`, and a block appears
 * only when that scope was granted *and* the builder had a source for it.
 *
 * ## What is not in this file, deliberately
 *
 * There is no account number, no mask, no institution name, no provider id, no
 * access token, no display name, no email, no address, no user note and no raw
 * descriptor — and none of them is absent by being filtered out somewhere, they
 * are absent because **this type has nowhere to put them**. That is the
 * difference between a minimisation rule and a minimisation *mechanism*: adding
 * `institutionName` to a block here would be a visible, reviewable diff in the
 * published contract, not a field that leaks because a mapper forgot a `delete`.
 *
 * ## Money
 *
 * Money crosses as `{ minor: "1234", currency: "USD" }` — minor units in a
 * string (docs/CONVENTIONS.md, "On the wire"). `bigint` does not survive
 * `JSON.stringify` and IEEE-754 loses cents, so a JSON number is not available
 * for money at any point in this contract. Ratios (weights, confidence,
 * coverage, APY) *are* JSON numbers, because they are ratios and never flow back
 * into a `*_minor` column.
 *
 * ## Refs, not identities
 *
 * Merchants cross as `MERCHANT_<12 hex>` — a keyed, stable pseudonym (03 §8.3).
 * Accounts and categories cross as their own uuids for a `builtin` or
 * `local_model` advisor (the app is going to render a link back to them) and as
 * tokens for an `external` one. `builder.ts` owns that decision; this schema
 * accepts either because both are opaque strings to the advisor, which is the
 * point.
 */
import { z } from 'zod';

/** `{ minor, currency }`. A string for the minor units; never a JSON number. */
export const MoneyJsonSchema = z
  .strictObject({
    minor: z.string().regex(/^-?\d{1,20}$/, 'minor units as a decimal integer string'),
    currency: z.string().regex(/^[A-Z]{3}$/),
  })
  .describe('Money as minor units in a string, paired with an ISO-4217 code.');

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
const yearMonth = z.string().regex(/^\d{4}-\d{2}$/, 'YYYY-MM');
/** A ratio in [0,1]. Floats are correct here and may never reach a `_minor` column. */
const unitInterval = z.number().min(0).max(1);
/** `MERCHANT_<12 hex>`, or any opaque ref the builder minted. Never a name. */
const opaqueRef = z.string().min(1).max(64).regex(/^[A-Za-z0-9_:.-]+$/, 'opaque ref');

/**
 * 03 §8.3's amount buckets. A band, not a figure.
 *
 * The exhaustive ladder is part of the contract rather than a formatter's
 * choice, because an advisor that has learned `'50-200'` must keep meaning the
 * same thing next release, and because the validator has to be able to tell a
 * bucket label from a number an advisor invented.
 */
export const AMOUNT_BUCKETS = [
  '0-10',
  '10-50',
  '50-200',
  '200-1000',
  '1000-5000',
  '5000+',
] as const;
export type AmountBucket = (typeof AMOUNT_BUCKETS)[number];
const amountBucket = z.enum(AMOUNT_BUCKETS);

// ---------------------------------------------------------------------------
// networth.summary
// ---------------------------------------------------------------------------

export const NetWorthSummarySchema = z.strictObject({
  as_of: dateOnly,
  /** Rounded to $100 by the builder (08 §4.2). Still minor units. */
  assets: MoneyJsonSchema,
  liabilities: MoneyJsonSchema,
  net_worth: MoneyJsonSchema,
  /** Up to 12 points, oldest first. Month granularity; no finer. */
  trend: z.array(z.strictObject({ month: yearMonth, net_worth: MoneyJsonSchema })).max(12),
});

// ---------------------------------------------------------------------------
// cash.summary
// ---------------------------------------------------------------------------

export const CashSummarySchema = z.strictObject({
  as_of: dateOnly,
  total: MoneyJsonSchema,
  account_count: z.number().int().nonnegative(),
  /** Balance-weighted. A ratio: 0.0001 is 0.01% APY. */
  blended_apy: unitInterval,
  /** `null` when no monthly expense figure is available to divide by. */
  emergency_fund_months: z.number().min(0).max(600).nullable(),
  accounts: z
    .array(
      z.strictObject({
        /** Opaque. Never a name, never a mask, never an institution. */
        account_ref: opaqueRef,
        type: z.enum(['checking', 'savings', 'money_market', 'cash_management', 'other']),
        balance: MoneyJsonSchema,
        apy: unitInterval.nullable(),
      }),
    )
    .max(64),
});

// ---------------------------------------------------------------------------
// cashflow.monthly
// ---------------------------------------------------------------------------

export const CashflowMonthlySchema = z.strictObject({
  from_month: yearMonth,
  to_month: yearMonth,
  currency: z.string().regex(/^[A-Z]{3}$/),
  months: z
    .array(
      z.strictObject({
        month: yearMonth,
        income: MoneyJsonSchema,
        expense: MoneyJsonSchema,
        net: MoneyJsonSchema,
        by_category: z
          .array(
            z.strictObject({
              category_ref: opaqueRef,
              /** The taxonomy slug (`food.dining`), not a user-written name. */
              category_slug: z.string().min(1).max(96),
              amount: MoneyJsonSchema,
            }),
          )
          .max(128),
      }),
    )
    .max(24),
});

// ---------------------------------------------------------------------------
// budgets.status
// ---------------------------------------------------------------------------

export const BudgetsStatusSchema = z.strictObject({
  period_start: dateOnly,
  /** **Exclusive**, as everywhere in `@ctx/budgeting`. */
  period_end: dateOnly,
  period_kind: z.string().min(1).max(32),
  currency: z.string().regex(/^[A-Z]{3}$/),
  ready_to_assign: MoneyJsonSchema,
  /** Fraction of the period elapsed, for a pace comparison. */
  elapsed: unitInterval,
  lines: z
    .array(
      z.strictObject({
        line_ref: opaqueRef,
        category_ref: opaqueRef.nullable(),
        category_slug: z.string().min(1).max(96).nullable(),
        kind: z.string().min(1).max(32),
        assigned: MoneyJsonSchema,
        activity: MoneyJsonSchema,
        available: MoneyJsonSchema,
        /** 07 §1.3's red half: cash has already left a depository account. */
        cash_overspend: MoneyJsonSchema,
        /** 07 §1.3's yellow half: borrowed on a card; no cash has moved. */
        credit_overspend: MoneyJsonSchema,
        needed_this_period: MoneyJsonSchema,
        underfunded: MoneyJsonSchema,
      }),
    )
    .max(256),
});

// ---------------------------------------------------------------------------
// recurring.list
// ---------------------------------------------------------------------------

export const RecurringListSchema = z.strictObject({
  as_of: dateOnly,
  currency: z.string().regex(/^[A-Z]{3}$/),
  streams: z
    .array(
      z.strictObject({
        series_ref: opaqueRef,
        /** `MERCHANT_<hash>`. The vendor, tokenised, always (D22). */
        merchant_ref: opaqueRef,
        cadence: z.string().min(1).max(32),
        type: z.string().min(1).max(32),
        status: z.string().min(1).max(32),
        user_confirmed: z.boolean(),
        confidence: unitInterval,
        typical_amount: MoneyJsonSchema,
        observed_min: MoneyJsonSchema,
        observed_max: MoneyJsonSchema,
        /** `null` for a stream that has stopped forecasting. */
        next_due_date: dateOnly.nullable(),
        first_seen: dateOnly,
        last_seen: dateOnly,
        periods_per_year: z.number().min(0).max(366),
        /** 07 §2.4: an EARLY_DETECTION stream never drives a $-impact insight. */
        eligible_for_impact: z.boolean(),
        price_changes: z
          .array(
            z.strictObject({
              effective_date: dateOnly,
              direction: z.enum(['INCREASE', 'DECREASE']),
              previous_amount: MoneyJsonSchema,
              new_amount: MoneyJsonSchema,
              annual_impact: MoneyJsonSchema,
            }),
          )
          .max(12),
      }),
    )
    .max(512),
});

// ---------------------------------------------------------------------------
// transactions.summary
// ---------------------------------------------------------------------------

export const TransactionsSummarySchema = z.strictObject({
  from_month: yearMonth,
  to_month: yearMonth,
  currency: z.string().regex(/^[A-Z]{3}$/),
  by_category: z
    .array(
      z.strictObject({
        category_ref: opaqueRef,
        category_slug: z.string().min(1).max(96),
        count: z.number().int().nonnegative(),
        total: MoneyJsonSchema,
      }),
    )
    .max(128),
  top_merchants: z
    .array(
      z.strictObject({
        merchant_ref: opaqueRef,
        count: z.number().int().nonnegative(),
        total: MoneyJsonSchema,
      }),
    )
    .max(64),
});

// ---------------------------------------------------------------------------
// transactions.raw
// ---------------------------------------------------------------------------

export const TransactionsRawSchema = z.strictObject({
  from_date: dateOnly,
  to_date: dateOnly,
  currency: z.string().regex(/^[A-Z]{3}$/),
  rows: z
    .array(
      z.strictObject({
        transaction_ref: opaqueRef,
        date: dateOnly,
        merchant_ref: opaqueRef.nullable(),
        category_slug: z.string().min(1).max(96).nullable(),
        /** A band. 03 §8.3: exact amounts across enough rows are a fingerprint. */
        amount_bucket: amountBucket,
        direction: z.enum(['outflow', 'inflow']),
      }),
    )
    .max(2000),
});

// ---------------------------------------------------------------------------
// The blocks Phase 3/4 will fill
// ---------------------------------------------------------------------------

export const HoldingsAggregateSchema = z.strictObject({
  as_of: dateOnly,
  by_asset_class: z
    .array(z.strictObject({ asset_class: z.string().min(1).max(32), weight: unitInterval }))
    .max(32),
  top_positions: z
    .array(z.strictObject({ symbol: z.string().min(1).max(16), weight: unitInterval }))
    .max(32),
  target_allocation: z
    .array(z.strictObject({ asset_class: z.string().min(1).max(32), weight: unitInterval }))
    .max(32),
  account_type_mix: z.record(z.string().max(32), unitInterval),
});

export const HoldingsDetailSchema = z.strictObject({
  as_of: dateOnly,
  positions: z
    .array(
      z.strictObject({
        symbol: z.string().min(1).max(16),
        quantity: z.string().regex(/^-?\d+(\.\d+)?$/, 'decimal string, never a float'),
        cost_basis: MoneyJsonSchema,
        market_value: MoneyJsonSchema,
        unrealized: MoneyJsonSchema,
        oldest_lot_days: z.number().int().nonnegative(),
      }),
    )
    .max(256),
});

export const GoalsListSchema = z.strictObject({
  goals: z
    .array(
      z.strictObject({
        goal_ref: opaqueRef,
        name: z.string().min(1).max(96),
        target: MoneyJsonSchema,
        horizon_months: z.number().int().nonnegative(),
        progress: unitInterval,
      }),
    )
    .max(64),
});

export const RiskProfileSchema = z.strictObject({
  tolerance: z.string().min(1).max(32),
  horizon_years: z.number().int().min(0).max(100),
  /** A band (`'22-32'`), never the figure. */
  tax_bracket_band: z.string().min(1).max(16),
  liquidity_need: z.enum(['low', 'medium', 'high']),
});

export const MarketWatchlistSchema = z.strictObject({
  symbols: z.array(z.string().min(1).max(16)).max(128),
});

export const InstitutionsNamesSchema = z.strictObject({
  institutions: z
    .array(z.strictObject({ institution_ref: opaqueRef, name: z.string().min(1).max(96) }))
    .max(64),
});

// ---------------------------------------------------------------------------
// The snapshot
// ---------------------------------------------------------------------------

/**
 * Every block is optional and every block is `additionalProperties: false`.
 *
 * Optional because absence is the mechanism: an ungranted scope, or a granted
 * scope with no source behind it, produces **no key**. `null` would have been
 * the wrong choice — an advisor cannot tell a `null` block from an empty one and
 * would reason about zero — and so would `{}`.
 */
export const AdvisorSnapshotSchema = z
  .strictObject({
    networth_summary: NetWorthSummarySchema.optional(),
    cash_summary: CashSummarySchema.optional(),
    cashflow_monthly: CashflowMonthlySchema.optional(),
    budgets_status: BudgetsStatusSchema.optional(),
    recurring_list: RecurringListSchema.optional(),
    goals_list: GoalsListSchema.optional(),
    risk_profile: RiskProfileSchema.optional(),
    market_watchlist: MarketWatchlistSchema.optional(),
    holdings_aggregate: HoldingsAggregateSchema.optional(),
    holdings_detail: HoldingsDetailSchema.optional(),
    transactions_summary: TransactionsSummarySchema.optional(),
    transactions_raw: TransactionsRawSchema.optional(),
    institutions_names: InstitutionsNamesSchema.optional(),
  })
  .describe('The minimised, read-only view an advisor receives. One key per granted scope.');

export type AdvisorSnapshot = z.infer<typeof AdvisorSnapshotSchema>;
export type MoneyJson = z.infer<typeof MoneyJsonSchema>;
