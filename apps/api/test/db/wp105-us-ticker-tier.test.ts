// SPDX-License-Identifier: MIT
/**
 * WP 10.5, decision D29 — a bare US-dollar ticker from Plaid becomes a real
 * holding when OpenFIGI names exactly one US composite FIGI for it, and stays
 * a named "could not identify" row, with the reason in words, when it names
 * more than one.
 *
 * End to end against Postgres: the recorded Plaid Sandbox fixture through
 * `FakePlaidApi`, with VTI stripped to a **bare ticker** (no FIGI, ISIN, CUSIP
 * or MIC — the shape Plaid sends for many US listings), through the real
 * `createInvestmentSyncPort` and lot consumer, to `GET /holdings`. OpenFIGI is
 * the hermetic fake (`createFakeFigiMapper`); nothing dials out.
 */
import { PlaidConnector } from '@connector/plaid';
import {
  FakePlaidApi,
  HOLDINGS_RESPONSE,
  INVESTMENTS,
  PUBLIC_TOKEN,
  defaultItemSpec,
  investmentTransactionsResponse,
  linkSettings,
  testClock,
} from '@connector/plaid/test';
import { newId, systemClock } from '@core/kernel';
import {
  createFakeFigiMapper,
  drizzleLotStore,
  figiMappingOf,
  outboxOf,
  runLotSync,
  US_COMPOSITE_FIGI_PROVIDER,
  type FakeFigiMapper,
  type FigiMapping,
} from '@ctx/investments';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createInvestmentSyncPort } from '../../src/domain.ts';
import { plainReasonsOf } from '../../src/routes/investments.ts';
import {
  createApiHarness,
  expectStatus,
  NO_DATABASE,
  type ApiHarness,
} from '../helpers/api-harness.ts';

interface HoldingsWire {
  holdings: { securityId?: string; symbol: string | null }[];
  unresolved: { name: string | null; ticker: string | null; reasons: string[] }[];
  excluded: { symbol: string | null; reason: string }[];
}

const VTI_COMPOSITE = 'BBG000BDTF76';

/**
 * Plaid's VTI with every identity stripped: a bare ticker, USD, type etf. On
 * **both** legs — holdings and investment transactions each carry their own
 * `securities` list, and a transactions leg still naming VTI by FIGI and MIC
 * would establish the row by itself and prove nothing about D29.
 */
const BARE_SECURITIES = HOLDINGS_RESPONSE.securities.map((security) =>
  security.ticker_symbol === 'VTI'
    ? { ...security, figi: null, isin: null, cusip: null, market_identifier_code: null }
    : security,
);

/** Link a Plaid item over the fixture, sync it, and run the lot consumer with `figi`. */
async function syncThroughD29(suite: string, figi: FakeFigiMapper): Promise<ApiHarness> {
  const api = new FakePlaidApi([
    {
      ...defaultItemSpec(),
      holdings: { ...HOLDINGS_RESPONSE, securities: BARE_SECURITIES },
      investmentTransactions: {
        ...investmentTransactionsResponse(INVESTMENTS.investment_transactions),
        securities: BARE_SECURITIES,
      },
    },
  ]);
  const h = await createApiHarness({
    suite,
    plaidConnector: new PlaidConnector({ api, settings: linkSettings(), clock: testClock() }),
  });
  const response = await h.request({
    method: 'POST',
    url: '/connections/plaid/exchange',
    session: h.fresh,
    body: { publicToken: PUBLIC_TOKEN, institutionName: 'Northwind Brokerage' },
  });
  expectStatus(response, 201);
  const connectionId = (response.json() as { connectionId: string }).connectionId;
  await h.orchestrator.syncConnection({
    connectionId,
    userId: h.userId,
    trigger: 'manual',
    correlationId: newId(),
  });
  const runs = await h.database.db.execute<{ id: string }>(sql`
    SELECT id FROM sync_runs
     WHERE user_id = ${h.userId}::uuid AND operation IN ('holdings', 'investment_txns')
     ORDER BY CASE operation WHEN 'holdings' THEN 0 ELSE 1 END, started_at
  `);
  const port = createInvestmentSyncPort(h.database.db, systemClock, {
    figiFor: () => Promise.resolve(figi),
  });
  for (const run of runs.rows) {
    await runLotSync(
      {
        store: drizzleLotStore(h.database.db, systemClock),
        port,
        clock: systemClock,
        outbox: outboxOf(h.database.db),
      },
      { userId: h.userId, syncRunId: run.id, correlationId: newId() },
    );
  }
  return h;
}

async function holdingsOf(h: ApiHarness): Promise<HoldingsWire> {
  const response = await h.request({ method: 'GET', url: '/holdings', session: h.stale });
  expectStatus(response, 200);
  return response.json() as HoldingsWire;
}

describe.skipIf(NO_DATABASE)(
  'WP 10.5 / D29 — a bare USD ticker with one US composite FIGI is a real holding',
  () => {
    let h: ApiHarness;
    const lines: readonly FigiMapping[] = [
      figiMappingOf('BBG000BDTF76', {
        ticker: 'VTI',
        exchCode: 'US',
        compositeFigi: VTI_COMPOSITE,
      }),
      figiMappingOf('BBG000BDTG11', {
        ticker: 'VTI',
        exchCode: 'UP',
        compositeFigi: VTI_COMPOSITE,
      }),
    ];
    const figi = createFakeFigiMapper({ table: { 'TICKER:VTI/US': lines } });

    beforeAll(async () => {
      h = await syncThroughD29('wp105ustick', figi);
    }, 180_000);

    afterAll(async () => {
      await h?.close();
    }, 60_000);

    it('asks OpenFIGI once per run, as TICKER + exchCode US with no micCode', () => {
      const asked = figi.requests.flat();
      expect(asked.length).toBeGreaterThan(0);
      for (const job of asked) {
        expect(job).toEqual({ idType: 'TICKER', idValue: 'VTI', micCode: null, exchCode: 'US' });
      }
      // One batched request per run that named VTI, never one per position.
      for (const request of figi.requests) expect(request).toHaveLength(1);
    });

    it('VTI is in GET /holdings as a real holding, not in unresolved', async () => {
      const body = await holdingsOf(h);
      expect(body.holdings.map((row) => row.symbol)).toContain('VTI');
      expect(body.unresolved.map((row) => row.ticker)).not.toContain('VTI');
      // It may be excluded from *valuation* (`price_unknown`: the harness has no
      // price feed), but never as `security_unresolved`.
      expect(body.excluded).not.toContainEqual(
        expect.objectContaining({ symbol: 'VTI', reason: 'security_unresolved' }),
      );
      // The cash sweep, which has nothing but Plaid's own id, is still unresolved.
      expect(body.unresolved.map((row) => row.name)).toContain('Northwind Cash Sweep');
    });

    it('the security is established on the composite FIGI, with OpenFIGI’s provenance recorded', async () => {
      const security = await h.database.db.execute<{
        identity_kind: string;
        figi: string | null;
        ticker: string | null;
        mic: string | null;
        type: string;
      }>(sql`
        SELECT identity_kind, figi, ticker, mic, type
          FROM securities WHERE user_id = ${h.userId}::uuid AND ticker = 'VTI'
      `);
      expect(security.rows).toEqual([
        { identity_kind: 'figi', figi: VTI_COMPOSITE, ticker: 'VTI', mic: null, type: 'etf' },
      ]);
      const identifiers = await h.database.db.execute<{
        kind: string;
        value: string;
        provider: string | null;
        confidence: string;
      }>(sql`
        SELECT i.kind, i.value, i.provider, i.confidence::text AS confidence
          FROM security_identifiers i
          JOIN securities s ON s.id = i.security_id
         WHERE s.user_id = ${h.userId}::uuid AND s.ticker = 'VTI'
         ORDER BY i.kind
      `);
      expect(identifiers.rows).toEqual(
        expect.arrayContaining([
          {
            kind: 'figi',
            value: VTI_COMPOSITE,
            provider: US_COMPOSITE_FIGI_PROVIDER,
            confidence: '0.8000',
          },
          { kind: 'ticker', value: 'VTI', provider: 'plaid', confidence: '0.3000' },
        ]),
      );
    });
  },
);

describe.skipIf(NO_DATABASE)(
  'WP 10.5 / D29 — a bare USD ticker with two US composites stays unresolved, in words',
  () => {
    let h: ApiHarness;
    const figi = createFakeFigiMapper({
      table: {
        'TICKER:VTI/US': [
          figiMappingOf('BBG000BDTF76', { compositeFigi: 'BBG000BDTF76' }),
          figiMappingOf('BBG000BHTMY2', { compositeFigi: 'BBG000BHTMY2' }),
        ],
      },
    });

    beforeAll(async () => {
      h = await syncThroughD29('wp105ustamb', figi);
    }, 180_000);

    afterAll(async () => {
      await h?.close();
    }, 60_000);

    it('VTI is listed under unresolved with the ambiguous-US-listing reason, and mints no security', async () => {
      expect(figi.requests.flat().length).toBeGreaterThan(0);
      const body = await holdingsOf(h);
      expect(body.holdings.map((row) => row.symbol)).not.toContain('VTI');
      const vti = body.unresolved.find((row) => row.ticker === 'VTI');
      expect(vti, JSON.stringify(body.unresolved)).toBeDefined();
      expect(vti?.reasons.join(' ')).toMatch(/OpenFIGI matched it to more than one US listing/u);
      expect(vti?.reasons.join(' ')).not.toMatch(/A ticker alone/u);
      const securities = await h.database.db.execute<{ n: string }>(sql`
        SELECT count(*)::text AS n FROM securities WHERE user_id = ${h.userId}::uuid AND ticker = 'VTI'
      `);
      expect(securities.rows[0]?.n).toBe('0');
    });
  },
);

describe('plainReasonsOf — D29’s reasons in words', () => {
  const words = (reason: string): string =>
    plainReasonsOf([{ tier: 'ticker', reason, detail: 'VTI' }]).join(' ');

  it('says what OpenFIGI answered for each non-answer, and never that a ticker alone is unused', () => {
    expect(words('ambiguous_us_ticker')).toBe(
      'Only a ticker (VTI) was given, with no exchange. OpenFIGI matched it to more than one US ' +
        'listing, so it is not used to identify one.',
    );
    expect(words('no_us_match')).toBe(
      'Only a ticker (VTI) was given, with no exchange. OpenFIGI found no US listing with that ' +
        'ticker.',
    );
    expect(words('us_ticker_not_checked')).toMatch(/could not be reached .* next sync/u);
    expect(words('unqualified_ticker')).toMatch(/used only for a US-dollar stock, ETF or fund/u);
    expect(words('unqualified_ticker')).not.toMatch(/not used to identify/u);
  });
});
