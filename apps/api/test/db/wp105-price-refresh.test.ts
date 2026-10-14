// SPDX-License-Identifier: MIT
/**
 * WP 10.5 — the price refresh plans from the holder's positions, and
 * "Refresh prices" runs it now (WP 10.4 §0, defect (f)).
 *
 * Against Postgres, through the shipped pieces: `@ctx/investments`'
 * `readPricingPositions` under `createPriceRefreshPlanner`, the real
 * `POST /market-data/refresh` in `buildApp`, and `appModules`' own
 * `integrations.price_refresh` job handler with **no** `planFor` supplied —
 * the shape `worker.ts` builds. Every provider is `@ctx/integrations`'
 * `createFakeTransport` under the real adapters, with a fixed public DNS answer
 * for the egress guard. No live call. The keys are synthetic.
 *
 * The positions are chosen so each planner rule has a row that breaks it:
 * VTI held in two accounts (one subject, not two); BTC, a chain's own coin
 * (CoinGecko's id from WP 3.4's map); a token contract with no coin id and an
 * equity with no ticker (both named, never dropped); a cash sweep (no provider
 * prices cash: counted, not asked about); a position sold to zero and a
 * security nobody holds (neither planned); a EUR-quoted fund held in EUR (an
 * FX pair, and Tiingo's own "USD only" answer named).
 */
import { redact } from '@core/config';
import { newId, systemClock } from '@core/kernel';
import { createEgressPolicy, createNtfyChannel, createSmtpChannel } from '@ctx/notifications';
import { createFakeTransport, jsonResponse, type FakeHandler } from '@ctx/integrations';
import { sql } from 'drizzle-orm';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createConnectorRegistry,
  createDomainRuntime,
  createInvestmentSyncPort,
  createMarketDataRunRecorder,
  createMarketDataRuntime,
  createMarketDataWriter,
} from '../../src/domain.ts';
import { PRICE_REFRESH_JOB_KIND, appModules } from '../../src/modules.ts';
import { createPriceRefreshPlanner } from '../../src/price-refresh.ts';
import {
  createApiHarness,
  expectStatus,
  NO_DATABASE,
  type ApiHarness,
} from '../helpers/api-harness.ts';

const TIINGO_KEY = 'wp105TiingoSyntheticKey0000000001'; // gitleaks:allow — synthetic
const FRED_KEY = 'wp105fredsynthetickey00000000002'; // gitleaks:allow — synthetic
const COINGECKO_KEY = 'CG-wp105SyntheticKey000000003'; // gitleaks:allow — synthetic
const PUBLIC = (): Promise<string[]> => Promise.resolve(['93.184.216.34']);

/** Answers like the three providers. VTI and BTC have a close; anything else has none. */
const answer: FakeHandler = (request) => {
  const path = request.destination.path;
  if (request.destination.host === 'api.tiingo.com') {
    return jsonResponse(
      path.includes('/tiingo/daily/vti/')
        ? [{ date: '2026-01-02T00:00:00.000Z', close: 268.4 }]
        : [],
    );
  }
  if (request.destination.host === 'api.coingecko.com') {
    return jsonResponse(
      path.includes('/coins/bitcoin/')
        ? { market_data: { current_price: { usd: 64100.5 } } }
        : { id: 'unknown' },
    );
  }
  if (request.destination.host === 'api.stlouisfed.org') {
    return jsonResponse({ observations: [{ date: '2026-01-02', value: '1.0921' }] });
  }
  return jsonResponse({ error: 'unexpected host' }, 500);
};

interface SummaryWire {
  asOfDate: string;
  counts: {
    held: number;
    priceable: number;
    priced: number;
    unpriced: number;
    notPricedByProvider: number;
  };
  priced: { securityId: string; symbol: string | null; provider: string }[];
  unpriced: {
    securityId: string;
    symbol: string | null;
    name: string | null;
    provider: string | null;
    reason: string;
    detail: string | null;
  }[];
  notPricedByProvider: { securityId: string; kind: string }[];
  fx: { rowsWritten: number; pairs: { base: string; quote: string; fetched: boolean }[] };
  priceRowsWritten: number;
  requests: { provider: string; operation: string; requestsMade: number }[];
  budgets: { provider: string; used: number; limit: number }[];
  nextRefreshAt: string;
}

describe.skipIf(NO_DATABASE)('WP 10.5 — the price-refresh planner and Refresh prices', () => {
  let h: ApiHarness;
  const fake = createFakeTransport(answer);
  const accountA = newId();
  const accountB = newId();
  const id = {
    vti: newId(),
    btc: newId(),
    token: newId(),
    noTicker: newId(),
    cash: newId(),
    sold: newId(),
    unheld: newId(),
    euFund: newId(),
  };

  async function security(
    securityId: string,
    fields: {
      identityKind: string;
      identityKey: string;
      type: string;
      name: string;
      ticker?: string | null;
      chain?: string | null;
      contract?: string | null;
      currency?: string;
    },
  ): Promise<void> {
    // fixture: securities row written by SQL because its only writer is the investments sync's SecurityResolver (no route writes it); these are the shapes the resolver writes for a ticker, an ISIN, and a chain's own coin or token contract
    await h.database.db.execute(sql`
      INSERT INTO securities (
        id, user_id, identity_kind, identity_key, ticker, chain, contract, name, type, currency,
        is_cash_equivalent, classification_source, classification_depth, classification_flagged
      ) VALUES (
        ${securityId}::uuid, ${h.userId}::uuid, ${fields.identityKind}, ${fields.identityKey},
        ${fields.ticker ?? null}, ${fields.chain ?? null}, ${fields.contract ?? null}, ${fields.name},
        ${fields.type}, ${fields.currency ?? 'USD'}, ${fields.type === 'cash'}, 'UNCLASSIFIED', 0, false
      )
    `);
  }

  async function holding(
    accountId: string,
    securityId: string,
    quantity: string,
    currency = 'USD',
  ): Promise<void> {
    // fixture: holdings row written by SQL because its only writer is the investments sync (the lot consumer's `upsertHolding`; no route writes it); a sync writes a decimal-string quantity, zero for a position sold out
    await h.database.db.execute(sql`
      INSERT INTO holdings (
        id, user_id, account_id, security_id, quantity, institution_value_minor, currency,
        cost_basis_minor, cost_basis_is_user_supplied, cost_basis_source, as_of_date
      ) VALUES (
        ${newId()}::uuid, ${h.userId}::uuid, ${accountId}::uuid, ${securityId}::uuid,
        ${quantity}, NULL, ${currency}, NULL, false, NULL, '2026-01-02'::date
      )
    `);
  }

  async function priceRows(): Promise<{ security_id: string; source: string; close: string }[]> {
    const rows = await h.database.db.execute<{
      security_id: string;
      source: string;
      close: string;
    }>(sql`
      SELECT security_id::text, source, close::text FROM prices
       WHERE user_id = ${h.userId}::uuid ORDER BY source, security_id
    `);
    return rows.rows;
  }

  beforeAll(async () => {
    h = await createApiHarness({
      suite: 'wp105refresh',
      // Tiingo and FRED by file; no CoinGecko key, so BTC is the one a holder
      // would see as "no CoinGecko key".
      extraSecrets: { tiingo_api_key: TIINGO_KEY, fred_api_key: FRED_KEY },
      marketDataTransport: fake.transport,
      marketDataResolve: PUBLIC,
    });
    const u = h.userId.slice(0, 8);
    await security(id.vti, {
      identityKind: 'ticker',
      identityKey: `ticker:VTI:${u}`,
      type: 'etf',
      name: 'Vanguard Total Stock Market ETF',
      ticker: 'VTI',
    });
    await security(id.btc, {
      identityKind: 'chain_contract',
      identityKey: `chain:bitcoin:native:${u}`,
      type: 'crypto',
      name: 'Bitcoin',
      ticker: 'BTC',
      chain: 'bitcoin',
      contract: 'native',
    });
    await security(id.token, {
      identityKind: 'chain_contract',
      identityKey: `chain:ethereum:0xtoken:${u}`,
      type: 'crypto',
      name: 'Some Token',
      chain: 'ethereum',
      contract: '0x00000000000000000000000000000000000000aa',
    });
    await security(id.noTicker, {
      identityKind: 'isin',
      identityKey: `isin:US0000000001:${u}`,
      type: 'equity',
      name: 'Private Placement Co',
    });
    await security(id.cash, {
      identityKind: 'cusip',
      identityKey: `cusip:SWEEP0001:${u}`,
      type: 'cash',
      name: 'Northwind Cash Sweep',
    });
    await security(id.sold, {
      identityKind: 'ticker',
      identityKey: `ticker:SOLD:${u}`,
      type: 'equity',
      name: 'Sold Out Inc',
      ticker: 'SOLD',
    });
    await security(id.unheld, {
      identityKind: 'ticker',
      identityKey: `ticker:IGNR:${u}`,
      type: 'etf',
      name: 'Never Held ETF',
      ticker: 'IGNR',
    });
    await security(id.euFund, {
      identityKind: 'ticker',
      identityKey: `ticker:EUF:${u}`,
      type: 'etf',
      name: 'Euro Fund',
      ticker: 'EUF',
      currency: 'EUR',
    });
    await holding(accountA, id.vti, '10.000000000000000000');
    await holding(accountB, id.vti, '5.000000000000000000');
    await holding(accountA, id.btc, '0.250000000000000000');
    await holding(accountA, id.token, '100.000000000000000000');
    await holding(accountA, id.noTicker, '20.000000000000000000');
    await holding(accountA, id.cash, '1675.320000000000000000');
    await holding(accountA, id.sold, '0.000000000000000000');
    await holding(accountB, id.euFund, '3.000000000000000000', 'EUR');
  }, 180_000);

  afterAll(async () => {
    await h?.close();
  }, 60_000);

  it('plans every security with a non-zero position, once, routed by kind; names what it cannot plan; adds FX for a non-USD position', async () => {
    const plan = await createPriceRefreshPlanner(h.database.db)(h.userId, '2026-01-02');

    // Real positions, not every security: the sold-out and the never-held are absent.
    const held = plan.held.map((entry) => entry.securityId).sort();
    expect(held).toEqual([id.vti, id.btc, id.token, id.noTicker, id.cash, id.euFund].sort());
    expect(held).not.toContain(id.sold);
    expect(held).not.toContain(id.unheld);

    // One subject per security (VTI is in two accounts), built the way each source expects.
    const subjects = new Map(plan.securities.map((entry) => [entry.securityId, entry]));
    expect([...subjects.keys()].sort()).toEqual([id.vti, id.btc, id.euFund].sort());
    expect(subjects.get(id.vti)).toMatchObject({
      kind: 'etf',
      subject: { kind: 'ticker', symbol: 'VTI', mic: null },
      currency: 'USD',
    });
    expect(subjects.get(id.btc)).toMatchObject({
      kind: 'crypto',
      subject: { kind: 'coin_id', coinId: 'bitcoin' },
    });
    expect(subjects.get(id.euFund)).toMatchObject({ currency: 'EUR' });

    // Named, with a reason, never silently dropped.
    expect(
      plan.unplannable.map((entry) => [entry.securityId, entry.provider, entry.reason]).sort(),
    ).toEqual(
      [
        [id.token, 'coingecko', 'no_coin_id'],
        [id.noTicker, 'tiingo', 'no_ticker'],
      ].sort(),
    );
    // No provider prices cash: counted, not planned.
    expect(plan.notPricedByProvider.map((entry) => entry.securityId)).toEqual([id.cash]);
    // Every distinct non-base position currency → base, and never USD/USD.
    expect(plan.fxPairs).toEqual([{ base: 'EUR', quote: 'USD' }]);
  });

  it('POST /market-data/refresh runs the refresh now and says, per security, what was priced and why not', async () => {
    const before = fake.requests.length;
    const response = await h.request({
      method: 'POST',
      url: '/market-data/refresh',
      session: h.stale,
    });
    expectStatus(response, 200);
    const body = response.json() as SummaryWire;

    expect(body.counts).toEqual({
      held: 6,
      priceable: 5,
      priced: 1,
      unpriced: 4,
      notPricedByProvider: 1,
    });
    expect(body.priced).toEqual([
      expect.objectContaining({ securityId: id.vti, symbol: 'VTI', provider: 'tiingo' }),
    ]);
    const reasons = new Map(body.unpriced.map((entry) => [entry.securityId, entry]));
    expect(reasons.get(id.btc)).toMatchObject({
      provider: 'coingecko',
      reason: 'source_not_configured',
    });
    expect(reasons.get(id.token)).toMatchObject({ reason: 'no_coin_id' });
    expect(reasons.get(id.noTicker)).toMatchObject({ reason: 'no_ticker' });
    expect(reasons.get(id.euFund)).toMatchObject({ provider: 'tiingo', reason: 'no_data' });
    expect(reasons.get(id.euFund)?.detail).toMatch(/quotes in USD/u);
    expect(body.notPricedByProvider).toEqual([
      expect.objectContaining({ securityId: id.cash, kind: 'cash' }),
    ]);
    expect(body.fx.pairs).toEqual([
      expect.objectContaining({ base: 'EUR', quote: 'USD', fetched: true }),
    ]);
    expect(body.fx.rowsWritten).toBe(1);
    expect(body.priceRowsWritten).toBe(1);
    expect(body.budgets.some((entry) => entry.provider === 'tiingo')).toBe(true);

    // Exactly the planned subjects went out: VTI to Tiingo (EUF is answered by
    // the adapter without a request — Tiingo quotes USD only), EUR/USD to FRED,
    // nothing for the sold, the never-held, the cash, or BTC without a key.
    const sent = fake.requests.slice(before).map((request) => request.destination.host);
    expect(sent.sort()).toEqual(['api.stlouisfed.org', 'api.tiingo.com']);
    const paths = fake.requests
      .slice(before)
      .map((request) => request.destination.path)
      .join(' ');
    expect(paths).not.toMatch(/sold|ignr/iu);

    expect(await priceRows()).toEqual([
      { security_id: id.vti, source: 'tiingo', close: '268.4000000000' },
    ]);
    const fx = await h.database.db.execute<{ base: string; quote: string }>(sql`
      SELECT base_currency AS base, quote_currency AS quote FROM fx_rates WHERE user_id = ${h.userId}::uuid
    `);
    expect(fx.rows).toEqual([{ base: 'EUR', quote: 'USD' }]);
    const runs = await h.database.db.execute<{ provider: string; operation: string }>(sql`
      SELECT provider, operation FROM market_data_runs
       WHERE user_id = ${h.userId}::uuid ORDER BY provider, operation
    `);
    expect(runs.rows).toEqual([
      { provider: 'fred', operation: 'fx_refresh' },
      { provider: 'tiingo', operation: 'price_refresh' },
    ]);
  });

  it('a second Refresh prices within ten minutes is refused with the retry time, and asks no provider', async () => {
    const before = fake.requests.length;
    const response = await h.request({
      method: 'POST',
      url: '/market-data/refresh',
      session: h.stale,
    });
    expectStatus(response, 409);
    const problem = response.json() as { type: string; detail: string };
    expect(problem.type).toMatch(/market_data\.refresh_too_soon$/u);
    expect(problem.detail).toMatch(/Try again after \d{4}-\d{2}-\d{2}T/u);
    const retryAfter = Number(response.headers['retry-after']);
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(600);
    expect(fake.requests.length).toBe(before);
  });

  it('the shipped integrations job, with no planFor supplied (worker.ts), plans from the same positions and prices BTC once a CoinGecko key exists', async () => {
    const logger = pino({ level: 'silent' });
    const runtime = createDomainRuntime({
      database: h.database.db,
      clock: systemClock,
      logger,
      registry: createConnectorRegistry(),
      secretBox: h.security.requireSecretBox(),
    });
    const denyAll = createEgressPolicy({ allowedHosts: [] });
    const marketDataRuntime = createMarketDataRuntime({
      secrets: {
        tiingo_api_key: redact(TIINGO_KEY),
        fred_api_key: redact(FRED_KEY),
        coingecko_api_key: redact(COINGECKO_KEY),
        openfigi_api_key: undefined,
      },
      allowedHosts: [],
      clock: systemClock,
      logger,
      transport: fake.transport,
      resolve: PUBLIC,
    });
    const modules = appModules({
      advisorsEnabled: true,
      localModelConfigured: false,
      database: h.database.db,
      userId: h.userId,
      orchestrator: runtime.orchestrator,
      timezone: 'UTC',
      clock: systemClock,
      notificationChannels: {
        ntfy: createNtfyChannel({ policy: denyAll }),
        smtp: createSmtpChannel({ policy: denyAll }),
      },
      secretBox: h.security.requireSecretBox(),
      investmentSyncPort: createInvestmentSyncPort(h.database.db, systemClock),
      // Exactly worker.ts's shape: no `planFor`.
      marketData: {
        runtime: marketDataRuntime,
        writer: createMarketDataWriter(h.database.db),
        recorder: createMarketDataRunRecorder(h.database.db),
      },
    });
    const job = modules
      .find((module) => module.flagKey === 'module.integrations')
      ?.jobs?.find((entry) => entry.kind === PRICE_REFRESH_JOB_KIND);
    expect(job, 'module.integrations registers the price refresh').toBeDefined();

    const before = fake.requests.length;
    await job?.handler({}, {
      id: newId(),
      userId: h.userId,
      kind: PRICE_REFRESH_JOB_KIND,
      attempt: 1,
      correlationId: newId(),
      logger,
      clock: systemClock,
      signal: new AbortController().signal,
    } as never);
    const hosts = fake.requests.slice(before).map((request) => request.destination.host);
    expect(hosts).toContain('api.coingecko.com');
    expect(hosts).toContain('api.tiingo.com');
    const rows = await priceRows();
    expect(rows).toContainEqual({
      security_id: id.btc,
      source: 'coingecko',
      close: '64100.5000000000',
    });
    expect(rows.map((row) => row.security_id)).not.toContain(id.sold);
  });
});
