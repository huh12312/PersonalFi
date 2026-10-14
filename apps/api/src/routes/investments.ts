// SPDX-License-Identifier: MIT
/**
 * `/holdings`, `/accounts/{id}/holdings` and `/investments/*` — the portfolio,
 * as HTTP.
 *
 * WP 3.9. `docs/plan/03-phase-3-dispatch.md` §3 assigns this file the aggregated
 * holdings view, the per-account detail, allocation, drift, performance and the
 * basis-method election. Three of its rules are not conveniences, and they are
 * restated here because every consumer inherits them:
 *
 *   * **`unclassifiedPct` and `stale` are fields, never inferences.** 07 §4.3 is
 *     normative — *"surface `% unclassified` next to every allocation chart and
 *     drift number"* — and a client that had to derive either one from the rows
 *     would derive it differently on each screen. Both are on every response
 *     that could mislead without them, present and zero rather than absent.
 *   * **A TWR, an MWR and a dollar gain are three disjoint wire shapes.** See
 *     the block comment above {@link WireTimeWeightedReturn}: the `?: never`
 *     members are the enforcement, `tsc` is what checks them, and
 *     `apps/api/test/db/investments-routes.test.ts` → `'the performance response
 *     cannot express a TWR and a dollar gain in the same object'` pins it with
 *     `@ts-expect-error`.
 *   * **Nothing here does portfolio arithmetic.** Every number comes from WP
 *     3.3's pure analytics over WP 3.2's holdings and WP 3.4's price ladder. A
 *     route that multiplied a quantity by a price would be a second, untested
 *     valuation engine that agreed with the first one right up until it did not.
 *
 * ## Auth policy
 *
 * Reading the portfolio and writing an **overlay** are the user answering, and
 * then correcting, a question about their own data — session-only, the shape
 * `rules.ts` and `budgets.ts` already use. The one write here that is not an
 * overlay is the **basis-method election**: `AVERAGE_COST` is sticky by database
 * trigger (`basis_method_elections_average_cost_is_sticky`) and is a tax
 * election the user cannot take back, so it carries `requireFreshSession` for
 * the reason `connections.ts` gives about one-way doors. The `PUT` price
 * override in `prices.ts` carries one too, and for a sharper reason: it is rung
 * 1 of 07 §6.1's ladder and outranks every provider.
 *
 * ## Every route is scoped by `user_id` in its own `WHERE`
 *
 * Not by a shared middleware and not by a repository that "always" adds it: the
 * predicate is in the SQL each reader issues, and `'every route refuses another
 * user's data'` drops exactly one of them and observes the suite go red. D6
 * means there is normally one account holder, which is precisely why this has to
 * be tested rather than assumed — a single-user deployment never exercises the
 * control by accident.
 */
import type { Database } from '@core/db';
import {
  DateOnly,
  Money,
  Quantity,
  currency as toCurrency,
  minorUnitScale,
  newId,
  type Clock,
  type CurrencyCode,
  type DateOnly as DateOnlyType,
  type Money as MoneyType,
} from '@core/kernel';
import { MANAGEMENT_STYLES, listAccounts } from '@ctx/ledger';
import {
  AVERAGE_COST_ELIGIBLE_TYPES,
  BASIS_METHODS,
  allocationOf,
  classifyActivity,
  createPriceReader,
  driftAgainstTargets,
  drizzleLotStore,
  drizzlePriceStore,
  effectiveClassificationOf,
  externalFlowsOf,
  marketValueOf,
  moneyWeightedReturn,
  portfolioDollarGain,
  ratio,
  summariseActivity,
  timeWeightedReturn,
  valueHoldings,
  type ActivityInput,
  type AllocationDimension,
  type AllocationReport,
  type AllocationTarget,
  type AnalyticsHolding,
  type BasisMethod,
  type DatedValuation,
  type DerivedClassification,
  type DollarGain,
  type ExternalFlow,
  type Lot,
  type MoneyWeightedReturn,
  type PricePoint,
  type PriceReader,
  type StoredOverlay,
  type SummaryMovement,
  type TimeWeightedReturn,
  type ValuationBasis,
  type ValuationOptions,
  type ValuedPosition,
} from '@ctx/investments';
import {
  ASSET_CLASSES,
  REGIONS,
  SECURITY_TYPES,
  type AssetClass,
  type ClassificationSource,
  type OverlayField,
  type Region,
  type SecurityType,
} from '@ctx/investments/schema';
import { sql } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { AppError, problems } from '../problem.ts';
import { dateOnly, money, moneyOrNull } from '../wire.ts';
import type { RouteDeps } from './deps.ts';

/**
 * D6: one account holder, one reporting currency.
 *
 * Hard-coded exactly as `insights.ts` and `reports.ts` hard-code it, and for the
 * same reason: there is no per-user base-currency setting yet, and inventing one
 * here would put the decision in a route file. A holding denominated in anything
 * else is **excluded and named** by `valueHoldings` rather than converted at a
 * rate this route did not read — D4's rule, inherited rather than re-stated.
 */
export const BASE_CURRENCY: CurrencyCode = toCurrency('USD');

/** How many distinct valuation dates `/performance` will price. See `valuationDatesFor`. */
const MAX_VALUATION_DATES = 64;

// ---------------------------------------------------------------------------
// Reading the portfolio
// ---------------------------------------------------------------------------

/** One `holdings` row joined to its security and the user's overlay. */
export interface HoldingRead {
  readonly holdingId: string;
  readonly accountId: string;
  readonly securityId: string;
  readonly symbol: string | null;
  readonly name: string | null;
  readonly securityType: SecurityType;
  readonly quantity: string;
  readonly costBasis: MoneyType | null;
  readonly costBasisSource: string | null;
  readonly asOfDate: string;
  readonly assetClass: AssetClass;
  readonly region: Region;
  readonly sector: string;
  readonly expenseRatio: string | null;
  readonly isCashEquivalent: boolean;
  readonly classificationSource: ClassificationSource;
  readonly overridden: readonly OverlayField[];
}

interface HoldingRow extends Record<string, unknown> {
  holding_id: string;
  account_id: string;
  security_id: string;
  quantity: string;
  cost_basis_minor: string | bigint | null;
  cost_basis_source: string | null;
  currency: string;
  as_of_date: string;
  ticker: string | null;
  s_name: string | null;
  s_type: SecurityType;
  s_asset_class: AssetClass;
  s_region: Region;
  s_sector: string;
  s_expense_ratio: string | null;
  s_is_cash_equivalent: boolean;
  s_classification_source: ClassificationSource;
  o_asset_class: AssetClass | null;
  o_region: Region | null;
  o_sector: string | null;
  o_expense_ratio: string | null;
  o_is_cash_equivalent: boolean | null;
  o_name: string | null;
  o_locked_fields: OverlayField[] | null;
}

/**
 * Current positions, joined to the securities master and the user's overlay.
 *
 * `user_id` appears **three times** — on `holdings`, on `securities` and on
 * `security_overlay` — rather than once with the joins trusted to stay inside
 * the user. A join predicate is a different thing from an authorisation
 * predicate, and conflating them is how one silently becomes load-bearing for
 * the other; the sabotage in §4 of the evidence note removes the `holdings` one
 * and watches every holdings assertion fail.
 */
export async function readHoldings(
  database: Database,
  userId: string,
  accountId: string | null,
): Promise<readonly HoldingRead[]> {
  const result = await database.execute<HoldingRow>(sql`
    SELECT h.id                     AS holding_id,
           h.account_id,
           h.security_id,
           h.quantity,
           h.cost_basis_minor,
           h.cost_basis_source,
           h.currency,
           to_char(h.as_of_date, 'YYYY-MM-DD') AS as_of_date,
           s.ticker,
           s.name                   AS s_name,
           s.type                   AS s_type,
           s.asset_class            AS s_asset_class,
           s.region                 AS s_region,
           s.sector                 AS s_sector,
           s.expense_ratio          AS s_expense_ratio,
           s.is_cash_equivalent     AS s_is_cash_equivalent,
           s.classification_source  AS s_classification_source,
           o.asset_class            AS o_asset_class,
           o.region                 AS o_region,
           o.sector                 AS o_sector,
           o.expense_ratio          AS o_expense_ratio,
           o.is_cash_equivalent     AS o_is_cash_equivalent,
           o.name                   AS o_name,
           o.locked_fields          AS o_locked_fields
      FROM holdings h
      JOIN securities s
        ON s.id = h.security_id AND s.user_id = ${userId}::uuid
      LEFT JOIN security_overlay o
        ON o.security_id = h.security_id AND o.user_id = ${userId}::uuid
     WHERE h.user_id = ${userId}::uuid
       AND (${accountId}::uuid IS NULL OR h.account_id = ${accountId}::uuid)
     ORDER BY s.ticker NULLS LAST, h.security_id, h.account_id
  `);
  return result.rows.map(effectiveHoldingOf);
}

// ---------------------------------------------------------------------------
// C-8's UI half (gate-security-review.md G3-11), rebuilt by WP 10.4: a position
// the resolver could not identify, as a named row on the holdings responses.
//
// Source of truth: `unresolved_holdings`, which the lot consumer replaces per
// account on every sync (migration 0043's header). Before WP 10.4 this read
// `investments.SecurityResolutionFailed` events, which carry no account, no
// quantity and no value, and — the log being append-only — could not say a
// position had since resolved without a second lookup by identifier. The table
// answers all three: a later successful resolution is simply not re-inserted.
// ---------------------------------------------------------------------------

/** One tier's abstention, as the resolver wrote it. */
interface StoredAbstentionRead {
  readonly tier: string;
  readonly reason: string;
  readonly detail: string | null;
}

interface UnresolvedHoldingRow extends Record<string, unknown> {
  id: string;
  account_id: string;
  provider: string;
  provider_security_id: string | null;
  name: string | null;
  ticker: string | null;
  quantity: string;
  institution_value_minor: string | bigint | null;
  currency: string;
  abstentions: readonly StoredAbstentionRead[];
  as_of_date: string;
  observed_at: Date | string;
}

export interface UnresolvedHoldingRead {
  readonly id: string;
  readonly accountId: string;
  readonly provider: string;
  readonly providerSecurityId: string | null;
  readonly name: string | null;
  readonly ticker: string | null;
  readonly quantity: string;
  /** The institution's own figure. Never computed from a price. */
  readonly institutionValue: MoneyType | null;
  readonly abstentions: readonly StoredAbstentionRead[];
  readonly reasons: readonly string[];
  readonly asOfDate: string;
  readonly observedAt: string;
}

/** How many unresolved positions a response lists. A cap, not a page: the excess is counted. */
const MAX_UNRESOLVED_POSITIONS = 200;

const TIER_WORDS: Readonly<Record<string, string>> = Object.freeze({
  figi: 'FIGI',
  isin: 'ISIN',
  cusip: 'CUSIP',
  ticker: 'ticker',
  chain_contract: 'chain and contract',
  proprietary: "institution's own id",
});

/**
 * The resolver's abstentions, in plain words. One sentence per kind of reason,
 * so "no FIGI, no ISIN, no CUSIP" reads as one line rather than three.
 */
export function plainReasonsOf(abstentions: readonly StoredAbstentionRead[]): string[] {
  const reasons: string[] = [];
  const absent = abstentions
    .filter((entry) => entry.reason === 'absent' && entry.tier !== 'chain_contract')
    .map((entry) => TIER_WORDS[entry.tier] ?? entry.tier);
  for (const entry of abstentions) {
    if (entry.reason === 'unqualified_ticker') {
      reasons.push(
        `Only a ticker${entry.detail === null ? '' : ` (${entry.detail})`} was given, with no ` +
          'exchange. A ticker alone can name more than one security, so it is not used to ' +
          'identify one.',
      );
    } else if (entry.reason === 'malformed') {
      reasons.push(
        `The ${TIER_WORDS[entry.tier] ?? entry.tier} given` +
          `${entry.detail === null ? '' : ` (${entry.detail})`} is not a valid one.`,
      );
    } else if (entry.reason === 'proprietary_is_not_an_identity') {
      reasons.push(
        "Only the institution's own id was given, which does not identify a security anywhere else.",
      );
    }
  }
  const identityAbsent = absent.filter((word) => word !== 'ticker');
  if (identityAbsent.length > 0) {
    reasons.push(`No ${identityAbsent.join(', ')} was given, and no match was found for it.`);
  }
  if (reasons.length === 0) reasons.push('No identifier the institution gave matched a security.');
  return reasons;
}

/**
 * The positions nobody could identify, for the whole holder (`scope` null) or
 * the listed accounts. Display only — never valued.
 */
export async function readUnresolvedHoldings(
  database: Database,
  userId: string,
  scope: AccountScope,
): Promise<readonly UnresolvedHoldingRead[]> {
  const result = await database.execute<UnresolvedHoldingRow>(sql`
    SELECT id,
           account_id,
           provider,
           provider_security_id,
           name,
           ticker,
           quantity,
           institution_value_minor,
           currency,
           abstentions,
           to_char(as_of_date, 'YYYY-MM-DD') AS as_of_date,
           observed_at
      FROM unresolved_holdings
     WHERE user_id = ${userId}::uuid
       AND ${accountPredicate(scope)}
     ORDER BY coalesce(name, ticker, provider_security_id, ''), account_id, id
     LIMIT ${MAX_UNRESOLVED_POSITIONS}
  `);
  return result.rows.map((row) => {
    const code = toCurrency(row.currency.trim());
    const abstentions = Array.isArray(row.abstentions) ? row.abstentions : [];
    return {
      id: row.id,
      accountId: row.account_id,
      provider: row.provider,
      providerSecurityId: row.provider_security_id,
      name: row.name,
      ticker: row.ticker,
      quantity: Quantity.toDatabaseString(Quantity.fromDatabaseString(String(row.quantity))),
      institutionValue:
        row.institution_value_minor === null
          ? null
          : Money.of(BigInt(row.institution_value_minor), code),
      abstentions,
      reasons: plainReasonsOf(abstentions),
      asOfDate: String(row.as_of_date).slice(0, 10),
      observedAt: new Date(row.observed_at).toISOString(),
    };
  });
}

/** An unresolved position, as one more `excluded` entry: allocation and holdings name it. */
function excludedOfUnresolved(row: UnresolvedHoldingRead): {
  holdingId: string;
  symbol: string | null;
  reason: 'security_unresolved';
} {
  return { holdingId: row.id, symbol: row.ticker ?? row.name, reason: 'security_unresolved' };
}

const unresolvedSecurityWire = z
  .object({
    id: z.uuid().describe('This row. Changes on every sync; not a security id.'),
    accountId: z.uuid(),
    provider: z.string(),
    providerSecurityId: z.string().nullable(),
    name: z.string().nullable().describe("The provider's own name for the security."),
    ticker: z.string().nullable().describe("The provider's own ticker, as given."),
    quantity: z.string(),
    institutionValue: z
      .object({ minor: z.string(), currency: z.string().length(3) })
      .nullable()
      .describe(
        "The institution's own value for the position, as reported. Not a price × quantity.",
      ),
    abstentions: z.array(
      z.object({ tier: z.string(), reason: z.string(), detail: z.string().nullable() }),
    ),
    reasons: z
      .array(z.string())
      .describe('Why it could not be identified, in plain words, one sentence each.'),
    asOfDate: dateOnly,
    observedAt: z.string(),
  })
  .meta({ id: 'UnresolvedSecurity' });

function unresolvedWireOf(row: UnresolvedHoldingRead): z.infer<typeof unresolvedSecurityWire> {
  return {
    id: row.id,
    accountId: row.accountId,
    provider: row.provider,
    providerSecurityId: row.providerSecurityId,
    name: row.name,
    ticker: row.ticker,
    quantity: row.quantity,
    institutionValue:
      row.institutionValue === null
        ? null
        : {
            minor: row.institutionValue.minor.toString(),
            currency: row.institutionValue.currency,
          },
    abstentions: row.abstentions.map((entry) => ({ ...entry })),
    reasons: [...row.reasons],
    asOfDate: row.asOfDate,
    observedAt: row.observedAt,
  };
}

function effectiveHoldingOf(row: HoldingRow): HoldingRead {
  const derived: DerivedClassification = {
    assetClass: row.s_asset_class,
    region: row.s_region,
    sector: row.s_sector,
    expenseRatio: row.s_expense_ratio,
    classificationSource: row.s_classification_source,
  };
  const locked = row.o_locked_fields ?? [];
  const overlay: StoredOverlay | null =
    row.o_locked_fields === null
      ? null
      : {
          assetClass: row.o_asset_class,
          region: row.o_region,
          sector: row.o_sector,
          expenseRatio: row.o_expense_ratio,
          lockedFields: locked,
        };
  // 04 §2.2's sparse overlay, resolved by the context's own function rather
  // than by a `??` chain here — a second implementation of "which value wins"
  // is how a user's override starts losing to a re-sync on one screen only.
  const effective = effectiveClassificationOf(derived, overlay);
  const code = toCurrency(row.currency.trim());
  return {
    holdingId: row.holding_id,
    accountId: row.account_id,
    securityId: row.security_id,
    symbol: row.ticker,
    name: locked.includes('name') && row.o_name !== null ? row.o_name : row.s_name,
    securityType: row.s_type,
    quantity: String(row.quantity),
    costBasis: row.cost_basis_minor === null ? null : Money.of(BigInt(row.cost_basis_minor), code),
    costBasisSource: row.cost_basis_source,
    asOfDate: String(row.as_of_date).slice(0, 10),
    assetClass: effective.assetClass,
    region: effective.region,
    sector: effective.sector,
    expenseRatio: effective.expenseRatio,
    // `is_cash_equivalent` is an overlay field the context's resolver does not
    // cover (it resolves the four classification fields), so it is resolved
    // here by the same rule: only a *locked* value wins.
    isCashEquivalent:
      locked.includes('is_cash_equivalent') && row.o_is_cash_equivalent !== null
        ? row.o_is_cash_equivalent
        : row.s_is_cash_equivalent,
    classificationSource: effective.source,
    overridden: effective.overridden,
  };
}

/** A `PriceReader` bound to this user, over `@ctx/investments`' own ladder. */
export function priceReaderFor(
  database: Database,
  userId: string,
  clock: Clock,
  kinds: ReadonlyMap<string, string>,
): PriceReader {
  return createPriceReader({
    store: drizzlePriceStore(database),
    userId,
    // Resolved from rows already read rather than with a query per security.
    // `other` for anything unknown is `DEFAULT_LADDERS`' honest default: it
    // still tries `user_override` and `last_known`, so a missing classification
    // degrades to "no price", never to a wrong one.
    kindOf: (securityId: string): Promise<string> =>
      Promise.resolve(kinds.get(securityId) ?? 'other'),
    clock,
  });
}

export interface PricedPortfolio {
  readonly holdings: readonly AnalyticsHolding[];
  /** Keyed by `holdingId`, so a response can report the rung and the date. */
  readonly points: ReadonlyMap<string, PricePoint | null>;
  readonly reads: readonly HoldingRead[];
}

/**
 * Value every current position at `asOf`, through WP 3.4's ladder.
 *
 * One price lookup per **security**, not per holding: the same ETF in a 401(k)
 * and a taxable account is one price, and asking twice would double the read
 * cost and risk two different answers if a refresh landed in between.
 */
export async function priceHoldings(
  reads: readonly HoldingRead[],
  reader: PriceReader,
  asOf: string,
): Promise<PricedPortfolio> {
  // One batched read for the whole portfolio (WP 9.14 / P-6): 200 sequential
  // ladder walks were ~2 s, almost all of it round trips and unbounded history.
  const bySecurity = await reader.priceMany(
    [...new Set(reads.map((read) => read.securityId))],
    asOf,
    BASE_CURRENCY,
  );

  const points = new Map<string, PricePoint | null>();
  const holdings: AnalyticsHolding[] = reads.map((read) => {
    const point = bySecurity.get(read.securityId) ?? null;
    points.set(read.holdingId, point);
    return {
      holdingId: read.holdingId,
      accountId: read.accountId,
      securityId: read.securityId,
      symbol: read.symbol,
      quantity: Quantity.fromDatabaseString(read.quantity),
      price:
        point === null
          ? null
          : { amount: Quantity.of(point.close), currency: toCurrency(point.currency) },
      // WP 3.4's read-time verdict, carried rather than recomputed. A route that
      // re-derived staleness against its own clock would disagree with the
      // reader the moment the two clocks differed — and `stale` is a field on
      // this wire precisely so nobody downstream re-derives it either.
      staleness: point?.staleness ?? 'STALE',
      assetClass: read.assetClass,
      region: read.region,
      sector: read.sector,
      expenseRatio: read.expenseRatio,
      isCashEquivalent: read.isCashEquivalent,
      // 07 §4.1's fourth boolean. Cash and cash equivalents are not investable;
      // everything else the user holds in an investment account is.
      isInvestable: !read.isCashEquivalent && read.assetClass !== 'CASH',
      costBasis: read.costBasis,
    };
  });
  return { holdings, points, reads };
}

function valuationOptionsFor(basis: ValuationBasis): ValuationOptions {
  return { currency: BASE_CURRENCY, scale: minorUnitScale(BASE_CURRENCY), basis };
}

// ---------------------------------------------------------------------------
// Wire shapes
// ---------------------------------------------------------------------------

const moneyWire = z.object({ minor: z.string(), currency: z.string().length(3) });

const priceWire = z
  .object({
    close: z.string().describe('A decimal string. Never a JSON number (D3).'),
    currency: z.string().length(3),
    priceDate: dateOnly.describe('The observation used — not necessarily the date asked for.'),
    rung: z.string().describe('Which rung of 07 §6.1’s ladder answered.'),
    source: z.string().nullable(),
    carriedForward: z.boolean(),
    providerCarriedForward: z.boolean(),
    observedAt: z.string(),
    staleness: z.enum(['FRESH', 'STALE']),
    includeInAsOfNowDeltas: z.boolean(),
  })
  .meta({ id: 'PriceQuote' });

function priceOf(point: PricePoint | null): z.infer<typeof priceWire> | null {
  if (point === null) return null;
  return {
    close: point.close,
    currency: point.currency,
    priceDate: point.priceDate,
    rung: point.rung,
    source: point.source,
    carriedForward: point.carriedForward,
    providerCarriedForward: point.providerCarriedForward,
    observedAt: point.observedAt.toISOString(),
    staleness: point.staleness,
    includeInAsOfNowDeltas: point.includeInAsOfNowDeltas,
  };
}

const unrealizedWire = z
  .object({
    status: z.enum(['available', 'unavailable']),
    gain: moneyWire
      .nullable()
      .describe('`null` whenever the status is unavailable. Never a zero standing in for unknown.'),
    reason: z.enum(['basis_unknown', 'price_unknown', 'currency_mismatch']).nullable(),
    warning: z.string().nullable(),
  })
  .meta({ id: 'UnrealizedGain' });

function unrealizedOf(report: DollarGain): z.infer<typeof unrealizedWire> {
  return report.status === 'available'
    ? { status: 'available', gain: money(report.gain), reason: null, warning: null }
    : { status: 'unavailable', gain: null, reason: report.reason, warning: report.warning };
}

const excludedWire = z.object({
  holdingId: z.uuid(),
  symbol: z.string().nullable(),
  // `security_unresolved` (WP 10.4): a position the resolver could not
  // identify. `holdingId` is then its `unresolved_holdings` row id.
  reason: z.enum(['stale_price', 'price_unknown', 'currency_mismatch', 'security_unresolved']),
});

const aggregatedHoldingWire = z
  .object({
    securityId: z.uuid(),
    symbol: z.string().nullable(),
    name: z.string().nullable(),
    securityType: z.enum(SECURITY_TYPES),
    assetClass: z.enum(ASSET_CLASSES),
    region: z.enum(REGIONS),
    sector: z.string(),
    classificationSource: z.string(),
    /** A decimal string at `QUANTITY_SCALE`, summed across every account. */
    quantity: z.string(),
    accountCount: z.int().nonnegative(),
    marketValue: moneyWire.nullable(),
    costBasis: moneyWire.nullable(),
    unrealized: unrealizedWire,
    weight: z.string().nullable().describe('Share of the valued portfolio, as a Ratio string.'),
    price: priceWire.nullable(),
    /** 07 §6.1, as a field: a stale price is labelled, never silently fresh. */
    stale: z.boolean(),
  })
  .meta({ id: 'AggregatedHolding' });

const allocationReportWire = z
  .object({
    dimension: z.enum(['asset_class', 'region', 'sector']),
    basis: z.enum(['as_of_now', 'last_known']),
    currency: z.string().length(3),
    total: moneyWire,
    slices: z.array(z.object({ key: z.string(), value: moneyWire, weight: z.string() })),
    /** 07 §4.3, normative. Present even when it is zero; never inferred. */
    unclassifiedPct: z.string(),
    unclassifiedValue: moneyWire,
    excluded: z.array(excludedWire),
    includesCash: z.literal(true),
    lookThrough: z.literal('fund_level_only'),
  })
  .meta({ id: 'AllocationReport' });

function allocationWireOf(
  report: AllocationReport,
  unresolved: readonly UnresolvedHoldingRead[] = [],
): z.infer<typeof allocationReportWire> {
  return {
    dimension: report.dimension,
    basis: report.basis,
    currency: report.currency,
    total: money(report.total),
    // `holdingIds` is deliberately dropped on the way out: a slice is a chart
    // segment, and the positions behind it are what `/accounts/{id}/holdings`
    // is for.
    slices: report.slices.map((slice) => ({
      key: slice.key,
      value: money(slice.value),
      weight: slice.weight,
    })),
    unclassifiedPct: report.unclassifiedPct,
    unclassifiedValue: money(report.unclassifiedValue),
    // WP 10.4: a position nobody could identify is outside every slice and
    // the denominator, and named here like an unpriced one.
    excluded: [
      ...report.excluded.map((row) => ({ ...row })),
      ...unresolved.map(excludedOfUnresolved),
    ],
    includesCash: true,
    lookThrough: 'fund_level_only',
  };
}

// ---------------------------------------------------------------------------
// The three performance shapes, on the wire
// ---------------------------------------------------------------------------

/**
 * 07 §4.2 — *"Never put a TWR next to a dollar gain, and never benchmark an
 * MWR. That's the whole rule."* — as a fact about this module's types.
 *
 * `@ctx/investments`' `TimeWeightedReturn`, `MoneyWeightedReturn` and
 * `DollarGain` already carry the `?: never` members that make the three
 * mutually unassignable (`src/analytics/types.ts`). Those are *domain* types
 * holding `Money` and `DateOnly`; what crosses this boundary is JSON.
 * Re-declaring the guards here is therefore not duplication — it is the same
 * rule stated in the other type, and without it the serialisation boundary
 * would be exactly where the rule stops applying. With
 * `exactOptionalPropertyTypes` on, an object carrying both fails to type-check
 * whether it was written as a literal or assembled by a spread.
 *
 * The response holds all three under three different **keys**, which is allowed
 * and is the point: the rule forbids one *object* expressing both, so that no
 * chart can plot them on one axis and no card can put them in one row.
 */
export interface WireTimeWeightedReturn {
  readonly kind: 'time_weighted';
  readonly periodReturn: string;
  readonly annualized: string | null;
  readonly annualizationWithheld: string | null;
  readonly spanDays: number;
  readonly from: string;
  readonly to: string;
  readonly method: 'sub_period_linking' | 'modified_dietz';
  readonly approximate: boolean;
  /**
   * A mutable array element type, deliberately: `z.infer` of `z.array(...)` is
   * mutable, and a `readonly` array here would not be assignable to the
   * response schema — which is exactly the check that keeps this wire type and
   * that schema honest. The `?: never` guards below are what this interface is
   * for; the variance of one array is not worth defeating them over.
   */
  readonly warnings: { readonly code: string; readonly detail: string }[];
  readonly benchmarkComparable: true;
  /** 07 §4.2, in the type system rather than in a review checklist. */
  readonly gain?: never;
  readonly dollarGain?: never;
  readonly marketValue?: never;
  readonly costBasis?: never;
  /** WP 10.3: nor any of the period summary's dollar figures. */
  readonly periodGain?: never;
  readonly netContributions?: never;
  readonly closingValue?: never;
}

export type WireMoneyWeightedReturn =
  | {
      readonly kind: 'money_weighted';
      readonly status: 'available';
      readonly periodReturn: string;
      readonly annualized: string | null;
      readonly annualizationWithheld: string | null;
      readonly spanDays: number;
      readonly from: string;
      readonly to: string;
      readonly solver: 'newton' | 'bisection';
      readonly newtonDiverged: boolean;
      readonly benchmarkComparable: false;
      /** The second half of 07 §4.2: an MWR may never carry a benchmark. */
      readonly benchmark?: never;
      readonly gain?: never;
      readonly dollarGain?: never;
    }
  | {
      readonly kind: 'money_weighted';
      readonly status: 'unavailable';
      readonly reason: string;
      readonly detail: string;
      readonly spanDays: number;
      readonly benchmarkComparable: false;
      readonly benchmark?: never;
      readonly periodReturn?: never;
      readonly annualized?: never;
      readonly gain?: never;
    };

export type WireDollarGain =
  | {
      readonly kind: 'dollar_gain';
      readonly status: 'available';
      readonly gain: { readonly minor: string; readonly currency: string };
      readonly marketValue: { readonly minor: string; readonly currency: string };
      readonly costBasis: { readonly minor: string; readonly currency: string };
      readonly periodReturn?: never;
      readonly annualized?: never;
      readonly benchmarkComparable?: never;
    }
  | {
      readonly kind: 'dollar_gain';
      readonly status: 'unavailable';
      readonly reason: string;
      readonly warning: string;
      readonly marketValue: { readonly minor: string; readonly currency: string } | null;
      readonly positionIds: string[];
      readonly gain?: never;
      readonly costBasis?: never;
      readonly periodReturn?: never;
      readonly benchmarkComparable?: never;
    };

const timeWeightedWire = z
  .object({
    kind: z.literal('time_weighted'),
    periodReturn: z.string(),
    annualized: z.string().nullable(),
    annualizationWithheld: z.string().nullable(),
    spanDays: z.int(),
    from: dateOnly,
    to: dateOnly,
    method: z.enum(['sub_period_linking', 'modified_dietz']),
    approximate: z.boolean(),
    warnings: z.array(z.object({ code: z.string(), detail: z.string() })),
    benchmarkComparable: z.literal(true),
  })
  .meta({ id: 'TimeWeightedReturn' });

const moneyWeightedWire = z
  .discriminatedUnion('status', [
    z.object({
      kind: z.literal('money_weighted'),
      status: z.literal('available'),
      periodReturn: z.string(),
      annualized: z.string().nullable(),
      annualizationWithheld: z.string().nullable(),
      spanDays: z.int(),
      from: dateOnly,
      to: dateOnly,
      solver: z.enum(['newton', 'bisection']),
      newtonDiverged: z.boolean(),
      benchmarkComparable: z.literal(false),
    }),
    z.object({
      kind: z.literal('money_weighted'),
      status: z.literal('unavailable'),
      reason: z.string(),
      detail: z.string(),
      spanDays: z.int(),
      benchmarkComparable: z.literal(false),
    }),
  ])
  .meta({ id: 'MoneyWeightedReturn' });

const dollarGainWire = z
  .discriminatedUnion('status', [
    z.object({
      kind: z.literal('dollar_gain'),
      status: z.literal('available'),
      gain: moneyWire,
      marketValue: moneyWire,
      costBasis: moneyWire,
    }),
    z.object({
      kind: z.literal('dollar_gain'),
      status: z.literal('unavailable'),
      reason: z.string(),
      warning: z.string(),
      marketValue: moneyWire.nullable(),
      positionIds: z.array(z.string()),
    }),
  ])
  .meta({ id: 'DollarGain' });

/**
 * The declared return type is the *wire guard*, and the route's response schema
 * is what `tsc` then checks it against — so both halves have to agree or the
 * build fails. There is no cast anywhere on this path.
 */
function timeWeightedWireOf(report: TimeWeightedReturn): WireTimeWeightedReturn {
  return {
    kind: 'time_weighted',
    periodReturn: report.periodReturn,
    annualized: report.annualized,
    annualizationWithheld: report.annualizationWithheld,
    spanDays: report.spanDays,
    from: report.from,
    to: report.to,
    method: report.method,
    approximate: report.approximate,
    // `subPeriods` is not serialised: it carries a `Money` per boundary, and a
    // shape that put a dollar figure inside the TWR object would hand a client
    // exactly the pairing the `?: never` members above exist to forbid.
    warnings: report.warnings.map((warning) => ({ code: warning.code, detail: warning.detail })),
    benchmarkComparable: true,
  };
}

function moneyWeightedWireOf(report: MoneyWeightedReturn): WireMoneyWeightedReturn {
  if (report.status === 'unavailable') {
    return {
      kind: 'money_weighted',
      status: 'unavailable',
      reason: report.reason,
      detail: report.detail,
      spanDays: report.spanDays,
      benchmarkComparable: false,
    };
  }
  return {
    kind: 'money_weighted',
    status: 'available',
    periodReturn: report.periodReturn,
    annualized: report.annualized,
    annualizationWithheld: report.annualizationWithheld,
    spanDays: report.spanDays,
    from: report.from,
    to: report.to,
    solver: report.diagnostics.solver,
    newtonDiverged: report.diagnostics.newtonDiverged,
    benchmarkComparable: false,
  };
}

function dollarGainWireOf(report: DollarGain): WireDollarGain {
  if (report.status === 'unavailable') {
    return {
      kind: 'dollar_gain',
      status: 'unavailable',
      reason: report.reason,
      warning: report.warning,
      marketValue: moneyOrNull(report.marketValue),
      positionIds: [...report.positionIds],
    };
  }
  return {
    kind: 'dollar_gain',
    status: 'available',
    gain: money(report.gain),
    marketValue: money(report.marketValue),
    costBasis: money(report.costBasis),
  };
}

/**
 * The health snapshot's dollar half (WP 10.3): what the scope was worth, what
 * went in and out, what it earned in income and paid in fees over the period.
 *
 * A **fourth** disjoint shape, guarded like the other three: it carries dollar
 * figures and therefore no rate, so the strip that renders it cannot put a TWR
 * beside a dollar gain (07 §4.2) — the TWR is a separate object the UI renders
 * in a separate block. `periodGain` is `closing − opening − netContributions`:
 * the change in value that did not come from the holder's own money.
 *
 * Nothing in it is fabricated (O-2, `fees.ts`'s house style): a position with
 * no price on a valuation date, a movement in another currency, an external
 * transfer that could not be valued and a cash movement that could not be
 * classified are each **excluded and named** under `exclusions`, and
 * `complete` is `false` whenever any list is non-empty.
 */
export interface WirePeriodSummary {
  readonly kind: 'period_summary';
  readonly from: string;
  readonly to: string;
  readonly openingValue: { readonly minor: string; readonly currency: string };
  readonly closingValue: { readonly minor: string; readonly currency: string };
  readonly netContributions: { readonly minor: string; readonly currency: string };
  readonly dividendsAndInterest: { readonly minor: string; readonly currency: string };
  readonly reinvestedDividends: { readonly minor: string; readonly currency: string };
  readonly feesPaid: { readonly minor: string; readonly currency: string };
  readonly taxesWithheld: { readonly minor: string; readonly currency: string };
  readonly periodGain: { readonly minor: string; readonly currency: string };
  readonly complete: boolean;
  readonly exclusions: {
    unpricedSecurities: { securityId: string; symbol: string | null; name: string | null }[];
    foreignCurrencyMovements: string[];
    unvaluedTransfers: string[];
    unclassifiedMovements: string[];
    /** WP 10.4: positions nobody could identify, by `unresolved_holdings` row. */
    unresolvedSecurities: { id: string; symbol: string | null; name: string | null }[];
    /** WP 10.4: movements in such a security, kept for Activity, left out of every flow. */
    unresolvedMovements: string[];
  };
  /** 07 §4.2: a dollar figure never shares an object with a rate. */
  readonly periodReturn?: never;
  readonly annualized?: never;
  readonly timeWeighted?: never;
  readonly benchmarkComparable?: never;
}

const periodSummaryWire = z
  .object({
    kind: z.literal('period_summary'),
    from: dateOnly,
    to: dateOnly,
    openingValue: moneyWire.describe('Σ priced positions on `from`.'),
    closingValue: moneyWire.describe('Σ priced positions on `to`: the value at `to`.'),
    netContributions: moneyWire.describe(
      'Σ external flows in (from, to], positive = net money in: contributions, withdrawals, ' +
        'transfers in and out (in kind, valued at the transfer date). The same flows the TWR ' +
        'and MWR are measured against.',
    ),
    dividendsAndInterest: moneyWire.describe('Cash dividends, fund distributions and interest.'),
    reinvestedDividends: moneyWire.describe(
      'Reinvested dividends, apart: a broker reporting both legs would otherwise count one twice.',
    ),
    feesPaid: moneyWire.describe('Fee rows plus commissions on trades. A magnitude.'),
    taxesWithheld: moneyWire.describe('Taxes withheld in the account. A magnitude.'),
    periodGain: moneyWire.describe('closingValue − openingValue − netContributions.'),
    complete: z.boolean().describe('false when anything below was excluded.'),
    exclusions: z.object({
      unpricedSecurities: z.array(
        z.object({
          securityId: z.string(),
          symbol: z.string().nullable(),
          name: z.string().nullable(),
        }),
      ),
      foreignCurrencyMovements: z.array(z.string()),
      unvaluedTransfers: z.array(z.string()),
      unclassifiedMovements: z.array(z.string()),
      unresolvedSecurities: z
        .array(
          z.object({ id: z.string(), symbol: z.string().nullable(), name: z.string().nullable() }),
        )
        .describe(
          'Positions the resolver could not identify (WP 10.4): outside every valuation, named.',
        ),
      unresolvedMovements: z
        .array(z.string())
        .describe(
          'Movements in a security nobody could identify (WP 10.4): listed in Activity, left ' +
            'out of every flow — their value is outside the valuation too, so counting the flow ' +
            'alone would book the money as a loss.',
        ),
    }),
  })
  .meta({ id: 'PeriodSummary' });

// ---------------------------------------------------------------------------
// Performance inputs
// ---------------------------------------------------------------------------

interface MovementRow extends Record<string, unknown> {
  id: string;
  account_id: string;
  security_id: string | null;
  security_unresolved: boolean;
  trade_date: string;
  type: string;
  subtype: string | null;
  amount_minor: string | bigint;
  fees_minor: string | bigint;
  currency: string;
  quantity: string;
}

/**
 * Which accounts a performance question is about. `null` is the whole
 * portfolio — every position and every movement the holder has — which is
 * exactly what the route answered before WP 10.3 added the other two.
 */
export type AccountScope = readonly string[] | null;

/**
 * One bound `uuid[]` parameter as a Postgres array literal (`domain.ts`'s
 * `uuidArrayParameter`, for the reason it gives: Drizzle's `sql` template
 * expands an interpolated array into a row constructor, not an array). The ids
 * are this file's own reads of `accounts.id`, checked to be UUIDs anyway.
 */
function uuidArrayLiteral(ids: readonly string[]): string {
  for (const id of ids) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(id)) {
      throw new Error(`not a UUID: ${JSON.stringify(id)}`);
    }
  }
  return `{${ids.join(',')}}`;
}

/**
 * The `account_id` predicate for a scope: everything, or the listed accounts.
 * Every table it is used on names the column `account_id`, so the column is
 * written here rather than spliced in (G-28: no `sql.raw`).
 */
function accountPredicate(scope: AccountScope) {
  return scope === null ? sql`TRUE` : sql`account_id = ANY(${uuidArrayLiteral(scope)}::uuid[])`;
}

/**
 * Every investment movement in `(from, to]` for the scope, classified once.
 *
 * **Which rows are external flows, and why** — WP 10.3 replaced a filter on
 * the house type (`type IN ('CASH', 'TRANSFER_IN', 'TRANSFER_OUT')`) with
 * `@ctx/investments`' `classifyActivity`, because the house type answers the
 * lot engine's question, not this one. The filter counted a fund's capital
 * gain distribution, a tax withheld and a margin expense (all `CASH`) as
 * deposits and withdrawals, a merger (`TRANSFER_IN`) as a transfer, and missed
 * a 401(k) payroll contribution and an IRA distribution entirely (Plaid files
 * them as `buy/contribution` and `sell/distribution`, which are `BUY` and
 * `SELL` to the lot engine). The audit and the regression tests are in
 * `docs/evidence/phase-10/wp10.3-investment-activity-performance.md` §4.
 *
 * What counts is value crossing the account boundary; a dividend, a reinvested
 * dividend, interest, a fee, a tax and a trade are part of the return. An
 * in-kind transfer (no cash amount) is priced at its trade date by
 * {@link valueInKindTransfers}; one that cannot be priced is counted in
 * `unvaluedTransfers` rather than treated as a zero flow, because a zero flow
 * silently attributes the whole transferred position to performance.
 */
async function readMovements(
  database: Database,
  userId: string,
  from: string,
  to: string,
  scope: AccountScope,
): Promise<{ readonly movements: SummaryMovement[]; readonly unresolved: string[] }> {
  const result = await database.execute<MovementRow>(sql`
    SELECT id,
           account_id,
           security_id,
           security_unresolved,
           to_char(trade_date, 'YYYY-MM-DD') AS trade_date,
           type,
           subtype,
           amount_minor,
           fees_minor,
           currency,
           quantity
      FROM investment_transactions
     WHERE user_id = ${userId}::uuid
       AND ${accountPredicate(scope)}
       AND trade_date > ${from}::date
       AND trade_date <= ${to}::date
     ORDER BY trade_date, id
  `);
  // WP 10.4: a movement in a security nobody could identify is stored so
  // Activity can list it, and kept out of every flow here — its position is
  // outside the valuation, so its flow alone would be booked as a gain or a
  // loss. Named in `exclusions.unresolvedMovements` instead.
  const unresolved = result.rows.filter((row) => row.security_unresolved).map((row) => row.id);
  const movements = result.rows
    .filter((row) => !row.security_unresolved)
    .map((row) => {
      const code = toCurrency(row.currency.trim());
      const input: ActivityInput = {
        type: row.type,
        subtype: row.subtype,
        amount: Money.of(BigInt(row.amount_minor), code),
        fees: Money.of(BigInt(row.fees_minor), code),
        quantity: Quantity.fromDatabaseString(String(row.quantity)),
        securityId: row.security_id,
      };
      return {
        id: row.id,
        date: DateOnly.parse(String(row.trade_date).slice(0, 10)),
        input,
        classified: classifyActivity(input),
      };
    });
  return { movements, unresolved };
}

/**
 * Price every in-kind external transfer at its trade date, through the same
 * ladder the valuations use. One batched read per distinct date. A transfer
 * whose security has no price that day (or a price in another currency) is
 * left unpriced and named, never valued at zero.
 */
async function valueInKindTransfers(
  movements: readonly SummaryMovement[],
  reader: PriceReader,
): Promise<{ readonly movements: SummaryMovement[]; readonly unpriced: ReadonlySet<string> }> {
  const scale = minorUnitScale(BASE_CURRENCY);
  const byDate = new Map<string, SummaryMovement[]>();
  for (const movement of movements) {
    if (movement.classified.inKind === null) continue;
    if (movement.input.amount.currency !== BASE_CURRENCY) continue;
    const list = byDate.get(movement.date) ?? [];
    list.push(movement);
    byDate.set(movement.date, list);
  }
  const valued = new Map<string, MoneyType>();
  const unpriced = new Set<string>();
  for (const [date, list] of byDate) {
    const points = await reader.priceMany(
      [...new Set(list.map((movement) => movement.classified.inKind?.securityId ?? ''))],
      date,
      BASE_CURRENCY,
    );
    for (const movement of list) {
      const inKind = movement.classified.inKind;
      if (inKind === null) continue;
      const point = points.get(inKind.securityId) ?? null;
      if (point === null || toCurrency(point.currency) !== BASE_CURRENCY) {
        unpriced.add(inKind.securityId);
        continue;
      }
      const value = marketValueOf(
        inKind.quantity,
        { amount: Quantity.of(point.close), currency: BASE_CURRENCY },
        scale,
      );
      valued.set(movement.id, inKind.direction === 'in' ? value : Money.negate(value));
    }
  }
  return {
    movements: movements.map((movement) => {
      const value = valued.get(movement.id);
      return value === undefined ? movement : { ...movement, valuedFlow: value };
    }),
    unpriced,
  };
}

/**
 * The dates `/performance` will price.
 *
 * The endpoints, plus every flow date — which is exactly what sub-period linking
 * needs, and exactly what `timeWeightedReturn` falls back from when one is
 * missing. Capped at {@link MAX_VALUATION_DATES}: beyond that only the endpoints
 * are priced and the engine answers Modified Dietz **flagged `approximate`**,
 * which is an honest degradation rather than a several-thousand-query request.
 */
function valuationDatesFor(
  from: DateOnlyType,
  to: DateOnlyType,
  flows: readonly ExternalFlow[],
): readonly DateOnlyType[] {
  const dates = new Set<DateOnlyType>([from, to]);
  for (const flow of flows) dates.add(flow.date);
  if (dates.size > MAX_VALUATION_DATES) return [from, to];
  return [...dates].sort(DateOnly.compare);
}

interface PositionRow extends Record<string, unknown> {
  security_id: string;
  account_id: string;
  quantity: string;
  as_of_date: string;
}

/**
 * What was held on `date`, across the scope's accounts (every account when the
 * scope is `null`), one row per account × security.
 *
 * The union of `holdings_snapshots` (the per-day history) and `holdings` (the
 * current position) — `domain.ts`'s `createPlanningHoldingsReader` gives the
 * reasoning: snapshots alone leave today unanswerable before the first snapshot
 * lands, and `holdings` alone carries a stale share count backwards through a
 * month of contributions and calls the result observed.
 */
async function positionsOn(
  database: Database,
  userId: string,
  date: string,
  scope: AccountScope,
): Promise<readonly PositionRow[]> {
  const result = await database.execute<PositionRow>(sql`
    SELECT DISTINCT ON (security_id, account_id)
           security_id, account_id, quantity, to_char(as_of_date, 'YYYY-MM-DD') AS as_of_date
      FROM (
        SELECT security_id, account_id, quantity, as_of_date
          FROM holdings_snapshots
         WHERE user_id = ${userId}::uuid
           AND ${accountPredicate(scope)}
        UNION ALL
        SELECT security_id, account_id, quantity, as_of_date
          FROM holdings
         WHERE user_id = ${userId}::uuid
           AND ${accountPredicate(scope)}
      ) AS o
     WHERE as_of_date <= ${date}::date
     ORDER BY security_id, account_id, as_of_date DESC
  `);
  return result.rows;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** D6: one account holder, and their zone decides what "today" means. */
export async function todayFor(deps: RouteDeps): Promise<string> {
  const rows = await deps.pool.query<{ display_timezone: string }>(
    `SELECT display_timezone FROM users ORDER BY created_at, id LIMIT 1`,
  );
  const zone = rows.rows[0]?.display_timezone ?? 'UTC';
  // `en-CA` renders `YYYY-MM-DD`, which is the one locale that agrees with
  // `DateOnly` by construction rather than by string surgery.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(deps.clock.now());
}

/**
 * The Postgres `constraint` of a failed statement, wherever Drizzle put it.
 *
 * `node-postgres` sets `constraint` on its own error; Drizzle wraps that in a
 * `DrizzleQueryError` whose `cause` is the original. Walking the chain is what
 * makes "the trigger refused" distinguishable from "something broke", and the
 * difference on the wire is a 409 the user can act on versus a 500 they cannot.
 */
function constraintOf(error: unknown): string {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && typeof current === 'object' && current !== null; depth += 1) {
    const named = (current as { constraint?: unknown }).constraint;
    if (typeof named === 'string') return named;
    current = (current as { cause?: unknown }).cause;
  }
  return '';
}

const basisQuery = z.enum(['as_of_now', 'last_known']).optional();

/**
 * `?target=US_EQUITY:0.6&target=US_BOND:0.4`.
 *
 * Targets arrive in the request rather than from a table because **there is no
 * targets table**: `allocation_targets` is in no Phase 3 migration, and WP 3.9's
 * brief adds none (0018 stays reserved). §8 of the evidence note records this as
 * a finding rather than quietly inventing a default — 07 §8 Q9's rule is that
 * drift *suppresses* rather than invents, and a 60/40 nobody chose is an
 * invention with a number on it.
 */
const targetQuery = z
  .union([z.string(), z.array(z.string())])
  .optional()
  .transform((value): readonly string[] =>
    value === undefined ? [] : Array.isArray(value) ? value : [value],
  );

function parseTargets(raw: readonly string[]): readonly AllocationTarget[] {
  const targets: AllocationTarget[] = [];
  for (const entry of raw) {
    const [key = '', weight = ''] = entry.split(':');
    const assetClass = key.trim().toUpperCase();
    if (!(ASSET_CLASSES as readonly string[]).includes(assetClass)) {
      throw new AppError({
        status: 400,
        code: 'investments.unknown_asset_class',
        title: 'Bad Request',
        detail: `${JSON.stringify(key)} is not one of ${ASSET_CLASSES.join(', ')}`,
        family: 'user',
      });
    }
    if (!/^\d*\.?\d+$/u.test(weight.trim())) {
      throw new AppError({
        status: 400,
        code: 'investments.malformed_target',
        title: 'Bad Request',
        detail:
          'a target is "<ASSET_CLASS>:<weight>", e.g. "US_EQUITY:0.6"; got ' +
          JSON.stringify(entry),
        family: 'user',
      });
    }
    targets.push({ assetClass: assetClass as AssetClass, targetWeight: ratio(weight.trim()) });
  }
  return targets;
}

// ---------------------------------------------------------------------------
// Scope (WP 10.3): one account, or every account one kind of manager runs
// ---------------------------------------------------------------------------

/**
 * `management` as a performance scope: the holder's three classes from the
 * account overlay (`@ctx/ledger`'s `MANAGEMENT_STYLES`, a CHECK in 0042), plus
 * `unclassified` for an investment account the holder has not classified —
 * named, so it is a row of its own and never silently folded into another.
 */
export const MANAGEMENT_SCOPES = [...MANAGEMENT_STYLES, 'unclassified'] as const;
export type ManagementScope = (typeof MANAGEMENT_SCOPES)[number];

const scopeWire = z
  .object({
    kind: z.enum(['portfolio', 'account', 'management']),
    management: z.enum(MANAGEMENT_SCOPES).nullable(),
    accountIds: z
      .array(z.uuid())
      .describe('The accounts measured; empty for the whole portfolio (every account).'),
  })
  .meta({ id: 'PerformanceScope' });

export interface InvestmentAccountRead {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly provider: string;
  readonly connectionId: string | null;
  readonly management: (typeof MANAGEMENT_STYLES)[number] | null;
}

/**
 * The accounts a performance or activity question can be about: every
 * investment or crypto account, plus any other account that holds a position
 * or has an investment movement (a manual account typed otherwise still has a
 * portfolio if it holds one). Joined to the holder's overlay for `management`.
 * `user_id` is in the predicate of every table touched, not trusted to a join.
 */
export async function investmentAccountsOf(
  database: Database,
  userId: string,
): Promise<readonly InvestmentAccountRead[]> {
  const result = await database.execute<{
    id: string;
    name: string;
    type: string;
    provider: string;
    connection_id: string | null;
    management: (typeof MANAGEMENT_STYLES)[number] | null;
  }>(sql`
    SELECT a.id, a.name, a.type, a.provider, a.connection_id, o.management
      FROM accounts a
      LEFT JOIN account_overrides o
        ON o.user_id = ${userId}::uuid AND o.account_id = a.id
     WHERE a.user_id = ${userId}::uuid
       AND (a.type IN ('investment', 'crypto')
            OR EXISTS (SELECT 1 FROM holdings h
                        WHERE h.user_id = ${userId}::uuid AND h.account_id = a.id)
            OR EXISTS (SELECT 1 FROM investment_transactions t
                        WHERE t.user_id = ${userId}::uuid AND t.account_id = a.id))
     ORDER BY a.name, a.id
  `);
  return result.rows.map((row) => ({
    id: row.id,
    name: row.name,
    type: row.type,
    provider: row.provider,
    connectionId: row.connection_id,
    management: row.management,
  }));
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export const investmentRoutes = (deps: RouteDeps): FastifyPluginAsyncZod => {
  const { guards, database, clock } = deps;

  /** Read, then price: the pair every portfolio route starts with. */
  const portfolioFor = async (
    userId: string,
    accountId: string | null,
    asOf: string,
  ): Promise<PricedPortfolio> => {
    const reads = await readHoldings(database, userId, accountId);
    const kinds = new Map<string, string>(
      reads.map((read) => [read.securityId, read.securityType]),
    );
    return priceHoldings(reads, priceReaderFor(database, userId, clock, kinds), asOf);
  };

  /** {@link portfolioFor} over a scope: every account (`null`) or the listed ones. */
  const portfolioForScope = async (
    userId: string,
    scope: AccountScope,
    asOf: string,
  ): Promise<PricedPortfolio> => {
    const all = await readHoldings(database, userId, null);
    const inScope = scope === null ? null : new Set(scope);
    const reads = inScope === null ? all : all.filter((read) => inScope.has(read.accountId));
    const kinds = new Map<string, string>(
      reads.map((read) => [read.securityId, read.securityType]),
    );
    return priceHoldings(reads, priceReaderFor(database, userId, clock, kinds), asOf);
  };

  /**
   * `?account=` or `?management=` → the accounts to measure (WP 10.3).
   *
   * Both at once is a 400: "this account, but only if an advisor runs it" is
   * a question with two answers, and picking one silently is how a screen ends
   * up labelled with the scope it did not compute. An account that is not
   * this holder's — or not an investment account — is a 404, indistinguishable
   * from one that does not exist. A management class with no accounts is a
   * 404 too, naming the class: a portfolio of nothing has no return.
   */
  const resolveScope = async (
    userId: string,
    query: {
      readonly account?: string | undefined;
      readonly management?: ManagementScope | undefined;
    },
  ): Promise<{
    readonly kind: 'portfolio' | 'account' | 'management';
    readonly management: ManagementScope | null;
    readonly accountIds: AccountScope;
  }> => {
    if (query.account !== undefined && query.management !== undefined) {
      throw new AppError({
        status: 400,
        code: 'investments.scope_conflict',
        title: 'Bad Request',
        detail: 'pass `account` or `management`, not both',
        family: 'user',
      });
    }
    if (query.account === undefined && query.management === undefined) {
      return { kind: 'portfolio', management: null, accountIds: null };
    }
    const accounts = await investmentAccountsOf(database, userId);
    if (query.account !== undefined) {
      const account = accounts.find((entry) => entry.id === query.account);
      if (account === undefined) {
        throw new AppError({
          status: 404,
          code: 'investments.account_not_found',
          title: 'Not Found',
          detail: 'no investment account with that id',
          family: 'user',
        });
      }
      return { kind: 'account', management: null, accountIds: [account.id] };
    }
    const management = query.management ?? 'unclassified';
    const accountIds = accounts
      .filter((entry) => (entry.management ?? 'unclassified') === management)
      .map((entry) => entry.id);
    if (accountIds.length === 0) {
      throw new AppError({
        status: 404,
        code: 'investments.scope_empty',
        title: 'Not Found',
        detail: `no investment account is classified as ${management}`,
        family: 'user',
      });
    }
    return { kind: 'management', management, accountIds };
  };

  return async (app) => {
    app.get(
      '/holdings',
      {
        schema: {
          operationId: 'listHoldings',
          summary: 'Every position, aggregated by ticker across accounts',
          description:
            'One row per security, summed over every account that holds it. `unclassifiedPct` ' +
            'and each row’s `stale` are fields, not inferences: 07 §4.3 makes the first ' +
            'normative and 07 §6.1 makes the second a statement about the clock at read time. ' +
            '`unresolved` (C-8, G3-11; WP 10.4) lists positions the resolver could not identify, ' +
            'one row per account and position, with the provider’s name and ticker, the ' +
            'quantity, the institution’s own value and the reasons in plain words. They are ' +
            'never valued, and each is also named in `excluded` (`security_unresolved`).',
          tags: ['investments'],
          querystring: z.object({ asOf: dateOnly.optional(), basis: basisQuery }),
          response: {
            200: z.object({
              asOf: dateOnly,
              basis: z.enum(['as_of_now', 'last_known']),
              currency: z.string().length(3),
              total: moneyWire,
              unclassifiedPct: z.string(),
              holdings: z.array(aggregatedHoldingWire),
              excluded: z.array(excludedWire),
              unresolved: z.array(unresolvedSecurityWire),
            }),
            ...problems(401, 503),
          },
        },
      },
      async (request) => {
        const session = await guards.requireSession(request);
        const asOf = request.query.asOf ?? (await todayFor(deps));
        const basis = request.query.basis ?? 'as_of_now';
        const options = valuationOptionsFor(basis);
        const portfolio = await portfolioFor(session.userId, null, asOf);
        const set = valueHoldings(portfolio.holdings, options);
        const allocation = allocationOf('asset_class', set, options);

        const readById = new Map(portfolio.reads.map((read) => [read.holdingId, read]));
        const valuedById = new Map(set.valued.map((entry) => [entry.holding.holdingId, entry]));

        interface Bucket {
          read: HoldingRead;
          quantity: string;
          accountIds: Set<string>;
          marketValue: MoneyType;
          costBasis: MoneyType;
          basisUnknown: boolean;
          priced: boolean;
          stale: boolean;
        }
        const buckets = new Map<string, Bucket>();
        for (const holding of portfolio.holdings) {
          const read = readById.get(holding.holdingId);
          if (read === undefined) continue;
          const bucket: Bucket = buckets.get(read.securityId) ?? {
            read,
            quantity: '0',
            accountIds: new Set<string>(),
            marketValue: Money.zero(BASE_CURRENCY),
            costBasis: Money.zero(BASE_CURRENCY),
            basisUnknown: false,
            priced: true,
            stale: false,
          };
          bucket.quantity = Quantity.toDatabaseString(
            Quantity.add(Quantity.of(bucket.quantity), holding.quantity),
          );
          bucket.accountIds.add(read.accountId);
          const valued = valuedById.get(holding.holdingId);
          if (valued === undefined) bucket.priced = false;
          else bucket.marketValue = Money.add(bucket.marketValue, valued.marketValue);
          if (read.costBasis === null || read.costBasis.currency !== BASE_CURRENCY) {
            bucket.basisUnknown = true;
          } else {
            bucket.costBasis = Money.add(bucket.costBasis, read.costBasis);
          }
          if (holding.staleness === 'STALE') bucket.stale = true;
          buckets.set(read.securityId, bucket);
        }

        const holdings = [...buckets].map(([securityId, bucket]) => {
          const marketValue = bucket.priced ? bucket.marketValue : null;
          const costBasis = bucket.basisUnknown ? null : bucket.costBasis;
          // The never-zero rule, applied by the context's own function rather
          // than by a branch here: one position without a basis makes the gain
          // unavailable, and it keeps the market value, which *is* knowable.
          const gain = portfolioDollarGain(
            [{ id: securityId, marketValue, costBasis }],
            BASE_CURRENCY,
          );
          return {
            securityId,
            symbol: bucket.read.symbol,
            name: bucket.read.name,
            securityType: bucket.read.securityType,
            assetClass: bucket.read.assetClass,
            region: bucket.read.region,
            sector: bucket.read.sector,
            classificationSource: bucket.read.classificationSource,
            quantity: bucket.quantity,
            accountCount: bucket.accountIds.size,
            marketValue: moneyOrNull(marketValue),
            costBasis: moneyOrNull(costBasis),
            unrealized: unrealizedOf(gain),
            weight:
              marketValue === null || Money.isZero(set.total)
                ? null
                : ratio(
                    Quantity.divide(
                      Quantity.of(marketValue.minor.toString()),
                      Quantity.of(set.total.minor.toString()),
                    ),
                  ),
            price: priceOf(portfolio.points.get(bucket.read.holdingId) ?? null),
            stale: bucket.stale,
          };
        });

        const unresolved = await readUnresolvedHoldings(database, session.userId, null);

        return {
          asOf,
          basis,
          currency: BASE_CURRENCY,
          total: money(set.total),
          unclassifiedPct: allocation.unclassifiedPct,
          holdings,
          excluded: [
            ...set.excluded.map((row) => ({ ...row })),
            ...unresolved.map(excludedOfUnresolved),
          ],
          unresolved: unresolved.map(unresolvedWireOf),
        };
      },
    );

    app.get(
      '/accounts/:accountId/holdings',
      {
        schema: {
          operationId: 'listAccountHoldings',
          summary: 'The positions in one account, with their lots and basis provenance',
          description:
            'Per-position lots with their ages, basis source, and an `unavailable` unrealized ' +
            'gain where the basis is unknown — 04 §5.5’s rule, carried onto the wire rather ' +
            'than computed from a zero. `unresolved` (C-8, G3-11; WP 10.4) is this account’s ' +
            'positions the resolver could not identify — never valued, and each also named in ' +
            '`excluded` (`security_unresolved`).',
          tags: ['investments'],
          params: z.object({ accountId: z.uuid() }),
          querystring: z.object({ asOf: dateOnly.optional(), basis: basisQuery }),
          response: {
            200: z.object({
              accountId: z.uuid(),
              asOf: dateOnly,
              basis: z.enum(['as_of_now', 'last_known']),
              currency: z.string().length(3),
              total: moneyWire,
              unclassifiedPct: z.string(),
              positions: z.array(
                z.object({
                  holdingId: z.uuid(),
                  securityId: z.uuid(),
                  symbol: z.string().nullable(),
                  name: z.string().nullable(),
                  assetClass: z.enum(ASSET_CLASSES),
                  quantity: z.string(),
                  marketValue: moneyWire.nullable(),
                  costBasis: moneyWire.nullable(),
                  costBasisSource: z.string().nullable(),
                  basisMethod: z.enum(BASIS_METHODS),
                  unrealized: unrealizedWire,
                  price: priceWire.nullable(),
                  stale: z.boolean(),
                  lots: z.array(
                    z.object({
                      lotId: z.uuid(),
                      openDate: dateOnly,
                      ageDays: z.int().nonnegative(),
                      longTerm: z.boolean(),
                      quantityRemaining: z.string(),
                      basis: moneyWire.nullable(),
                      basisSource: z.string(),
                      basisWarning: z.string().nullable(),
                    }),
                  ),
                }),
              ),
              excluded: z.array(excludedWire),
              unresolved: z.array(unresolvedSecurityWire),
            }),
            ...problems(401, 404, 503),
          },
        },
      },
      async (request) => {
        const session = await guards.requireSession(request);
        // The scope check, before a single holding is read: `@ctx/ledger`'s own
        // roster for *this* user. Another holder's account id is a 404 and not
        // a 403 — a 403 would confirm the id exists.
        const accounts = await listAccounts(database, {
          userId: session.userId,
          includeClosed: true,
        });
        if (!accounts.some((account) => account.id === request.params.accountId)) {
          throw new AppError({
            status: 404,
            code: 'investments.account_not_found',
            title: 'Not Found',
            detail: `no account ${request.params.accountId}`,
            family: 'user',
          });
        }

        const asOf = request.query.asOf ?? (await todayFor(deps));
        const basis = request.query.basis ?? 'as_of_now';
        const options = valuationOptionsFor(basis);
        const portfolio = await portfolioFor(session.userId, request.params.accountId, asOf);
        const set = valueHoldings(portfolio.holdings, options);
        const allocation = allocationOf('asset_class', set, options);
        const valuedById = new Map(set.valued.map((entry) => [entry.holding.holdingId, entry]));
        const store = drizzleLotStore(database, clock);
        const today = DateOnly.parse(asOf);

        const positions = [];
        for (const read of portfolio.reads) {
          const lots: readonly Lot[] = await store.listOpenLots(
            session.userId,
            read.accountId,
            read.securityId,
          );
          const basisMethod: BasisMethod = await store.basisMethodFor(
            session.userId,
            read.accountId,
            read.securityId,
          );
          const marketValue = valuedById.get(read.holdingId)?.marketValue ?? null;
          const gain = portfolioDollarGain(
            [{ id: read.holdingId, marketValue, costBasis: read.costBasis }],
            BASE_CURRENCY,
          );
          const point = portfolio.points.get(read.holdingId) ?? null;
          positions.push({
            holdingId: read.holdingId,
            securityId: read.securityId,
            symbol: read.symbol,
            name: read.name,
            assetClass: read.assetClass,
            quantity: read.quantity,
            marketValue: moneyOrNull(marketValue),
            costBasis: moneyOrNull(read.costBasis),
            costBasisSource: read.costBasisSource,
            basisMethod,
            unrealized: unrealizedOf(gain),
            price: priceOf(point),
            stale: point === null ? true : point.staleness === 'STALE',
            lots: lots.map((lot) => ({
              lotId: lot.id,
              openDate: lot.openDate,
              ageDays: Math.max(0, DateOnly.differenceInDays(lot.openDate, today)),
              // The holding period, not the open date: a wash sale tacks the
              // replaced lot's period on, which is the whole reason
              // `holdingPeriodStartDate` is a separate column.
              longTerm: DateOnly.differenceInDays(lot.holdingPeriodStartDate, today) >= 365,
              quantityRemaining: Quantity.toDatabaseString(lot.quantityRemaining),
              basis: moneyOrNull(lot.basis),
              basisSource: lot.basisSource,
              basisWarning: lot.basisWarning,
            })),
          });
        }

        const unresolved = await readUnresolvedHoldings(database, session.userId, [
          request.params.accountId,
        ]);

        return {
          accountId: request.params.accountId,
          asOf,
          basis,
          currency: BASE_CURRENCY,
          total: money(set.total),
          unclassifiedPct: allocation.unclassifiedPct,
          positions,
          excluded: [
            ...set.excluded.map((row) => ({ ...row })),
            ...unresolved.map(excludedOfUnresolved),
          ],
          unresolved: unresolved.map(unresolvedWireOf),
        };
      },
    );

    app.get(
      '/investments/allocation',
      {
        schema: {
          operationId: 'getAllocation',
          summary: 'Allocation by asset class, region and sector, with % unclassified',
          description:
            'Fund-level only (no synthetic look-through), cash in the denominator, and ' +
            '`unclassifiedPct` on every dimension — present even when zero, because 07 §4.3 ' +
            'makes a drift claim beside a large unclassified share noise.',
          tags: ['investments'],
          querystring: z.object({ asOf: dateOnly.optional(), basis: basisQuery }),
          response: {
            200: z.object({
              asOf: dateOnly,
              byAssetClass: allocationReportWire,
              byRegion: allocationReportWire,
              bySector: allocationReportWire,
            }),
            ...problems(401, 503),
          },
        },
      },
      async (request) => {
        const session = await guards.requireSession(request);
        const asOf = request.query.asOf ?? (await todayFor(deps));
        const options = valuationOptionsFor(request.query.basis ?? 'as_of_now');
        const portfolio = await portfolioFor(session.userId, null, asOf);
        // One valuation, three dimensions — so the three reports cannot
        // disagree about the denominator.
        const set = valueHoldings(portfolio.holdings, options);
        const unresolved = await readUnresolvedHoldings(database, session.userId, null);
        const of = (dimension: AllocationDimension): z.infer<typeof allocationReportWire> =>
          allocationWireOf(allocationOf(dimension, set, options), unresolved);
        return {
          asOf,
          byAssetClass: of('asset_class'),
          byRegion: of('region'),
          bySector: of('sector'),
        };
      },
    );

    app.get(
      '/investments/drift',
      {
        schema: {
          operationId: 'getDrift',
          summary: 'Drift against a target allocation, on the absolute 5-point band',
          description:
            'Targets are supplied as `?target=US_EQUITY:0.6`. **With no targets the response ' +
            'suppresses rather than invents** (07 §8 Q9): `targetsSet` is `false`, `rows` is ' +
            'empty, and `unclassifiedPct` is still returned. There is no `allocation_targets` ' +
            'table in Phase 3 — see wp3.9-routes.md §8.',
          tags: ['investments'],
          querystring: z.object({
            asOf: dateOnly.optional(),
            basis: basisQuery,
            target: targetQuery,
          }),
          response: {
            200: z.object({
              asOf: dateOnly,
              targetsSet: z.boolean(),
              bandPoints: z.string(),
              total: moneyWire,
              unclassifiedPct: z.string(),
              /** `unclassifiedPct > 10pp`: 07 §4.3's noise flag, as a field. */
              noisy: z.boolean(),
              proposalsWithheld: z.string().nullable(),
              rows: z.array(
                z.object({
                  assetClass: z.enum(ASSET_CLASSES),
                  actualWeight: z.string(),
                  targetWeight: z.string(),
                  actualValue: moneyWire,
                  gapPoints: z.string(),
                  insideBand: z.boolean(),
                  proposal: z
                    .object({
                      direction: z.enum(['increase', 'reduce']),
                      amount: moneyWire,
                    })
                    .nullable(),
                }),
              ),
              allocation: allocationReportWire,
              excluded: z.array(excludedWire),
            }),
            ...problems(400, 401, 503),
          },
        },
      },
      async (request) => {
        const session = await guards.requireSession(request);
        const asOf = request.query.asOf ?? (await todayFor(deps));
        const options = valuationOptionsFor(request.query.basis ?? 'as_of_now');
        const portfolio = await portfolioFor(session.userId, null, asOf);
        const targets = parseTargets(request.query.target);
        const unresolved = await readUnresolvedHoldings(database, session.userId, null);
        const unresolvedExcluded = unresolved.map(excludedOfUnresolved);

        if (targets.length === 0) {
          const set = valueHoldings(portfolio.holdings, options);
          const allocation = allocationOf('asset_class', set, options);
          return {
            asOf,
            targetsSet: false,
            bandPoints: '5.0000',
            total: money(allocation.total),
            unclassifiedPct: allocation.unclassifiedPct,
            noisy: false,
            proposalsWithheld: null,
            rows: [],
            allocation: allocationWireOf(allocation, unresolved),
            excluded: [...set.excluded.map((row) => ({ ...row })), ...unresolvedExcluded],
          };
        }

        let report;
        try {
          report = driftAgainstTargets(portfolio.holdings, targets, options);
        } catch (error) {
          throw new AppError({
            status: 400,
            code: 'investments.invalid_targets',
            title: 'Bad Request',
            detail: error instanceof Error ? error.message : 'the targets could not be used',
            family: 'user',
          });
        }

        return {
          asOf,
          targetsSet: true,
          bandPoints: report.bandPoints,
          total: money(report.total),
          unclassifiedPct: report.unclassifiedPct,
          noisy: report.noisy,
          proposalsWithheld: report.proposalsWithheld,
          rows: report.rows.map((row) => ({
            assetClass: row.assetClass,
            actualWeight: row.actualWeight,
            targetWeight: row.targetWeight,
            actualValue: money(row.actualValue),
            gapPoints: row.gapPoints,
            insideBand: row.insideBand,
            // A proposal is withheld wholesale when the valuation is
            // incomplete: `drift.ts` empties `proposals` and this row-level
            // field has to agree, or the UI would render a trade size the
            // report itself refused to offer.
            proposal:
              row.proposal === null || report.proposalsWithheld !== null
                ? null
                : { direction: row.proposal.direction, amount: money(row.proposal.amount) },
          })),
          allocation: allocationWireOf(report.allocation, unresolved),
          excluded: [...report.excluded.map((row) => ({ ...row })), ...unresolvedExcluded],
        };
      },
    );

    /**
     * Every answer `/investments/performance` gives, for one scope (WP 10.3).
     *
     * Valuations (`positionsOn`) and flows (`readMovements`) are restricted to
     * the scope's accounts; everything after that — sub-period linking, the
     * Modified Dietz fallback flagged `approximate`, XIRR, the under-a-year
     * annualization withholding, the disjoint wire shapes — is exactly the
     * engine the whole-portfolio answer has always used.
     */
    const performanceFor = async (
      userId: string,
      fromDate: DateOnlyType,
      toDate: DateOnlyType,
      scope: AccountScope,
    ) => {
      // One kind lookup for the whole user, so the price ladder is asked for
      // one kind per security rather than one per (security, date). The ticker
      // and name are what an exclusion is named by.
      const securityRows = await database.execute<{
        id: string;
        type: string;
        ticker: string | null;
        name: string | null;
      }>(sql`
        SELECT id, type, ticker, name FROM securities WHERE user_id = ${userId}::uuid
      `);
      const kinds = new Map(securityRows.rows.map((row) => [row.id, row.type]));
      const securityById = new Map(securityRows.rows.map((row) => [row.id, row]));
      const reader = priceReaderFor(database, userId, clock, kinds);
      const scale = minorUnitScale(BASE_CURRENCY);

      const read = await readMovements(database, userId, fromDate, toDate, scope);
      const { movements, unpriced: unpricedTransfers } = await valueInKindTransfers(
        read.movements,
        reader,
      );
      const unresolvedHoldings = await readUnresolvedHoldings(database, userId, scope);
      const { flows, unvalued } = externalFlowsOf(movements, BASE_CURRENCY);
      const totals = summariseActivity(movements, BASE_CURRENCY);
      const dates = valuationDatesFor(fromDate, toDate, flows);

      const unpricedSecurities = new Set<string>(unpricedTransfers);
      const valuations: DatedValuation[] = [];
      for (const date of dates) {
        const positions = await positionsOn(database, userId, date, scope);
        let total = Money.zero(BASE_CURRENCY);
        // One batched read per valuation date, not one per position (P-6).
        const points = await reader.priceMany(
          positions.map((position) => position.security_id),
          date,
          BASE_CURRENCY,
        );
        for (const position of positions) {
          const point = points.get(position.security_id) ?? null;
          const quantity = Quantity.fromDatabaseString(String(position.quantity));
          // A position with no price (or a price in another currency) is left
          // out of the valuation — and, since WP 10.3, *named* in the period
          // summary rather than silently missing. A zero quantity is no
          // position at all, priced or not.
          if (point === null || toCurrency(point.currency) !== BASE_CURRENCY) {
            if (!Quantity.isZero(quantity)) unpricedSecurities.add(position.security_id);
            continue;
          }
          // `marketValueOf` is `@ctx/investments`' own `quantity × price`,
          // rounded once, half-even, at the boundary into minor units. Reused
          // rather than rewritten: a second rounding rule here would put two
          // different portfolio values on two different screens.
          total = Money.add(
            total,
            marketValueOf(
              quantity,
              { amount: Quantity.of(point.close), currency: BASE_CURRENCY },
              scale,
            ),
          );
        }
        valuations.push({ date, value: total });
      }

      const opening = valuations[0];
      const closing = valuations[valuations.length - 1];
      if (opening === undefined || closing === undefined || valuations.length < 2) {
        throw new AppError({
          status: 400,
          code: 'investments.no_valuations',
          title: 'Bad Request',
          detail: 'there is nothing to value over that period',
          family: 'user',
        });
      }

      const twr = timeWeightedReturn({ valuations, flows }, { allowApproximateFallback: true });
      const mwr = moneyWeightedReturn({ openingValue: opening, flows, closingValue: closing });

      // The dollar gain is answered over *today's* positions, which is the
      // only set whose cost basis is known: a historical basis would need the
      // lot ledger replayed to `from`, and WP 3.2's engine holds lots, not
      // dated basis snapshots. Stated rather than implied.
      const portfolio = await portfolioForScope(userId, scope, toDate);
      const set = valueHoldings(portfolio.holdings, valuationOptionsFor('last_known'));
      const valuedById = new Map(set.valued.map((entry) => [entry.holding.holdingId, entry]));
      const positions: ValuedPosition[] = portfolio.reads.map((holding) => ({
        id: holding.holdingId,
        marketValue: valuedById.get(holding.holdingId)?.marketValue ?? null,
        costBasis: holding.costBasis,
      }));

      const exclusions = {
        unpricedSecurities: [...unpricedSecurities].sort().map((securityId) => ({
          securityId,
          symbol: securityById.get(securityId)?.ticker ?? null,
          name: securityById.get(securityId)?.name ?? null,
        })),
        foreignCurrencyMovements: [...totals.foreignCurrency],
        unvaluedTransfers: [...totals.unvaluedTransfers],
        unclassifiedMovements: [...totals.unclassified],
        unresolvedSecurities: unresolvedHoldings.map((row) => ({
          id: row.id,
          symbol: row.ticker,
          name: row.name,
        })),
        unresolvedMovements: [...read.unresolved],
      };
      const summary: WirePeriodSummary = {
        kind: 'period_summary',
        from: fromDate,
        to: toDate,
        openingValue: money(opening.value),
        closingValue: money(closing.value),
        netContributions: money(totals.netContributions),
        dividendsAndInterest: money(totals.dividendsAndInterest),
        reinvestedDividends: money(totals.reinvestedDividends),
        feesPaid: money(totals.feesPaid),
        taxesWithheld: money(totals.taxesWithheld),
        periodGain: money(
          Money.subtract(Money.subtract(closing.value, opening.value), totals.netContributions),
        ),
        complete:
          exclusions.unpricedSecurities.length === 0 &&
          exclusions.foreignCurrencyMovements.length === 0 &&
          exclusions.unvaluedTransfers.length === 0 &&
          exclusions.unclassifiedMovements.length === 0 &&
          exclusions.unresolvedSecurities.length === 0 &&
          exclusions.unresolvedMovements.length === 0,
        exclusions,
      };

      return {
        timeWeighted: timeWeightedWireOf(twr),
        moneyWeighted: moneyWeightedWireOf(mwr),
        dollarGain: dollarGainWireOf(portfolioDollarGain(positions, BASE_CURRENCY)),
        summary,
        // Movements we could see but could not value: an external transfer
        // with no price, or one in another currency. Never counted as zero.
        unvaluedTransfers: unvalued.length,
        valuationDates: [...dates],
      };
    };

    /** `from`/`to` → two real dates, `to` strictly later, or a 400 naming why. */
    const periodOf = async (query: {
      readonly from: string;
      readonly to?: string | undefined;
    }): Promise<{ readonly fromDate: DateOnlyType; readonly toDate: DateOnlyType }> => {
      const to = query.to ?? (await todayFor(deps));
      if (!DateOnly.is(query.from) || !DateOnly.is(to)) {
        throw new AppError({
          status: 400,
          code: 'investments.invalid_period',
          title: 'Bad Request',
          detail: 'from and to must be calendar dates that exist',
          family: 'user',
        });
      }
      const fromDate = DateOnly.parse(query.from);
      const toDate = DateOnly.parse(to);
      if (DateOnly.differenceInDays(fromDate, toDate) <= 0) {
        throw new AppError({
          status: 400,
          code: 'investments.invalid_period',
          title: 'Bad Request',
          detail: '`to` must be later than `from`',
          family: 'user',
        });
      }
      return { fromDate, toDate };
    };

    app.get(
      '/investments/performance',
      {
        schema: {
          operationId: 'getPerformance',
          summary: 'Time-weighted return, money-weighted return and dollar gain — in three shapes',
          description:
            '07 §4.2: never a TWR beside a dollar gain, never a benchmarked MWR. The three ' +
            'answers occupy three disjoint objects under three keys, so no object in this ' +
            'payload expresses the forbidden pairing. WP 10.3: `account` or `management` ' +
            '(never both — 400) restricts the valuations and the flows to that scope; ' +
            '`summary` is the period’s dollar picture (value, net contributions, income, fees), ' +
            'a fourth disjoint object with every exclusion named.',
          tags: ['investments'],
          querystring: z.object({
            from: dateOnly,
            to: dateOnly.optional(),
            account: z
              .uuid()
              .optional()
              .describe('One account. Mutually exclusive with management.'),
            management: z
              .enum(MANAGEMENT_SCOPES)
              .optional()
              .describe(
                'Every account the holder classified so (account overrides), or `unclassified`.',
              ),
          }),
          response: {
            200: z.object({
              from: dateOnly,
              to: dateOnly,
              currency: z.string().length(3),
              scope: scopeWire,
              timeWeighted: timeWeightedWire,
              moneyWeighted: moneyWeightedWire,
              dollarGain: dollarGainWire,
              summary: periodSummaryWire,
              /** Movements we could see but could not value. Never counted as zero. */
              unvaluedTransfers: z.int().nonnegative(),
              valuationDates: z.array(dateOnly),
            }),
            ...problems(400, 401, 404, 503),
          },
        },
      },
      async (request) => {
        const session = await guards.requireSession(request);
        const { fromDate, toDate } = await periodOf(request.query);
        const scope = await resolveScope(session.userId, request.query);
        const answer = await performanceFor(session.userId, fromDate, toDate, scope.accountIds);
        return {
          from: fromDate,
          to: toDate,
          currency: BASE_CURRENCY,
          scope: {
            kind: scope.kind,
            management: scope.management,
            accountIds: scope.accountIds === null ? [] : [...scope.accountIds],
          },
          ...answer,
        };
      },
    );

    app.get(
      '/investments/performance/by-management',
      {
        schema: {
          operationId: 'getPerformanceByManagement',
          summary: 'Performance per management class: advisor, robo-advisor, self-directed',
          description:
            'One row per management class the holder has at least one investment account in, ' +
            'plus `unclassified` when an account has none (WP 10.3). Each row is the scoped ' +
            '`/investments/performance` answer: the same three disjoint objects (TWR, MWR, ' +
            'dollar gain) and the period summary, never merged. Only the TWR is comparable ' +
            'across rows (07 §4.2: it removes the effect of when money arrived); an MWR is the ' +
            'holder’s own rate and is never benchmarked.',
          tags: ['investments'],
          querystring: z.object({ from: dateOnly, to: dateOnly.optional() }),
          response: {
            200: z.object({
              from: dateOnly,
              to: dateOnly,
              currency: z.string().length(3),
              rows: z.array(
                z
                  .object({
                    management: z.enum(MANAGEMENT_SCOPES),
                    accountIds: z.array(z.uuid()),
                    timeWeighted: timeWeightedWire,
                    moneyWeighted: moneyWeightedWire,
                    dollarGain: dollarGainWire,
                    summary: periodSummaryWire,
                    unvaluedTransfers: z.int().nonnegative(),
                    valuationDates: z.array(dateOnly),
                  })
                  .meta({ id: 'ManagementPerformanceRow' }),
              ),
            }),
            ...problems(400, 401, 503),
          },
        },
      },
      async (request) => {
        const session = await guards.requireSession(request);
        const { fromDate, toDate } = await periodOf(request.query);
        const accounts = await investmentAccountsOf(database, session.userId);
        const rows = [];
        for (const management of MANAGEMENT_SCOPES) {
          const accountIds = accounts
            .filter((account) => (account.management ?? 'unclassified') === management)
            .map((account) => account.id);
          if (accountIds.length === 0) continue;
          rows.push({
            management,
            accountIds,
            ...(await performanceFor(session.userId, fromDate, toDate, accountIds)),
          });
        }
        return { from: fromDate, to: toDate, currency: BASE_CURRENCY, rows };
      },
    );

    app.put(
      '/investments/basis-method',
      {
        schema: {
          operationId: 'electBasisMethod',
          summary: 'Elect the cost-basis method for one account and security',
          description:
            'Needs a step-up assertion: `AVERAGE_COST` is sticky by database trigger ' +
            '(`basis_method_elections_average_cost_is_sticky`) and is a tax election the user ' +
            'cannot take back. **`AVERAGE_COST` is refused for anything that is not a mutual ' +
            'fund** — the engine does not know a security’s type, by design ' +
            '(wp3.2-lots.md §12 item 5), so the check belongs here, where it does.',
          tags: ['investments'],
          body: z.object({
            accountId: z.uuid(),
            securityId: z.uuid(),
            method: z.enum(BASIS_METHODS),
          }),
          response: {
            200: z.object({
              accountId: z.uuid(),
              securityId: z.uuid(),
              method: z.enum(BASIS_METHODS),
              sticky: z.boolean(),
            }),
            ...problems(400, 401, 403, 404, 409, 422, 503),
          },
        },
      },
      async (request) => {
        const session = await guards.requireFreshSession(request);
        const accounts = await listAccounts(database, {
          userId: session.userId,
          includeClosed: true,
        });
        if (!accounts.some((account) => account.id === request.body.accountId)) {
          throw new AppError({
            status: 404,
            code: 'investments.account_not_found',
            title: 'Not Found',
            detail: `no account ${request.body.accountId}`,
            family: 'user',
          });
        }
        const securityRows = await database.execute<{ type: SecurityType }>(sql`
          SELECT type FROM securities
           WHERE id = ${request.body.securityId}::uuid AND user_id = ${session.userId}::uuid
           LIMIT 1
        `);
        const securityType = securityRows.rows[0]?.type;
        if (securityType === undefined) {
          throw new AppError({
            status: 404,
            code: 'investments.security_not_found',
            title: 'Not Found',
            detail: `no security ${request.body.securityId}`,
            family: 'user',
          });
        }

        // 07 §4.4 and the IRS: average cost is available for mutual funds, not
        // for equities, ETFs or crypto. `AVERAGE_COST_ELIGIBLE_TYPES` is the
        // context's own list; this route is the first place in the system that
        // knows both the election *and* the security's type, which is exactly
        // why wp3.2-lots.md §12 item 5 left the check here.
        if (
          request.body.method === 'AVERAGE_COST' &&
          !(AVERAGE_COST_ELIGIBLE_TYPES as readonly string[]).includes(securityType)
        ) {
          throw new AppError({
            status: 422,
            code: 'investments.average_cost_ineligible',
            title: 'Unprocessable Content',
            detail:
              `AVERAGE_COST is available for ${AVERAGE_COST_ELIGIBLE_TYPES.join(', ')} only; ` +
              `this security is a ${securityType}.`,
            family: 'domain',
          });
        }

        try {
          await drizzleLotStore(database, clock).electBasisMethod({
            id: newId(),
            userId: session.userId,
            accountId: request.body.accountId,
            securityId: request.body.securityId,
            method: request.body.method,
            electedOn: DateOnly.parse(await todayFor(deps)),
          });
        } catch (error) {
          // The trigger raises `23514` and names itself in the error's
          // `constraint` field; the *message* is prose and does not repeat the
          // name. Matching on the constraint rather than the sentence is the
          // difference between a 409 and a 500 the day somebody rewords it —
          // and it has to be read through `cause`, because Drizzle wraps the
          // driver's error in a `DrizzleQueryError` that carries neither the
          // SQLSTATE nor the constraint on itself.
          if (constraintOf(error) === 'basis_method_elections_average_cost_is_sticky') {
            throw new AppError({
              status: 409,
              code: 'investments.average_cost_is_sticky',
              title: 'Conflict',
              detail:
                'AVERAGE_COST has already been elected for this account and security and cannot ' +
                'be switched away from (07 §4.4).',
              family: 'domain',
            });
          }
          throw error;
        }

        return {
          accountId: request.body.accountId,
          securityId: request.body.securityId,
          method: request.body.method,
          sticky: request.body.method === 'AVERAGE_COST',
        };
      },
    );
  };
};
