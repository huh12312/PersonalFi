// SPDX-License-Identifier: MIT
/**
 * The four blocks WP 3.10's rules read, as in-package fixtures.
 *
 * ## Why these are literals and the Phase 2 blocks are not
 *
 * `test/advisors/seed.ts` builds its snapshot through the **real**
 * `SnapshotBuilder`, and its header explains why that matters: a hand-written
 * fixture is one whose shape agrees with the rules because the same person
 * wrote both.
 *
 * That argument still holds and it cannot be applied here yet, because there is
 * no builder branch to go through. `holdings.aggregate`, `holdings.detail`,
 * `liabilities.terms` and `market.rates` all carry `sourcedInPhase2: false`;
 * `#blockFor` has no case for them and returns `null`; and `snapshot/builder.ts`
 * and its ports are not this work package's to change. So the fixtures are
 * literals, and two things stand in for the builder:
 *
 *   1. **Every block is parsed by the published schema** before any test sees
 *      it (`validated()` below). A fixture that drifted from
 *      `AdvisorSnapshotSchema` — an extra field, a float where a decimal string
 *      belongs, a weight over one — fails at construction rather than producing
 *      a green test over a snapshot the platform could never send.
 *   2. **The minimisation rules are asserted against the fixture**, not assumed
 *      of it: `test/scope-minimization.test.ts` checks that `holdings.aggregate`
 *      carries no quantity, no cost basis and no account id, and that every
 *      figure in `networth.summary` is a whole hundred. Those are the same two
 *      properties the builder would have to hold up, checked on the data the
 *      rules actually run against.
 *
 * When the builder additions land (§7 of the evidence doc), the honest
 * follow-up is to delete these literals and let `seedSnapshot` produce the
 * blocks, keeping the schema parse as a belt.
 *
 * ## The numbers reconcile
 *
 * They did not have to — four scopes are four independent grants — but a
 * fixture whose parts contradict each other is one where a reviewer cannot tell
 * a rule's bug from the fixture's. So:
 *
 * ```
 * investable_total  $500,000  = US_EQUITY $225,000 + US_BOND $90,000
 *                             + INTL_DEV_EQUITY $30,000 + CRYPTO $100,000
 *                             + CASH $45,000 + UNCLASSIFIED $10,000
 * US_EQUITY         $225,000  = VTI $130,000 + ACME $60,000 + OLDFUND $35,000
 * CRYPTO            $100,000  = BTC $80,000 + USDC $20,000
 *                             = exchange $60,000 + self-custody $40,000
 * net worth         $530,700  = assets $560,000 − liabilities $29,300
 * liabilities       $29,320   = $4,820 + $3,100 + $21,400, rounded to $29,300
 * ```
 *
 * The rounding on the last line is `networth.summary`'s own: 08 §4.2 rounds
 * that block to $100 and this fixture shows the rounding rather than hiding it.
 */
import { AdvisorSnapshotSchema, type AdvisorSnapshot } from '../../src/contract/snapshot.ts';

export const PORTFOLIO_TODAY = '2026-09-19';
const USD = 'USD';

function usd(minor: number): { readonly minor: string; readonly currency: string } {
  return { minor: String(minor), currency: USD };
}

/**
 * The exact FRED attribution sentence, ® included.
 *
 * Copied from `@ctx/integrations`'s `ATTRIBUTIONS.fred` rather than imported:
 * the boundary lint forbids `@ctx/insights` from reaching into another context,
 * which is the same rule that stops the rules importing `@ctx/investments`.
 * `test/scope-minimization.test.ts` asserts the string is carried verbatim into
 * the caveats of every insight that shows a rate, which is the property that
 * actually matters — 01 §4.3 makes the sentence a licence condition, and a
 * paraphrase of a licence condition is a new licence condition.
 */
export const FRED_ATTRIBUTION =
  'This product uses the FRED® API but is not endorsed or certified by the ' +
  'Federal Reserve Bank of St. Louis.';

const FRED_ATTRIBUTION_URL = 'https://fred.stlouisfed.org/docs/api/terms_of_use.html';

// ---------------------------------------------------------------------------
// holdings.aggregate
// ---------------------------------------------------------------------------

/**
 * Weights against a target that is deliberately off in three places and inside
 * the band in two, so the 5pp band is exercised from both sides.
 *
 * | Class | Actual | Target | Gap | I1 |
 * | --- | --- | --- | --- | --- |
 * | US_EQUITY | 45% | 52% | −7pp | fires, notable |
 * | US_BOND | 18% | 28% | −10pp | fires, warning |
 * | INTL_DEV_EQUITY | 6% | 10% | −4pp | inside the band |
 * | CRYPTO | 20% | 5% | +15pp | fires, warning |
 * | CASH | 9% | 5% | +4pp | inside the band |
 */
const HOLDINGS_AGGREGATE = {
  as_of: PORTFOLIO_TODAY,
  currency: USD,
  investable_total: usd(50_000_000),
  // Under the one-tenth ceiling, so I1 speaks. `noisyPortfolioSnapshot` is the
  // same fixture with this number moved past it.
  unclassified_pct: 0.02,
  by_asset_class: [
    { asset_class: 'US_EQUITY', weight: 0.45, value: usd(22_500_000) },
    { asset_class: 'CRYPTO', weight: 0.2, value: usd(10_000_000) },
    { asset_class: 'US_BOND', weight: 0.18, value: usd(9_000_000) },
    { asset_class: 'CASH', weight: 0.09, value: usd(4_500_000) },
    { asset_class: 'INTL_DEV_EQUITY', weight: 0.06, value: usd(3_000_000) },
    { asset_class: 'UNCLASSIFIED', weight: 0.02, value: usd(1_000_000) },
  ],
  top_positions: [
    {
      symbol: 'VTI',
      weight: 0.26,
      value: usd(13_000_000),
      asset_class: 'US_EQUITY',
      employer_stock: false,
      is_crypto: false,
    },
    {
      symbol: 'BND',
      weight: 0.18,
      value: usd(9_000_000),
      asset_class: 'US_BOND',
      employer_stock: false,
      is_crypto: false,
    },
    {
      symbol: 'BTC',
      weight: 0.16,
      value: usd(8_000_000),
      asset_class: 'CRYPTO',
      employer_stock: false,
      is_crypto: true,
    },
    {
      symbol: 'ACME',
      weight: 0.12,
      value: usd(6_000_000),
      asset_class: 'US_EQUITY',
      employer_stock: true,
      is_crypto: false,
    },
    {
      symbol: 'OLDFUND',
      weight: 0.07,
      value: usd(3_500_000),
      asset_class: 'US_EQUITY',
      employer_stock: false,
      is_crypto: false,
    },
  ],
  target_allocation: [
    { asset_class: 'US_EQUITY', weight: 0.52 },
    { asset_class: 'US_BOND', weight: 0.28 },
    { asset_class: 'INTL_DEV_EQUITY', weight: 0.1 },
    { asset_class: 'CRYPTO', weight: 0.05 },
    { asset_class: 'CASH', weight: 0.05 },
  ],
  account_type_mix: { taxable: 0.62, tax_deferred: 0.38 },
  idle_cash: {
    total: usd(1_200_000),
    floor: usd(100_000),
    min_days: 21,
    longest_idle_days: 47,
  },
  crypto_custody: {
    exchange_value: usd(6_000_000),
    self_custody_value: usd(4_000_000),
    unknown_value: usd(0),
  },
} as const;

// ---------------------------------------------------------------------------
// holdings.detail
// ---------------------------------------------------------------------------

/**
 * Six positions, each carrying one rule's trigger and at least one rule's
 * control.
 *
 * | Symbol | Fires | Is the control for |
 * | --- | --- | --- |
 * | VTI | I4's paired cost (a real gain to realise) | I2 — a cheap fund with a matching peer |
 * | ACME | I5, I6 (one lot at a loss, one at a gain) | I4 — 12%, under the fifth |
 * | OLDFUND | I2 (89bp against a 4bp comparable) | I6 — tax-deferred, so a loss there is nothing |
 * | BND | — | I2 — cheap, and a peer that matches |
 * | VXUS | — | I2 — 1bp over its peer, under the 20bp trigger |
 * | BTC | X5 | I6 — crypto, which X5 owns |
 * | USDC | X3, X6 | X5 — no basis, so no computable loss |
 */
const HOLDINGS_DETAIL = {
  as_of: PORTFOLIO_TODAY,
  currency: USD,
  positions: [
    {
      symbol: 'VTI',
      asset_class: 'US_EQUITY',
      account_type: 'taxable',
      quantity: '420.500000000000000000',
      cost_basis: usd(9_800_000),
      market_value: usd(13_000_000),
      unrealized: usd(3_200_000),
      oldest_lot_days: 1100,
      basis_known: true,
      is_crypto: false,
      is_stablecoin: false,
      employer_stock: false,
      expense_ratio: 0.0003,
      peer_expense_ratio: 0.0003,
      annual_fee_cost: usd(3_900),
      high_fee: false,
      lots: [
        {
          opened_days: 1100,
          quantity: '420.500000000000000000',
          cost_basis: usd(9_800_000),
          market_value: usd(13_000_000),
          unrealized: usd(3_200_000),
          long_term: true,
        },
      ],
    },
    {
      symbol: 'ACME',
      asset_class: 'US_EQUITY',
      account_type: 'taxable',
      quantity: '1200.000000000000000000',
      cost_basis: usd(6_850_000),
      market_value: usd(6_000_000),
      unrealized: usd(-850_000),
      oldest_lot_days: 520,
      basis_known: true,
      is_crypto: false,
      is_stablecoin: false,
      employer_stock: true,
      expense_ratio: null,
      peer_expense_ratio: null,
      annual_fee_cost: null,
      high_fee: false,
      lots: [
        {
          opened_days: 520,
          quantity: '700.000000000000000000',
          cost_basis: usd(4_550_000),
          market_value: usd(3_500_000),
          unrealized: usd(-1_050_000),
          long_term: true,
        },
        {
          opened_days: 95,
          quantity: '500.000000000000000000',
          cost_basis: usd(2_300_000),
          market_value: usd(2_500_000),
          unrealized: usd(200_000),
          long_term: false,
        },
      ],
    },
    {
      symbol: 'OLDFUND',
      asset_class: 'US_EQUITY',
      account_type: 'tax_deferred',
      quantity: '310.250000000000000000',
      cost_basis: usd(3_100_000),
      market_value: usd(3_500_000),
      unrealized: usd(400_000),
      oldest_lot_days: 1500,
      basis_known: true,
      is_crypto: false,
      is_stablecoin: false,
      employer_stock: false,
      expense_ratio: 0.0089,
      peer_expense_ratio: 0.0004,
      annual_fee_cost: usd(31_150),
      high_fee: true,
      lots: [
        {
          opened_days: 1500,
          quantity: '310.250000000000000000',
          cost_basis: usd(3_100_000),
          market_value: usd(3_500_000),
          unrealized: usd(400_000),
          long_term: true,
        },
      ],
    },
    {
      symbol: 'BND',
      asset_class: 'US_BOND',
      account_type: 'tax_deferred',
      quantity: '1230.000000000000000000',
      cost_basis: usd(9_400_000),
      market_value: usd(9_000_000),
      unrealized: usd(-400_000),
      oldest_lot_days: 800,
      basis_known: true,
      is_crypto: false,
      is_stablecoin: false,
      employer_stock: false,
      expense_ratio: 0.0003,
      peer_expense_ratio: 0.0003,
      annual_fee_cost: usd(2_700),
      high_fee: false,
      lots: [
        {
          opened_days: 800,
          quantity: '1230.000000000000000000',
          cost_basis: usd(9_400_000),
          market_value: usd(9_000_000),
          unrealized: usd(-400_000),
          long_term: true,
        },
      ],
    },
    {
      symbol: 'VXUS',
      asset_class: 'INTL_DEV_EQUITY',
      account_type: 'taxable',
      quantity: '480.000000000000000000',
      cost_basis: usd(2_900_000),
      market_value: usd(3_000_000),
      unrealized: usd(100_000),
      oldest_lot_days: 640,
      basis_known: true,
      is_crypto: false,
      is_stablecoin: false,
      employer_stock: false,
      expense_ratio: 0.0007,
      peer_expense_ratio: 0.0006,
      annual_fee_cost: usd(2_100),
      high_fee: false,
      lots: [
        {
          opened_days: 640,
          quantity: '480.000000000000000000',
          cost_basis: usd(2_900_000),
          market_value: usd(3_000_000),
          unrealized: usd(100_000),
          long_term: true,
        },
      ],
    },
    {
      symbol: 'BTC',
      asset_class: 'CRYPTO',
      account_type: 'taxable',
      quantity: '0.860000000000000000',
      cost_basis: usd(9_200_000),
      market_value: usd(8_000_000),
      unrealized: usd(-1_200_000),
      oldest_lot_days: 730,
      basis_known: true,
      is_crypto: true,
      is_stablecoin: false,
      employer_stock: false,
      expense_ratio: null,
      peer_expense_ratio: null,
      annual_fee_cost: null,
      high_fee: false,
      lots: [
        {
          opened_days: 730,
          quantity: '0.860000000000000000',
          cost_basis: usd(9_200_000),
          market_value: usd(8_000_000),
          unrealized: usd(-1_200_000),
          long_term: true,
        },
      ],
    },
    {
      symbol: 'USDC',
      asset_class: 'CRYPTO',
      account_type: 'taxable',
      quantity: '20000.000000000000000000',
      // No basis: X6's whole subject, and the reason `unrealized` is `null`
      // rather than zero. A missing basis that crossed as zero would make the
      // unrealised gain wrong by the whole position.
      cost_basis: null,
      market_value: usd(2_000_000),
      unrealized: null,
      oldest_lot_days: 240,
      basis_known: false,
      is_crypto: true,
      is_stablecoin: true,
      employer_stock: false,
      expense_ratio: null,
      peer_expense_ratio: null,
      annual_fee_cost: null,
      high_fee: false,
      lots: [
        {
          opened_days: 240,
          quantity: '20000.000000000000000000',
          cost_basis: null,
          market_value: usd(2_000_000),
          unrealized: null,
          long_term: false,
        },
      ],
    },
  ],
} as const;

// ---------------------------------------------------------------------------
// networth.summary
// ---------------------------------------------------------------------------

/** Every figure a whole hundred, which is 08 §4.2's rule and its own test. */
const NETWORTH_SUMMARY = {
  as_of: PORTFOLIO_TODAY,
  assets: usd(56_000_000),
  liabilities: usd(2_930_000),
  net_worth: usd(53_070_000),
  trend: [
    { month: '2026-07', net_worth: usd(51_000_000) },
    { month: '2026-08', net_worth: usd(52_000_000) },
    { month: '2026-09', net_worth: usd(53_070_000) },
  ],
} as const;

// ---------------------------------------------------------------------------
// liabilities.terms
// ---------------------------------------------------------------------------

/**
 * Three liabilities, each carrying one D-rule's trigger and one's control.
 *
 * | Ref | Fires | Is the control for |
 * | --- | --- | --- |
 * | `LIAB_a1b2c3d4e5f6` | D2 (24% against a 21% series), D3 (five months), D6 (due, unpaid) | D4 — no promotional rate |
 * | `LIAB_b2c3d4e5f6a1` | D4 (promotional rate ends in under ninety days) | D2 — 19% is *under* the card series, so the benchmark actually gates; D6 — due next month, paid this one |
 * | `LIAB_c3d4e5f6a1b2` | D2 (6.89% against a 4.18% ten-year), D5 | D3 — one month, under the three |
 *
 * `liability_ref` is a token in the shape the tokeniser mints. It is not an
 * account id, not a provider id and not a mask.
 */
const LIABILITIES_TERMS = {
  as_of: PORTFOLIO_TODAY,
  currency: USD,
  liabilities: [
    {
      liability_ref: 'LIAB_a1b2c3d4e5f6',
      kind: 'credit_card',
      apr: 0.2399,
      promo_apr: null,
      promo_apr_end_date: null,
      credit_limit: usd(1_500_000),
      statement_balance: usd(482_000),
      current_balance: usd(482_000),
      minimum_payment: usd(14_500),
      payment_due_date: '2026-09-10',
      last_payment_date: '2026-08-08',
      last_payment_amount: usd(14_500),
      minimum_only_months: 5,
    },
    {
      liability_ref: 'LIAB_b2c3d4e5f6a1',
      kind: 'credit_card',
      apr: 0.1899,
      promo_apr: 0,
      promo_apr_end_date: '2026-11-20',
      credit_limit: usd(900_000),
      statement_balance: usd(310_000),
      current_balance: usd(310_000),
      minimum_payment: usd(6_000),
      payment_due_date: '2026-10-05',
      last_payment_date: '2026-09-05',
      last_payment_amount: usd(60_000),
      minimum_only_months: 0,
    },
    {
      liability_ref: 'LIAB_c3d4e5f6a1b2',
      kind: 'student_loan',
      apr: 0.0689,
      promo_apr: null,
      promo_apr_end_date: null,
      credit_limit: null,
      statement_balance: null,
      current_balance: usd(2_140_000),
      minimum_payment: usd(24_000),
      payment_due_date: '2026-10-01',
      last_payment_date: '2026-09-01',
      last_payment_amount: usd(24_000),
      minimum_only_months: 1,
    },
  ],
} as const;

// ---------------------------------------------------------------------------
// market.rates
// ---------------------------------------------------------------------------

/**
 * Five dated FRED observations and one stale one.
 *
 * The stale row is not decoration. D2 and C2 both skip a stale observation
 * rather than label it, and a fixture with no stale row would let that
 * behaviour rot untested — so `MORTGAGE30US` is marked stale, and the
 * `scope-minimization` suite asserts that no insight ever cites it.
 */
const MARKET_RATES = {
  as_of: PORTFOLIO_TODAY,
  attribution: FRED_ATTRIBUTION,
  attribution_url: FRED_ATTRIBUTION_URL,
  rates: [
    {
      series_id: 'SAVINGSRATE',
      kind: 'savings_apy',
      observation_date: '2026-09-15',
      rate: 0.0425,
      units: 'percent_per_annum',
      stale: false,
    },
    {
      series_id: 'DTB3',
      kind: 'short_term_risk_free',
      observation_date: '2026-09-18',
      rate: 0.0512,
      units: 'percent_per_annum',
      stale: false,
    },
    {
      series_id: 'TERMCBCCALLNS',
      kind: 'credit_card_apr',
      observation_date: '2026-09-01',
      rate: 0.2124,
      units: 'percent_per_annum',
      stale: false,
    },
    {
      series_id: 'DGS10',
      kind: 'ten_year_treasury',
      observation_date: '2026-09-18',
      rate: 0.0418,
      units: 'percent_per_annum',
      stale: false,
    },
    {
      series_id: 'MORTGAGE30US',
      kind: 'mortgage_30y',
      observation_date: '2025-02-11',
      rate: 0.0642,
      units: 'percent_per_annum',
      stale: true,
    },
  ],
} as const;

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

/** The scope ids these fixtures stand in for, and the key each produces. */
export const PORTFOLIO_SCOPE_KEYS: Readonly<Record<string, keyof AdvisorSnapshot>> = Object.freeze({
  'holdings.aggregate': 'holdings_aggregate',
  'holdings.detail': 'holdings_detail',
  'networth.summary': 'networth_summary',
  'liabilities.terms': 'liabilities_terms',
  'market.rates': 'market_rates',
});

/**
 * Parse through the published schema, always.
 *
 * `parse`, not `safeParse`: a malformed fixture is a bug in this file and it
 * should stop the suite at construction rather than surface as a rule that
 * mysteriously found nothing.
 */
function validated(snapshot: unknown): AdvisorSnapshot {
  return AdvisorSnapshotSchema.parse(snapshot);
}

/** The blocks alone, for a test that wants only the new scopes. */
export function portfolioBlocks(
  scopes: readonly string[] = Object.keys(PORTFOLIO_SCOPE_KEYS),
): Partial<AdvisorSnapshot> {
  const granted = new Set(scopes);
  const blocks: Record<string, unknown> = {};
  // Granted-but-unsourced and ungranted are the same outcome in the builder —
  // no key — and they have to be the same outcome here, or a test would be
  // proving a property the platform does not have.
  if (granted.has('holdings.aggregate')) blocks['holdings_aggregate'] = HOLDINGS_AGGREGATE;
  if (granted.has('holdings.detail')) blocks['holdings_detail'] = HOLDINGS_DETAIL;
  if (granted.has('networth.summary')) blocks['networth_summary'] = NETWORTH_SUMMARY;
  if (granted.has('liabilities.terms')) blocks['liabilities_terms'] = LIABILITIES_TERMS;
  if (granted.has('market.rates')) blocks['market_rates'] = MARKET_RATES;
  return validated(blocks);
}

/** The same aggregate block with the unclassified share past the ceiling. */
export function noisyAggregateBlocks(): Partial<AdvisorSnapshot> {
  return validated({
    holdings_aggregate: {
      ...HOLDINGS_AGGREGATE,
      // 18%, which is 07 §4.3's own worked example of the case I1 must refuse.
      unclassified_pct: 0.18,
    },
  });
}
