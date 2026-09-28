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
import { listAccounts } from '@ctx/ledger';
import {
  AVERAGE_COST_ELIGIBLE_TYPES,
  BASIS_METHODS,
  allocationOf,
  createPriceReader,
  driftAgainstTargets,
  drizzleLotStore,
  drizzlePriceStore,
  effectiveClassificationOf,
  identifierKeyOf,
  marketValueOf,
  moneyWeightedReturn,
  portfolioDollarGain,
  ratio,
  timeWeightedReturn,
  valueHoldings,
  type AllocationDimension,
  type AllocationReport,
  type AllocationTarget,
  type AnalyticsHolding,
  type BasisMethod,
  type DatedValuation,
  type DerivedClassification,
  type DollarGain,
  type ExternalFlow,
  type IdentifierKind,
  type Lot,
  type MoneyWeightedReturn,
  type PricePoint,
  type PriceReader,
  type StoredOverlay,
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
// C-8's UI half (gate-security-review.md G3-11): a position the resolver
// could not identify, surfaced on the holdings response rather than being
// invisible. The other half — a notifications `render.ts` case — is
// `@ctx/notifications`' `src/render.ts`; that surface needs a rule the user
// created, this one needs nothing.
// ---------------------------------------------------------------------------

/** One `investments.SecurityResolutionFailed` payload's shape, off the wire (`@ctx/investments`' `events.ts`). */
interface UnresolvedEventRow extends Record<string, unknown> {
  provider: string;
  provider_security_id: string | null;
  name: string | null;
  identifiers: readonly {
    readonly kind: string;
    readonly value: string;
    readonly chain: string | null;
    readonly mic: string | null;
  }[];
  abstentions: readonly {
    readonly tier: string;
    readonly reason: string;
    readonly detail: string | null;
  }[];
  observed_at: Date;
}

export interface UnresolvedSecurity {
  readonly provider: string;
  readonly providerSecurityId: string | null;
  readonly name: string | null;
  readonly abstentions: readonly {
    readonly tier: string;
    readonly reason: string;
    readonly detail: string | null;
  }[];
  readonly observedAt: string;
}

/** How many failure events to read before dedupe-by-identity, and how many unresolved positions to show. */
const MAX_UNRESOLVED_EVENTS = 200;
const MAX_UNRESOLVED_SECURITIES = 25;

/**
 * True when at least one identifier the failed event carried now has a
 * matching `security_identifiers` row — i.e. a later sync resolved it, so
 * this is not a *current* gap even though the event is still in
 * `domain_events` (append-only; nothing here rewrites or expires it).
 */
async function anyIdentifierNowResolved(
  database: Database,
  userId: string,
  provider: string,
  identifiers: UnresolvedEventRow['identifiers'],
): Promise<boolean> {
  if (identifiers.length === 0) return false;
  const keys = identifiers.map((identifier) =>
    identifierKeyOf({
      kind: identifier.kind as IdentifierKind,
      value: identifier.value,
      chain: identifier.chain,
      mic: identifier.mic,
      provider,
    }),
  );
  const result = await database.execute<{ resolved: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1 FROM security_identifiers
       WHERE user_id = ${userId}::uuid
         AND identifier_key = ANY(${keys}::text[])
    ) AS resolved
  `);
  return result.rows[0]?.resolved ?? false;
}

/**
 * The most recent `investments.SecurityResolutionFailed` per distinct
 * failure — `(provider, providerSecurityId ?? name)`, since
 * `providerSecurityId` is legitimately absent for some abstain reasons and a
 * bare `DISTINCT ON` with SQL NULL would collapse every nameless failure
 * from one provider into one row — for positions that have not since
 * resolved (see {@link anyIdentifierNowResolved}).
 *
 * User-wide, not account-scoped: the event never carries an account id (by
 * design — see the event's own doc: "what it does not carry: … any account
 * id"), so `readHoldings`'s per-account `accountId` filter has nothing to
 * join against here. Both `GET /holdings` and `GET /accounts/:id/holdings`
 * show the same list for that reason, stated in each route's own
 * description.
 */
export async function readUnresolvedSecurities(
  database: Database,
  userId: string,
): Promise<readonly UnresolvedSecurity[]> {
  const result = await database.execute<UnresolvedEventRow>(sql`
    SELECT DISTINCT ON (payload ->> 'provider', coalesce(payload ->> 'providerSecurityId', payload ->> 'name', ''))
           payload ->> 'provider'           AS provider,
           payload ->> 'providerSecurityId' AS provider_security_id,
           payload ->> 'name'               AS name,
           coalesce(payload -> 'identifiers', '[]'::jsonb) AS identifiers,
           coalesce(payload -> 'abstentions', '[]'::jsonb) AS abstentions,
           occurred_at                      AS observed_at
      FROM domain_events
     WHERE user_id = ${userId}::uuid
       AND event_type = 'investments.SecurityResolutionFailed'
     ORDER BY payload ->> 'provider',
              coalesce(payload ->> 'providerSecurityId', payload ->> 'name', ''),
              seq DESC
     LIMIT ${MAX_UNRESOLVED_EVENTS}
  `);

  const unresolved: UnresolvedSecurity[] = [];
  for (const row of result.rows) {
    if (unresolved.length >= MAX_UNRESOLVED_SECURITIES) break;
    const resolved = await anyIdentifierNowResolved(
      database,
      userId,
      row.provider,
      row.identifiers,
    );
    if (resolved) continue;
    unresolved.push({
      provider: row.provider,
      providerSecurityId: row.provider_security_id,
      name: row.name,
      abstentions: row.abstentions,
      observedAt: new Date(row.observed_at).toISOString(),
    });
  }
  return unresolved;
}

const unresolvedSecurityWire = z
  .object({
    provider: z.string(),
    providerSecurityId: z.string().nullable(),
    name: z.string().nullable(),
    abstentions: z.array(
      z.object({ tier: z.string(), reason: z.string(), detail: z.string().nullable() }),
    ),
    observedAt: z.string(),
  })
  .meta({ id: 'UnresolvedSecurity' });

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
  const bySecurity = new Map<string, PricePoint | null>();
  for (const securityId of new Set(reads.map((read) => read.securityId))) {
    bySecurity.set(securityId, await reader.price(securityId, asOf, BASE_CURRENCY));
  }

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
  reason: z.enum(['stale_price', 'price_unknown', 'currency_mismatch']),
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

function allocationWireOf(report: AllocationReport): z.infer<typeof allocationReportWire> {
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
    excluded: report.excluded.map((row) => ({ ...row })),
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

// ---------------------------------------------------------------------------
// Performance inputs
// ---------------------------------------------------------------------------

interface FlowRow extends Record<string, unknown> {
  trade_date: string;
  amount_minor: string | bigint;
  currency: string;
  type: string;
}

/**
 * The external cash flows a return is measured against.
 *
 * **Which rows count, and why.** A `BUY` inside an investment account moves cash
 * from that account's sweep into a security; it changes nothing about what the
 * user *put in*, so it is internal and must not appear here — counting it would
 * make every purchase look like a deposit and drag the measured return towards
 * zero. What counts is value crossing the account boundary: `CASH` (deposits
 * and withdrawals, house sign convention, negative = out), `TRANSFER_IN` and
 * `TRANSFER_OUT`.
 *
 * A transfer whose `amount_minor` is zero is a real movement we cannot value —
 * an in-kind securities transfer with no cash leg — and it is **counted in
 * `unvaluedTransfers` rather than treated as a zero flow**, because a zero flow
 * silently attributes the whole transferred position to performance.
 */
async function readFlows(
  database: Database,
  userId: string,
  from: string,
  to: string,
): Promise<{ readonly flows: readonly ExternalFlow[]; readonly unvaluedTransfers: number }> {
  const result = await database.execute<FlowRow>(sql`
    SELECT to_char(trade_date, 'YYYY-MM-DD') AS trade_date,
           amount_minor,
           currency,
           type
      FROM investment_transactions
     WHERE user_id = ${userId}::uuid
       AND type IN ('CASH', 'TRANSFER_IN', 'TRANSFER_OUT')
       AND trade_date > ${from}::date
       AND trade_date <= ${to}::date
     ORDER BY trade_date
  `);

  const flows: ExternalFlow[] = [];
  let unvaluedTransfers = 0;
  for (const row of result.rows) {
    const code = toCurrency(row.currency.trim());
    // D4 again: a foreign-currency flow is not converted at a rate this route
    // did not read. It is left out and named, never folded in at par.
    if (code !== BASE_CURRENCY) {
      unvaluedTransfers += 1;
      continue;
    }
    const minor = BigInt(row.amount_minor);
    if (minor === 0n) {
      unvaluedTransfers += 1;
      continue;
    }
    flows.push({
      date: DateOnly.parse(String(row.trade_date).slice(0, 10)),
      amount: Money.of(minor, code),
    });
  }
  return { flows, unvaluedTransfers };
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
 * What was held on `date`, across every account, one row per account × security.
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
): Promise<readonly PositionRow[]> {
  const result = await database.execute<PositionRow>(sql`
    SELECT DISTINCT ON (security_id, account_id)
           security_id, account_id, quantity, to_char(as_of_date, 'YYYY-MM-DD') AS as_of_date
      FROM (
        SELECT security_id, account_id, quantity, as_of_date
          FROM holdings_snapshots
         WHERE user_id = ${userId}::uuid
        UNION ALL
        SELECT security_id, account_id, quantity, as_of_date
          FROM holdings
         WHERE user_id = ${userId}::uuid
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
            '`unresolved` (C-8, G3-11) lists positions the resolver could not identify at all — ' +
            'user-wide rather than aggregated by security, because there is no security to key ' +
            'them by; the event never carries an account id either, so this list is the same on ' +
            'every account’s own holdings response.',
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

        const unresolved = await readUnresolvedSecurities(database, session.userId);

        return {
          asOf,
          basis,
          currency: BASE_CURRENCY,
          total: money(set.total),
          unclassifiedPct: allocation.unclassifiedPct,
          holdings,
          excluded: set.excluded.map((row) => ({ ...row })),
          unresolved: unresolved.map((row) => ({
            ...row,
            abstentions: row.abstentions.map((a) => ({ ...a })),
          })),
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
            'than computed from a zero. `unresolved` (C-8, G3-11) is the same user-wide list ' +
            '`GET /holdings` carries, not filtered to this account: the resolution-failure event ' +
            'never carries an account id, so there is nothing to filter by.',
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

        const unresolved = await readUnresolvedSecurities(database, session.userId);

        return {
          accountId: request.params.accountId,
          asOf,
          basis,
          currency: BASE_CURRENCY,
          total: money(set.total),
          unclassifiedPct: allocation.unclassifiedPct,
          positions,
          excluded: set.excluded.map((row) => ({ ...row })),
          unresolved: unresolved.map((row) => ({
            ...row,
            abstentions: row.abstentions.map((a) => ({ ...a })),
          })),
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
        const of = (dimension: AllocationDimension): z.infer<typeof allocationReportWire> =>
          allocationWireOf(allocationOf(dimension, set, options));
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
            allocation: allocationWireOf(allocation),
            excluded: set.excluded.map((row) => ({ ...row })),
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
          allocation: allocationWireOf(report.allocation),
          excluded: report.excluded.map((row) => ({ ...row })),
        };
      },
    );

    app.get(
      '/investments/performance',
      {
        schema: {
          operationId: 'getPerformance',
          summary: 'Time-weighted return, money-weighted return and dollar gain — in three shapes',
          description:
            '07 §4.2: never a TWR beside a dollar gain, never a benchmarked MWR. The three ' +
            'answers occupy three disjoint objects under three keys, so no object in this ' +
            'payload expresses the forbidden pairing.',
          tags: ['investments'],
          querystring: z.object({ from: dateOnly, to: dateOnly.optional() }),
          response: {
            200: z.object({
              from: dateOnly,
              to: dateOnly,
              currency: z.string().length(3),
              timeWeighted: timeWeightedWire,
              moneyWeighted: moneyWeightedWire,
              dollarGain: dollarGainWire,
              /** Movements we could see but could not value. Never counted as zero. */
              unvaluedTransfers: z.int().nonnegative(),
              valuationDates: z.array(dateOnly),
            }),
            ...problems(400, 401, 503),
          },
        },
      },
      async (request) => {
        const session = await guards.requireSession(request);
        const to = request.query.to ?? (await todayFor(deps));
        if (!DateOnly.is(request.query.from) || !DateOnly.is(to)) {
          throw new AppError({
            status: 400,
            code: 'investments.invalid_period',
            title: 'Bad Request',
            detail: 'from and to must be calendar dates that exist',
            family: 'user',
          });
        }
        const fromDate = DateOnly.parse(request.query.from);
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

        const { flows, unvaluedTransfers } = await readFlows(
          database,
          session.userId,
          fromDate,
          toDate,
        );
        const dates = valuationDatesFor(fromDate, toDate, flows);

        // One kind lookup for the whole user, so the price ladder is asked for
        // one kind per security rather than one per (security, date).
        const kindRows = await database.execute<{ id: string; type: string }>(sql`
          SELECT id, type FROM securities WHERE user_id = ${session.userId}::uuid
        `);
        const kinds = new Map(kindRows.rows.map((row) => [row.id, row.type]));
        const reader = priceReaderFor(database, session.userId, clock, kinds);
        const scale = minorUnitScale(BASE_CURRENCY);

        const valuations: DatedValuation[] = [];
        for (const date of dates) {
          const positions = await positionsOn(database, session.userId, date);
          let total = Money.zero(BASE_CURRENCY);
          for (const position of positions) {
            const point = await reader.price(position.security_id, date, BASE_CURRENCY);
            if (point === null) continue;
            const priceCurrency = toCurrency(point.currency);
            if (priceCurrency !== BASE_CURRENCY) continue;
            // `marketValueOf` is `@ctx/investments`' own `quantity × price`,
            // rounded once, half-even, at the boundary into minor units. Reused
            // rather than rewritten: a second rounding rule here would put two
            // different portfolio values on two different screens.
            total = Money.add(
              total,
              marketValueOf(
                Quantity.fromDatabaseString(String(position.quantity)),
                { amount: Quantity.of(point.close), currency: priceCurrency },
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
        const portfolio = await portfolioFor(session.userId, null, toDate);
        const set = valueHoldings(portfolio.holdings, valuationOptionsFor('last_known'));
        const valuedById = new Map(set.valued.map((entry) => [entry.holding.holdingId, entry]));
        const positions: ValuedPosition[] = portfolio.reads.map((read) => ({
          id: read.holdingId,
          marketValue: valuedById.get(read.holdingId)?.marketValue ?? null,
          costBasis: read.costBasis,
        }));

        return {
          from: fromDate,
          to: toDate,
          currency: BASE_CURRENCY,
          timeWeighted: timeWeightedWireOf(twr),
          moneyWeighted: moneyWeightedWireOf(mwr),
          dollarGain: dollarGainWireOf(portfolioDollarGain(positions, BASE_CURRENCY)),
          unvaluedTransfers,
          valuationDates: [...dates],
        };
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
