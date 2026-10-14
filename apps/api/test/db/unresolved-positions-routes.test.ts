// SPDX-License-Identifier: MIT
/**
 * WP 10.4 — a position nobody could identify is a named row, not nothing; its
 * movements stay in Activity; allocation and performance leave both out and
 * **name** them. End to end against Postgres, from a real Plaid sync (the
 * recorded Sandbox fixture through `FakePlaidApi`) through the real
 * `createInvestmentSyncPort` and lot consumer to the routes.
 *
 * The fixture's cash sweep ("Northwind Cash Sweep") carries no ticker, CUSIP,
 * ISIN or FIGI — only Plaid's own id — so the resolver abstains on it, which
 * is exactly the shape of Chris's IRA positions that showed nothing anywhere.
 */
import { PlaidConnector } from '@connector/plaid';
import {
  FakePlaidApi,
  HOLDINGS_RESPONSE,
  INVESTMENTS,
  PUBLIC_TOKEN,
  defaultItemSpec,
  linkSettings,
  testClock,
} from '@connector/plaid/test';
import { DateOnly, Money, Quantity, currency, newId, systemClock } from '@core/kernel';
import { outboxOf } from '@ctx/investments';
import {
  createFakeFigiMapper,
  figiMappingOf,
  drizzleLotStore,
  runLotSync,
  type FigiMapper,
} from '@ctx/investments';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createInvestmentSyncPort } from '../../src/domain.ts';
import {
  createApiHarness,
  expectStatus,
  NO_DATABASE,
  type ApiHarness,
} from '../helpers/api-harness.ts';

interface UnresolvedWire {
  id: string;
  accountId: string;
  provider: string;
  providerSecurityId: string | null;
  name: string | null;
  ticker: string | null;
  quantity: string;
  institutionValue: { minor: string; currency: string } | null;
  reasons: string[];
}

describe.skipIf(NO_DATABASE)(
  'WP 10.4 — unresolved positions on the holdings, allocation, performance and activity routes',
  () => {
    let h: ApiHarness;
    let accountId: string;
    const figiAsked: FigiMapper[] = [];
    // Answers VTI's ISIN with its FIGI, as OpenFIGI does. The holdings below drop
    // the FIGI the recorded fixture carries, so the only way `securities.figi`
    // can end up set is this mapper reaching the resolver.
    const figi = createFakeFigiMapper({
      table: { 'ID_ISIN:US9229087690': [figiMappingOf('BBG000BDTF76', { ticker: 'VTI' })] },
    });

    async function runIds(operation: string): Promise<string[]> {
      const rows = await h.database.db.execute<{ id: string }>(sql`
      SELECT id FROM sync_runs WHERE user_id = ${h.userId}::uuid AND operation = ${operation}
       ORDER BY started_at
    `);
      return rows.rows.map((row) => row.id);
    }

    async function consume(runId: string): Promise<void> {
      const port = createInvestmentSyncPort(h.database.db, systemClock, {
        figiFor: async () => {
          figiAsked.push(figi);
          return figi;
        },
      });
      await runLotSync(
        {
          store: drizzleLotStore(h.database.db, systemClock),
          port,
          clock: systemClock,
          outbox: outboxOf(h.database.db),
        },
        { userId: h.userId, syncRunId: runId, correlationId: newId() },
      );
    }

    beforeAll(async () => {
      const holdings = {
        ...HOLDINGS_RESPONSE,
        securities: HOLDINGS_RESPONSE.securities.map((security) =>
          security.ticker_symbol === 'VTI' ? { ...security, figi: null } : security,
        ),
      };
      // One more movement, in the sweep nobody can identify: before WP 10.4 the
      // port dropped it before it was stored.
      const first = INVESTMENTS.investment_transactions[0];
      if (first === undefined) throw new Error('the fixture has no investment transaction');
      const sweepContribution = {
        ...first,
        investment_transaction_id: 'itx-sweep-contribution',
        security_id: 'sec-cash-0002',
        type: 'buy' as typeof first.type,
        subtype: 'contribution' as typeof first.subtype,
        name: 'CONTRIBUTION TO SWEEP',
        quantity: 250,
        price: 1,
        amount: 250,
        fees: 0,
      };
      const api = new FakePlaidApi([
        {
          ...defaultItemSpec({
            investmentTransactions: [...INVESTMENTS.investment_transactions, sweepContribution],
          }),
          holdings,
        },
      ]);
      h = await createApiHarness({
        suite: 'wp104unres',
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
      for (const runId of [...(await runIds('holdings')), ...(await runIds('investment_txns'))]) {
        await consume(runId);
      }
      const accounts = await h.database.db.execute<{ account_id: string }>(sql`
      SELECT account_id FROM unresolved_holdings WHERE user_id = ${h.userId}::uuid LIMIT 1
    `);
      accountId = accounts.rows[0]?.account_id ?? '';
    }, 180_000);

    afterAll(async () => {
      await h?.close();
    }, 60_000);

    it('the resolver is handed the holder’s OpenFIGI mapper (before WP 10.4 no resolver ever got one)', async () => {
      expect(figiAsked.length).toBeGreaterThan(0);
      // VTI arrives with an ISIN and a CUSIP and no FIGI, so the batched FIGI pass asked about it…
      expect(figi.requests.flat().map((job) => job.idType)).toContain('ID_ISIN');
      // …and the resolver used the answer: the row carries the FIGI only OpenFIGI could give it.
      const vti = await h.database.db.execute<{ figi: string | null }>(sql`
        SELECT figi FROM securities WHERE user_id = ${h.userId}::uuid AND ticker = 'VTI'
      `);
      expect(vti.rows[0]?.figi).toBe('BBG000BDTF76');
    });

    it('GET /holdings names the position the resolver abstained on, with its quantity, the institution’s value and the reasons', async () => {
      expect(accountId, 'the sync left an unresolved row').not.toBe('');
      const response = await h.request({ method: 'GET', url: '/holdings', session: h.stale });
      expectStatus(response, 200);
      const body = response.json() as {
        unresolved: UnresolvedWire[];
        excluded: { holdingId: string; symbol: string | null; reason: string }[];
        holdings: { symbol: string | null }[];
      };
      const sweep = body.unresolved.find((row) => row.name === 'Northwind Cash Sweep');
      expect(sweep, JSON.stringify(body.unresolved)).toBeDefined();
      if (sweep === undefined) return;
      expect(sweep.accountId).toBe(accountId);
      expect(sweep.provider).toBe('plaid');
      expect(sweep.providerSecurityId).toBe('sec-cash-0002');
      expect(Number(sweep.quantity)).toBeGreaterThan(0);
      expect(sweep.institutionValue).toEqual({ minor: '167532', currency: 'USD' });
      expect(sweep.reasons.join(' ')).toMatch(/institution's own id/u);
      // Never valued, and named in `excluded`.
      expect(body.excluded).toContainEqual({
        holdingId: sweep.id,
        symbol: 'Northwind Cash Sweep',
        reason: 'security_unresolved',
      });
      expect(body.holdings.map((row) => row.symbol)).not.toContain('Northwind Cash Sweep');

      // The account's own panel shows it; another account's does not.
      const mine = await h.request({
        method: 'GET',
        url: `/accounts/${accountId}/holdings`,
        session: h.stale,
      });
      expectStatus(mine, 200);
      expect(
        (mine.json() as { unresolved: UnresolvedWire[] }).unresolved.map((r) => r.id),
      ).toContain(sweep.id);
    });

    it('a Plaid movement in the unidentified sweep is stored with NULL security and its provider names, and listed in Activity', async () => {
      const stored = await h.database.db.execute<{
        security_id: string | null;
        security_unresolved: boolean;
        provider_security_name: string | null;
      }>(sql`
      SELECT security_id, security_unresolved, provider_security_name
        FROM investment_transactions
       WHERE user_id = ${h.userId}::uuid AND provider_transaction_id = 'itx-sweep-contribution'
    `);
      expect(stored.rows).toEqual([
        {
          security_id: null,
          security_unresolved: true,
          provider_security_name: 'Northwind Cash Sweep',
        },
      ]);
      const activity = await h.request({
        method: 'GET',
        url: '/investments/transactions?from=2020-01-01&to=2030-12-31',
        session: h.stale,
      });
      expectStatus(activity, 200);
      const names = (
        activity.json() as { items: { unresolvedSecurity: { name: string | null } | null }[] }
      ).items.map((item) => item.unresolvedSecurity?.name ?? null);
      expect(names).toContain('Northwind Cash Sweep');
    });

    it('allocation leaves it out of every slice and names it in each report’s excluded list', async () => {
      const response = await h.request({
        method: 'GET',
        url: '/investments/allocation',
        session: h.stale,
      });
      expectStatus(response, 200);
      const body = response.json() as Record<
        'byAssetClass' | 'byRegion' | 'bySector',
        { excluded: { reason: string; symbol: string | null }[] }
      >;
      for (const report of [body.byAssetClass, body.byRegion, body.bySector]) {
        expect(report.excluded).toContainEqual(
          expect.objectContaining({
            reason: 'security_unresolved',
            symbol: 'Northwind Cash Sweep',
          }),
        );
      }
    });

    it('a movement in an unidentified security is listed in Activity under its own name, and performance names it instead of counting it', async () => {
      // A 401(k) contribution-buy of a fund nobody could identify, stored as the
      // consumer stores one (the lot store's own writer).
      const transactionId = newId();
      const usd = currency('USD');
      await drizzleLotStore(h.database.db, systemClock).upsertInvestmentTransaction(h.userId, {
        id: transactionId,
        accountId,
        securityId: null,
        provider: 'plaid',
        providerTransactionId: 'itx-unresolved-contribution',
        type: 'BUY',
        subtype: 'contribution',
        name: 'Contribution',
        quantity: Quantity.of('2.5'),
        price: Quantity.of('171.22'),
        amount: Money.of(-42_805n, usd),
        fees: Money.zero(usd),
        tradeDate: DateOnly.parse('2026-05-20'),
        settleDate: null,
        source: 'BROKER',
        fingerprint: null,
        unresolved: { name: 'Vanguard Target Retirement 2050 Fund', ticker: 'VFIFX' },
      });

      const activity = await h.request({
        method: 'GET',
        url: `/investments/transactions?from=2026-01-01&to=2026-12-31&account=${accountId}`,
        session: h.stale,
      });
      expectStatus(activity, 200);
      const item = (
        activity.json() as {
          items: {
            id: string;
            kind: string;
            security: unknown;
            unresolvedSecurity: { name: string | null; symbol: string | null } | null;
            flow: { minor: string } | null;
          }[];
        }
      ).items.find((row) => row.unresolvedSecurity?.symbol === 'VFIFX');
      expect(item).toBeDefined();
      expect(item?.security).toBeNull();
      expect(item?.unresolvedSecurity).toEqual({
        name: 'Vanguard Target Retirement 2050 Fund',
        symbol: 'VFIFX',
      });
      // Flow classification still applies: a contribution is an external flow.
      expect(item?.kind).toBe('contribution');
      expect(item?.flow?.minor).toBe('42805');

      const performance = await h.request({
        method: 'GET',
        url: '/investments/performance?from=2026-01-01&to=2026-06-30',
        session: h.stale,
      });
      expectStatus(performance, 200);
      const summary = (
        performance.json() as {
          summary: {
            complete: boolean;
            exclusions: {
              unresolvedMovements: string[];
              unresolvedSecurities: { id: string; name: string | null }[];
            };
          };
        }
      ).summary;
      const stored = await h.database.db.execute<{ id: string }>(sql`
      SELECT id FROM investment_transactions
       WHERE provider_transaction_id = 'itx-unresolved-contribution'
    `);
      expect(summary.exclusions.unresolvedMovements).toContain(stored.rows[0]?.id);
      expect(summary.exclusions.unresolvedSecurities.map((row) => row.name)).toContain(
        'Northwind Cash Sweep',
      );
      expect(summary.complete).toBe(false);
    });

    it('a later sync that resolves the position clears its row', async () => {
      // The consumer's replacement, as a run in which every position of the
      // account resolved would leave it.
      await drizzleLotStore(h.database.db, systemClock).replaceUnresolvedHoldings(
        h.userId,
        { accountId, provider: 'plaid' },
        [],
      );
      const response = await h.request({ method: 'GET', url: '/holdings', session: h.stale });
      expect((response.json() as { unresolved: unknown[] }).unresolved).toEqual([]);
    });
  },
);
