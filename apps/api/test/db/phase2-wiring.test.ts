// SPDX-License-Identifier: MIT
/**
 * The Phase 2 wiring batch, proved end to end over a real database.
 *
 * `docs/plan/02-phase-2-dispatch.md` §4 assigns four contexts —
 * `@ctx/budgeting`, `@ctx/recurring`, `@ctx/notifications`, `@ctx/insights` —
 * to the orchestrator's shared-file wiring step: `apps/api/src/platform.ts`'s
 * `MODULE_FLAGS`, `apps/api/src/domain.ts`'s adapters and
 * `apps/api/src/modules.ts`'s `appModules()` registrations. None of the four
 * contexts' own test suites can prove the composition root actually wires
 * them correctly — each runs against its own fakes (`inMemoryLedgerPort`,
 * `createFakeLedger`, …) precisely because the boundary lint forbids a context
 * from importing the real `@ctx/ledger` to prove otherwise. This file is that
 * proof: it syncs real data through the real HTTP path, drains the real
 * consumer pump `appModules()` builds — exactly what `worker.ts` builds, not a
 * hand-rolled substitute (`categorization-wiring.test.ts`'s pattern, extended
 * to four more modules) — and asserts each context wrote a real row.
 *
 * There is no REST surface yet for creating a budget, a notification channel
 * or a notification rule (WP 2.9/2.11/routes carried items), so this suite
 * calls the real `@ctx/budgeting`/`@ctx/notifications` service functions
 * directly to set the scene — the same thing `categorization-wiring.test.ts`
 * does by inserting a rule with raw SQL because `POST /rules` did not exist
 * yet either. What runs through the *pump* is the real, production consumer
 * wiring; only the scene-setting is direct.
 *
 * Four claims, one per new module:
 *
 *   a. a real spending transaction, synced and categorised, produces a
 *      non-zero `budget_line_actuals` row (module.budgeting);
 *   b. three monthly charges from one payee produce a `recurring_candidates`
 *      row (module.recurring);
 *   c. a budget overspend's `budgeting.BudgetThresholdCrossed` event produces
 *      a `notification_outbox` row, and — separately — the real egress guard,
 *      under the default deny-all policy, refuses delivery through it with
 *      `host_not_allowed` (module.notifications, 02 §5's egress risk);
 *   d. triggering the nightly advisor run manually for one wave-one built-in
 *      rule produces a `pending_review` row in `insights` (module.insights).
 */
import { DateOnly, money, newId, systemClock } from '@core/kernel';
import { createConsumerPump, platformExecutor } from '@core/platform';
import { manualTransaction } from '@connector/manual';
import { createBudget, openPeriod, type BudgetingContext } from '@ctx/budgeting';
import { categoryIdsByKey, seedSystemTaxonomy } from '@ctx/categorization';
import {
  BUILTIN_CATALOGUE,
  createBuiltinRegistry,
  grantScopes,
  runAdvisor,
  type InsightsDependencies,
} from '@ctx/insights';
import {
  createChannel,
  createEgressPolicy,
  createFakeChannel,
  createNtfyChannel,
  createRule as createNotificationRule,
  createSmtpChannel,
  drainNotifications,
  verifyChannel,
  type NotificationsContext,
} from '@ctx/notifications';
import { sql } from 'drizzle-orm';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createConnectorRegistry,
  createDomainRuntime,
  createInvestmentSyncPort,
  createInsightsBudgetPort,
  createInsightsLedgerPort,
  createInsightsInvestmentsPort,
  createInsightsMarketDataPort,
  createInsightsRecurringPort,
} from '../../src/domain.ts';
import { appModules, registerBuiltinAdvisors } from '../../src/modules.ts';
import {
  createApiHarness,
  linkManual,
  NO_DATABASE,
  type ApiHarness,
} from '../helpers/api-harness.ts';

const CHECKING = 'phase2wire-checking';
const DINING_CATEGORY_KEY = 'dining.restaurants';
const CASH_ADVISOR_ID = 'builtin.cash.emergency_fund_short';

describe.skipIf(NO_DATABASE)(
  'Phase 2 wiring batch (apps/api/src/{platform,domain,modules}.ts)',
  () => {
    let h: ApiHarness;

    beforeAll(async () => {
      h = await createApiHarness({ suite: 'p2wire' });
    }, 60_000);

    afterAll(async () => {
      await h.close();
    }, 60_000);

    it('a real sync drives budgeting, recurring, notifications and insights through the real appModules() wiring', async () => {
      await seedSystemTaxonomy(h.database.db, { userId: h.userId, clock: systemClock });
      const categoryIds = await categoryIdsByKey(h.database.db, h.userId);
      const diningCategoryId = categoryIds.get(DINING_CATEGORY_KEY);
      expect(diningCategoryId).toBeDefined();
      if (diningCategoryId === undefined) throw new Error('unreachable');

      const today = DateOnly.parse(systemClock.now().toISOString().slice(0, 10));
      const diningDate = DateOnly.addDays(today, -3);
      // Exactly two hits, not three: three perfectly regular, identical-amount
      // monthly charges score confidently enough to auto-confirm straight to
      // `ACTIVE` (`AUTO_CONFIRM_CONFIDENCE = 0.8`) and skip the candidate
      // stage entirely — `n=2` is capped at `EARLY_DETECTION`'s 0.70
      // (`packages/contexts/recurring/src/confidence.ts`), which is above
      // `CANDIDATE_CONFIDENCE` (0.55) and below the auto-confirm floor, so it
      // lands exactly where this claim needs it: a real `recurring_candidates`
      // row, not an already-active series.
      const netflixDates = [1, 0].map((monthsAgo) => DateOnly.addMonths(today, -monthsAgo));

      // --- 1. A rule, so the dining charge gets a category ------------------
      // No REST surface for rules exists yet (wp1.4 evidence §8) — the same
      // gap `categorization-wiring.test.ts` works around the same way.
      const ruleId = newId();
      await h.database.db.execute(sql`
        INSERT INTO rules
          (id, user_id, name, priority, enabled, conditions, actions, run_on_sync, stop_processing)
        VALUES (
          ${ruleId}, ${h.userId}, ${'phase2-wiring: cafe -> dining'}, 100, TRUE,
          ${JSON.stringify({ all: [{ type: 'payee', match: 'contains', value: 'CAFE DELUXE' }], any: [] })}::jsonb,
          ${JSON.stringify([{ type: 'set_category', categoryKey: DINING_CATEGORY_KEY }])}::jsonb,
          TRUE, FALSE
        )
      `);

      // --- 2. A budget with a $0-assigned line for that category ------------
      // Any spending in it is an immediate cash overspend — the "the one hard
      // alert" 07 §1.9 describes, and the trigger `budgeting.BudgetThresholdCrossed`
      // fires from (module.notifications' claim below).
      const budgetContext: BudgetingContext = {
        userId: h.userId,
        clock: systemClock,
        correlationId: newId(),
      };
      const budget = await createBudget(h.database.db, budgetContext, {
        name: 'phase2-wiring budget',
        currency: 'USD',
        timezone: 'UTC',
      });
      const period = await openPeriod(h.database.db, budgetContext, {
        budgetId: budget.id,
        on: today,
      });
      // `@ctx/budgeting`'s public surface has `createBudget`/`openPeriod`/
      // `assign` but no line *constructor* (`assign` requires an existing
      // `lineId`) — there is no REST route for one either (WP 2.9 owns the
      // budget screen). The same gap `categorization-wiring.test.ts` works
      // around for rules: a direct insert into the owning table, matching
      // `src/budget.ts`'s own `upsertLine` column layout exactly (`dirty:
      // true`, every other minor column left at its schema default of 0).
      const lineId = newId();
      await h.database.db.execute(sql`
        INSERT INTO budget_lines
          (id, user_id, budget_id, budget_period_id, kind, category_id, currency, dirty)
        VALUES (
          ${lineId}, ${h.userId}, ${budget.id}, ${period.id}, 'category', ${diningCategoryId},
          'USD', TRUE
        )
      `);
      const line = { id: lineId };

      // --- 3. A real sync: three monthly Netflix charges + one dining charge,
      //        plus an opening balance low enough that the emergency-fund-short
      //        cash rule (C4) fires once the dining spend lands. -------------
      await linkManual(h, {
        providerConnectionId: 'phase2wire-conn',
        displayName: 'Phase 2 Wiring Bank',
        accounts: [
          {
            providerAccountId: CHECKING,
            name: 'Phase 2 Wiring Checking',
            type: 'depository',
            currency: 'USD',
          },
        ],
        batch: {
          balances: [
            {
              providerAccountId: CHECKING,
              current: money(12_000n, 'USD'), // $120: emergency_fund_months < 3 once $60 is spent
              available: null,
              limit: null,
              asOf: systemClock.now(),
            },
          ],
          added: [
            ...netflixDates.map((date, index) =>
              manualTransaction({
                providerAccountId: CHECKING,
                providerTransactionId: `phase2wire-netflix-${String(index)}`,
                amount: money(-1_599n, 'USD'),
                postedDate: date,
                name: 'NETFLIX.COM',
                merchantName: 'Netflix',
              }),
            ),
            manualTransaction({
              providerAccountId: CHECKING,
              providerTransactionId: 'phase2wire-dining-1',
              amount: money(-6_000n, 'USD'), // $60
              postedDate: diningDate,
              name: 'SQ *CAFE DELUXE',
              merchantName: 'Cafe Deluxe',
            }),
          ],
        },
      });

      // --- 4. A real notification channel + rule, over the real egress guard.
      //
      // Created under a *permissive* policy (the operator's allow-list at the
      // moment the channel was configured) and verified with a fake adapter —
      // `verifyChannel`'s own network probe has nothing to dial in a test, and
      // a fake `{ ok: true }` is exactly what proves the *enable* path without
      // asserting anything about a real ntfy server. The deny-all refusal this
      // suite is actually about is proven separately, in step 7, against the
      // *real* `createNtfyChannel` adapter under the real default policy.
      const notificationsContext: NotificationsContext = {
        userId: h.userId,
        clock: systemClock,
        correlationId: newId(),
      };
      const permissivePolicy = createEgressPolicy({ allowedHosts: ['notify.example.com'] });
      const channel = await createChannel(
        h.database.db,
        notificationsContext,
        {
          displayName: 'phase2-wiring ntfy',
          config: {
            kind: 'ntfy',
            scheme: 'https',
            host: 'notify.example.com',
            port: 443,
            topic: 'phase2wiring',
            accessToken: null,
          },
        },
        { secretBox: h.security.requireSecretBox(), policy: permissivePolicy },
      );
      const verified = await verifyChannel(
        h.database.db,
        notificationsContext,
        { channelId: channel.id },
        {
          secretBox: h.security.requireSecretBox(),
          registry: { ntfy: createFakeChannel(), smtp: createFakeChannel() },
        },
      );
      expect(verified.ok).toBe(true);

      await createNotificationRule(h.database.db, notificationsContext, {
        channelId: channel.id,
        name: 'phase2-wiring: budget overspend',
        eventType: 'budgeting.BudgetThresholdCrossed',
        deliveryClass: 'PROMPT',
        timezone: 'UTC',
        quietHoursEnabled: false,
      });

      // --- 5. Grant the insights scopes the C4 rule needs -------------------
      // No consent route exists yet (wp2.6-insights.md §6's carried item), so
      // this suite grants directly, the same way it inserted a rule directly.
      await grantScopes(
        h.database.db,
        { userId: h.userId, clock: systemClock, correlationId: newId() },
        CASH_ADVISOR_ID,
        ['cash.summary', 'cashflow.monthly'],
      );

      // --- 6. Register the catalogue, and drain the real appModules() pump --
      // Exactly what `worker.ts` builds — not a hand-rolled consumer set —
      // per `categorization-wiring.test.ts`'s own pattern, extended to the
      // four Phase 2 modules.
      await registerBuiltinAdvisors(h.database.db, {
        userId: h.userId,
        clock: systemClock,
        correlationId: newId(),
      });

      const logger = pino({ level: 'silent' });
      const runtime = createDomainRuntime({
        database: h.database.db,
        clock: systemClock,
        logger,
        registry: createConnectorRegistry(),
        secretBox: h.security.requireSecretBox(),
      });
      const denyAllPolicy = createEgressPolicy({ allowedHosts: [] });
      const modules = appModules({
        database: h.database.db,
        userId: h.userId,
        orchestrator: runtime.orchestrator,
        timezone: 'UTC',
        clock: systemClock,
        notificationChannels: {
          ntfy: createNtfyChannel({ policy: denyAllPolicy }),
          smtp: createSmtpChannel({ policy: denyAllPolicy }),
        },
        secretBox: h.security.requireSecretBox(),
        investmentSyncPort: createInvestmentSyncPort(h.database.db),
        advisorTokenSecret: 'phase2-wiring-test-secret',
      });

      const wired = new Map(modules.map((module) => [module.flagKey, module] as const));
      for (const key of [
        'module.categorization',
        'module.budgeting',
        'module.recurring',
        'module.notifications',
      ] as const) {
        expect(wired.get(key)?.consumers?.length ?? 0).toBeGreaterThan(0);
      }
      // `module.insights`'s composition (`insightsModule` in modules.ts) is
      // conditional on `advisorTokenSecret` — proven here by supplying one
      // above and asserting the *full* registration (consumer, jobs and
      // schedule), not just the underlying service call this test drives
      // directly further down.
      const insightsRegistration = wired.get('module.insights');
      expect(insightsRegistration?.consumers?.length ?? 0).toBeGreaterThan(0);
      expect(insightsRegistration?.jobs?.length ?? 0).toBeGreaterThan(0);
      expect(insightsRegistration?.schedules).toBeDefined();

      const pump = createConsumerPump({
        pool: h.database.pool,
        db: platformExecutor(h.database.db),
        clock: systemClock,
        logger,
        consumers: [
          ...(wired.get('module.categorization')?.consumers ?? []),
          ...(wired.get('module.budgeting')?.consumers ?? []),
          ...(wired.get('module.recurring')?.consumers ?? []),
          ...(wired.get('module.notifications')?.consumers ?? []),
        ],
      });
      // Drained twice: the first pass reacts to `ledger.TransactionsUpserted`
      // before categorization has assigned anything, so budgeting's own first
      // recompute lands the dining charge in the uncategorised line; the
      // `categorization.AssignmentsChanged` event that same pass appends is
      // what re-dirties it into the real category on the second pass — the
      // same cross-context cascade `@ctx/budgeting`'s own "late-arriving
      // transaction" suite exercises, here driven by two real contexts rather
      // than a synthetic event.
      const firstDrain = await pump.drain();
      expect(firstDrain).toBeGreaterThan(0);
      await pump.drain();

      // === (a) module.budgeting: a real, non-zero actuals row ===============
      const actualsRows = await h.database.db.execute(sql`
        SELECT activity_minor FROM budget_line_actuals
        WHERE budget_line_id = ${line.id} AND user_id = ${h.userId}
      `);
      const actualsRow = (actualsRows as unknown as { rows: { activity_minor: string }[] }).rows[0];
      expect(actualsRow).toBeDefined();
      expect(BigInt(actualsRow?.activity_minor ?? '0')).toBe(-6_000n);

      // === (b) module.recurring: a candidate for the seed subscription ======
      const candidateRows = await h.database.db.execute(sql`
        SELECT id, state, proposed_cadence FROM recurring_candidates WHERE user_id = ${h.userId}
      `);
      const candidates = (candidateRows as unknown as { rows: { id: string; state: string }[] })
        .rows;
      expect(candidates.length).toBeGreaterThan(0);

      // === (c) module.notifications: outbox row, then a real egress refusal =
      const outboxRows = await h.database.db.execute(sql`
        SELECT id, dedupe_key FROM notification_outbox
        WHERE user_id = ${h.userId} AND rule_id IS NOT NULL
      `);
      const outbox = (outboxRows as unknown as { rows: { id: string; dedupe_key: string }[] }).rows;
      expect(outbox.length).toBeGreaterThan(0);
      expect(outbox[0]?.dedupe_key).toContain('budgeting.threshold');

      // The delivery job, called directly (`drainNotifications`'s own doc:
      // "a plain function so a test can call it without a job runner"), with
      // the *real* `createNtfyChannel` under the default deny-all policy —
      // exactly what `apps/api/src/domain.ts#createNotificationEgressPolicy`
      // produces when `NOTIFICATIONS_ALLOWED_HOSTS` is unset.
      const attempted = await drainNotifications(
        {
          database: h.database.db,
          registry: {
            ntfy: createNtfyChannel({ policy: denyAllPolicy }),
            smtp: createSmtpChannel({ policy: denyAllPolicy }),
          },
          secretBoxFor: () => h.security.requireSecretBox(),
          clock: systemClock,
        },
        h.userId,
        newId(),
      );
      expect(attempted).toBeGreaterThan(0);

      const attemptRows = await h.database.db.execute(sql`
        SELECT outcome, refusal_code FROM delivery_attempts WHERE user_id = ${h.userId}
      `);
      const attempts = (
        attemptRows as unknown as { rows: { outcome: string; refusal_code: string | null }[] }
      ).rows;
      expect(attempts.length).toBeGreaterThan(0);
      expect(
        attempts.some(
          (row) => row.outcome === 'refused' && row.refusal_code === 'host_not_allowed',
        ),
      ).toBe(true);

      // === (d) module.insights: a manually-triggered run produces a
      //         pending_review insight from a real wave-one built-in rule ===
      const registry = createBuiltinRegistry();
      const dependencies: InsightsDependencies = {
        registry,
        ports: {
          ledger: createInsightsLedgerPort(h.database.db, systemClock),
          budget: createInsightsBudgetPort(h.database.db),
          recurring: createInsightsRecurringPort(h.database.db),
          // WP 3.10a made `SnapshotPorts` five. The real ports, not fakes: this
          // suite has a real database, and a fake here would be a claim about a
          // fake. Both answer `null` for a holder with no portfolio, which is
          // this fixture, so no block is added and every assertion below is
          // unchanged.
          investments: createInsightsInvestmentsPort(h.database.db, systemClock),
          marketData: createInsightsMarketDataPort({ source: undefined }),
        },
        settings: {
          advisorsEnabled: true,
          moduleEnabled: true,
          timeZone: 'UTC',
          baseCurrency: 'USD',
          tokenSecret: 'phase2-wiring-test-secret',
        },
      };
      // `registerBuiltinAdvisors` above registered all fourteen; confirm the
      // one this suite drives is really wave one (on by default) rather than
      // asserting against a rule this suite happens to have picked.
      const entry = BUILTIN_CATALOGUE.find((candidate) => candidate.advisorId === CASH_ADVISOR_ID);
      expect(entry?.wave).toBe('cash_and_subscriptions');
      expect(entry?.defaultEnabled).toBe(true);

      const runResult = await runAdvisor(
        h.database.db,
        { userId: h.userId, clock: systemClock, correlationId: newId(), causationId: null },
        dependencies,
        { advisorId: CASH_ADVISOR_ID, trigger: 'manual' },
      );
      expect(runResult.status).toBe('completed');
      expect(runResult.refusal).toBeNull();
      expect(runResult.proposed).toBeGreaterThan(0);

      const insightRows = await h.database.db.execute(sql`
        SELECT status, type FROM insights
        WHERE user_id = ${h.userId} AND advisor_id = ${CASH_ADVISOR_ID}
      `);
      const insightRowList = (
        insightRows as unknown as { rows: { status: string; type: string }[] }
      ).rows;
      expect(insightRowList.length).toBeGreaterThan(0);
      expect(insightRowList.every((row) => row.status === 'pending_review')).toBe(true);
    }, 120_000);
  },
);
