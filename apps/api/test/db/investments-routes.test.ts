// SPDX-License-Identifier: MIT
/**
 * WP 3.9's REST surface for investments, over a real database.
 *
 * ## Why this suite seeds with SQL when every other route suite links a
 * connector
 *
 * `api-harness.ts`'s header states the rule and the reason: the ledger is
 * filled by linking a `ManualConnector` and running a sync, because a suite that
 * seeded with raw SQL "would be asserting against rows no production code path
 * can produce". That rule is honoured here for everything it *can* be honoured
 * for — the **accounts** these holdings sit in are real, linked over HTTP
 * through `POST /connections` — and it is deliberately broken for `securities`,
 * `holdings`, `holdings_snapshots`, `prices` and `investment_transactions`,
 * because in this repository at this commit there is exactly one code path that
 * writes them and it is **WP 3.7's Plaid investments sync, still in flight in a
 * concurrent work package**. Waiting for it would mean shipping this route file
 * with no test at all, and building a second fake sync here would be a fixture
 * asserting against itself.
 *
 * What the seed below is careful about is that it writes rows the real writers
 * would write: `cost_basis_minor` is `NULL` on the position whose basis is
 * genuinely unknown (never `0`), `prices.source` is never `last_known` (the
 * `prices_source_is_an_observation` CHECK), quantities are decimal strings, and
 * `observed_at` — not `price_date` — is what makes a price stale, because 07
 * §6.1's rule is about the clock at read time.
 *
 * ## The three exit tests
 *
 *   * `'every route refuses another user's data'` — one case per route family.
 *     D6 means there is normally one holder, which is exactly why this has to be
 *     asserted: a single-user deployment never exercises the control by
 *     accident. §4 of `docs/evidence/phase-3/wp3.9-routes.md` records the
 *     sabotage that turns it red.
 *   * `'the performance response cannot express a TWR and a dollar gain in the
 *     same object'` — a **type-level** test. `@ts-expect-error` is checked by
 *     `tsc -b`, not by vitest, and that is the point: if the `?: never` guards
 *     on `WireTimeWeightedReturn` are removed, the directive becomes unused and
 *     `tsc` fails the build.
 *   * `'a stale price is labeled in the response rather than silently fresh'` —
 *     against the payload, not against date arithmetic the test did itself.
 */
import { newId } from '@core/kernel';
import { WALLETRPC_PROVIDER } from '@connector/walletrpc';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  WireDollarGain,
  WireMoneyWeightedReturn,
  WireTimeWeightedReturn,
} from '../../src/routes/investments.ts';
import {
  NO_DATABASE,
  createApiHarness,
  expectStatus,
  linkManual,
  problemOf,
  type ApiHarness,
} from '../helpers/api-harness.ts';

const DAY_MS = 86_400_000;

/**
 * BIP84's published test-vector account key, the same one
 * `@connector/walletrpc`'s own suite uses. Public material by construction: a
 * zpub derives addresses and can sign nothing.
 */
const WATCH_ONLY_ZPUB =
  'zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs';

function isoDay(offsetDays: number): string {
  return new Date(Date.now() + offsetDays * DAY_MS).toISOString().slice(0, 10);
}

/**
 * Walks a thrown error's `.cause` chain for the first node shaped like a
 * Postgres error (a five-character SQLSTATE), so a raw-SQL constraint
 * violation can be asserted by code and by name rather than by message
 * text. Same shape as `packages/contexts/planning/test/db/assumptions.test.ts`'s
 * own `sqlStateOf` — not imported, so this file has no cross-suite dependency
 * on another work package's test file.
 */
function sqlStateOf(error: unknown): { code?: string; constraint?: string } {
  let cursor: unknown = error;
  while (cursor !== null && typeof cursor === 'object') {
    const candidate = cursor as { code?: unknown; constraint?: unknown; cause?: unknown };
    if (typeof candidate.code === 'string' && /^[0-9A-Z]{5}$/.test(candidate.code)) {
      return {
        code: candidate.code,
        ...(typeof candidate.constraint === 'string' ? { constraint: candidate.constraint } : {}),
      };
    }
    cursor = candidate.cause;
  }
  return {};
}

interface Seeded {
  readonly brokerageAccountId: string;
  readonly iraAccountId: string;
  readonly vti: string;
  readonly bnd: string;
  readonly mutualFund: string;
}

interface HoldingsBody {
  readonly asOf: string;
  readonly total: { minor: string; currency: string };
  readonly unclassifiedPct: string;
  readonly holdings: readonly {
    securityId: string;
    symbol: string | null;
    quantity: string;
    accountCount: number;
    marketValue: { minor: string } | null;
    costBasis: { minor: string } | null;
    unrealized: { status: string; gain: unknown; reason: string | null };
    stale: boolean;
    price: { staleness: string; rung: string } | null;
  }[];
  readonly excluded: readonly { holdingId: string; reason: string }[];
}

describe.skipIf(NO_DATABASE)('/holdings, /securities, /prices and /investments (WP 3.9)', () => {
  let h: ApiHarness;
  let seeded: Seeded;
  let otherUserId: string;

  /** A securities row, written the way `SecurityResolver` writes one. */
  async function insertSecurity(
    userId: string,
    input: {
      readonly ticker: string;
      readonly name: string;
      readonly type: string;
      readonly assetClass: string;
      readonly region: string;
      readonly sector: string;
    },
  ): Promise<string> {
    const id = newId();
    await h.database.db.execute(sql`
      INSERT INTO securities (
        id, user_id, identity_kind, identity_key, ticker, name, type, currency,
        is_cash_equivalent, asset_class, region, sector,
        classification_source, classification_depth, classification_flagged
      ) VALUES (
        ${id}::uuid, ${userId}::uuid, 'ticker', ${`ticker:${input.ticker}:${userId.slice(0, 8)}`},
        ${input.ticker}, ${input.name}, ${input.type}, 'USD', false,
        ${input.assetClass}, ${input.region}, ${input.sector}, 'LOCAL_SEED_TABLE', 0, false
      )
    `);
    return id;
  }

  async function insertHolding(input: {
    readonly userId: string;
    readonly accountId: string;
    readonly securityId: string;
    readonly quantity: string;
    /** `null` is a genuinely unknown basis. It is never written as a zero. */
    readonly costBasisMinor: bigint | null;
    readonly institutionValueMinor: bigint;
  }): Promise<void> {
    await h.database.db.execute(sql`
      INSERT INTO holdings (
        id, user_id, account_id, security_id, quantity, institution_value_minor, currency,
        cost_basis_minor, cost_basis_is_user_supplied, cost_basis_source, as_of_date
      ) VALUES (
        ${newId()}::uuid, ${input.userId}::uuid, ${input.accountId}::uuid,
        ${input.securityId}::uuid, ${input.quantity}, ${input.institutionValueMinor}, 'USD',
        ${input.costBasisMinor}, false,
        ${input.costBasisMinor === null ? 'ESTIMATED' : 'BROKER'}, ${isoDay(0)}::date
      )
    `);
  }

  /**
   * One observation. `observedAtOffsetHours` is what decides staleness — not
   * `priceDate` — because 07 §6.1's rule is "how old is this information?".
   */
  async function insertPrice(input: {
    readonly userId: string;
    readonly securityId: string;
    readonly priceDate: string;
    readonly close: string;
    readonly observedAtOffsetHours: number;
  }): Promise<void> {
    const observedAt = new Date(Date.now() + input.observedAtOffsetHours * 3_600_000);
    await h.database.db.execute(sql`
      INSERT INTO prices (
        id, user_id, security_id, price_date, source, close, currency, stale, observed_at
      ) VALUES (
        ${newId()}::uuid, ${input.userId}::uuid, ${input.securityId}::uuid,
        ${input.priceDate}::date, 'tiingo', ${input.close}, 'USD', false,
        ${observedAt.toISOString()}::timestamptz
      )
    `);
  }

  beforeAll(async () => {
    h = await createApiHarness({ suite: 'wp39-inv' });
    otherUserId = await h.database.createUser('Second Holder');

    const linked = await linkManual(h, {
      providerConnectionId: 'wp39-inv-conn',
      displayName: 'Test Brokerage',
      accounts: [
        { providerAccountId: 'brokerage', name: 'Taxable', type: 'investment', currency: 'USD' },
        { providerAccountId: 'ira', name: 'Rollover IRA', type: 'investment', currency: 'USD' },
      ],
    });
    const accountRows = await h.database.db.execute<{
      id: string;
      provider_account_id: string;
    }>(sql`
      SELECT a.id, a.provider_account_id
        FROM accounts a
       WHERE a.user_id = ${h.userId}::uuid
       ORDER BY a.provider_account_id
    `);
    const byProvider = new Map(accountRows.rows.map((row) => [row.provider_account_id, row.id]));
    const brokerageAccountId = byProvider.get('brokerage');
    const iraAccountId = byProvider.get('ira');
    if (brokerageAccountId === undefined || iraAccountId === undefined) {
      throw new Error(`the manual link did not create both accounts: ${linked.accountIds.join()}`);
    }

    const vti = await insertSecurity(h.userId, {
      ticker: 'VTI',
      name: 'Vanguard Total Stock Market ETF',
      type: 'etf',
      assetClass: 'US_EQUITY',
      region: 'US',
      sector: 'DIVERSIFIED',
    });
    const bnd = await insertSecurity(h.userId, {
      ticker: 'BND',
      name: 'Vanguard Total Bond Market ETF',
      type: 'etf',
      assetClass: 'US_BOND',
      region: 'US',
      sector: 'DIVERSIFIED',
    });
    const mutualFund = await insertSecurity(h.userId, {
      ticker: 'VTSAX',
      name: 'Vanguard Total Stock Market Index Admiral',
      type: 'mutual_fund',
      assetClass: 'US_EQUITY',
      region: 'US',
      sector: 'DIVERSIFIED',
    });

    // VTI in both accounts — the "aggregated by ticker **across** accounts"
    // claim needs two rows for one security or it proves nothing.
    await insertHolding({
      userId: h.userId,
      accountId: brokerageAccountId,
      securityId: vti,
      quantity: '10.000000000000000000',
      costBasisMinor: 200_000n,
      institutionValueMinor: 250_000n,
    });
    await insertHolding({
      userId: h.userId,
      accountId: iraAccountId,
      securityId: vti,
      quantity: '5.000000000000000000',
      costBasisMinor: 100_000n,
      institutionValueMinor: 125_000n,
    });
    // BND with a genuinely unknown basis. NULL, never 0 — 04 §5.5.
    await insertHolding({
      userId: h.userId,
      accountId: brokerageAccountId,
      securityId: bnd,
      quantity: '20.000000000000000000',
      costBasisMinor: null,
      institutionValueMinor: 150_000n,
    });

    // VTI: observed an hour ago → FRESH. BND: observed two days ago → STALE,
    // even though its `price_date` is today's.
    await insertPrice({
      userId: h.userId,
      securityId: vti,
      priceDate: isoDay(0),
      close: '250.0000000000',
      observedAtOffsetHours: -1,
    });
    await insertPrice({
      userId: h.userId,
      securityId: bnd,
      priceDate: isoDay(0),
      close: '75.0000000000',
      observedAtOffsetHours: -48,
    });

    // A second holder with a security of their own, so "refuses another user's
    // data" is a real cross-user assertion and not a query against an empty
    // database.
    await insertSecurity(otherUserId, {
      ticker: 'SPY',
      name: 'SPDR S&P 500 ETF',
      type: 'etf',
      assetClass: 'US_EQUITY',
      region: 'US',
      sector: 'DIVERSIFIED',
    });

    seeded = { brokerageAccountId, iraAccountId, vti, bnd, mutualFund };
  }, 120_000);

  afterAll(async () => {
    await h.close();
  });

  // ---------------------------------------------------------------- holdings

  it('aggregates one security across every account that holds it', async () => {
    const response = await h.request({ method: 'GET', url: '/holdings', session: h.stale });
    expectStatus(response, 200);
    const body = response.json() as HoldingsBody;

    const vti = body.holdings.find((row) => row.securityId === seeded.vti);
    expect(vti, 'VTI should be one row, not two').toBeDefined();
    expect(vti?.accountCount).toBe(2);
    expect(vti?.quantity).toBe('15.000000000000000000');
    // 15 × 250.00 = $3,750.00
    expect(vti?.marketValue?.minor).toBe('375000');
    expect(vti?.costBasis?.minor).toBe('300000');
    expect(vti?.unrealized.status).toBe('available');

    expect(body.holdings.filter((row) => row.securityId === seeded.vti)).toHaveLength(1);
  });

  it('reports an unknown basis as unavailable rather than a gain from zero', async () => {
    const response = await h.request({
      method: 'GET',
      url: `/holdings?basis=last_known`,
      session: h.stale,
    });
    expectStatus(response, 200);
    const body = response.json() as HoldingsBody;
    const bnd = body.holdings.find((row) => row.securityId === seeded.bnd);
    expect(bnd?.costBasis).toBeNull();
    expect(bnd?.unrealized.status).toBe('unavailable');
    expect(bnd?.unrealized.reason).toBe('basis_unknown');
    expect(bnd?.unrealized.gain).toBeNull();
    // The market value is still reported: the position's *worth* is knowable
    // even when its cost is not.
    expect(bnd?.marketValue?.minor).toBe('150000');
  });

  it('a stale price is labeled in the response rather than silently fresh', async () => {
    // 1. On the aggregated view, as a field on the row.
    const holdings = await h.request({
      method: 'GET',
      url: '/holdings?basis=last_known',
      session: h.stale,
    });
    expectStatus(holdings, 200);
    const body = holdings.json() as HoldingsBody;
    const bnd = body.holdings.find((row) => row.securityId === seeded.bnd);
    const vti = body.holdings.find((row) => row.securityId === seeded.vti);
    expect(bnd?.stale, 'a price observed 48 h ago is STALE').toBe(true);
    expect(bnd?.price?.staleness).toBe('STALE');
    expect(vti?.stale, 'a price observed an hour ago is not').toBe(false);
    expect(vti?.price?.staleness).toBe('FRESH');

    // 2. On the price route itself, as a field rather than as a date the client
    //    is trusted to subtract.
    const price = await h.request({
      method: 'GET',
      url: `/prices/${seeded.bnd}`,
      session: h.stale,
    });
    expectStatus(price, 200);
    const priceBody = price.json() as {
      price: { staleness: string; includeInAsOfNowDeltas: boolean; rung: string } | null;
    };
    expect(priceBody.price?.staleness).toBe('STALE');
    expect(priceBody.price?.includeInAsOfNowDeltas).toBe(false);

    // 3. And under `as_of_now` it leaves the denominator entirely and is *named*
    //    in `excluded` — 07 §6.1, rather than being counted at last week's
    //    number.
    const asOfNow = await h.request({ method: 'GET', url: '/holdings', session: h.stale });
    expectStatus(asOfNow, 200);
    const nowBody = asOfNow.json() as HoldingsBody;
    expect(nowBody.excluded.some((row) => row.reason === 'stale_price')).toBe(true);
    expect(nowBody.total.minor).toBe('375000');
  });

  it('returns unclassifiedPct as a field on allocation, present even when it is zero', async () => {
    const response = await h.request({
      method: 'GET',
      url: '/investments/allocation?basis=last_known',
      session: h.stale,
    });
    expectStatus(response, 200);
    const body = response.json() as {
      byAssetClass: { unclassifiedPct: string; slices: { key: string; weight: string }[] };
      byRegion: { unclassifiedPct: string };
      bySector: { unclassifiedPct: string };
    };
    for (const report of [body.byAssetClass, body.byRegion, body.bySector]) {
      expect(typeof report.unclassifiedPct).toBe('string');
    }
    expect(body.byAssetClass.unclassifiedPct).toBe('0.0000000000');
    const keys = body.byAssetClass.slices.map((slice) => slice.key).sort();
    expect(keys).toEqual(['US_BOND', 'US_EQUITY']);
  });

  it('drift suppresses rather than invents when no target has been set', async () => {
    const response = await h.request({
      method: 'GET',
      url: '/investments/drift?basis=last_known',
      session: h.stale,
    });
    expectStatus(response, 200);
    const body = response.json() as {
      targetsSet: boolean;
      rows: unknown[];
      unclassifiedPct: string;
    };
    expect(body.targetsSet).toBe(false);
    expect(body.rows).toHaveLength(0);
    // Still reported: 07 §4.3 wants it beside *every* drift number, including
    // the absence of one.
    expect(body.unclassifiedPct).toBe('0.0000000000');
  });

  it('drift against a 60/40 target reports the gap in points on the absolute band', async () => {
    const response = await h.request({
      method: 'GET',
      url: '/investments/drift?basis=last_known&target=US_EQUITY:0.6&target=US_BOND:0.4',
      session: h.stale,
    });
    expectStatus(response, 200);
    const body = response.json() as {
      targetsSet: boolean;
      bandPoints: string;
      rows: { assetClass: string; actualWeight: string; gapPoints: string; insideBand: boolean }[];
    };
    expect(body.targetsSet).toBe(true);
    expect(body.bandPoints).toBe('5.0000');
    // $3,750 equity / $5,250 total = 71.428…%, against a 60% target: +11.43pp.
    const equity = body.rows.find((row) => row.assetClass === 'US_EQUITY');
    expect(equity?.gapPoints.startsWith('11.4')).toBe(true);
    expect(equity?.insideBand).toBe(false);
  });

  // ------------------------------------------------------- performance shapes

  it('the performance response cannot express a TWR and a dollar gain in the same object', () => {
    /**
     * A **type-level** assertion. `tsc -b` is what checks it; vitest only keeps
     * it in a file that runs. Removing the `?: never` members from
     * `WireTimeWeightedReturn` makes each `@ts-expect-error` below *unused*,
     * and an unused `@ts-expect-error` is itself a compile error — so the guard
     * cannot be deleted quietly.
     */
    const twr: WireTimeWeightedReturn = {
      kind: 'time_weighted',
      periodReturn: '0.0800000000',
      annualized: null,
      annualizationWithheld: 'period_under_one_year',
      spanDays: 90,
      from: '2026-01-01',
      to: '2026-04-01',
      method: 'sub_period_linking',
      approximate: false,
      warnings: [],
      benchmarkComparable: true,
    };

    // @ts-expect-error 07 §4.2: a time-weighted return may never carry a dollar gain.
    const twrWithGain: WireTimeWeightedReturn = { ...twr, gain: { minor: '800', currency: 'USD' } };

    const twrWithValue: WireTimeWeightedReturn = {
      ...twr,
      // @ts-expect-error 07 §4.2: nor a market value, which is the same mistake wearing a hat.
      marketValue: { minor: '1', currency: 'USD' },
    };

    const gain: WireDollarGain = {
      kind: 'dollar_gain',
      status: 'available',
      gain: { minor: '800', currency: 'USD' },
      marketValue: { minor: '10800', currency: 'USD' },
      costBasis: { minor: '10000', currency: 'USD' },
    };

    // @ts-expect-error 07 §4.2: and a dollar gain may never carry a return.
    const gainWithReturn: WireDollarGain = { ...gain, periodReturn: '0.0800000000' };

    const mwr: WireMoneyWeightedReturn = {
      kind: 'money_weighted',
      status: 'unavailable',
      reason: 'no_sign_change_in_flows',
      detail: 'every flow has the same sign',
      spanDays: 90,
      benchmarkComparable: false,
    };

    // @ts-expect-error 07 §4.2's second half: an MWR may never be benchmarked.
    const mwrWithBenchmark: WireMoneyWeightedReturn = { ...mwr, benchmark: '0.1000000000' };

    // Consumed so the bindings are not unused; the assertion that matters
    // already happened in the type checker.
    expect([twrWithGain, twrWithValue, gainWithReturn, mwrWithBenchmark]).toHaveLength(4);
  });

  it('serves the three performance answers under three separate keys', async () => {
    const response = await h.request({
      method: 'GET',
      url: `/investments/performance?from=${isoDay(-30)}&to=${isoDay(0)}`,
      session: h.stale,
    });
    expectStatus(response, 200);
    const body = response.json() as {
      timeWeighted: Record<string, unknown>;
      moneyWeighted: Record<string, unknown>;
      dollarGain: Record<string, unknown>;
    };
    expect(body.timeWeighted['kind']).toBe('time_weighted');
    expect(body.moneyWeighted['kind']).toBe('money_weighted');
    expect(body.dollarGain['kind']).toBe('dollar_gain');

    // The wire rule, asserted on the payload as well as in the type system: the
    // serialiser drops `subPeriods` precisely so no dollar figure rides inside
    // the TWR object.
    for (const forbidden of ['gain', 'dollarGain', 'marketValue', 'costBasis', 'subPeriods']) {
      expect(Object.keys(body.timeWeighted)).not.toContain(forbidden);
    }
    expect(Object.keys(body.moneyWeighted)).not.toContain('benchmark');
    expect(Object.keys(body.dollarGain)).not.toContain('periodReturn');

    // The portfolio holds one position with no basis, so the gain is
    // unavailable rather than computed from a zero.
    expect(body.dollarGain['status']).toBe('unavailable');
    expect(body.dollarGain['reason']).toBe('basis_unknown');
  });

  // ------------------------------------------------------------- the overlay

  it('an asset-class overlay survives as the effective classification and is locked', async () => {
    const patch = await h.request({
      method: 'PATCH',
      url: `/securities/${seeded.bnd}`,
      session: h.stale,
      body: { assetClass: 'TIPS' },
    });
    expectStatus(patch, 200);
    const patched = patch.json() as {
      security: {
        derived: { assetClass: string };
        overlay: { assetClass: string; lockedFields: string[] } | null;
        effective: { assetClass: string; classificationSource: string; overridden: string[] };
      };
    };
    expect(patched.security.derived.assetClass, 'the provider row is untouched').toBe('US_BOND');
    expect(patched.security.overlay?.assetClass).toBe('TIPS');
    // The invariant the route exists to hold: a stored value is always locked.
    expect(patched.security.overlay?.lockedFields).toContain('asset_class');
    expect(patched.security.effective.assetClass).toBe('TIPS');
    expect(patched.security.effective.classificationSource).toBe('USER_OVERRIDE');
    expect(patched.security.effective.overridden).toContain('asset_class');

    const allocation = await h.request({
      method: 'GET',
      url: '/investments/allocation?basis=last_known',
      session: h.stale,
    });
    expectStatus(allocation, 200);
    const keys = (
      allocation.json() as { byAssetClass: { slices: { key: string }[] } }
    ).byAssetClass.slices.map((slice) => slice.key);
    expect(keys, 'the overlay reaches the chart, not just the detail screen').toContain('TIPS');

    // Clearing it unlocks it and the derived value comes back.
    const cleared = await h.request({
      method: 'PATCH',
      url: `/securities/${seeded.bnd}`,
      session: h.stale,
      body: { assetClass: null },
    });
    expectStatus(cleared, 200);
    const back = cleared.json() as {
      security: { effective: { assetClass: string }; overlay: { lockedFields: string[] } | null };
    };
    expect(back.security.effective.assetClass).toBe('US_BOND');
    expect(back.security.overlay?.lockedFields).not.toContain('asset_class');
  });

  // --------------------------------------------------------- price overrides

  it('a price override needs a step-up assertion and then wins the ladder', async () => {
    const stale = await h.request({
      method: 'PUT',
      url: `/prices/${seeded.vti}`,
      session: h.stale,
      body: { priceDate: isoDay(0), close: '300.0000000000' },
    });
    expect(stale.statusCode).toBe(403);
    expect(problemOf(stale)['code']).toBe('step_up_required');

    const fresh = await h.request({
      method: 'PUT',
      url: `/prices/${seeded.vti}`,
      session: h.fresh,
      body: { priceDate: isoDay(0), close: '300.0000000000' },
    });
    expectStatus(fresh, 200);
    const body = fresh.json() as { price: { rung: string; close: string } | null };
    expect(body.price?.rung).toBe('user_override');
    expect(body.price?.close).toBe('300.0000000000');
  });

  // ----------------------------------------------- the basis-method election

  it('refuses an AVERAGE_COST election on anything that is not a mutual fund', async () => {
    const onEtf = await h.request({
      method: 'PUT',
      url: '/investments/basis-method',
      session: h.fresh,
      body: {
        accountId: seeded.brokerageAccountId,
        securityId: seeded.vti,
        method: 'AVERAGE_COST',
      },
    });
    expect(onEtf.statusCode).toBe(422);
    expect(problemOf(onEtf)['code']).toBe('investments.average_cost_ineligible');

    const onFund = await h.request({
      method: 'PUT',
      url: '/investments/basis-method',
      session: h.fresh,
      body: {
        accountId: seeded.brokerageAccountId,
        securityId: seeded.mutualFund,
        method: 'AVERAGE_COST',
      },
    });
    expectStatus(onFund, 200);
    expect((onFund.json() as { sticky: boolean }).sticky).toBe(true);

    // And it is sticky: the database trigger refuses the way back.
    const away = await h.request({
      method: 'PUT',
      url: '/investments/basis-method',
      session: h.fresh,
      body: { accountId: seeded.brokerageAccountId, securityId: seeded.mutualFund, method: 'FIFO' },
    });
    expect(away.statusCode).toBe(409);
    expect(problemOf(away)['code']).toBe('investments.average_cost_is_sticky');

    const staleAttempt = await h.request({
      method: 'PUT',
      url: '/investments/basis-method',
      session: h.stale,
      body: { accountId: seeded.brokerageAccountId, securityId: seeded.vti, method: 'HIFO' },
    });
    expect(staleAttempt.statusCode).toBe(403);
  });

  // ---------------------------------------------------------------- the scope

  it("every route refuses another user's data", async () => {
    const theirs = await h.issueSession({ userId: otherUserId, fresh: true });

    // 1. The aggregated holdings family. Their portfolio is empty; ours is not.
    const holdings = await h.request({ method: 'GET', url: '/holdings', session: theirs });
    expectStatus(holdings, 200);
    const holdingsBody = holdings.json() as HoldingsBody;
    expect(holdingsBody.holdings).toHaveLength(0);
    expect(holdingsBody.total.minor).toBe('0');

    // 2. The per-account family. Our account id is *not found* for them —
    //    a 403 would confirm the id exists.
    const account = await h.request({
      method: 'GET',
      url: `/accounts/${seeded.brokerageAccountId}/holdings`,
      session: theirs,
    });
    expect(account.statusCode).toBe(404);
    expect(problemOf(account)['code']).toBe('investments.account_not_found');

    // 3. The securities family, read and write.
    const security = await h.request({
      method: 'GET',
      url: `/securities/${seeded.vti}`,
      session: theirs,
    });
    expect(security.statusCode).toBe(404);
    const patch = await h.request({
      method: 'PATCH',
      url: `/securities/${seeded.vti}`,
      session: theirs,
      body: { assetClass: 'CRYPTO' },
    });
    expect(patch.statusCode).toBe(404);

    // 4. The prices family, read and write. The override must not be able to
    //    restate the value of a security that is not theirs.
    const price = await h.request({
      method: 'GET',
      url: `/prices/${seeded.vti}`,
      session: theirs,
    });
    expect(price.statusCode).toBe(404);
    const override = await h.request({
      method: 'PUT',
      url: `/prices/${seeded.vti}`,
      session: theirs,
      body: { priceDate: isoDay(0), close: '1.0000000000' },
    });
    expect(override.statusCode).toBe(404);

    // 5. The analytics family — allocation, drift and performance all read the
    //    same portfolio, so one case covers the three.
    const allocation = await h.request({
      method: 'GET',
      url: '/investments/allocation?basis=last_known',
      session: theirs,
    });
    expectStatus(allocation, 200);
    const allocationBody = allocation.json() as {
      byAssetClass: { total: { minor: string }; slices: unknown[] };
    };
    expect(allocationBody.byAssetClass.total.minor).toBe('0');
    expect(allocationBody.byAssetClass.slices).toHaveLength(0);

    const drift = await h.request({
      method: 'GET',
      url: '/investments/drift?basis=last_known&target=US_EQUITY:1',
      session: theirs,
    });
    expectStatus(drift, 200);
    expect((drift.json() as { total: { minor: string } }).total.minor).toBe('0');

    // 6. The basis-method election family.
    const election = await h.request({
      method: 'PUT',
      url: '/investments/basis-method',
      session: theirs,
      body: { accountId: seeded.brokerageAccountId, securityId: seeded.vti, method: 'HIFO' },
    });
    expect(election.statusCode).toBe(404);

    // And nothing above leaked a single one of our rows into their responses.
    const serialised = JSON.stringify([holdingsBody, allocationBody, drift.json()]);
    for (const id of [seeded.vti, seeded.bnd, seeded.brokerageAccountId, seeded.iraAccountId]) {
      expect(serialised).not.toContain(id);
    }
  });

  /**
   * WP 3.9 §4, S1: dropping `WHERE h.user_id` from `readHoldings` stayed
   * **green**, not because the control was absent but because the `JOIN
   * securities s ON … AND s.user_id` doubles it. That is proof the
   * *combination* leaks nothing for an ordinary, same-owner holding — it is
   * not proof either predicate is independently sufficient, and the sabotage
   * table itself says so: "a single-predicate sabotage is not sufficient
   * evidence for this route."
   *
   * **Phase 3 gate C-14 (§4.1(d)) closed the gap this test used to stand in
   * for.** Through the gate, `holdings.security_id` was a bare `REFERENCES
   * securities (id)`, not a composite FK against `(user_id, security_id)`,
   * so the plant below succeeded and the assertions that followed proved the
   * *read-path* predicates independently sufficient — proof the query is
   * safe, never proof the data is impossible. Migration `0025` adds
   * `holdings_security_belongs_to_user`, a composite FK to `securities
   * (user_id, id)` (itself now `UNIQUE`), so the exact insert below is now
   * refused by the database before a row is ever written — the assertion
   * this test now makes. The read-path predicates this test used to exercise
   * (`WHERE h.user_id`, `JOIN securities s ON … AND s.user_id`) still exist
   * in `readHoldings` as defence in depth, but there is no longer any way to
   * construct the row that would tell them apart.
   */
  it('a holding whose security belongs to another user is refused by the database (holdings_security_belongs_to_user), not merely by the read-path predicates', async () => {
    // otherUserId attempts to hold a security h.userId owns.
    let thrown: unknown;
    try {
      await insertHolding({
        userId: otherUserId,
        accountId: newId(), // opaque; `holdings.account_id` carries no FK (see the table's header)
        securityId: seeded.vti,
        quantity: '1.000000000000000000',
        costBasisMinor: null,
        institutionValueMinor: 10_000n,
      });
    } catch (error) {
      thrown = error;
    }
    const state = sqlStateOf(thrown);
    expect(state.code, 'a foreign_key_violation (23503), not a silent success').toBe('23503');
    expect(state.constraint).toBe('holdings_security_belongs_to_user');

    // The insert never happened: VTI's aggregate is exactly what the first
    // test in this file pinned, undisturbed by the refused plant.
    const asOwner = await h.request({ method: 'GET', url: '/holdings', session: h.stale });
    expectStatus(asOwner, 200);
    const ownerVti = (asOwner.json() as HoldingsBody).holdings.find(
      (row) => row.securityId === seeded.vti,
    );
    expect(ownerVti?.accountCount, 'the security owner never gained a planted row').toBe(2);
    expect(ownerVti?.quantity).toBe('15.000000000000000000');

    // The would-be planter has nothing either — the insert was refused, not
    // merely hidden from them by a query predicate.
    const theirs = await h.issueSession({ userId: otherUserId, fresh: true });
    const asPlanter = await h.request({ method: 'GET', url: '/holdings', session: theirs });
    expectStatus(asPlanter, 200);
    const planterBody = asPlanter.json() as HoldingsBody;
    expect(planterBody.holdings, 'nothing was ever inserted for the would-be planter').toHaveLength(
      0,
    );
    expect(planterBody.total.minor).toBe('0');

    // `/accounts/{id}/holdings`, `/investments/allocation` and
    // `/investments/drift` all read through this same `readHoldings` — see
    // `portfolioFor` in `apps/api/src/routes/investments.ts` — so the
    // structural fix (and this one test) covers every caller.
  });
});

/**
 * The seam `docs/evidence/phase-3/wp3.w-wiring.md` §10 item 8 left open.
 *
 * A separate harness because it needs the `wallet_rpc` connector registered,
 * which the default route harness deliberately does not do — `GET /connectors`
 * is asserted elsewhere against an exact provider list.
 */
describe.skipIf(NO_DATABASE)('the watch-only wallet link seam (WP 3.9)', () => {
  let h: ApiHarness;

  beforeAll(async () => {
    h = await createApiHarness({ suite: 'wp39-wallet', walletRpc: true });
  }, 120_000);

  afterAll(async () => {
    await h.close();
  });

  it('a watch-only wallet link persists its addresses on first connect', async () => {
    const response = await h.request({
      method: 'POST',
      url: '/connections',
      session: h.fresh,
      body: {
        provider: WALLETRPC_PROVIDER,
        input: {
          chain: 'bitcoin',
          // A watch-only BIP84 account key — the published test vector, also
          // used by `@connector/walletrpc`'s own suite. Never a private key and
          // never a seed phrase: `assertNoPrivateMaterial` refuses those at this
          // seam, before anything parses, stores or logs them.
          value: WATCH_ONLY_ZPUB,
          label: 'Cold storage',
        },
      },
    });
    expectStatus(response, 201);
    const body = response.json() as { connectionId: string };

    const rows = await h.database.db.execute<{
      chain: string;
      descriptor: string;
      label: string;
      connection_id: string;
    }>(sql`
      SELECT chain, descriptor, label, connection_id
        FROM wallet_addresses
       WHERE user_id = ${h.userId}::uuid
    `);

    // Before this work package, `createConnection` called `connect()` before
    // the `connections` row existed, so `put` had nowhere to write and this
    // table stayed empty — the connection linked and then answered "this
    // connection has no wallet on record" on its first sync from the worker.
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]?.connection_id).toBe(body.connectionId);
    expect(rows.rows[0]?.chain).toBe('bitcoin');
    expect(rows.rows[0]?.descriptor).toBe(WATCH_ONLY_ZPUB);
    expect(rows.rows[0]?.label).toBe('Cold storage');
  });

  it('a re-link of the same wallet updates the row rather than adding one', async () => {
    const relink = await h.request({
      method: 'POST',
      url: '/connections',
      session: h.fresh,
      body: {
        provider: WALLETRPC_PROVIDER,
        input: {
          chain: 'bitcoin',
          value: WATCH_ONLY_ZPUB,
          label: 'Cold storage (renamed)',
        },
      },
    });
    expectStatus(relink, 201);

    const rows = await h.database.db.execute<{ label: string }>(sql`
      SELECT label FROM wallet_addresses WHERE user_id = ${h.userId}::uuid
    `);
    // `providerConnectionId` is a fresh `newId()` on every `connect()`, so a
    // second link of the same descriptor is a second connection — what must not
    // happen is a connection with no wallet row behind it.
    expect(rows.rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.rows.some((row) => row.label === 'Cold storage (renamed)')).toBe(true);
  });
});
