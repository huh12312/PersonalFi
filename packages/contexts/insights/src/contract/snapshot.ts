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
const opaqueRef = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_:.-]+$/, 'opaque ref');

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
  /**
   * ISO-4217 codes left out of `assets`/`liabilities`/`net_worth` because no
   * FX conversion was available for them (WP 4.12b, C-10/G3-13). Absent when
   * every open account already matched the base currency, or every mismatch
   * converted. The builder never folds an unconverted account in at par.
   */
  excluded_currencies: z
    .array(z.string().regex(/^[A-Z]{3}$/))
    .max(16)
    .optional(),
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
  /** Same rule as `NetWorthSummarySchema.excluded_currencies`, for `total`. */
  excluded_currencies: z
    .array(z.string().regex(/^[A-Z]{3}$/))
    .max(16)
    .optional(),
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
// transactions.anomalies, fees.summary — WP 5.7
// ---------------------------------------------------------------------------

/** How many trailing months a robust-statistics window covers. Reported, not implied. */
const twelveMonthWindow = z.number().int().positive().max(24);

/**
 * `transactions.anomalies` — S1 and S5, only the rows that already qualified.
 *
 * `baseline_median` and `baseline_mad` are `null` together, exactly when the
 * row's category had fewer than `SNAPSHOT_WINDOWS.anomalyMinSample`
 * transactions in the window to found a baseline on — S5 can still flag such a
 * row (its trigger needs no category baseline), S1 cannot. `deviation_multiple`
 * is `null` under the same condition: the ratio it reports is `|amount −
 * median| ÷ mad`, computed once at the boundary from the exact bigint
 * deviation and MAD, and is a presentation ratio like `weight` or `confidence`
 * — never fed back into a `*_minor` figure.
 */
export const TransactionsAnomaliesSchema = z.strictObject({
  as_of: dateOnly,
  currency: z.string().regex(/^[A-Z]{3}$/),
  window_months: twelveMonthWindow,
  /** The $25 materiality floor (09 Q17, 07 S1), reported rather than implied. */
  materiality_floor: MoneyJsonSchema,
  /** The ">3 robust deviations" threshold, as the multiple it is. */
  deviation_threshold: z.number().positive(),
  /** 07 S5's "> $250", reported so the rule's copy can cite it rather than print it. */
  new_merchant_floor: MoneyJsonSchema,
  rows: z
    .array(
      z.strictObject({
        transaction_ref: opaqueRef,
        date: dateOnly,
        category_slug: z.string().min(1).max(96).nullable(),
        merchant_ref: opaqueRef.nullable(),
        /** Exact. This scope does not bucket — a masked outlier is not an outlier. */
        amount: MoneyJsonSchema,
        baseline_median: MoneyJsonSchema.nullable(),
        baseline_mad: MoneyJsonSchema.nullable(),
        deviation_multiple: z.number().nonnegative().nullable(),
        /** S5's trigger: this row is the merchant's earliest appearance in the window. */
        first_seen_merchant: z.boolean(),
        /**
         * 09 NOT-5: a pending charge that later posts is the same `id` (D10),
         * so it is the same `transaction_ref` and the same insight key — this
         * field is for the separate case, a near-identical charge the builder
         * folded rather than flagging twice. `null` on almost every row.
         */
        duplicate_of: opaqueRef.nullable(),
        /** One of `fees.summary`'s type slugs when this row's category is one, else `null`. */
        fee_type: z.string().min(1).max(64).nullable(),
      }),
    )
    .max(500),
});

/**
 * `fees.summary` — totals, never a row. `builtin.spending.fee_hunter` sums the
 * avoidable subset and picks the worst offender itself, from these totals; the
 * scope declares the classification (which type is avoidable) so the rule
 * does not.
 */
export const FeesSummarySchema = z.strictObject({
  as_of: dateOnly,
  currency: z.string().regex(/^[A-Z]{3}$/),
  window_months: twelveMonthWindow,
  by_type: z
    .array(
      z.strictObject({
        type: z.string().min(1).max(64),
        /** `false` only for interest charges — 07: "interest charges are the D family's". */
        avoidable: z.boolean(),
        count: z.number().int().nonnegative(),
        total: MoneyJsonSchema,
      }),
    )
    .max(16),
  by_account: z
    .array(
      z.strictObject({
        account_ref: opaqueRef,
        count: z.number().int().nonnegative(),
        total: MoneyJsonSchema,
      }),
    )
    .max(64),
  /**
   * `holdings.detail.positions[].annual_fee_cost`, summed — never recomputed.
   * `null` unless `holdings.detail` was *also* granted, the same cross-scope
   * rule `cash.summary.emergency_fund_months` follows.
   */
  expense_ratio_drag: MoneyJsonSchema.nullable(),
});

// ---------------------------------------------------------------------------
// categorization.rule_candidates — WP 11.1
// ---------------------------------------------------------------------------

/**
 * `categorization.rule_candidates` — merchants the holder keeps filing the
 * same way by hand, the input to `builtin.spending.rule_suggestion`.
 *
 * One row per (merchant, category) pair with at least two current, confirmed,
 * user-sourced assignments, most-confirmed first. The block carries every
 * such pair rather than only the ones over the advisor's threshold: the
 * threshold is a decision, and decisions belong to the advisor that is
 * tested on them, not to a reader.
 *
 * `transactions[]` is an array of objects rather than of bare refs so that
 * every evidence row citing one ends in a `transaction_ref` leaf — the leaf
 * `mentions.ts` and the web's evidence panel resolve an entity link from.
 */
export const RuleCandidatesSchema = z.strictObject({
  merchants: z
    .array(
      z.strictObject({
        /** `MERCHANT_<12 hex>`, for every advisor kind (D22). */
        merchant_ref: opaqueRef,
        /** The category's uuid for an in-process advisor; a token for any other. */
        category_ref: opaqueRef,
        category_slug: z.string().min(1).max(96),
        /** Current, user-sourced, confirmed assignments of this merchant to this category. */
        confirmations: z.number().int().positive(),
        /** An enabled rule would already file this merchant's newest confirmed transaction. */
        covered_by_rule: z.boolean(),
        /** The holder pinned this merchant's category, so the merchant tier already files it. */
        locked_default: z.boolean(),
        /** The newest confirmed transactions behind the count, newest first. */
        transactions: z
          .array(z.strictObject({ transaction_ref: opaqueRef }))
          .min(1)
          .max(8),
      }),
    )
    .max(64),
});

// ---------------------------------------------------------------------------
// holdings.aggregate, holdings.detail — WP 3.10
// ---------------------------------------------------------------------------

/**
 * A quantity. A decimal *string*, never a JSON number.
 *
 * D3 is irreversible and the Phase 3 risk table is blunt about why: portfolio
 * math multiplies quantity by price and then sums, so a float's error compounds
 * where nobody looks. `NUMERIC(38,18)` on the way in, a string on the wire.
 */
const quantityString = z.string().regex(/^-?\d+(\.\d+)?$/, 'decimal string, never a float');

const assetClass = z.string().min(1).max(32);
const symbol = z.string().min(1).max(16);

/**
 * How the account holding a position is taxed. A *class*, never the account.
 *
 * I6 needs "is this lot in a taxable account" and I12 needs "are bonds in the
 * wrong one". Neither needs to know which account, and 08 §4.2 is explicit that
 * `holdings.detail` carries no account id. So the tax treatment crosses on its
 * own, which is the whole of what the rules reason about.
 */
export const ACCOUNT_TAX_TREATMENTS = ['taxable', 'tax_deferred', 'tax_free', 'unknown'] as const;
export type AccountTaxTreatment = (typeof ACCOUNT_TAX_TREATMENTS)[number];

/**
 * `holdings.aggregate` — weights and pre-triggered aggregates, nothing per-account.
 *
 * Structurally a projection of WP 3.3's analytics *output*: `AllocationReport`
 * (`slices` → `by_asset_class`, `unclassifiedPct` → `unclassified_pct`),
 * `ConcentrationReport` (`investableTotal`, `positions` → `top_positions`),
 * `DriftReport` (`targets` → `target_allocation`) and `IdleCashReport`
 * (`idleTotal`, `floor`, `minDays` → `idle_cash`). Mirrored rather than
 * imported: `@ctx/insights` may not reach into `@ctx/investments` — the
 * boundary lint forbids it — and an advisor reads the snapshot, never a context.
 *
 * `unclassified_pct` is not optional and not nullable. 07 §4.3 requires it
 * "beside every allocation chart and drift number", and it is the input to I1's
 * self-suppression: a drift claim over a portfolio that is 18% unclassified is
 * noise, and a rule that could not see the coverage would state it anyway.
 */
export const HoldingsAggregateSchema = z.strictObject({
  as_of: dateOnly,
  currency: z.string().regex(/^[A-Z]{3}$/),
  /** 07 §4.1's `is_investable` base. Not net worth, not total holdings. */
  investable_total: MoneyJsonSchema,
  /** 07 §4.3's mandatory number. Present even when it is zero. */
  unclassified_pct: unitInterval,
  by_asset_class: z
    .array(
      z.strictObject({
        asset_class: assetClass,
        weight: unitInterval,
        value: MoneyJsonSchema,
      }),
    )
    .max(32),
  /**
   * Top-N by weight. `value` rides with `weight` rather than being reconstructed
   * from `weight × investable_total`: that product is a float times a money
   * figure, which is the arithmetic D3 exists to keep out of a money path.
   */
  top_positions: z
    .array(
      z.strictObject({
        symbol,
        weight: unitInterval,
        value: MoneyJsonSchema,
        asset_class: assetClass,
        /** I5. The user's own tag — this app never infers an employer. */
        employer_stock: z.boolean(),
        is_crypto: z.boolean(),
      }),
    )
    .max(32),
  /**
   * Empty when the user has not set one. §8 Q9 and the dispatch both say an
   * unset target never becomes an implied 60/40, so I1 withholds on an empty
   * list rather than inventing a benchmark to drift from.
   */
  target_allocation: z
    .array(z.strictObject({ asset_class: assetClass, weight: unitInterval }))
    .max(32),
  account_type_mix: z.record(z.string().max(32), unitInterval),
  /**
   * `IdleCashReport`, aggregated. Per-account rows would be account linkage,
   * which this scope does not carry, so the `max($1,000, 2% of account)`
   * threshold is applied by the builder and only the qualifying total crosses.
   */
  idle_cash: z
    .strictObject({
      total: MoneyJsonSchema,
      /** The `$1,000` floor, reported rather than implied, so I3 can cite it. */
      floor: MoneyJsonSchema,
      /** Days the *least* long-idle qualifying balance has been sitting. */
      min_days: z.number().int().nonnegative(),
      longest_idle_days: z.number().int().nonnegative(),
    })
    .optional(),
  /** X2. A split of crypto value by custody, with no wallet or venue named. */
  crypto_custody: z
    .strictObject({
      exchange_value: MoneyJsonSchema,
      self_custody_value: MoneyJsonSchema,
      unknown_value: MoneyJsonSchema,
    })
    .optional(),
});

/**
 * One tax lot. An **age**, never an open date.
 *
 * A lot's open date is a timestamp of a decision the user made; the age in days
 * is what I6, I18 and X5 actually test against. The coarser field answers every
 * question the catalogue asks and fingerprints nothing.
 */
const LotSchema = z.strictObject({
  opened_days: z.number().int().nonnegative(),
  quantity: quantityString,
  cost_basis: MoneyJsonSchema.nullable(),
  market_value: MoneyJsonSchema,
  /** `null` exactly when `cost_basis` is: an unknown basis is not a zero one. */
  unrealized: MoneyJsonSchema.nullable(),
  long_term: z.boolean(),
});

export const HoldingsDetailSchema = z.strictObject({
  as_of: dateOnly,
  currency: z.string().regex(/^[A-Z]{3}$/),
  positions: z
    .array(
      z.strictObject({
        symbol,
        asset_class: assetClass,
        account_type: z.enum(ACCOUNT_TAX_TREATMENTS),
        quantity: quantityString,
        /**
         * `null` when no basis is recorded — X6's whole subject, and the field
         * WP 3.11 renders as "unavailable" rather than "$0.00". A missing basis
         * that crossed as zero would make every unrealised gain wrong by the
         * whole position.
         */
        cost_basis: MoneyJsonSchema.nullable(),
        market_value: MoneyJsonSchema,
        unrealized: MoneyJsonSchema.nullable(),
        oldest_lot_days: z.number().int().nonnegative(),
        /** `cost_basis !== null`, stated so X6's trigger is a field, not a `!==`. */
        basis_known: z.boolean(),
        is_crypto: z.boolean(),
        /** X3. A stablecoin is a cash-like holding that is not insured cash. */
        is_stablecoin: z.boolean(),
        employer_stock: z.boolean(),
        /** `FeeRow.expenseRatio`. A ratio: 0.0014 is 0.14%. `null` when unknown. */
        expense_ratio: unitInterval.nullable(),
        /** What a comparable index fund charges, when one is known. I2's `alt`. */
        peer_expense_ratio: unitInterval.nullable(),
        /**
         * `FeeRow.annualCost` — `market_value × expense_ratio`, rounded once,
         * half-even, upstream. Carried rather than derived so the one
         * `money × ratio` multiplication happens in the context that owns the
         * rounding mode, not in a rule.
         */
        annual_fee_cost: MoneyJsonSchema.nullable(),
        /** `FeeRow.high` — 07 I2's trigger, evaluated once upstream. */
        high_fee: z.boolean(),
        lots: z.array(LotSchema).max(32),
      }),
    )
    .max(256),
});

// ---------------------------------------------------------------------------
// liabilities.terms — WP 3.10
// ---------------------------------------------------------------------------

export const LIABILITY_KINDS = [
  'credit_card',
  'student_loan',
  'mortgage',
  'auto_loan',
  'personal_loan',
  'line_of_credit',
  'other',
] as const;
export type LiabilityKind = (typeof LIABILITY_KINDS)[number];

/**
 * `liabilities.terms` — the APR / limit / statement-balance block.
 *
 * WP 2.7 listed U8, C5, C6 and the whole D family as unwritable, and every one
 * of those reasons named the same three missing fields. This is them.
 *
 * `liability_ref` is an opaque token from the same tokeniser that mints
 * `cash_summary.accounts[].account_ref`, so an insight key is stable across
 * runs without the advisor holding anything that means something outside this
 * snapshot. It is not an account id and resolving it is the app's job.
 *
 * Every term is nullable except the balance and the kind, because a liability
 * arriving from an aggregator routinely has no APR, no limit and no statement —
 * and a rule that cannot see a term must withhold rather than assume one. D2
 * and D4 both gate on a non-null APR for exactly that reason.
 */
export const LiabilitiesTermsSchema = z.strictObject({
  as_of: dateOnly,
  currency: z.string().regex(/^[A-Z]{3}$/),
  liabilities: z
    .array(
      z.strictObject({
        liability_ref: opaqueRef,
        kind: z.enum(LIABILITY_KINDS),
        /** A ratio: 0.2399 is 23.99% APR. `null` when the provider gave none. */
        apr: unitInterval.nullable(),
        /** A promotional rate in force now, typically 0. `null` when there is none. */
        promo_apr: unitInterval.nullable(),
        /** When the promotional rate ends and `apr` takes over. D4's trigger. */
        promo_apr_end_date: dateOnly.nullable(),
        credit_limit: MoneyJsonSchema.nullable(),
        /** What the last statement reported. C5's utilisation numerator. */
        statement_balance: MoneyJsonSchema.nullable(),
        /** Always present: a liability with no balance is not a liability. */
        current_balance: MoneyJsonSchema,
        minimum_payment: MoneyJsonSchema.nullable(),
        payment_due_date: dateOnly.nullable(),
        last_payment_date: dateOnly.nullable(),
        last_payment_amount: MoneyJsonSchema.nullable(),
        /**
         * How many of the recent months were paid at the minimum only. D3's
         * "3+ months" trigger, counted by the reader that holds the payment
         * history; `null` when there is not enough history to count.
         */
        minimum_only_months: z.number().int().min(0).max(120).nullable(),
      }),
    )
    .max(64),
});

// ---------------------------------------------------------------------------
// market.rates — WP 3.10
// ---------------------------------------------------------------------------

/**
 * What a rate is *for*. Named, because a rule must not pick a series by string.
 *
 * C1 and C2 want what cash could earn; D2 wants what comparable borrowing
 * costs; X3 wants what a bank or T-bill would pay on an idle stablecoin. A rule
 * selecting `'DGS3MO'` by literal would break the day the deployment tracked
 * `'TB3MS'` instead, and would also be a series id hardcoded in a rule — the
 * cousin of the hardcoded 4%.
 */
export const MARKET_RATE_KINDS = [
  'short_term_risk_free',
  'ten_year_treasury',
  'savings_apy',
  'credit_card_apr',
  'mortgage_30y',
  'other',
] as const;
export type MarketRateKind = (typeof MARKET_RATE_KINDS)[number];

/**
 * `market.rates` — a dated, attributed, FRED-sourced rate.
 *
 * The scope WP 2.7 said it needed and did not have. `rules-cash.ts` recorded
 * the shape of the fix precisely: *"a new snapshot field and one more ref, not
 * a constant in this file."* This is the field.
 *
 * Three properties make the figure defensible rather than merely present:
 *
 *   * **`observation_date`.** A rate with no date behind it is an assumption.
 *     The date is the answer to "as of when?" and it is what makes `stale`
 *     computable rather than a judgement.
 *   * **`rate` is a ratio, not the series' own units.** FRED publishes
 *     `DGS3MO` in percent — `4.25` means 4.25% — and the builder divides. This
 *     is the one reinterpretation the snapshot performs on a provider value,
 *     and it is here rather than in a rule because the alternative is every
 *     consumer dividing by 100 and one of them forgetting. `units` records
 *     what the builder converted *from* so the conversion is auditable.
 *   * **`attribution`.** 01 §4.3 makes the exact sentence a licence condition
 *     (WP 3.4 §4). It rides with the data because a surface cannot render an
 *     obligation it was never told about, and a rule that prints a rate is such
 *     a surface.
 */
export const MarketRatesSchema = z.strictObject({
  as_of: dateOnly,
  /**
   * The exact sentence the licence requires, verbatim, ® included. Not a
   * template and not a paraphrase — a paraphrase of a licence condition is a
   * new licence condition.
   */
  attribution: z.string().min(1).max(320),
  attribution_url: z.string().max(2048).nullable(),
  rates: z
    .array(
      z.strictObject({
        /** The FRED series id, e.g. `DGS3MO`. Evidence, not identity. */
        series_id: z
          .string()
          .min(1)
          .max(32)
          .regex(/^[A-Za-z0-9_-]+$/),
        kind: z.enum(MARKET_RATE_KINDS),
        observation_date: dateOnly,
        /** A ratio. `0.0425` is 4.25% a year. */
        rate: unitInterval,
        /** The units the provider published, before conversion. Audit trail. */
        units: z.string().min(1).max(48),
        /** Computed by the builder against its own freshness ladder, never stored. */
        stale: z.boolean(),
      }),
    )
    .max(16),
});

// ---------------------------------------------------------------------------
// goals.list, risk.profile — published at 1.0.0, filled by WP 4.9
// ---------------------------------------------------------------------------

/**
 * `goals.list` — one row per active goal whose pace can be evaluated.
 *
 * The five 1.0.0 fields are unchanged. `pace` is **contract 1.3.0**, optional,
 * and strictly additive: 07 R6's sentence is *"{goal} needs ${m}/mo to reach
 * ${target} by {date}; you're contributing ${c}"*, and neither `m` nor `c` is
 * derivable from a progress ratio and a month count — `m` needs the funded
 * amount (which this block deliberately does not carry) and `c` needs the
 * goal's contribution plans. WP 4.6's `evaluateGoalPace` computes both exactly
 * in the context that owns the rounding, and they cross here as money rather
 * than being re-derived in a rule.
 *
 * `goal_ref` is a `GOAL_` pseudonym for every advisor kind, never the goal's
 * id; the target date crosses as `horizon_months`, never as a date.
 */
export const GoalsListSchema = z.strictObject({
  goals: z
    .array(
      z.strictObject({
        goal_ref: opaqueRef,
        name: z.string().min(1).max(96),
        target: MoneyJsonSchema,
        horizon_months: z.number().int().nonnegative(),
        progress: unitInterval,
        /** Contract 1.3.0. WP 4.6's goal-pace verdict (07 R6). */
        pace: z
          .strictObject({
            /** Off track iff what is funded plus what is planned falls short of the target. */
            status: z.enum(['on_track', 'off_track']),
            /** What closes the gap by the date, per month, rounded up to the minor unit. */
            required_monthly: MoneyJsonSchema,
            /** What the goal's contribution plans schedule, per month, on average to the date. */
            planned_monthly: MoneyJsonSchema,
          })
          .optional(),
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

// ---------------------------------------------------------------------------
// plan.projection — contract 1.3.0, WP 4.9
// ---------------------------------------------------------------------------

/**
 * A ratio (or a factor, which may exceed one) as a **decimal string**, at most
 * six places.
 *
 * Not `unitInterval`. Every ratio in this block arrives from `@ctx/planning`
 * as a decimal string — `projection_runs.success_probability` is `NUMERIC(7,6)`
 * and WP 4.3's savings rate is a four-place string — and the Phase 4 gate's
 * "never" list includes *a success probability never crosses the wire as a
 * JSON number*. Converting to a float here to satisfy the snapshot's usual
 * convention would be the one place that rule was broken. The numeral tracer
 * and the derivation evaluator both read decimal strings already.
 */
const decimalString = z
  .string()
  .regex(/^\d{1,6}(\.\d{1,6})?$/, 'a non-negative decimal string, never a JSON number');
const calendarYear = z.number().int().min(1900).max(2200);
const wholeAge = z.number().int().min(0).max(130);

/**
 * `plan.projection` — the newest baseline run, as ratios, ages and years.
 *
 * **No balance, no account, no date finer than a year** (the dispatch's words).
 * The only money in the block is the terminal band, which is a *forecast* of
 * the plan's last year rather than a balance the holder has, and it is rounded
 * to $1,000 by the scope row. Everything a rule needs about the holder's
 * money today crosses as a share or a rate over it:
 *
 *   * **R1** reads `savings_rate` — two rates over one income, so the income
 *     itself never crosses (`risk.profile` makes the same choice with a band);
 *   * **R2** reads `success_probability` against `success_target`, both
 *     decimal strings, and the path count and plan-end age its sentence names;
 *   * **R3** reads `rmd` and `ages.current`, and the tax-deferred *share*;
 *   * **R4** reads the statutory claim factors in `social_security` — a factor
 *     is a multiplier on a benefit, and no benefit figure crosses;
 *   * **R7** reads `guardrail`, present only in decumulation.
 *
 * Every optional sub-block is absent when its inputs are: no stated
 * contributions and no derivable income → no `savings_rate`; a birth year the
 * RMD schedule does not cover → no `rmd`; no Social Security in the plan → no
 * `social_security`; not yet retired, or a retirement whose income covers its
 * spending → no `guardrail`. Absent, never zero.
 */
export const PlanProjectionSchema = z.strictObject({
  /** The year of the run's starting-balance day. A year, never the date. */
  as_of_year: calendarYear,
  currency: z.string().regex(/^[A-Z]{3}$/),
  method: z.enum(['monte_carlo', 'deterministic']),
  paths: z.number().int().min(1).max(1_000_000),
  /** WP 4.2's content hash. Evidence for "which assumptions?", not identity. */
  assumptions_version: z
    .string()
    .min(1)
    .max(96)
    .regex(/^[A-Za-z0-9_.:@-]+$/),
  /** `true` when the run's assumptions are retired or differ from the holder's current ones. */
  stale: z.boolean(),
  /** `'0.713000'`. A deterministic run is `'1'` or `'0'` and is not a probability. */
  success_probability: decimalString,
  /** 09 GOAL-7's target, `'0.80'` by default: what the plan is measured against. */
  success_target: decimalString,
  /** The band in the plan's last year, today's dollars, rounded to $1,000. */
  terminal: z.strictObject({
    age: wholeAge,
    calendar_year: calendarYear,
    /** `null` for a deterministic run, which has one path and no band. */
    p5: MoneyJsonSchema.nullable(),
    p50: MoneyJsonSchema,
    p95: MoneyJsonSchema.nullable(),
  }),
  ages: z.strictObject({
    current: wholeAge,
    retirement: wholeAge,
    plan_end: wholeAge,
  }),
  savings_rate: z
    .strictObject({
      /** What the plan's contributions come to, over the observed income. */
      plan: decimalString,
      /** What WP 4.3's derived contributions come to, over the same income. */
      observed: decimalString,
      /** `derived`: the plan assumed exactly what was observed, so the two agree by construction. */
      plan_source: z.enum(['stated', 'derived']),
    })
    .optional(),
  rmd: z
    .strictObject({
      /** SECURE 2.0's start age for the holder's birth year, from WP 4.2's file. */
      start_age: wholeAge,
      start_year: calendarYear,
      /** The tax-deferred bucket's share of what the plan starts from. */
      tax_deferred_share: decimalString,
    })
    .optional(),
  social_security: z
    .strictObject({
      claim_age_years: wholeAge,
      claim_age_months: z.number().int().min(0).max(11),
      /** The statutory multiplier on the benefit at the plan's claim age. */
      claim_factor: decimalString,
      /** The same multiplier at seventy. */
      factor_at_70: decimalString,
    })
    .optional(),
  guardrail: z
    .strictObject({
      /** The portfolio withdrawal rate this year: (spending − income) ÷ portfolio. */
      withdrawal_rate: decimalString,
      /** 07 §5.6's initial rate the band is drawn around. */
      reference_rate: decimalString,
      lower: decimalString,
      upper: decimalString,
      position: z.enum(['below', 'within', 'above']),
    })
    .optional(),
});

// ---------------------------------------------------------------------------
// The two blocks with no source (market.watchlist has no model;
// institutions.names is a deliberate refusal)
// ---------------------------------------------------------------------------

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
    // Contract 1.3.0 (WP 4.9). Placed after `risk_profile` to match the scope
    // catalogue's order, which is the snapshot's own property order.
    plan_projection: PlanProjectionSchema.optional(),
    market_watchlist: MarketWatchlistSchema.optional(),
    holdings_aggregate: HoldingsAggregateSchema.optional(),
    holdings_detail: HoldingsDetailSchema.optional(),
    liabilities_terms: LiabilitiesTermsSchema.optional(),
    market_rates: MarketRatesSchema.optional(),
    transactions_summary: TransactionsSummarySchema.optional(),
    transactions_raw: TransactionsRawSchema.optional(),
    institutions_names: InstitutionsNamesSchema.optional(),
    // Contract 1.4.0 (WP 5.7). Appended, like 1.3.0's `plan_projection` before
    // it: the two new blocks join at the end rather than being interleaved
    // into scope-catalogue order, which keeps the contract diff additive.
    transactions_anomalies: TransactionsAnomaliesSchema.optional(),
    fees_summary: FeesSummarySchema.optional(),
    // Contract 1.7.0 (WP 11.1). Appended, like 1.4.0's two blocks.
    rule_candidates: RuleCandidatesSchema.optional(),
  })
  .describe('The minimised, read-only view an advisor receives. One key per granted scope.');

export type AdvisorSnapshot = z.infer<typeof AdvisorSnapshotSchema>;
export type MoneyJson = z.infer<typeof MoneyJsonSchema>;
