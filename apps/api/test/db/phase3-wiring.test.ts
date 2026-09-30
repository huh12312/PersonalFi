// SPDX-License-Identifier: MIT
/**
 * The Phase 3 wiring batch, proved end to end over a real database.
 *
 * `apps/api/test/phase3-registration.test.ts` proves the *shape* of what
 * `appModules()` returns. This file proves the shape is connected to anything:
 * a real `connections.SyncRunCompleted`, produced by a real sync through the
 * real orchestrator, reaches `@ctx/investments`' lot consumer through the real
 * `createConsumerPump` that `worker.ts` builds — not a hand-rolled substitute —
 * and the consumer writes real rows and appends a real event.
 *
 * It is the file the `module.investments` / `module.integrations` flag flip is
 * conditional on (`apps/api/src/platform.ts`'s `MODULE_FLAGS`), which is why
 * it asserts the two things a flag flip is actually a claim about:
 *
 *   a. **the consumer is delivered the event and writes** — `module.investments`;
 *   b. **the write happens inside the pump's transaction**, so a handler that
 *      fails halfway leaves nothing behind and does not advance its offset.
 *
 * ## Why (b) is tested by breaking the port rather than by inspection
 *
 * `createLotConsumer` takes `storeFor`/`outboxFor` as *factories over
 * `ConsumerContext.tx`* precisely so a `LotsUpdated` cannot survive a
 * rolled-back derivation (wp3.2-lots.md §11). You cannot see that property by
 * reading a row; you can only see it by making the derivation fail after it
 * has already written something and observing that the something is gone.
 *
 * `runLotSync` upserts the investment transaction (`consumer.ts:244`) well
 * before it asks the port `isRetirementAccount` (`consumer.ts:326`). So a port
 * that throws from `isRetirementAccount` fails *mid-derivation*, with a write
 * already issued. If the write is in the pump's transaction it disappears and
 * the offset does not move; if `storeFor` had been handed a pool-backed
 * `Database` instead — the mistake this shape exists to prevent — the row
 * would still be there. The second drain, with the port repaired, then shows
 * the same event being retried and succeeding, which is also the
 * at-least-once redelivery claim.
 *
 * ## What is deliberately not asserted here
 *
 * `InvestmentSyncPort.factsForRun` is **stubbed**, and that is not a shortcut:
 * `domain.ts`'s real implementation returns no facts today because no provider
 * leg persists them yet (WP 3.7 owns that — see its doc comment). Driving the
 * real one would assert only that empty in gives empty out. What must be real
 * for this file to mean anything is everything *around* the port — the
 * registration, the pump, the transaction, the store and the outbox — and all
 * of those are.
 */
import { PlaidConnector } from '@connector/plaid';
import {
  FakePlaidApi,
  INVESTMENTS,
  ITEM,
  PUBLIC_TOKEN,
  SYNC_PAGES,
  defaultItemSpec,
  fakePlaidItem,
  linkSettings,
  plainItemOf,
  testClock as plaidTestClock,
} from '@connector/plaid/test';
import { DateOnly, money, newId, systemClock } from '@core/kernel';
import { createConsumerPump, platformExecutor } from '@core/platform';
import { createEgressPolicy, createNtfyChannel, createSmtpChannel } from '@ctx/notifications';
import {
  LOTS_CONSUMER_NAME,
  type InvestmentSyncPort,
  type ResolvedTransactionFact,
} from '@ctx/investments';
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
  drizzleTransactionalExecutor,
  planningPortsFor,
  securityResolverFor,
  assertDrizzleTransaction,
} from '../../src/domain.ts';
import {
  NET_WORTH_CONSUMER_NAME,
  NET_WORTH_SNAPSHOT_CRON,
  NET_WORTH_SNAPSHOT_JOB_KIND,
  PRICE_REFRESH_JOB_KIND,
  appModules,
} from '../../src/modules.ts';
import { recordBalance } from '@ctx/ledger';
import {
  createApiHarness,
  linkManual,
  NO_DATABASE,
  type ApiHarness,
} from '../helpers/api-harness.ts';

describe.skipIf(NO_DATABASE)(
  'Phase 3 wiring batch (apps/api/src/{platform,domain,modules}.ts)',
  () => {
    let h: ApiHarness;
    let plaidApi: FakePlaidApi;

    beforeAll(async () => {
      // WP 3.7: a real `PlaidConnector` over the hermetic fake, so the last
      // test in this file can drive a *real* holdings/investment-transactions
      // sync rather than a stubbed port. Adding it to the registry changes
      // nothing for the tests above — they link `manual`.
      plaidApi = new FakePlaidApi([defaultItemSpec()]);
      h = await createApiHarness({
        suite: 'p3wire',
        plaidConnector: new PlaidConnector({
          api: plaidApi,
          settings: linkSettings(),
          clock: plaidTestClock(),
        }),
      });
    }, 120_000);

    afterAll(async () => {
      await h.close();
    }, 60_000);

    it('a real sync run reaches the lot consumer through the real pump, and its writes live or die with the pump transaction', async () => {
      const logger = pino({ level: 'silent' });
      const accountId = newId();

      // A real `securities` row, resolved by WP 3.1's real resolver through
      // `domain.ts`'s own `securityResolverFor`. Not a made-up UUID:
      // `investment_transactions.security_id` carries a foreign key into
      // `securities`, so a fabricated id fails the insert — which is how this
      // test found out that the two work packages' tables really are joined.
      const resolution = await securityResolverFor(h.database.db, systemClock).resolve(
        { kind: 'ticker', value: 'VTI', chain: null, mic: 'XNYS' },
        { userId: h.userId, provider: 'manual', correlationId: newId() },
      );
      expect(resolution.outcome, 'the resolver must place a ticker with a MIC').toBe('resolved');
      if (resolution.outcome !== 'resolved') return;
      const securityId = resolution.securityId;

      // The port's behaviour, switchable mid-test. `failMode` is what makes
      // the derivation fail *after* it has written (see the header).
      let failMode = true;
      const transactionFact: ResolvedTransactionFact = {
        accountId,
        securityId,
        source: 'BROKER',
        fact: {
          providerAccountId: 'p3wire-account',
          providerTransactionId: 'p3wire-buy-1',
          // WP 3.14a: the whole `ProviderSecurityFact`, not a bare identifier.
          security: {
            providerSecurityId: 'p3wire-sec-1',
            identifiers: [{ kind: 'ticker', value: 'VTI', chain: null, mic: 'XNYS' }],
            name: 'Vanguard Total Stock Market ETF',
            type: 'etf',
            subtype: null,
            currency: 'USD',
            isCashEquivalent: false,
            closePrice: null,
            closePriceAsOf: null,
            raw: {},
            fingerprint: 'p3wire-fingerprint-1',
          },
          date: DateOnly.parse('2026-02-02'),
          name: 'Buy VTI',
          type: 'buy',
          subtype: 'buy',
          quantity: '10',
          price: '100.00',
          amount: money(-100_000n, 'USD'),
          fees: money(0n, 'USD'),
          raw: {},
          fingerprint: 'p3wire-fingerprint-1',
        },
      };

      const port: InvestmentSyncPort = {
        factsForRun: async () => ({
          provider: 'manual',
          asOfDate: DateOnly.parse('2026-02-02'),
          holdings: [],
          transactions: [transactionFact],
        }),
        isRetirementAccount: async () => {
          if (failMode) {
            // Thrown from inside `runLotSync`, after the investment
            // transaction has already been upserted.
            throw new Error('p3wire: deliberate mid-derivation failure');
          }
          return false;
        },
        isDigitalAsset: async () => false,
      };

      const runtime = createDomainRuntime({
        database: h.database.db,
        clock: systemClock,
        logger,
        registry: createConnectorRegistry(),
        secretBox: h.security.requireSecretBox(),
      });
      const denyAll = createEgressPolicy({ allowedHosts: [] });
      const marketDataRuntime = createMarketDataRuntime({
        // No key files in the test environment, so this registers no source —
        // which is itself the zero-key install the flag default relies on.
        secrets: {
          tiingo_api_key: undefined,
          fred_api_key: undefined,
          coingecko_api_key: undefined,
          openfigi_api_key: undefined,
        },
        allowedHosts: [],
        clock: systemClock,
        logger,
      });
      const modules = appModules({
        // W-A wiring (WP 5.1): the two operator halves of the kill ladder the
        // real worker reads from config; a test wires them as the defaults do.
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
        investmentSyncPort: port,
        marketData: {
          runtime: marketDataRuntime,
          writer: createMarketDataWriter(h.database.db),
          recorder: createMarketDataRunRecorder(h.database.db),
        },
      });

      const wired = new Map(modules.map((module) => [module.flagKey, module] as const));

      // --- the registration itself -------------------------------------
      const investments = wired.get('module.investments');
      expect(investments?.consumers ?? []).toHaveLength(1);
      const integrations = wired.get('module.integrations');
      expect((integrations?.jobs ?? []).map((job) => job.kind)).toEqual([PRICE_REFRESH_JOB_KIND]);
      expect(integrations?.schedules).toBeDefined();

      // A zero-key install registers no price source at all. This is what
      // makes `module.integrations: true` safe as a default.
      expect(marketDataRuntime.sources).toHaveLength(0);
      expect(marketDataRuntime.figi).toBeUndefined();
      expect(marketDataRuntime.keys).toHaveLength(0);

      // --- the schedule row, declared through the real upsert ----------
      await integrations?.schedules?.(h.userId);
      const scheduled = await h.database.db.execute<{
        name: string;
        job_kind: string;
        cron: string;
      }>(
        sql`SELECT name, job_kind, cron FROM schedules WHERE user_id = ${h.userId}::uuid AND name = ${PRICE_REFRESH_JOB_KIND}`,
      );
      expect(scheduled.rows).toHaveLength(1);
      expect(scheduled.rows[0]?.job_kind).toBe(PRICE_REFRESH_JOB_KIND);
      expect(scheduled.rows[0]?.cron).toBe('45 3 * * *');

      // --- a real sync, producing a real connections.SyncRunCompleted ---
      await linkManual(h, {
        providerConnectionId: 'p3wire-conn',
        displayName: 'Phase 3 Wiring Brokerage',
        accounts: [
          {
            providerAccountId: 'p3wire-brokerage',
            name: 'Phase 3 Wiring Brokerage',
            type: 'investment',
            currency: 'USD',
          },
        ],
      });
      const completed = await h.database.db.execute<{ count: string }>(
        sql`SELECT count(*)::text AS count FROM domain_events WHERE event_type = 'connections.SyncRunCompleted'`,
      );
      expect(
        Number(completed.rows[0]?.count ?? '0'),
        'the manual sync must have produced at least one connections.SyncRunCompleted',
      ).toBeGreaterThan(0);

      const pump = createConsumerPump({
        pool: h.database.pool,
        // The same executor `worker.ts` builds. `platformExecutor` is
        // deliberately NOT used here — see the sabotage below.
        db: drizzleTransactionalExecutor(h.database.db),
        clock: systemClock,
        logger,
        consumers: [...(investments?.consumers ?? [])],
      });

      const offsetOf = async (): Promise<bigint> => {
        const rows = await h.database.db.execute<{ last_seq: string }>(
          sql`SELECT last_seq FROM event_consumer_offsets WHERE consumer_name = ${LOTS_CONSUMER_NAME}`,
        );
        return BigInt(rows.rows[0]?.last_seq ?? '0');
      };
      const writtenTransactions = async (): Promise<number> => {
        const rows = await h.database.db.execute<{ count: string }>(
          sql`SELECT count(*)::text AS count FROM investment_transactions WHERE account_id = ${accountId}::uuid`,
        );
        return Number(rows.rows[0]?.count ?? '0');
      };

      // --- (b) the failing drain: written, then rolled back -------------
      await pump.drain();
      expect(
        await writtenTransactions(),
        'a derivation that failed after writing must leave no row — the write is in the pump transaction',
      ).toBe(0);
      const offsetAfterFailure = await offsetOf();

      // The pump set `retry_after` on the failure, which is the control doing
      // its job — a poison event must not be re-run in a hot loop. Clearing it
      // is simulating the backoff *elapsing*, which in production is a few
      // seconds later; the `status`/`failed_count` bookkeeping is left alone
      // so the retry still goes through the ordinary redelivery path rather
      // than a reset one.
      await h.database.db.execute(
        sql`UPDATE event_consumer_offsets SET retry_after = NULL WHERE consumer_name = ${LOTS_CONSUMER_NAME}`,
      );

      // --- (a) the repaired drain: the same event, retried and applied ---
      failMode = false;
      await pump.drain();

      expect(
        await writtenTransactions(),
        'the repaired derivation must apply the same event it failed on (at-least-once redelivery)',
      ).toBe(1);
      expect(await offsetOf()).toBeGreaterThan(offsetAfterFailure);

      // The consumer appended its event in that same transaction.
      const lotsUpdated = await h.database.db.execute<{ count: string }>(
        sql`SELECT count(*)::text AS count FROM domain_events WHERE event_type = 'investments.LotsUpdated'`,
      );
      expect(Number(lotsUpdated.rows[0]?.count ?? '0')).toBeGreaterThan(0);

      // And a lot was opened, which is the thing the module exists to do.
      const lots = await h.database.db.execute<{ count: string }>(
        sql`SELECT count(*)::text AS count FROM cost_basis_lots WHERE account_id = ${accountId}::uuid`,
      );
      expect(Number(lots.rows[0]?.count ?? '0')).toBeGreaterThan(0);

      // --- idempotence: a third drain re-delivers nothing ---------------
      const offsetAfterSuccess = await offsetOf();
      await pump.drain();
      expect(await offsetOf()).toBe(offsetAfterSuccess);
      expect(await writtenTransactions()).toBe(1);
    }, 120_000);

    it('a pump built with platformExecutor is refused by name, not by a TypeError five frames down', () => {
      // The sabotage for `drizzleTransactionalExecutor`. `platformExecutor` —
      // what every Phase 1/2 consumer is served by, and what this pump would
      // have used if nobody had noticed — hands the handler an `Executor`
      // carrying `execute` alone. WP 3.2's lot store writes through Drizzle's
      // query builder, so before `assertDrizzleTransaction` existed this failed
      // as `db.insert is not a function`, recorded in `failed_error` on the
      // consumer offset row and nowhere a reader would look.
      //
      // Observed red before the guard, and it is the guard's message that is
      // asserted here rather than merely "it threw": a control that fires with
      // an unhelpful message is half a control.
      const narrowed = platformExecutor(h.database.db);
      let captured: unknown;
      const probe = narrowed.transaction(async (tx) => {
        try {
          assertDrizzleTransaction(tx);
        } catch (error) {
          captured = error;
        }
      });

      return probe.then(() => {
        expect(captured).toBeInstanceOf(Error);
        expect((captured as Error).message).toContain('drizzleTransactionalExecutor');
        expect((captured as Error).message).toContain('narrows away the Drizzle handle');
      });
    });

    it('the real InvestmentSyncPort answers honestly for a sync run that produced no investment facts', async () => {
      // `domain.ts`'s real port, against the real `sync_runs` row the manual
      // sync above wrote. It must name the provider and the date and return two
      // empty arrays — not throw, and not invent a fact.
      const real = createInvestmentSyncPort(h.database.db);
      const run = await h.database.db.execute<{ id: string }>(
        sql`SELECT id FROM sync_runs WHERE user_id = ${h.userId}::uuid ORDER BY started_at DESC LIMIT 1`,
      );
      const runId = run.rows[0]?.id;
      expect(runId, 'the manual sync must have written a sync_runs row').toBeDefined();
      if (runId === undefined) return;

      const facts = await real.factsForRun(h.userId, runId);
      expect(facts.provider).toBe('manual');
      expect(facts.asOfDate).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
      expect(facts.holdings).toEqual([]);
      expect(facts.transactions).toEqual([]);
    });

    it('a real provider leg, the real port and the real pump put a lot in the database', async () => {
      // WP 3.7 closes the loop the test above leaves open. Nothing is stubbed:
      // the `holdings` and `investment_txns` legs of the real orchestrator call
      // the real `PlaidConnector`, which maps the recorded Sandbox fixture
      // through the real `map.ts`; the legs write real
      // `connection_sync_facts`; the real `createInvestmentSyncPort` reads them
      // back and resolves each security through WP 3.1's real
      // `SecurityResolver`; the real lot consumer, delivered by the real pump,
      // derives a lot. The only double in the chain is the socket.
      const logger = pino({ level: 'silent' });

      const linked = await h.request({
        method: 'POST',
        url: '/connections/plaid/exchange',
        session: h.fresh,
        body: { publicToken: PUBLIC_TOKEN, institutionName: 'Northwind Brokerage' },
      });
      expect(linked.statusCode, 'the plaid link must succeed').toBe(201);
      const connectionId = (linked.json() as { connectionId: string }).connectionId;

      const denyAll = createEgressPolicy({ allowedHosts: [] });
      const runtime = createDomainRuntime({
        database: h.database.db,
        clock: systemClock,
        logger,
        registry: createConnectorRegistry(),
        secretBox: h.security.requireSecretBox(),
      });
      const modules = appModules({
        // W-A wiring (WP 5.1): the two operator halves of the kill ladder the
        // real worker reads from config; a test wires them as the defaults do.
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
        // The real one. This is the line the whole test exists for.
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
      // Catch up over everything the earlier tests produced, so what this test
      // asserts is what *this* sync caused.
      await pump.drain();

      // --- the sync itself -----------------------------------------------
      const summary = await h.orchestrator.syncConnection({
        connectionId,
        userId: h.userId,
        trigger: 'manual',
        correlationId: newId(),
      });
      expect(summary.error).toBeNull();

      const staged = await h.database.db.execute<{ kind: string; count: string }>(
        sql`SELECT kind, count(*)::text AS count FROM connection_sync_facts GROUP BY kind ORDER BY kind`,
      );
      const stagedByKind = new Map(staged.rows.map((row) => [row.kind, Number(row.count)]));
      expect(stagedByKind.get('holding'), 'the holdings leg staged the fixture positions').toBe(3);
      expect(stagedByKind.get('investment_transaction')).toBe(5);

      // --- the consumer, through the real pump ----------------------------
      await pump.drain();

      // The security came from the resolver, not from a made-up id.
      //
      // Keyed on the FIGI, which is one of the four names `holdingFactOf` files
      // a VTI position under. It used to be the *only* one — WP 3.7 §11 item 1,
      // fixed in WP 3.7a — and the three tests below this one are that fix's.
      const security = await h.database.db.execute<{ id: string; ticker: string | null }>(sql`
        SELECT DISTINCT s.id, s.ticker
          FROM securities s
          JOIN security_identifiers i ON i.security_id = s.id
         WHERE s.user_id = ${h.userId}::uuid AND i.value = 'BBG000BDTF76'
      `);
      expect(security.rows, 'one security for the synced VTI position').toHaveLength(1);
      const securityId = security.rows[0]?.id;
      expect(securityId).toBeDefined();
      if (securityId === undefined) return;

      // The transactions the lot engine stored, labelled as the provider's own.
      // Scoped to `plaid`: the first test in this file wrote one `manual`
      // transaction through the stubbed port, and counting it here would make
      // this assertion about that test instead of this one.
      const stored = await h.database.db.execute<{ source: string; provider: string }>(sql`
        SELECT source, provider
          FROM investment_transactions
         WHERE user_id = ${h.userId}::uuid AND provider = 'plaid'
      `);
      expect(stored.rows.length, 'five fixture transactions land in the ledger').toBe(5);
      expect(
        stored.rows.every((row) => row.source === 'BROKER' && row.provider === 'plaid'),
        'an exact provider leg is BROKER, never IMPORTED or ESTIMATED',
      ).toBe(true);

      // …and the lot. The buy of 5 VTI at 268.40 opened one; the sell of 2
      // consumed part of it, so what survives is one open lot with 3 left.
      //
      // Scoped to `plaid` through the transaction that opened it, for the same
      // reason the assertion above is: the first test in this file opened a lot
      // on a `manual` transaction, in a different account, for VTI. Until WP
      // 3.7a that lot was invisible from here, because its security was a
      // *different row* — the ticker sighting the FIGI sighting could not
      // merge with. Now there is one security, so an unscoped count sees both
      // lots, and the test that used to pass by accident has to say which leg
      // it is about. The merge is asserted directly in 'a security seen as a
      // ticker and later as a FIGI is one securities row' below.
      const lots = await h.database.db.execute<{
        quantity_remaining: string;
        basis_source: string;
      }>(sql`
        SELECT l.quantity_remaining, l.basis_source
          FROM cost_basis_lots l
          JOIN investment_transactions t ON t.id = l.opened_by_transaction_id
         WHERE l.user_id = ${h.userId}::uuid
           AND l.security_id = ${securityId}::uuid
           AND t.provider = 'plaid'
      `);
      expect(lots.rows, 'the synced buy opened exactly one lot').toHaveLength(1);
      expect(Number(lots.rows[0]?.quantity_remaining ?? '0')).toBe(3);
      // `BROKER`, because the buy carried a real price — not `ESTIMATED`, which
      // is what an unknown basis must produce (04 §5.5).
      expect(lots.rows[0]?.basis_source).toBe('BROKER');

      // The positions the holdings leg asserted are stored too.
      const holdings = await h.database.db.execute<{ count: string }>(
        sql`SELECT count(*)::text AS count FROM holdings WHERE user_id = ${h.userId}::uuid`,
      );
      expect(Number(holdings.rows[0]?.count ?? '0')).toBeGreaterThan(0);
    }, 120_000);

    /**
     * WP 3.7a, item 1 — and the reason this file is where it is asserted.
     *
     * The first test in this describe resolved `ticker/VTI@XNYS` through
     * `securityResolverFor` (it needed a real `securities` row for a foreign
     * key). The test above then synced the Plaid fixture, whose VTI security
     * carries a FIGI, an ISIN, a CUSIP **and** that same MIC-qualified ticker.
     * Those are two sightings of one asset, by two different providers, and
     * nothing but the holdings leg connects them.
     *
     * Before the fix this query returned **two** rows: `holdingSecurityOf` kept
     * the FIGI and dropped the other three, so the resolver — which tiers
     * strongest-first over the set it is shown — was never shown the ticker
     * that would have found the row already there. It is the §5 risk table's
     * "one asset, two securities", reproduced by the fixtures rather than
     * argued about.
     *
     * `merged_into_id IS NULL` is in the `WHERE` on purpose: a merge is a
     * legitimate way to end up with one *surviving* row, and counting losers
     * would make this test unable to tell "never split" from "split and
     * healed". Here nothing merges — the second sighting joins the first row
     * directly — and the assertion on `merged` below says so.
     */
    it('a security seen as a ticker and later as a FIGI is one securities row', async () => {
      const rows = await h.database.db.execute<{
        id: string;
        ticker: string | null;
        figi: string | null;
        isin: string | null;
        cusip: string | null;
        identity_kind: string;
        merged_into_id: string | null;
      }>(sql`
        SELECT DISTINCT s.id, s.ticker, s.figi, s.isin, s.cusip, s.identity_kind, s.merged_into_id
          FROM securities s
          JOIN security_identifiers i ON i.security_id = s.id
         WHERE s.user_id = ${h.userId}::uuid
           AND s.merged_into_id IS NULL
           AND upper(i.value) IN ('VTI', 'BBG000BDTF76', 'US9229087690', '922908769')
      `);
      expect(
        rows.rows,
        'the ticker sighting and the FIGI sighting are one security, not two',
      ).toHaveLength(1);

      // …and it is one row that knows all four names, which is the thing that
      // makes the *next* provider's sighting land here too.
      const row = rows.rows[0];
      expect(row?.ticker).toBe('VTI');
      expect(row?.figi).toBe('BBG000BDTF76');
      expect(row?.isin).toBe('US9229087690');
      expect(row?.cusip).toBe('922908769');
      // The FIGI outranks the ticker that established the row, so the identity
      // was upgraded in place — same id, better name. Holdings and lots point
      // at that id and none of them had to move.
      expect(row?.identity_kind).toBe('figi');
      expect(row?.merged_into_id).toBeNull();

      const merged = await h.database.db.execute<{ count: string }>(sql`
        SELECT count(*)::text AS count FROM securities
         WHERE user_id = ${h.userId}::uuid AND merged_into_id IS NOT NULL
      `);
      expect(
        Number(merged.rows[0]?.count ?? '0'),
        'nothing had to be merged: the two sightings never became two rows',
      ).toBe(0);
    });

    /**
     * WP 3.7a, item 2. The same field, costing a different column.
     *
     * `securities.type` for VTI is `etf` because the holdings leg carried
     * Plaid's `type: 'etf'` and its display name alongside the identifiers. It
     * could not before: a `SecurityIdentifier` has no room for either, so
     * `securityTypeOf(null, identity, null)` answered `other` for everything
     * that was not a `chain_contract`.
     *
     * The row was *created* by the first test in this file from a bare ticker
     * with no provider type at all, so `other` is genuinely what it held until
     * this sync — which makes this an assertion about the resolver's upgrade
     * rule (`descriptionUpgradeOf`) as much as about the port shape. The rule
     * is one-directional: `other` gives way to a real answer, and a real answer
     * never gives way to `other`.
     */
    it('securities.type survives the holdings path', async () => {
      const rows = await h.database.db.execute<{
        type: string;
        name: string | null;
        asset_class: string;
      }>(sql`
        SELECT s.type, s.name, s.asset_class
          FROM securities s
         WHERE s.user_id = ${h.userId}::uuid AND s.figi = 'BBG000BDTF76'
      `);
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0]?.type, 'the provider said etf and the row says etf').toBe('etf');
      expect(rows.rows[0]?.name).toBe('Vanguard Total Stock Market ETF');
      // The classification columns were recomputed with the type rather than
      // left behind at whatever an unclassifiable `other` produced.
      expect(rows.rows[0]?.asset_class).not.toBe('UNCLASSIFIED');
    });

    /**
     * WP 3.7a, item 3 — WP 3.7 §11's third carried item.
     *
     * The cash-sweep position in the Plaid fixture carries no ticker, CUSIP,
     * ISIN or FIGI, so the only name available is Plaid's own `security_id`,
     * emitted as `proprietary`. The resolver refuses a proprietary identifier
     * as an identity, mints nothing, and appends `SecurityResolutionFailed` —
     * which is the correct behaviour and the record that the position exists.
     *
     * What was not correct is that the resolution runs in a transaction of its
     * own (`createInvestmentSyncPort`'s comment says why), so the pump retrying
     * a delivery re-ran the abstention and appended it again. This test calls
     * `factsForRun` a second time on the same run — which is exactly what a
     * retried delivery does to this port — and counts.
     */
    it('a retried delivery appends one SecurityResolutionFailed', async () => {
      const runs = await h.database.db.execute<{ id: string }>(sql`
        SELECT id FROM sync_runs
         WHERE user_id = ${h.userId}::uuid AND operation = 'holdings'
         ORDER BY started_at DESC LIMIT 1
      `);
      const holdingsRunId = runs.rows[0]?.id;
      expect(holdingsRunId, 'the holdings leg must have settled a sync_runs row').toBeDefined();
      if (holdingsRunId === undefined) return;

      const countFailures = async (): Promise<number> => {
        const rows = await h.database.db.execute<{ count: string }>(sql`
          SELECT count(*)::text AS count FROM domain_events
           WHERE user_id = ${h.userId}::uuid
             AND event_type = 'investments.SecurityResolutionFailed'
             AND payload->>'syncRunId' = ${holdingsRunId}
        `);
        return Number(rows.rows[0]?.count ?? '0');
      };

      expect(await countFailures(), 'the unnamed cash sweep failed to resolve exactly once').toBe(
        1,
      );

      // The payload says which sync produced it — the field the dedupe key is
      // built on, and the one a reader actually wants.
      const event = await h.database.db.execute<{
        provider: string;
        provider_security_id: string;
      }>(sql`
        SELECT payload->>'provider' AS provider,
               payload->>'providerSecurityId' AS provider_security_id
          FROM domain_events
         WHERE user_id = ${h.userId}::uuid
           AND event_type = 'investments.SecurityResolutionFailed'
           AND payload->>'syncRunId' = ${holdingsRunId}
      `);
      expect(event.rows[0]?.provider).toBe('plaid');
      expect(event.rows[0]?.provider_security_id).toBe('sec-cash-0002');

      // The retry. Same run, same port, same abstention — and no second report.
      const port = createInvestmentSyncPort(h.database.db);
      await port.factsForRun(h.userId, holdingsRunId);
      expect(
        await countFailures(),
        'a retried delivery is the same observation, not a second one',
      ).toBe(1);

      // Twice more, because "idempotent" that only survives one retry is a
      // coincidence. The pump backs off and retries repeatedly.
      await port.factsForRun(h.userId, holdingsRunId);
      await port.factsForRun(h.userId, holdingsRunId);
      expect(await countFailures()).toBe(1);
    }, 60_000);

    /**
     * WP 3.14a — the item wp3.7a-holding-identifiers.md §7 carried:
     * "`ProviderInvestmentTransactionFact.security` is still one
     * `SecurityIdentifier`... A run that produced investment transactions and
     * **no** holdings for the same security would split it exactly as
     * holdings used to."
     *
     * Reproduced with a *second* Plaid Item (`fakePlaidItem` — namespaced
     * account ids, so it cannot collide with the default Item's ledger
     * accounts) whose fixture has no `.holdings` at all: the holdings leg
     * comes back `PRODUCTS_NOT_SUPPORTED` (capability cleared, no facts
     * written) and the *only* sighting of this security is one investment
     * transaction. A security a provider names with a FIGI **and** a ticker
     * on the very same record is exactly `holdingSecurityOf`'s old failure —
     * before this WP, `investmentTransactionFactOf` picked the FIGI (the
     * strongest identifier) and dropped the ticker, the same defect WP 3.7a
     * fixed for holdings.
     *
     * The earlier sighting is a `manual` ticker-only resolution — same shape
     * as the very first test in this file — so the two sightings share
     * exactly one name if and only if the transaction fact carried it.
     *
     * `factsForRun` is called directly, deliberately skipping the lot
     * consumer/pump: what is under test is `resolveRunFacts`'s resolution
     * step alone, and running the consumer would open a lot and a cost-basis
     * row that the later `'a real provider leg...'` test's `provider =
     * 'plaid'`-scoped counts never anticipated a second Item contributing to.
     */
    it('an investment transaction with no holding for its security still merges with an earlier ticker-only sighting', async () => {
      const itemSpec = fakePlaidItem({
        accessToken: 'access-sandbox-NEVER-REAL-p314a-0000000000000000',
        publicToken: 'public-sandbox-NEVER-REAL-p314a-1111111111111111',
        itemId: 'item-p314a',
      });
      const security = {
        ...INVESTMENTS.securities[0]!,
        security_id: 'sec-p314a-0001',
        isin: null,
        cusip: null,
        figi: 'BBG000P31401',
        ticker_symbol: 'P314A',
        market_identifier_code: 'XNAS',
        name: 'P3.14a Test Security',
        type: 'equity',
      };
      const transaction = {
        ...INVESTMENTS.investment_transactions[0]!,
        investment_transaction_id: 'ivt-p314a-buy',
        account_id: 'item-p314a-acct-brokerage-003',
        security_id: security.security_id,
        name: 'BUY P314A',
      };
      plaidApi.addItem({
        ...itemSpec,
        // `fakePlaidItem`'s own accounts are namespaced by `itemId`
        // (`account_id`), but `SYNC_PAGES` is a shared fixture that splices
        // the *unnamespaced* `ACCOUNTS` onto every page (`harness.ts`'s own
        // comment: "Plaid volunteers the full account list on every page").
        // The transactions leg re-upserts every account a page volunteers
        // (`orchestrator.ts`'s `if (page.accounts.length > 0)`), so reusing
        // `SYNC_PAGES` here would collide with the default Item's
        // already-linked `acct-checking-001` on the ledger's own natural key.
        // An empty page (no accounts, no transactions) sidesteps the
        // collision; this test is about the investment_txns leg, not the
        // transactions one.
        pages: [
          {
            accounts: [],
            added: [],
            modified: [],
            removed: [],
            next_cursor: '',
            has_more: false,
            // Borrowed rather than typed by hand, so this file never needs to
            // import the `plaid` SDK's own enum.
            transactions_update_status: SYNC_PAGES[0]!.transactions_update_status,
            request_id: 'req-p314a-transactions-sync',
          },
        ],
        // No `.holdings`: `/investments/holdings/get` answers
        // PRODUCTS_NOT_SUPPORTED, exactly the `withoutHoldings` scenario
        // `defaultItemSpec` names, so this Item's only investments leg is
        // investment_txns.
        investmentTransactions: {
          accounts: [],
          securities: [security],
          investment_transactions: [transaction],
          total_investment_transactions: 1,
          item: plainItemOf(ITEM),
          request_id: 'req-p314a-investments-transactions-get',
        },
      });

      // The earlier, weaker sighting — a hand-entered ticker, the same shape
      // the first test in this file uses, and from a different provider so
      // there is no other route to the same row than the identifier itself.
      const priorResolution = await securityResolverFor(h.database.db, systemClock).resolve(
        { kind: 'ticker', value: 'P314A', chain: null, mic: 'XNAS' },
        { userId: h.userId, provider: 'manual', correlationId: newId() },
      );
      expect(priorResolution.outcome, 'the resolver must place a ticker with a MIC').toBe(
        'resolved',
      );

      const linked = await h.request({
        method: 'POST',
        url: '/connections/plaid/exchange',
        session: h.fresh,
        body: { publicToken: itemSpec.publicToken, institutionName: 'P3.14a Test Co' },
      });
      expect(linked.statusCode, 'the plaid link must succeed').toBe(201);
      const connectionId = (linked.json() as { connectionId: string }).connectionId;

      const summary = await h.orchestrator.syncConnection({
        connectionId,
        userId: h.userId,
        trigger: 'manual',
        correlationId: newId(),
      });
      expect(
        summary.error,
        'the transactions leg is unaffected by the missing products',
      ).toBeNull();

      const runs = await h.database.db.execute<{ id: string }>(sql`
        SELECT id FROM sync_runs
         WHERE connection_id = ${connectionId}::uuid AND operation = 'investment_txns'
         ORDER BY started_at DESC LIMIT 1
      `);
      const investmentTxnsRunId = runs.rows[0]?.id;
      expect(
        investmentTxnsRunId,
        'the investment_txns leg must have settled a sync_runs row',
      ).toBeDefined();
      if (investmentTxnsRunId === undefined) return;

      // Directly, not through the pump: see the header comment for why.
      await createInvestmentSyncPort(h.database.db).factsForRun(h.userId, investmentTxnsRunId);

      const rows = await h.database.db.execute<{
        id: string;
        ticker: string | null;
        figi: string | null;
        identity_kind: string;
        merged_into_id: string | null;
      }>(sql`
        SELECT DISTINCT s.id, s.ticker, s.figi, s.identity_kind, s.merged_into_id
          FROM securities s
          JOIN security_identifiers i ON i.security_id = s.id
         WHERE s.user_id = ${h.userId}::uuid
           AND s.merged_into_id IS NULL
           AND upper(i.value) IN ('P314A', 'BBG000P31401')
      `);
      expect(
        rows.rows,
        'the ticker sighting and the investment-transaction-only FIGI sighting are one ' +
          'security, not two',
      ).toHaveLength(1);
      expect(rows.rows[0]?.ticker).toBe('P314A');
      expect(rows.rows[0]?.figi).toBe('BBG000P31401');
      // The FIGI outranks the ticker that established the row, so — as in the
      // holdings case — the identity was upgraded in place.
      expect(rows.rows[0]?.identity_kind).toBe('figi');
      expect(rows.rows[0]?.merged_into_id).toBeNull();
    }, 60_000);

    it('module.planning: a real ledger.BalanceRecorded reaches the net-worth consumer through the real pump, and the 04:00 schedule lands', async () => {
      // WP 3.8's half of the flag flip, and it asserts the two things
      // `module.planning: true` is actually a claim about:
      //
      //   a. the consumer is *delivered* a real event through the real pump
      //      built with `drizzleTransactionalExecutor` — which is the only way
      //      to know `executorFor: (c) => assertDrizzleTransaction(c.tx)` is
      //      satisfied, because `markDirty` is written against Drizzle's query
      //      builder and `platformExecutor` would narrow the handle away;
      //   b. the schedule row lands through the real `upsertSchedule`, with the
      //      cron the job actually needs.
      //
      // Nothing here stubs the consumer, the pump or the scheduler.
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
        // W-A wiring (WP 5.1): the two operator halves of the kill ladder the
        // real worker reads from config; a test wires them as the defaults do.
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
      const planning = modules.find((module) => module.flagKey === 'module.planning');
      expect(planning?.consumers ?? []).toHaveLength(2);

      // --- (b) the schedule row, through the real upsert ------------------
      await planning?.schedules?.(h.userId);
      const scheduled = await h.database.db.execute<{ job_kind: string; cron: string }>(
        sql`SELECT job_kind, cron FROM schedules
             WHERE user_id = ${h.userId}::uuid AND name = ${NET_WORTH_SNAPSHOT_JOB_KIND}`,
      );
      expect(scheduled.rows).toHaveLength(1);
      expect(scheduled.rows[0]?.job_kind).toBe(NET_WORTH_SNAPSHOT_JOB_KIND);
      expect(scheduled.rows[0]?.cron).toBe(NET_WORTH_SNAPSHOT_CRON);

      // --- (a) a real ledger.BalanceRecorded, through the real pump -------
      const accountRows = await h.database.db.execute<{ id: string; currency: string }>(
        sql`SELECT id, currency FROM accounts WHERE user_id = ${h.userId}::uuid ORDER BY created_at LIMIT 1`,
      );
      const accountId = accountRows.rows[0]?.id;
      expect(accountId, 'the manual link above must have created an account').toBeDefined();
      if (accountId === undefined) return;

      await recordBalance(
        h.database.db,
        {
          userId: h.userId,
          accountId,
          current: money(123_45n, accountRows.rows[0]?.currency ?? 'USD'),
          available: null,
          limit: null,
          asOf: new Date('2026-06-15T12:00:00Z'),
          source: 'manual',
        },
        { clock: systemClock, correlationId: newId() },
      );

      const pump = createConsumerPump({
        pool: h.database.pool,
        db: drizzleTransactionalExecutor(h.database.db),
        clock: systemClock,
        logger,
        consumers: [...(planning?.consumers ?? [])],
      });
      await pump.drain();

      const offset = await h.database.db.execute<{ last_seq: string; failed_error: string | null }>(
        sql`SELECT last_seq, failed_error FROM event_consumer_offsets
             WHERE consumer_name = ${NET_WORTH_CONSUMER_NAME}`,
      );
      expect(offset.rows).toHaveLength(1);
      // The offset exists *and* nothing is recorded in `failed_error`. That
      // second half is the whole assertion: before
      // `drizzleTransactionalExecutor`, a consumer written against the query
      // builder failed here with `db.update is not a function` and the only
      // trace was this column (wp3.w-wiring.md §4).
      expect(offset.rows[0]?.failed_error).toBeNull();
      expect(BigInt(offset.rows[0]?.last_seq ?? '0')).toBeGreaterThan(0n);
    }, 120_000);

    it("planningPortsFor answers over the real ledger, and budgeting's exclusion list outranks the class default", async () => {
      // The four ports, over real rows. `onBudget` is the one flag with a
      // second source of truth — `budgets.off_budget_account_ids`, which
      // 0009_budgeting.sql says exists precisely so Budgeting does not write an
      // `on_budget` column into Ledger's table — so it is the one worth driving
      // in both directions.
      const ports = planningPortsFor(h.database.db, {
        userId: h.userId,
        timeZone: 'UTC',
        clock: systemClock,
      });

      const before = await ports.balances.accounts(h.userId, '2026-06-15');
      expect(before.length).toBeGreaterThan(0);
      const cash = before.find((account) => account.kind === 'cash');
      if (cash !== undefined) {
        // 07 §4.1: cash is on-budget, liquid and not investable.
        expect(cash.flags).toEqual({
          onBudget: true,
          inNetWorth: true,
          isLiquid: true,
          isInvestable: false,
        });
      }
      const brokerage = before.find((account) => account.kind === 'investment');
      expect(brokerage, 'the manual link above created an investment account').toBeDefined();
      // An investment account is investable and **not** liquid: selling a
      // position to buy groceries is not what 07 §4.1 means by liquid.
      expect(brokerage?.flags.isInvestable).toBe(true);
      expect(brokerage?.flags.isLiquid).toBe(false);
      expect(brokerage?.side).toBe('asset');

      // Now exclude one account from the budget and read again.
      const target = before[0];
      expect(target).toBeDefined();
      if (target === undefined) return;
      await h.database.db.execute(sql`
        INSERT INTO budgets (id, user_id, name, currency, timezone, off_budget_account_ids)
        VALUES (${newId()}::uuid, ${h.userId}::uuid, 'p3wire planning budget', 'USD', 'UTC',
                ${JSON.stringify([target.accountId])}::jsonb)
      `);
      const after = await ports.balances.accounts(h.userId, '2026-06-15');
      expect(after.find((account) => account.accountId === target.accountId)?.flags.onBudget).toBe(
        false,
      );
      // And only in the `false` direction: an account the list does not name
      // keeps whatever 07 §4.1's class table said.
      for (const account of after) {
        if (account.accountId === target.accountId) continue;
        const original = before.find((row) => row.accountId === account.accountId);
        expect(account.flags.onBudget).toBe(original?.flags.onBudget);
      }

      // The balance the test above recorded, read back as a local-day
      // observation rather than a `timestamptz`.
      const observation = await ports.balances.balanceOnOrBefore(
        h.userId,
        target.accountId,
        '2026-06-16',
      );
      if (observation !== null) {
        expect(observation.date).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
        expect(typeof observation.currentMinor).toBe('bigint');
      }

      // A day with nothing posted sums to zero — not `null`, and not a throw:
      // 04 §5.4's backfill subtracts this number unconditionally.
      expect(
        await ports.balances.transactionsTotalOn(h.userId, target.accountId, '1999-01-01'),
      ).toBe(0n);

      // No holdings snapshot exists for a brand-new account, and the honest
      // answer is an empty list on both sides of the bracket rather than an
      // invented quantity.
      expect(
        await ports.holdings.positionsOnOrBefore(h.userId, target.accountId, '2026-06-15'),
      ).toEqual([]);
      expect(
        await ports.holdings.bracketingObservations(
          h.userId,
          target.accountId,
          newId(),
          '2026-06-15',
        ),
      ).toEqual({ before: null, after: null });

      // D4 and 08 §6.6: the identity is the only 1.0 this system produces, and
      // it is labelled rather than inferred.
      const identity = await ports.fx.rate('USD', 'USD', '2026-06-15');
      expect(identity.rate).toBe('1');
      expect(identity.source).toBe('identity');
      // A pair nobody has ever observed throws rather than answering a
      // plausible par — the asymmetry with `PriceReader` that D4 exists for.
      await expect(ports.fx.rate('USD', 'JPY', '2026-06-15')).rejects.toThrow();
      // A security nobody has priced is an ordinary `null`, not a throw.
      expect(await ports.prices.price(newId(), '2026-06-15', 'USD')).toBeNull();
    }, 120_000);

    it('isRetirementAccount reads the provider subtype, and an unrecognised one is not a retirement account', async () => {
      const real = createInvestmentSyncPort(h.database.db);
      const rows = await h.database.db.execute<{ id: string }>(
        sql`SELECT id FROM accounts WHERE user_id = ${h.userId}::uuid LIMIT 1`,
      );
      const existing = rows.rows[0]?.id;
      expect(existing).toBeDefined();
      if (existing === undefined) return;

      // A manual account's subtype is whatever the user typed; none of the
      // harness's is a retirement marker.
      expect(await real.isRetirementAccount(existing)).toBe(false);
      // An account that does not exist is not a retirement account either —
      // and specifically does not throw, because a wash-sale scan over a
      // deleted account must degrade rather than fail the whole derivation.
      expect(await real.isRetirementAccount(newId())).toBe(false);

      await h.database.db.execute(
        sql`UPDATE accounts SET subtype = 'roth ira' WHERE id = ${existing}::uuid`,
      );
      expect(await real.isRetirementAccount(existing)).toBe(true);
      await h.database.db.execute(
        sql`UPDATE accounts SET subtype = NULL WHERE id = ${existing}::uuid`,
      );
    });
  },
);
