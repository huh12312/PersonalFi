// SPDX-License-Identifier: MIT
/**
 * `MODULES` — every bounded context this application runs, and what each brings.
 *
 * One list, built the same way in the API and in the worker, so "which events
 * exist" and "which module is on" cannot differ between the two processes. A
 * module whose flag is off contributes no events, no consumers, no job handlers
 * and no schedules: it costs nothing at runtime and cannot half-fill a read
 * model nobody is reading (08 §6.9).
 *
 * What each module contributes, Phase 1 plus the Phase 2 wiring batch:
 *
 * | Module                  | Events | Consumers                          | Jobs                                          | Schedule            |
 * | ----------------------- | ------ | ----------------------------------- | ---------------------------------------------- | ------------------- |
 * | `module.ledger`         | 5      | —                                   | —                                              | —                   |
 * | `module.connections`    | 3      | —                                   | `connections.sync`, `…sync_all`               | nightly             |
 * | `module.categorization` | 3      | `categorization.assignments@v1`    | `categorization.retrain`                       | weekly (Sun 04:00)  |
 * | `module.budgeting`      | 5      | `budgeting.actuals@v1`             | —                                              | —                   |
 * | `module.recurring`      | 5      | `recurring.detection@v1`           | —                                              | —                   |
 * | `module.notifications`  | 3      | `notifications.render@v1`          | `notifications.deliver`, `notifications.digest` | weekly digest       |
 * | `module.insights`       | 7      | `insights.dispatch@v1`             | `insights.run`, `insights.run_all`             | nightly (04:15)     |
 *
 * The Ledger registers **no consumer**, deliberately. It is the writer: it
 * states facts and reacts to none. Categorization is the first module here that
 * *does* — it reacts to `ledger.TransactionsUpserted` /
 * `ledger.TransactionSupersededByPosted` and writes its own tables plus, for a
 * winning rule decision only, one column back in `@ctx/ledger` through the
 * `LedgerPort` `apps/api/src/domain.ts` implements (wp1.4 evidence §6).
 *
 * `module.budgeting`, `module.recurring`, `module.notifications` and
 * `module.insights` are the four contexts this wiring batch (02-phase-2-
 * dispatch.md §4) registers. All four still ship `defaultEnabled: false` in
 * `platform.ts`'s `MODULE_FLAGS` — see `docs/evidence/phase-2/wp2.w-wiring.md`
 * for which of the four `apps/api/test/db/phase2-wiring.test.ts` proved green
 * enough to flip, and why any that stayed off did.
 */
import {
  CATEGORIZATION_EVENTS,
  createCategorizationConsumer,
  registerRetrainSchedule,
  retrainJobHandler,
  type CategorizationDatabase,
} from '@ctx/categorization';
import {
  CONNECTIONS_EVENTS,
  listSyncableConnections,
  syncAllJob,
  type ConnectionsDatabase,
  type ConnectionsExecutor,
  type SyncOrchestrator,
} from '@ctx/connections';
import { BUDGETING_EVENTS, createBudgetingConsumer, type BudgetingDatabase } from '@ctx/budgeting';
import {
  createBuiltinRegistry,
  createInsightsConsumer,
  insightsJobs,
  registerAdvisor,
  registerNightlySchedule as registerInsightsNightlySchedule,
  BUILTIN_CATALOGUE,
  INSIGHTS_EVENTS,
  type InsightsDatabase,
  type InsightsDependencies,
} from '@ctx/insights';
import { LEDGER_EVENTS } from '@ctx/ledger';
import {
  NOTIFICATIONS_EVENTS,
  createDeliveryJob,
  createDigestJob,
  createNotificationsConsumer,
  registerNotificationSchedules,
  type ChannelRegistry,
  type NotificationsDatabase,
} from '@ctx/notifications';
import { RECURRING_EVENTS, createRecurringConsumer, type RecurringDatabase } from '@ctx/recurring';
import { systemClock, type Clock } from '@core/kernel';
import { platformExecutor } from '@core/platform';
import type { SecretBox } from '@core/secretbox';
import {
  createBudgetingLedgerPort,
  createCategorizationLedgerPort,
  createInsightsBudgetPort,
  createInsightsLedgerPort,
  createInsightsRecurringPort,
  createRecurringLedgerPort,
} from './domain.ts';
import type { ModuleRegistration } from './platform.ts';

export interface ModuleWiringOptions {
  /**
   * One pool-backed handle, shared across every context's own typed alias
   * (`ConnectionsDatabase`, `LedgerDatabase`, `CategorizationDatabase`,
   * `BudgetingDatabase`, `RecurringDatabase`, `NotificationsDatabase` and
   * `InsightsDatabase` are all `@core/db`'s `Database`) — every bounded
   * context lives in one Postgres instance (docs/CONVENTIONS.md's
   * table-ownership model), so this is one connection pool, not seven.
   */
  readonly database: ConnectionsDatabase &
    CategorizationDatabase &
    BudgetingDatabase &
    RecurringDatabase &
    NotificationsDatabase &
    InsightsDatabase;
  readonly orchestrator: SyncOrchestrator;
  /**
   * The account holder's display timezone.
   *
   * 03:15 **local**, per 08 §3.7 — never the container's `TZ`. A nightly sync
   * that fires at 03:15 UTC for a user in UTC-5 runs at 22:15 their time, which
   * is neither quiet hours nor the start of a banking day.
   */
  readonly timezone: string;
  /** Defaults to `systemClock`; a caller only overrides it in a test. */
  readonly clock?: Clock;
  /**
   * Built by `createNotificationChannels` in `domain.ts`. Required so
   * `module.notifications`'s delivery job has somewhere to send.
   */
  readonly notificationChannels: ChannelRegistry;
  /**
   * The delivery job opens a sealed channel config per attempt, and the
   * insights job needs no key at all today — carried for the day an advisor's
   * evidence needs to unseal something. Already derived in both `app.ts` and
   * `worker.ts` (`security.requireSecretBox()` / the worker's own unlock).
   */
  readonly secretBox: SecretBox;
  /**
   * `@ctx/insights`'s `InsightsSettings.tokenSecret` (wp2.6-insights.md §6,
   * open item 5) — `config.secrets.advisor_token_secret`, revealed. `undefined`
   * when the operator has not written the file: `module.insights` then
   * registers no consumer, no job and no schedule, exactly the way `domain.ts`
   * feature-detects an absent Plaid credential, rather than running with a
   * secret nobody chose. Rotating this value re-pseudonymises every merchant,
   * so there is deliberately no in-process fallback that would silently start
   * tokenising with one value and "rotate" the moment a real file appears.
   */
  readonly advisorTokenSecret?: string;
}

/**
 * Connections the nightly fan-out should touch: everything `listSyncableConnections`
 * returns, which already excludes `reauth_required` (no auto-retrying a
 * connection whose reconnect needs the user) and anything without an
 * `AUTH_REQUIRED`-less history — see that function's own doc comment.
 *
 * **History (re-gate N-7, closed by decision D-5).** This function used to
 * also filter out every `PROCESS_LOCAL_PROVIDERS` connection
 * (`apps/api/src/domain.ts`), because `ManualStore` and `CsvImportConnector`'s
 * `#staged` map were per-process, in-memory state: the **worker** — a
 * different process, with an empty store — polled a Manual or CSV connection
 * it had never staged, got `AUTH_REQUIRED` ("this manual connection has been
 * disconnected"), and `setConnectionStatus` wrote a permanent, false "Needs
 * reconnection" on every manual account and every CSV import after the first
 * nightly run. Observed on the real stack (gate-security-review.md §8.6).
 *
 * `connection_staged_facts` (migration `0008_connections_staging.sql`) closed
 * the actual gap: both connectors now read/write through a durable
 * `StagingStore` (`apps/api/src/domain.ts`'s `attachDurableStaging`), so a
 * process that never staged a connection's rows hydrates them from Postgres
 * before it needs them. The worker syncing a Manual or CSV connection it
 * never linked is therefore the same operation as any other scheduled sync,
 * and excluding it here would only make it staler, not safer — the opposite
 * of what this function is for. `apps/api/test/regate-worker-boot.test.ts`'s
 * "nightly fan-out (re-gate N-7)" describe block re-gates this: the fan-out
 * source no longer names `PROCESS_LOCAL_PROVIDERS`, and
 * `apps/api/test/db/closeout-staging.test.ts` proves a worker-run fan-out
 * actually completes a Manual sync end to end.
 */
async function syncableConnectionIds(
  executor: ConnectionsExecutor,
  userId: string,
): Promise<readonly string[]> {
  const rows = await listSyncableConnections(executor, userId);
  return rows.map((row) => row.id);
}

/**
 * Register WP 2.7's fourteen-rule catalogue's manifests for a user — the
 * "wherever the `advisors` rows are first written for a user" call site
 * `docs/evidence/phase-2/wp2.7-advisor-catalog.md` §8 names and does not own.
 *
 * `apps/api/src/app.ts` calls this from the same `onReady` hook that seeds the
 * category taxonomy (D2-1's pattern, not a new one): a pass every boot, so a
 * rule added in a later release reaches a user created before it, and
 * `registerAdvisor`'s `onConflictDoUpdate` never touches `enabled` on an
 * existing row — a restart cannot re-enable an advisor the user switched off.
 * Registering a manifest here is bookkeeping, not execution: nothing runs
 * until `module.insights` is on *and* the advisor's own `enabled` column is
 * true *and* the user has granted its scopes, so calling this unconditionally
 * (regardless of `module.insights`'s flag state) is exactly as inert as
 * `ensureTaxonomy` running while `module.categorization` happens to be off.
 */
export async function registerBuiltinAdvisors(
  database: InsightsDatabase,
  context: { readonly userId: string; readonly clock: Clock; readonly correlationId: string },
): Promise<void> {
  for (const entry of BUILTIN_CATALOGUE) {
    await registerAdvisor(
      database,
      { userId: context.userId, clock: context.clock, correlationId: context.correlationId },
      { manifest: entry.advisor.manifest, enabled: entry.defaultEnabled },
    );
  }
}

export function appModules(options: ModuleWiringOptions): readonly ModuleRegistration[] {
  const { database, orchestrator, clock = systemClock } = options;
  return [
    { flagKey: 'module.ledger', events: LEDGER_EVENTS },
    {
      flagKey: 'module.connections',
      events: CONNECTIONS_EVENTS,
      jobs: [
        orchestrator.jobHandler(),
        // A schedule enqueues one job; that job enqueues one per connection. The
        // alternative — a schedule row per connection — means the scheduler table
        // grows with the user's institutions and a newly linked bank does not
        // sync until something remembers to add a row.
        syncAllJob(orchestrator, syncableConnectionIds, database),
      ],
      schedules: async (userId: string): Promise<void> => {
        await orchestrator.registerNightlySchedule(database, {
          userId,
          timezone: options.timezone,
        });
      },
    },
    {
      flagKey: 'module.categorization',
      events: CATEGORIZATION_EVENTS,
      // Sync-triggered only, per WP 1.4 §5's decision order: `decide()` is a pure
      // function of current state, so a re-run is safe, and the consumer's own
      // `run_on_sync` filter (`loadRules`) is what keeps a rule that should only
      // apply retroactively from firing on every incoming page.
      consumers: [
        createCategorizationConsumer({
          database,
          port: createCategorizationLedgerPort(database, clock),
        }),
      ],
      // WP 2.5: weekly retrain, after the nightly sync has had time to land
      // (`RETRAIN_CRON`, Sunday 04:00 local). `retrainClassifier` never throws
      // for "nothing to train" — an untrained user gets `COLD_MODEL`, not a
      // failure — so a retry only fires for a genuine database problem.
      jobs: [retrainJobHandler(database)],
      schedules: async (userId: string): Promise<void> => {
        await registerRetrainSchedule(database, { userId, timezone: options.timezone }, clock);
      },
    },
    {
      flagKey: 'module.budgeting',
      events: BUDGETING_EVENTS,
      // No jobs and no schedules. A period is opened lazily by whoever first
      // needs it, and the roll is driven by the user or by the open-period
      // path — there is no nightly "close the month" job to get wrong in a
      // timezone (wp2.1-budgeting.md §10).
      consumers: [createBudgetingConsumer({ database, port: createBudgetingLedgerPort(database) })],
    },
    {
      flagKey: 'module.recurring',
      events: RECURRING_EVENTS,
      // Consumes ledger.TransactionsUpserted, ledger.TransactionSupersededByPosted
      // and categorization.AssignmentsChanged. Scoped to the payees the event
      // touched: a stream is every transaction with one merchant, so the unit
      // of work is a merchant and never a page of transactions
      // (wp2.3-recurring.md §6).
      consumers: [
        createRecurringConsumer({
          database,
          port: createRecurringLedgerPort(database),
          options: { timeZone: options.timezone },
        }),
      ],
    },
    {
      flagKey: 'module.notifications',
      events: NOTIFICATIONS_EVENTS,
      // Writes to the outbox and stops. Delivery is the job's business: the
      // pump's transaction must not be held open across a call to somebody
      // else's mail server (wp2.4-notifications.md §8).
      consumers: [createNotificationsConsumer({ database })],
      jobs: [
        createDeliveryJob({
          database,
          registry: options.notificationChannels,
          // Per-user; this deployment has one holder (D6).
          secretBoxFor: () => options.secretBox,
          clock,
        }),
        createDigestJob({ database, clock }),
      ],
      schedules: async (userId: string): Promise<void> => {
        await registerNotificationSchedules(
          platformExecutor(database),
          { userId, timezone: options.timezone },
          clock,
        );
      },
    },
    insightsModule(database, options, clock),
  ];
}

/**
 * `module.insights`, built separately from the array literal above because it
 * is the one registration that is conditional on more than its flag:
 * `advisorTokenSecret` absent means the operator has not opted in yet
 * (wp2.6-insights.md §6, open item 5 — the file secret has no config key of
 * its own reason repeated at length in `ModuleWiringOptions`), and this
 * function registers the flag with no consumer, no job and no schedule in
 * that case rather than running with a secret nobody chose — the same
 * feature-detection shape `domain.ts`'s `createConnectorRegistry` uses for an
 * absent Plaid credential.
 *
 * The registry is `createBuiltinRegistry()` — WP 2.7's fourteen-rule catalogue
 * — per `docs/evidence/phase-2/wp2.7-advisor-catalog.md` §8's exact
 * registration line, now that WP 2.7 is committed and the package typechecks
 * clean project-wide. (An earlier draft of this function used
 * `createAdvisorRegistry([])` per wp2.6-insights.md §6's "WP 2.7 supplies the
 * catalogue", written before WP 2.7 landed; superseded here.) Registering a
 * manifest is not the same as enabling it or granting it anything: every
 * advisor still needs its `advisors.enabled` column (kill switch 2, written
 * once from `BuiltinCatalogueEntry.defaultEnabled` by `registerBuiltinAdvisors`
 * below) and a `snapshot_grants` row per scope (nobody's, until a consent
 * route exists — WP 2.6 §6's carried item), so registering the full catalogue
 * here is inert until both of those are true for a user.
 */
function insightsModule(
  database: ModuleWiringOptions['database'],
  options: ModuleWiringOptions,
  clock: Clock,
): ModuleRegistration {
  if (options.advisorTokenSecret === undefined) {
    return { flagKey: 'module.insights', events: INSIGHTS_EVENTS };
  }

  const registry = createBuiltinRegistry();
  const dependencies: InsightsDependencies = {
    registry,
    ports: {
      ledger: createInsightsLedgerPort(database, clock),
      budget: createInsightsBudgetPort(database),
      recurring: createInsightsRecurringPort(database),
    },
    settings: {
      // Kill switch 1 (`ADVISORS_ENABLED`) has no config key yet — open item;
      // `module.insights` is the switch this batch actually wires. See the
      // note on `ModuleWiringOptions.advisorTokenSecret`.
      advisorsEnabled: true,
      moduleEnabled: true,
      timeZone: options.timezone,
      // No config key yet either (wp2.6-insights.md §6 open item 3); every
      // seed and every account in this deployment is USD today.
      baseCurrency: 'USD',
      tokenSecret: options.advisorTokenSecret,
    },
  };

  return {
    flagKey: 'module.insights',
    events: INSIGHTS_EVENTS,
    consumers: [createInsightsConsumer({ registry })],
    jobs: insightsJobs({ database, dependencies, clock }),
    schedules: async (userId: string): Promise<void> => {
      await registerInsightsNightlySchedule(
        database,
        { userId, timezone: options.timezone },
        clock,
      );
    },
  };
}
