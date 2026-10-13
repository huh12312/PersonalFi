// SPDX-License-Identifier: MIT
/**
 * WP 10.3 over a real database: `GET /investments/transactions` (the Activity
 * tab), `GET /investments/performance?account=|management=`,
 * `GET /investments/performance/by-management`, and `management` on the
 * account overlay, through the real application.
 *
 * ## Where every row comes from (the parallel-construction rule)
 *
 * Nothing here is written with SQL:
 *
 *   * **The Plaid Sandbox fixture** (`@connector/plaid/test`'s `INVESTMENTS`:
 *     a buy, a sell, a dividend, a contribution and an account fee) arrives
 *     the way it does in production — `POST /connections/plaid/exchange`, the
 *     real orchestrator's `holdings` and `investment_txns` legs over the real
 *     `PlaidConnector` (the only double is the socket, `FakePlaidApi`), and the
 *     real lot consumer delivered by the real pump, exactly as
 *     `phase3-wiring.test.ts` drives it.
 *   * **The scope portfolios** (accounts the holder classifies as advisor,
 *     self-directed and not at all) are linked over HTTP (`linkManual`), their
 *     securities placed by the real `SecurityResolver`
 *     (`securityResolverFor`), their positions and movements written by the
 *     lot store's own writers (`drizzleLotStore(...).recordHoldingSnapshot`,
 *     `.upsertInvestmentTransaction`), their prices by the ladder's rung-1
 *     writer (`recordUserPriceOverride`), and their classification by
 *     `PUT /accounts/{id}/overrides`.
 *
 * ## The numbers the scope tests pin
 *
 *   * **Advisor** (one account, `ADV`): 10 × `ADVX` at $100.00 on 2025-01-02,
 *     $110.00 on 2025-06-30, nothing moved. TWR = **+10%**, no flows.
 *   * **Self-directed** (`SELF`): 5 × `SELFY` at $200.00 throughout; a $1,000.00
 *     contribution on 2025-03-03 buys 5 more. TWR = **0%**, MWR = **0%**, net
 *     contributions **$1,000.00**, period gain **$0.00** — the contribution is
 *     not performance.
 *   * **Unclassified** (`OPEN`): 1 × `ADVX` on 2025-01-02. On 2025-03-03 a
 *     401(k)-style payroll contribution arrives **as a buy** (`BUY`, subtype
 *     `contribution`, $100.00 for 1 share) and 1 more share arrives **in kind**
 *     (`TRANSFER_IN`, no cash amount): 3 × `ADVX`, $100 → $110. Both are
 *     external flows ($100.00 + 1 × $100.00 at the transfer date), so the TWR is
 *     **+10%** — the old `type IN ('CASH', 'TRANSFER_IN', 'TRANSFER_OUT')`
 *     filter missed the buy and could not value the transfer, and reads
 *     **+230%** for the same account. Its own row, named.
 */
import { PlaidConnector } from '@connector/plaid';
import {
  FakePlaidApi,
  PUBLIC_TOKEN,
  defaultItemSpec,
  linkSettings,
  testClock as plaidTestClock,
} from '@connector/plaid/test';
import { DateOnly, Money, Quantity, newId, systemClock } from '@core/kernel';
import { createConsumerPump } from '@core/platform';
import { drizzleLotStore, recordUserPriceOverride } from '@ctx/investments';
import { createEgressPolicy, createNtfyChannel, createSmtpChannel } from '@ctx/notifications';
import { createTestDatabase, type TestDatabase } from '@core/testkit';
import { sql } from 'drizzle-orm';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createConnectorRegistry,
  createDomainRuntime,
  createInvestmentSyncPort,
  drizzleTransactionalExecutor,
  securityResolverFor,
} from '../../src/domain.ts';
import { appModules } from '../../src/modules.ts';
import {
  buildExportBundle,
  parseAndVerifyBundle,
  serialiseBundle,
} from '../../src/reports/export/bundle.ts';
import { importBundle } from '../../src/reports/export/import.ts';
import {
  NO_DATABASE,
  createApiHarness,
  expectStatus,
  linkManual,
  problemOf,
  type ApiHarness,
} from '../helpers/api-harness.ts';

interface Activity {
  readonly id: string;
  readonly accountId: string;
  readonly tradeDate: string;
  readonly kind: string;
  readonly type: string;
  readonly subtype: string | null;
  readonly security: { id: string; symbol: string | null; name: string | null } | null;
  readonly amount: { minor: string; currency: string };
  readonly flow: { minor: string; currency: string } | null;
  readonly fees: { minor: string; currency: string };
  readonly source: string;
}

interface ActivityBody {
  readonly from: string;
  readonly to: string;
  readonly items: readonly Activity[];
  readonly nextCursor: string | null;
  readonly total: number;
  readonly accounts: readonly { accountId: string; activitySync: string; provider: string }[];
}

interface Summary {
  readonly kind: 'period_summary';
  readonly openingValue: { minor: string };
  readonly closingValue: { minor: string };
  readonly netContributions: { minor: string };
  readonly dividendsAndInterest: { minor: string };
  readonly feesPaid: { minor: string };
  readonly periodGain: { minor: string };
  readonly complete: boolean;
  readonly exclusions: {
    unpricedSecurities: { securityId: string; symbol: string | null }[];
    unvaluedTransfers: string[];
    unclassifiedMovements: string[];
    foreignCurrencyMovements: string[];
  };
}

interface PerformanceBody {
  readonly scope: { kind: string; management: string | null; accountIds: string[] };
  readonly timeWeighted: { periodReturn: string; annualized: string | null; method: string };
  readonly moneyWeighted: { status: string; periodReturn?: string };
  readonly dollarGain: { kind: string };
  readonly summary: Summary;
  readonly unvaluedTransfers: number;
}

interface ByManagementBody {
  readonly rows: readonly (PerformanceBody & { management: string; accountIds: string[] })[];
}

const D0 = DateOnly.parse('2025-01-02');
const D1 = DateOnly.parse('2025-03-03');
const D2 = DateOnly.parse('2025-06-30');
const PERIOD = `from=${D0}&to=${D2}`;

describe.skipIf(NO_DATABASE)('investment activity and scoped performance (WP 10.3)', () => {
  let h: ApiHarness;
  let otherUserId: string;
  let otherAccountId: string;
  const accounts = { adv: '', self: '', open: '' };
  let plaidBrokerageId = '';

  async function resolveTicker(ticker: string): Promise<string> {
    const resolution = await securityResolverFor(h.database.db, systemClock).resolve(
      { kind: 'ticker', value: ticker, chain: null, mic: 'XNYS' },
      { userId: h.userId, provider: 'manual', correlationId: newId() },
    );
    if (resolution.outcome !== 'resolved') throw new Error(`could not place ${ticker}`);
    return resolution.securityId;
  }

  async function snapshot(accountId: string, securityId: string, quantity: string, asOf: string) {
    await drizzleLotStore(h.database.db, systemClock).recordHoldingSnapshot(h.userId, {
      accountId,
      securityId,
      quantity: Quantity.of(quantity),
      institutionValue: null,
      costBasis: null,
      asOfDate: DateOnly.parse(asOf),
    });
  }

  async function price(securityId: string, priceDate: string, close: string) {
    await recordUserPriceOverride(
      h.database.db,
      h.userId,
      { securityId, priceDate, close, currency: 'USD' },
      systemClock,
    );
  }

  async function movement(input: {
    readonly accountId: string;
    readonly securityId: string | null;
    readonly type: 'BUY' | 'CASH' | 'DIVIDEND' | 'FEE' | 'SELL' | 'TRANSFER_IN';
    readonly userId?: string;
    readonly subtype: string;
    readonly quantity: string;
    readonly amountMinor: bigint;
    readonly tradeDate: string;
  }) {
    await drizzleLotStore(h.database.db, systemClock).upsertInvestmentTransaction(
      input.userId ?? h.userId,
      {
        id: newId(),
        accountId: input.accountId,
        securityId: input.securityId,
        provider: 'manual',
        providerTransactionId: `wp103-${newId()}`,
        type: input.type,
        subtype: input.subtype,
        name: `${input.type} ${input.subtype}`,
        quantity: Quantity.of(input.quantity),
        price: null,
        amount: Money.of(input.amountMinor, 'USD'),
        fees: Money.zero('USD'),
        tradeDate: DateOnly.parse(input.tradeDate),
        settleDate: null,
        source: 'USER',
        fingerprint: null,
      },
    );
  }

  async function classify(accountId: string, management: string | null) {
    const response = await h.request({
      method: 'PUT',
      url: `/accounts/${accountId}/overrides`,
      session: h.stale,
      body: { management },
    });
    expectStatus(response, 200);
    return response.json() as {
      account: { overlay: { management: { effective: string | null; source: string } } };
    };
  }

  beforeAll(async () => {
    h = await createApiHarness({
      suite: 'wp103-act',
      plaidConnector: new PlaidConnector({
        api: new FakePlaidApi([defaultItemSpec()]),
        settings: linkSettings(),
        clock: plaidTestClock(),
      }),
    });

    const linked = await linkManual(h, {
      providerConnectionId: 'wp103-manual',
      displayName: 'Scope Brokerage',
      accounts: [
        { providerAccountId: 'adv', name: 'Advised IRA', type: 'investment', currency: 'USD' },
        { providerAccountId: 'self', name: 'My Brokerage', type: 'investment', currency: 'USD' },
        { providerAccountId: 'open', name: 'Old 401k', type: 'investment', currency: 'USD' },
      ],
    });
    const [adv, self, open] = linked.accountIds;
    if (adv === undefined || self === undefined || open === undefined) {
      throw new Error('the manual link did not create three accounts');
    }
    // `linkManual` returns ids in the order given.
    accounts.adv = adv;
    accounts.self = self;
    accounts.open = open;

    const advx = await resolveTicker('ADVX');
    const selfy = await resolveTicker('SELFY');

    // Advisor: 10 ADVX, $100 → $110, no movement. Plus 4 NOPRC, which no rung
    // of the ladder can price: left out of every value and *named* (O-2).
    await snapshot(accounts.adv, advx, '10', D0);
    await snapshot(accounts.adv, await resolveTicker('NOPRC'), '4', D0);
    await price(advx, D0, '100.00');
    await price(advx, D2, '110.00');
    // Self-directed: 5 SELFY at $200; a $1,000 contribution buys 5 more on D1.
    await snapshot(accounts.self, selfy, '5', D0);
    await snapshot(accounts.self, selfy, '10', D1);
    await price(selfy, D0, '200.00');
    await movement({
      accountId: accounts.self,
      securityId: null,
      type: 'CASH',
      subtype: 'contribution',
      quantity: '0',
      amountMinor: 100_000n,
      tradeDate: D1,
    });
    await movement({
      accountId: accounts.self,
      securityId: selfy,
      type: 'BUY',
      subtype: 'buy',
      quantity: '5',
      amountMinor: -100_000n,
      tradeDate: D1,
    });
    // Unclassified: 1 ADVX; on D1 a contribution-buy of 1 and an in-kind transfer of 1.
    await snapshot(accounts.open, advx, '1', D0);
    await snapshot(accounts.open, advx, '3', D1);
    await movement({
      accountId: accounts.open,
      securityId: advx,
      type: 'BUY',
      subtype: 'contribution',
      quantity: '1',
      amountMinor: -10_000n,
      tradeDate: D1,
    });
    await movement({
      accountId: accounts.open,
      securityId: advx,
      type: 'TRANSFER_IN',
      subtype: 'transfer',
      quantity: '1',
      amountMinor: 0n,
      tradeDate: D1,
    });

    await classify(accounts.adv, 'advisor');
    await classify(accounts.self, 'self_directed');

    // A second holder with an investment account and a movement of their own.
    otherUserId = await h.database.createUser('Second Holder');
    otherAccountId = newId();
    // fixture: an accounts row for a second holder written by SQL because `linkManual` links for the harness's one signed-in holder and no route can create another holder's account; the ledger's `upsertAccount` writes this shape (provider manual, type investment, classification asset).
    await h.database.db.execute(sql`
      INSERT INTO accounts (id, user_id, provider, provider_account_id, name, type, classification, currency)
      VALUES (${otherAccountId}::uuid, ${otherUserId}::uuid, 'manual', 'other-1', 'Not Yours', 'investment', 'asset', 'USD')
    `);
    await movement({
      userId: otherUserId,
      accountId: otherAccountId,
      securityId: null,
      type: 'CASH',
      subtype: 'contribution',
      quantity: '0',
      amountMinor: 999_999n,
      tradeDate: D1,
    });
  }, 180_000);

  afterAll(async () => {
    await h.close();
  });

  // ---------------------------------------------------------------- activity

  it('the Plaid Sandbox fixture: "sync pending" before the leg runs, then buy, sell, dividend, contribution and fee as activity', async () => {
    const exchanged = await h.request({
      method: 'POST',
      url: '/connections/plaid/exchange',
      session: h.fresh,
      body: { publicToken: PUBLIC_TOKEN, institutionName: 'Northwind Brokerage' },
    });
    expect(exchanged.statusCode, 'the plaid link must succeed').toBe(201);
    const connectionId = (exchanged.json() as { connectionId: string }).connectionId;
    const brokerage = await h.database.db.execute<{ id: string }>(sql`
      SELECT id FROM accounts
       WHERE user_id = ${h.userId}::uuid AND provider_account_id = 'acct-brokerage-003'
    `);
    plaidBrokerageId = brokerage.rows[0]?.id ?? '';
    expect(plaidBrokerageId).not.toBe('');

    // Linked, not yet synced: the list is empty and says *pending*, not "none".
    const before = await h.request({
      method: 'GET',
      url: `/investments/transactions?from=2026-05-01&to=2026-06-30&account=${plaidBrokerageId}`,
      session: h.stale,
    });
    expectStatus(before, 200);
    const beforeBody = before.json() as ActivityBody;
    expect(beforeBody.items).toEqual([]);
    expect(beforeBody.accounts).toEqual([
      expect.objectContaining({ accountId: plaidBrokerageId, activitySync: 'pending' }),
    ]);

    // The real sync, then the real lot consumer through the real pump.
    const logger = pino({ level: 'silent' });
    const denyAll = createEgressPolicy({ allowedHosts: [] });
    const runtime = createDomainRuntime({
      database: h.database.db,
      clock: systemClock,
      logger,
      registry: createConnectorRegistry(),
      secretBox: h.security.requireSecretBox(),
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
      investmentSyncPort: createInvestmentSyncPort(h.database.db),
    });
    const investments = modules.find((module) => module.flagKey === 'module.investments');
    const pump = createConsumerPump({
      pool: h.database.pool,
      db: drizzleTransactionalExecutor(h.database.db),
      clock: systemClock,
      logger,
      consumers: [...(investments?.consumers ?? [])],
    });
    const summary = await h.orchestrator.syncConnection({
      connectionId,
      userId: h.userId,
      trigger: 'manual',
      correlationId: newId(),
    });
    expect(summary.error).toBeNull();
    await pump.drain();

    const after = await h.request({
      method: 'GET',
      url: `/investments/transactions?from=2026-05-01&to=2026-06-30&account=${plaidBrokerageId}`,
      session: h.stale,
    });
    expectStatus(after, 200);
    const body = after.json() as ActivityBody;
    expect(body.accounts).toEqual([
      expect.objectContaining({
        accountId: plaidBrokerageId,
        activitySync: 'synced',
        provider: 'plaid',
      }),
    ]);
    // Newest first.
    expect(body.items.map((item) => [item.tradeDate, item.kind, item.subtype])).toEqual([
      ['2026-06-01', 'fee', 'account fee'],
      ['2026-05-31', 'contribution', 'contribution'],
      ['2026-05-30', 'dividend', 'dividend'],
      ['2026-05-29', 'sell', 'sell'],
      ['2026-05-28', 'buy', 'buy'],
    ]);
    expect(body.total).toBe(5);
    expect(body.items.every((item) => item.source === 'BROKER')).toBe(true);
    const contribution = body.items.find((item) => item.kind === 'contribution');
    expect(contribution?.amount).toEqual({ minor: '100000', currency: 'USD' });
    expect(contribution?.security).toBeNull();
    // The flow the performance route measures against is on the row too.
    expect(contribution?.flow).toEqual({ minor: '100000', currency: 'USD' });
    expect(
      body.items.filter((item) => item.kind !== 'contribution').map((item) => item.flow),
    ).toEqual([null, null, null, null]);
    const buy = body.items.find((item) => item.kind === 'buy');
    expect(buy?.security?.symbol).toBe('VTI');
  }, 180_000);

  it("the fixture's dividend and fee are inside the return; only the contribution is a flow", async () => {
    const response = await h.request({
      method: 'GET',
      url: `/investments/performance?from=2026-05-01&to=2026-06-30&account=${plaidBrokerageId}`,
      session: h.stale,
    });
    expectStatus(response, 200);
    const body = response.json() as PerformanceBody;
    expect(body.scope).toEqual({
      kind: 'account',
      management: null,
      accountIds: [plaidBrokerageId],
    });
    expect(body.summary.netContributions.minor).toBe('100000');
    expect(body.summary.dividendsAndInterest.minor).toBe('4118');
    // The $20.00 account fee plus the $0.65 commission on the sell.
    expect(body.summary.feesPaid.minor).toBe('2065');
    expect(body.unvaluedTransfers).toBe(0);
    expect(body.summary.exclusions.unclassifiedMovements).toEqual([]);
  });

  it('filters by kind and by account, pages with a cursor without loss or repeat, and defaults to the last twelve months', async () => {
    const dividends = await h.request({
      method: 'GET',
      url: `/investments/transactions?from=2026-05-01&to=2026-06-30&kind=dividend`,
      session: h.stale,
    });
    expectStatus(dividends, 200);
    expect((dividends.json() as ActivityBody).items.map((item) => item.kind)).toEqual(['dividend']);

    const twoKinds = await h.request({
      method: 'GET',
      url: `/investments/transactions?from=2025-01-01&to=2026-06-30&kind=contribution&kind=fee`,
      session: h.stale,
    });
    // Self's cash contribution, Plaid's, and OPEN's contribution-buy and in-kind transfer.
    expect((twoKinds.json() as ActivityBody).items.map((item) => item.kind).sort()).toEqual([
      'contribution',
      'contribution',
      'contribution',
      'contribution',
      'fee',
    ]);

    const scoped = await h.request({
      method: 'GET',
      url: `/investments/transactions?from=2025-01-01&to=2026-06-30&account=${accounts.self}`,
      session: h.stale,
    });
    const scopedBody = scoped.json() as ActivityBody;
    expect(scopedBody.items.every((item) => item.accountId === accounts.self)).toBe(true);
    expect(scopedBody.items.map((item) => item.kind).sort()).toEqual(['buy', 'contribution']);
    // A manual account's activity arrives by hand: there is no leg to be pending.
    expect(scopedBody.accounts).toEqual([
      expect.objectContaining({ accountId: accounts.self, activitySync: 'not_applicable' }),
    ]);

    // Pages of two over all nine rows: every id once, in order.
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page = await h.request({
        method: 'GET',
        url:
          `/investments/transactions?from=2025-01-01&to=2026-06-30&limit=2` +
          (cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`),
        session: h.stale,
      });
      expectStatus(page, 200);
      const pageBody = page.json() as ActivityBody;
      expect(pageBody.total).toBe(9);
      expect(
        pageBody.items.some((item) => item.accountId === otherAccountId),
        "another holder's movement is never listed",
      ).toBe(false);
      seen.push(...pageBody.items.map((item) => item.id));
      cursor = pageBody.nextCursor;
      pages += 1;
    } while (cursor !== null && pages < 10);
    expect(pages).toBe(5);
    expect(seen).toHaveLength(9);
    expect(new Set(seen).size).toBe(9);

    // No dates: the last twelve months to the harness's today, which the 2025
    // rows are not in (they are more than a year before the Plaid fixture's).
    const defaulted = await h.request({
      method: 'GET',
      url: '/investments/transactions',
      session: h.stale,
    });
    expectStatus(defaulted, 200);
    const defaultedBody = defaulted.json() as ActivityBody;
    expect(
      DateOnly.differenceInDays(
        DateOnly.parse(defaultedBody.from),
        DateOnly.parse(defaultedBody.to),
      ),
    ).toBeGreaterThanOrEqual(364);
    expect(defaultedBody.items.some((item) => item.tradeDate.startsWith('2025-0'))).toBe(false);
  });

  it("refuses a cursor it did not issue, and another holder's account is a 404", async () => {
    const badCursor = await h.request({
      method: 'GET',
      url: '/investments/transactions?cursor=bm90LWEtY3Vyc29y',
      session: h.stale,
    });
    expectStatus(badCursor, 400);
    expect(problemOf(badCursor)['code']).toBe('investments.invalid_cursor');

    const foreign = await h.request({
      method: 'GET',
      url: `/investments/transactions?account=${otherAccountId}`,
      session: h.stale,
    });
    expectStatus(foreign, 404);

    const foreignPerformance = await h.request({
      method: 'GET',
      url: `/investments/performance?${PERIOD}&account=${otherAccountId}`,
      session: h.stale,
    });
    expectStatus(foreignPerformance, 404);
  });

  // ------------------------------------------------------------- performance

  it('one account: valuations and flows restricted to it — a contribution is not performance', async () => {
    const response = await h.request({
      method: 'GET',
      url: `/investments/performance?${PERIOD}&account=${accounts.self}`,
      session: h.stale,
    });
    expectStatus(response, 200);
    const body = response.json() as PerformanceBody;
    expect(Number(body.timeWeighted.periodReturn)).toBe(0);
    expect(body.timeWeighted.method).toBe('sub_period_linking');
    // Under a year: never annualized.
    expect(body.timeWeighted.annualized).toBeNull();
    expect(body.moneyWeighted.status).toBe('available');
    expect(Math.abs(Number(body.moneyWeighted.periodReturn))).toBeLessThan(1e-8);
    expect(body.summary.openingValue.minor).toBe('100000');
    expect(body.summary.closingValue.minor).toBe('200000');
    expect(body.summary.netContributions.minor).toBe('100000');
    expect(body.summary.periodGain.minor).toBe('0');
    expect(body.summary.complete).toBe(true);
  });

  it('a 401(k) contribution that arrives as a buy, and a transfer in kind, are flows — not growth', async () => {
    const response = await h.request({
      method: 'GET',
      url: `/investments/performance?${PERIOD}&account=${accounts.open}`,
      session: h.stale,
    });
    expectStatus(response, 200);
    const body = response.json() as PerformanceBody;
    // $100.00 bought with new money + 1 share in kind at $100.00 on D1.
    expect(body.summary.netContributions.minor).toBe('20000');
    expect(body.unvaluedTransfers).toBe(0);
    expect(Number(body.timeWeighted.periodReturn)).toBeCloseTo(0.1, 10);
    expect(body.summary.periodGain.minor).toBe('3000');
    expect(body.summary.complete).toBe(true);
  });

  it('by management: one row per class present plus unclassified, each the scoped answer', async () => {
    const response = await h.request({
      method: 'GET',
      url: `/investments/performance/by-management?${PERIOD}`,
      session: h.stale,
    });
    expectStatus(response, 200);
    const body = response.json() as ByManagementBody;
    const unclassifiedAccounts = [accounts.open, plaidBrokerageId].sort();
    expect(body.rows.map((row) => [row.management, [...row.accountIds].sort()])).toEqual([
      ['advisor', [accounts.adv]],
      ['self_directed', [accounts.self]],
      ['unclassified', unclassifiedAccounts],
    ]);
    const advisor = body.rows.find((row) => row.management === 'advisor');
    expect(Number(advisor?.timeWeighted.periodReturn)).toBeCloseTo(0.1, 10);
    expect(advisor?.summary.netContributions.minor).toBe('0');
    expect(advisor?.summary.periodGain.minor).toBe('10000');
    const self = body.rows.find((row) => row.management === 'self_directed');
    expect(Number(self?.timeWeighted.periodReturn)).toBe(0);
    expect(self?.summary.netContributions.minor).toBe('100000');

    // The row is the same answer `?management=` gives.
    const single = await h.request({
      method: 'GET',
      url: `/investments/performance?${PERIOD}&management=advisor`,
      session: h.stale,
    });
    expectStatus(single, 200);
    const singleBody = single.json() as PerformanceBody;
    expect(singleBody.scope).toEqual({
      kind: 'management',
      management: 'advisor',
      accountIds: [accounts.adv],
    });
    expect(singleBody.timeWeighted).toEqual(advisor?.timeWeighted);
    expect(singleBody.summary).toEqual(advisor?.summary);
  });

  it('account and management together is a 400; a class with no accounts is a 404 naming it', async () => {
    const both = await h.request({
      method: 'GET',
      url: `/investments/performance?${PERIOD}&account=${accounts.adv}&management=advisor`,
      session: h.stale,
    });
    expectStatus(both, 400);
    expect(problemOf(both)['code']).toBe('investments.scope_conflict');

    const empty = await h.request({
      method: 'GET',
      url: `/investments/performance?${PERIOD}&management=robo_advisor`,
      session: h.stale,
    });
    expectStatus(empty, 404);
    expect(problemOf(empty)['code']).toBe('investments.scope_empty');
  });

  it('the whole portfolio is still every account, and names a position it could not price', async () => {
    const response = await h.request({
      method: 'GET',
      url: `/investments/performance?${PERIOD}`,
      session: h.stale,
    });
    expectStatus(response, 200);
    const body = response.json() as PerformanceBody;
    expect(body.scope).toEqual({ kind: 'portfolio', management: null, accountIds: [] });
    // ADV $1,100 + SELF $2,000 + OPEN $330 at D2. The Plaid positions are dated
    // after D2, so they are not in this period at all.
    expect(body.summary.closingValue.minor).toBe('343000');
    // The unpriced position is not a zero hidden in the total: it is named.
    expect(body.summary.complete).toBe(false);
    expect(body.summary.exclusions.unpricedSecurities).toEqual([
      expect.objectContaining({ symbol: 'NOPRC' }),
    ]);
  });
});

/**
 * Its own harness, with manual accounts only: the export round trip of an
 * install that has run the Plaid fixture's sync fails on
 * `transactions_provider_superseded_by_id_fkey` (a pending row superseded by
 * its posted twin), which is the importer's row order and not this WP's —
 * recorded for the orchestrator in the evidence note. What this test is about
 * is that `management` travels with its row.
 */
describe.skipIf(NO_DATABASE)('management on the account overlay round-trips (WP 10.3)', () => {
  let h: ApiHarness;
  const accounts = { adv: '', self: '', open: '' };

  async function classify(accountId: string, management: string | null) {
    const response = await h.request({
      method: 'PUT',
      url: `/accounts/${accountId}/overrides`,
      session: h.stale,
      body: { management },
    });
    expectStatus(response, 200);
    return response.json() as {
      account: { overlay: { management: { effective: string | null; source: string } } };
    };
  }

  beforeAll(async () => {
    h = await createApiHarness({ suite: 'wp103-exp' });
    const linked = await linkManual(h, {
      providerConnectionId: 'wp103-export',
      displayName: 'Export Brokerage',
      accounts: [
        { providerAccountId: 'adv', name: 'Advised IRA', type: 'investment', currency: 'USD' },
        { providerAccountId: 'self', name: 'My Brokerage', type: 'investment', currency: 'USD' },
        { providerAccountId: 'open', name: 'Old 401k', type: 'investment', currency: 'USD' },
      ],
    });
    const [adv, self, open] = linked.accountIds;
    if (adv === undefined || self === undefined || open === undefined) {
      throw new Error('the manual link did not create three accounts');
    }
    accounts.adv = adv;
    accounts.self = self;
    accounts.open = open;
    await classify(accounts.adv, 'advisor');
    await classify(accounts.self, 'self_directed');
  }, 120_000);

  afterAll(async () => {
    await h.close();
  });

  it('management is set and cleared on the overlay through the route, and survives export and import', async () => {
    const set = await classify(accounts.open, 'robo_advisor');
    expect(set.account.overlay.management).toEqual({ effective: 'robo_advisor', source: 'holder' });

    const bundle = await buildExportBundle(h.database.pool, {
      userId: h.userId,
      appVersion: 'test',
      now: new Date('2026-10-13T00:00:00Z'),
    });
    const parsed = parseAndVerifyBundle(serialiseBundle(bundle));
    const clean: TestDatabase = await createTestDatabase(
      `wp103_export_${newId().replaceAll('-', '')}`,
    );
    try {
      await importBundle(clean.pool, parsed, clean.userId);
      const restored = await clean.pool.query<{ account_id: string; management: string | null }>(
        `SELECT account_id, management FROM account_overrides WHERE user_id = $1 ORDER BY account_id`,
        [clean.userId],
      );
      expect(restored.rows).toEqual(
        [
          { account_id: accounts.adv, management: 'advisor' },
          { account_id: accounts.self, management: 'self_directed' },
          { account_id: accounts.open, management: 'robo_advisor' },
        ].sort((a, b) => (a.account_id < b.account_id ? -1 : 1)),
      );
    } finally {
      await clean.drop();
    }

    const cleared = await classify(accounts.open, null);
    expect(cleared.account.overlay.management).toEqual({ effective: null, source: 'none' });
    const rows = await h.database.db.execute<{ count: string }>(sql`
      SELECT count(*)::text AS count FROM account_overrides WHERE account_id = ${accounts.open}::uuid
    `);
    expect(rows.rows[0]?.count, 'nothing left set: no row').toBe('0');
  });
});
