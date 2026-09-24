// SPDX-License-Identifier: MIT
/**
 * The categorization consumer, wired exactly the way `apps/api/src/modules.ts`
 * wires it in production, over a real database.
 *
 * Every other suite under `test/db/` builds the real `app` and drives it with
 * `app.inject`; this one does the same for the half of the wiring that never
 * runs *inside* the API process. `apps/api/src/app.ts` never calls
 * `appModules()`/`resolveModules()` — that only happens in `worker.ts`, by
 * design (the API stays request/response; the worker runs consumers, jobs and
 * the scheduler). So proving "a synced transaction gets a category from a rule"
 * end to end means building the same consumer pump the worker builds — from
 * `appModules()`'s own registration, not a shortcut around it — and draining it
 * against a transaction that arrived through the same
 * `POST /connections` → `SyncOrchestrator` → `applyProviderTransactions` path
 * every route test uses.
 *
 * The claim under test is wp1.4 evidence §6 end to end: a rule
 * (`@ctx/categorization`) decides, writes through the `LedgerPort` this file's
 * sibling `domain.ts` implements, and `GET /transactions` — the same JSON a
 * real client receives — shows the category without this suite ever calling
 * `@ctx/categorization` or `@ctx/ledger` from the same context (it does not;
 * both are reached the way production reaches them, through `modules.ts` and
 * HTTP respectively).
 */
import { DateOnly, money, newId, systemClock } from '@core/kernel';
import { createConsumerPump, platformExecutor } from '@core/platform';
import { manualTransaction } from '@connector/manual';
import { categoryIdsByKey, seedSystemTaxonomy } from '@ctx/categorization';
import { createEgressPolicy, createNtfyChannel, createSmtpChannel } from '@ctx/notifications';
import { sql } from 'drizzle-orm';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createConnectorRegistry,
  createDomainRuntime,
  createInvestmentSyncPort,
} from '../../src/domain.ts';
import { appModules } from '../../src/modules.ts';
import {
  createApiHarness,
  expectStatus,
  linkManual,
  NO_DATABASE,
  type ApiHarness,
} from '../helpers/api-harness.ts';

const CHECKING = 'checking';
const RULE_NAME = 'Blue Bottle is a treat';

interface TransactionListItem {
  readonly id: string;
  readonly name: string;
  readonly categoryId: string | null;
}

describe.skipIf(NO_DATABASE)('categorization wiring (apps/api/src/modules.ts)', () => {
  let h: ApiHarness;

  beforeAll(async () => {
    h = await createApiHarness({ suite: 'catwire' });
  });

  afterAll(async () => {
    await h.close();
  }, 60_000);

  it('a synced transaction ends up with an effective category from the rule tier', async () => {
    // The taxonomy has to exist before anything can be assigned to it — the same
    // precondition `categorizeTransactions` states as
    // `categorization.taxonomy_not_seeded`.
    await seedSystemTaxonomy(h.database.db, { userId: h.userId, clock: systemClock });

    // A rule, inserted directly: there is no REST surface for rules yet
    // (deferred, wp1.4 evidence §8), and this suite's claim is about the
    // consumer's wiring, not the rules CRUD surface.
    const ruleId = newId();
    await h.database.db.execute(sql`
      INSERT INTO rules
        (id, user_id, name, priority, enabled, conditions, actions, run_on_sync, stop_processing)
      VALUES (
        ${ruleId}, ${h.userId}, ${RULE_NAME}, 100, TRUE,
        ${JSON.stringify({
          all: [{ type: 'payee', match: 'contains', value: 'BLUE BOTTLE' }],
          any: [],
        })}::jsonb,
        ${JSON.stringify([{ type: 'set_category', categoryKey: 'dining.restaurants' }])}::jsonb,
        TRUE, FALSE
      )
    `);

    // The same path every route test uses: a transaction arrives through the
    // real sync, never an INSERT into transactions_provider.
    await linkManual(h, {
      providerConnectionId: 'catwire-conn',
      displayName: 'Everyday Bank',
      accounts: [
        {
          providerAccountId: CHECKING,
          name: 'Everyday Checking',
          type: 'depository',
          currency: 'USD',
        },
      ],
      batch: {
        added: [
          manualTransaction({
            providerAccountId: CHECKING,
            providerTransactionId: 'catwire-1',
            amount: money(-650n, 'USD'),
            postedDate: DateOnly.parse('2026-05-20'),
            name: 'SQ *BLUE BOTTLE COFFEE',
            merchantName: 'Blue Bottle Coffee',
          }),
        ],
      },
    });

    // Before the consumer runs: the effective category is unset. The ledger's
    // own resolveEffective has nothing to resolve yet — neither a user edit nor
    // a rule write has happened.
    const before = await list(h);
    const beforeRow = before.find((item) => item.name.includes('Blue Bottle'));
    expect(beforeRow?.categoryId ?? null).toBeNull();

    // Exactly what `worker.ts` builds from `appModules()`'s registration — not a
    // hand-rolled consumer, so a drift between this test and the real wiring
    // shows up here.
    const logger = pino({ level: 'silent' });
    const runtime = createDomainRuntime({
      database: h.database.db,
      clock: systemClock,
      logger,
      registry: createConnectorRegistry(),
      secretBox: h.security.requireSecretBox(),
    });
    const egressPolicy = createEgressPolicy({ allowedHosts: [] });
    const modules = appModules({
      database: h.database.db,
      userId: h.userId,
      orchestrator: runtime.orchestrator,
      timezone: 'UTC',
      clock: systemClock,
      notificationChannels: {
        ntfy: createNtfyChannel({ policy: egressPolicy }),
        smtp: createSmtpChannel({ policy: egressPolicy }),
      },
      secretBox: h.security.requireSecretBox(),
      investmentSyncPort: createInvestmentSyncPort(h.database.db),
    });
    const categorization = modules.find((module) => module.flagKey === 'module.categorization');
    expect(categorization).toBeDefined();
    expect(categorization?.events?.length).toBe(3);
    expect(categorization?.consumers?.length).toBe(1);

    const pump = createConsumerPump({
      pool: h.database.pool,
      db: platformExecutor(h.database.db),
      clock: systemClock,
      logger,
      consumers: categorization?.consumers ?? [],
    });
    const drained = await pump.drain();
    expect(drained).toBeGreaterThan(0);

    // The read side: the same GET /transactions JSON a browser gets, built from
    // `@ctx/ledger`'s `effectiveOf` — which now folds in the rule column
    // `setRuleCategory` wrote through the LedgerPort.
    const after = await list(h);
    const afterRow = after.find((item) => item.name.includes('Blue Bottle'));
    expect(afterRow).toBeDefined();

    const idByKey = await categoryIdsByKey(h.database.db, h.userId);
    expect(afterRow?.categoryId).toBe(idByKey.get('dining.restaurants'));
    expect(afterRow?.categoryId).not.toBeNull();
  }, 60_000);
});

async function list(h: ApiHarness): Promise<readonly TransactionListItem[]> {
  const response = await h.request({
    method: 'GET',
    url: '/transactions?limit=50',
    session: h.stale,
  });
  expectStatus(response, 200);
  const body = response.json() as { items: TransactionListItem[] };
  return body.items;
}
