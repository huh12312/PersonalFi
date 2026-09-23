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
  securityResolverFor,
  assertDrizzleTransaction,
} from '../../src/domain.ts';
import { PRICE_REFRESH_JOB_KIND, appModules } from '../../src/modules.ts';
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

    beforeAll(async () => {
      h = await createApiHarness({ suite: 'p3wire' });
    }, 60_000);

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
          security: { kind: 'ticker', value: 'VTI', chain: null, mic: 'XNYS' },
          providerSecurityId: 'p3wire-sec-1',
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
        database: h.database.db,
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
