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
 * | `module.investments`    | 5      | `investments.lots@v1`              | —                                              | —                   |
 * | `module.integrations`   | 2      | —                                   | `integrations.price_refresh`                   | daily (03:45)       |
 * | `module.planning`       | 1      | `planning.net_worth@v1`            | `planning.net_worth_snapshot`                  | daily (04:00)       |
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
import {
  PLANNING_EVENTS,
  SNAPSHOT_JOB_KIND,
  createNetWorthConsumer,
  netWorthSnapshotJobHandler,
  registerNetWorthSnapshotSchedule,
  type PlanningDatabase,
} from '@ctx/planning';
import {
  INVESTMENTS_EVENTS,
  createLotConsumer,
  drizzleLotStore,
  outboxOf as investmentsOutboxOf,
  type InvestmentsDatabase,
} from '@ctx/investments';
import {
  INTEGRATIONS_EVENTS,
  createPriceRefreshJob,
  type FredSource,
  type MarketDataRunRecorder,
  type MarketDataWriter,
  type PriceSource,
  type RefreshPlan,
} from '@ctx/integrations';
import { systemClock, type Clock } from '@core/kernel';
import { defineJob, platformExecutor, upsertSchedule } from '@core/platform';
import type { SecretBox } from '@core/secretbox';
import {
  createBudgetingLedgerPort,
  createCategorizationLedgerPort,
  createInsightsBudgetPort,
  createInsightsInvestmentsPort,
  createInsightsLedgerPort,
  createInsightsMarketDataPort,
  createInsightsRecurringPort,
  createRecurringLedgerPort,
  assertDrizzleTransaction,
  planningPortsFor,
  type MarketDataRuntime,
} from './domain.ts';
import type { InvestmentSyncPort } from '@ctx/investments';
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
    InsightsDatabase &
    InvestmentsDatabase &
    PlanningDatabase;
  readonly orchestrator: SyncOrchestrator;
  /**
   * The account holder these modules are being built for — the same id
   * `resolveModules(platform, userId, …)` is called with.
   *
   * Only `module.planning` reads it, and only because two of the four ports
   * `@ctx/planning` reads its world through (`PriceReader`, `FxReader`) take no
   * `userId` argument: they are `@ctx/investments`' readers, assigned straight
   * through with no adapter, and bind the holder at construction.
   * `SnapshotJobDependencies.portsFor` receives the job's transaction and
   * nothing else, so the id has to be closed over here.
   *
   * **This deployment has one holder (D6)** — the same assumption
   * `module.notifications`'s `secretBoxFor: () => options.secretBox` already
   * makes one screen up — and `planningModule` refuses **by name** if a job
   * ever arrives for a different user, so the assumption is checked rather
   * than merely documented. `docs/evidence/phase-3/wp3.w-wiring.md` §10 records
   * the clean fix, which is `@ctx/planning`'s to make: `portsFor` should take
   * `(executor, userId)`.
   */
  readonly userId: string;
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
  /**
   * `@ctx/investments`' `InvestmentSyncPort`, built by
   * `createInvestmentSyncPort(database)` in `domain.ts` — it reads
   * `@ctx/connections`' sync bookkeeping and `@ctx/ledger`'s accounts, neither
   * of which the lot engine may import.
   *
   * Required rather than optional: unlike a provider API key, there is no
   * deployment in which this is legitimately absent. Making it optional would
   * only create a way for a caller to half-register `module.investments`.
   */
  readonly investmentSyncPort: InvestmentSyncPort;
  /**
   * What `module.integrations` needs to actually fetch a price:
   * `createMarketDataRuntime(...)`'s sources (none when no key file is
   * present), the writer onto `@ctx/investments`' `prices`/`fx_rates`, and the
   * `market_data_runs` recorder. All three built in `domain.ts`.
   *
   * **Optional, and its absence is the feature-detection.** `undefined` means
   * the caller has no market-data wiring to give — the shape `app.ts` is in,
   * since only the worker runs jobs — and `module.integrations` then registers
   * its events and nothing else, exactly the way `insightsModule` handles an
   * absent `advisor_token_secret`. A *present* runtime with an empty `sources`
   * array is a different thing and registers normally: that is the zero-key
   * install, where the refresh runs and honestly finds nothing to ask.
   */
  readonly marketData?: MarketDataWiringOptions;
  /**
   * The currency `net_worth_daily.base_currency` is stated in. Defaults to
   * `USD`, and has no config key yet for the same reason `insightsModule`'s
   * `baseCurrency` does not (wp2.6-insights.md §6 open item 3): every seed and
   * every account in this deployment is USD today. It is a parameter rather
   * than a literal so the day that stops being true there is one place to
   * change and a test can drive a non-USD holder through the real wiring.
   */
  readonly baseCurrency?: string;
}

/** The three `module.integrations` collaborators `domain.ts` builds. */
export interface MarketDataWiringOptions {
  readonly runtime: MarketDataRuntime;
  readonly writer: MarketDataWriter;
  readonly recorder: MarketDataRunRecorder;
  /**
   * What to refresh. Supplied by the caller because `createPriceRefreshJob`
   * deliberately does not query holdings — it prices what it is handed.
   *
   * Returns an empty plan today: `holdings` is populated by WP 3.7's provider
   * legs (see `createInvestmentSyncPort`'s note in `domain.ts`), so there is
   * nothing to price yet and the honest plan is the empty one. The job still
   * runs, still records a `market_data_runs` row and still proves the schedule
   * fires — which is precisely what the Phase 3 gate's cold walk has to
   * observe, and what it could not observe if the schedule were withheld until
   * there were prices to fetch.
   */
  readonly planFor?: (userId: string, asOfDate: string) => Promise<RefreshPlan>;
}

/**
 * `integrations.price_refresh` — the job kind and the schedule name.
 *
 * One string for both, and it **must** match `SCHEDULE_NAME_PATTERN`
 * (`^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$`). That is not a style note: the Phase 2
 * cold boot found `@ctx/notifications` registering `notifications.deliver:<uuid>`,
 * every unit test green because the fake scheduler never applied the CHECK
 * constraint, and the real worker crash-looping from its first start
 * (wp2.w-wiring.md). `assertScheduleName` now makes that a unit-test failure,
 * and `apps/api/test/phase3-registration.test.ts` asserts this constant
 * against the pattern directly so the name cannot drift without a red test.
 */
export const PRICE_REFRESH_JOB_KIND = 'integrations.price_refresh';
export const PRICE_REFRESH_SCHEDULE_NAME = 'integrations.price_refresh';
/** 03:45 **local** (08 §3.7) — after the 03:15 nightly sync has had time to land. */
export const PRICE_REFRESH_CRON = '45 3 * * *';

/**
 * `planning.net_worth_snapshot` — WP 3.8's 04:00 job and schedule.
 *
 * Re-exported from `@ctx/planning` rather than restated, for the reason
 * `phase3-registration.test.ts` exists: the names that reach a CHECK constraint
 * must have exactly one definition. 04:00 **local** is after the 03:15 nightly
 * sync and the 03:45 price refresh, and comfortably past 08 §3.5's 02:00 seal
 * boundary, so the day this seals is a day whose balances and prices have
 * already landed.
 */
export {
  SNAPSHOT_CRON as NET_WORTH_SNAPSHOT_CRON,
  SNAPSHOT_JOB_KIND as NET_WORTH_SNAPSHOT_JOB_KIND,
  SNAPSHOT_SCHEDULE_NAME as NET_WORTH_SNAPSHOT_SCHEDULE_NAME,
  NET_WORTH_CONSUMER_NAME,
} from '@ctx/planning';

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
    {
      flagKey: 'module.investments',
      events: INVESTMENTS_EVENTS,
      // Consumes `connections.SyncRunCompleted`. Lots are rebuilt from the full
      // transaction history for each touched (account, security) pair and
      // written with `onConflictDoUpdate`, so a re-delivered run writes the
      // same rows and emits nothing (wp3.2-lots.md §6). No jobs and no
      // schedules: nothing here is time-driven.
      //
      // `storeFor`/`outboxFor` are **factories over the pump's transaction**,
      // not instances, and that is the whole reason the port takes them that
      // way: `ConsumerContext.tx` is the transaction the receipt and the offset
      // advance are written in, so building the store and the outbox from it
      // is what makes "a `LotsUpdated` never survives a rolled-back derivation"
      // structural rather than a habit. Same shape as `securityResolverFor` in
      // `domain.ts`.
      consumers: [
        createLotConsumer({
          // `drizzleLotStore` wants a full `Database`; the pump hands a bare
          // `Executor`. The cast is the same one `@core/platform`'s
          // `platformExecutor` and `@ctx/investments`' own `outboxOf` make at
          // this exact boundary (store.ts:55-61) — every query the store issues
          // goes through `execute`, which the transaction does provide.
          // `assertDrizzleTransaction` recovers the real Drizzle handle the
          // pump's transaction is carrying and fails by name if the pump was
          // built with an executor that narrowed it away — see
          // `drizzleTransactionalExecutor` in `domain.ts` for why that is a
          // composition-root decision and not a cast.
          storeFor: (context) => drizzleLotStore(assertDrizzleTransaction(context.tx), clock),
          outboxFor: (context) =>
            investmentsOutboxOf(assertDrizzleTransaction(context.tx) as InvestmentsDatabase),
          port: options.investmentSyncPort,
          clock,
        }),
      ],
    },
    integrationsModule(options, clock),
    planningModule(options, clock),
  ];
}

/**
 * `module.planning` — WP 3.8's net-worth snapshot.
 *
 * The first module in this list that registers **all three** of a consumer, a
 * job and a schedule, and the division of labour between them is the design:
 *
 *   * the **consumer** (`planning.net_worth@v1`) marks the open day `dirty`
 *     when a balance, a holding or a price lands, and does no arithmetic. One
 *     nightly sync produces one `ledger.BalanceRecorded` per account;
 *     recomputing inside each delivery would run the whole aggregate — every
 *     account, every holding, an FX lookup each — a dozen times in ninety
 *     seconds to produce a row only the last run's value survives in;
 *   * the **job** does that work once, at 04:00 local;
 *   * the **schedule** is what fires it.
 *
 * ## Two things this function is careful about
 *
 * **`executorFor` hands the consumer the pump's Drizzle transaction.**
 * `markDirty` is written against the query builder, and `ConsumerContext.tx` is
 * not a Drizzle handle unless the pump was built with
 * `drizzleTransactionalExecutor` — see `domain.ts` and wp3.w-wiring.md §4.
 * `assertDrizzleTransaction` fails **by name** if it was not, rather than as a
 * `db.select is not a function` recorded in `failed_error` where nobody looks.
 *
 * **The job is refused if it arrives for another holder.** `portsFor` receives
 * the job's transaction and no user id, so `planningPortsFor` closes over
 * `options.userId` (D6: one holder). That assumption is checked here rather
 * than trusted: a job whose `context.userId` differs would otherwise compute
 * one user's net worth from another user's prices, which is the class of bug
 * that is invisible in every test that has one user.
 */
function planningModule(options: ModuleWiringOptions, clock: Clock): ModuleRegistration {
  const database = options.database;
  const baseCurrency = options.baseCurrency ?? 'USD';
  const snapshot = netWorthSnapshotJobHandler({
    database,
    portsFor: (executor) =>
      planningPortsFor(executor, {
        userId: options.userId,
        timeZone: options.timezone,
        clock,
      }),
    timeZone: options.timezone,
    baseCurrency,
  });

  return {
    flagKey: 'module.planning',
    events: PLANNING_EVENTS,
    consumers: [
      createNetWorthConsumer({
        database,
        options: { timeZone: options.timezone },
        executorFor: (context) => assertDrizzleTransaction(context.tx),
      }),
    ],
    jobs: [
      {
        ...snapshot,
        handler: async (payload, context) => {
          if (context.userId !== options.userId) {
            throw new Error(
              `${SNAPSHOT_JOB_KIND} was enqueued for a user these modules were not built for ` +
                "(apps/api/src/modules.ts binds @ctx/planning's price and FX readers to one " +
                'holder — D6). Rebuild appModules() for that user, or give ' +
                "SnapshotJobDependencies.portsFor the job's own userId " +
                '(docs/evidence/phase-3/wp3.w-wiring.md §10).',
            );
          }
          await snapshot.handler(payload, context);
        },
      },
    ],
    schedules: async (userId: string): Promise<void> => {
      await registerNetWorthSnapshotSchedule(
        database,
        { userId, timezone: options.timezone },
        clock,
      );
    },
  };
}

/**
 * `module.integrations` — the 03:45 price refresh, its job handler and its
 * schedule row.
 *
 * Built separately from the array literal for the same reason `insightsModule`
 * is: it is conditional on more than its flag. `options.marketData` absent
 * means the caller has no market-data wiring to give — `app.ts` is in exactly
 * that position, because it runs no jobs — and this then registers the two
 * events and nothing else. Registering a *handler* in a process with no job
 * runner would be harmless; registering a *schedule* would not, because
 * `scheduler.tick` enqueues any due row and a job with no registered handler
 * is a row that retries five times and dies.
 *
 * ## Two things this function is careful about
 *
 * **The job is constructed inside the handler, not here.**
 * `createPriceRefreshJob` takes `userId`, `outbox` and `correlationId`, all of
 * which are per-invocation; building it once at wiring time would pin one
 * user's id and one correlation id into every future run.
 *
 * **The outbox is the job's own transaction.** `PricesUpdated` and
 * `PriceSourceUnavailable` are appended in it, so a refresh whose write fails
 * does not leave behind an event claiming prices moved.
 */
function integrationsModule(options: ModuleWiringOptions, clock: Clock): ModuleRegistration {
  const marketData = options.marketData;
  if (marketData === undefined) {
    return { flagKey: 'module.integrations', events: INTEGRATIONS_EVENTS };
  }

  const database = options.database;
  const planFor =
    marketData.planFor ??
    // The honest empty plan. WP 3.7's real planner will read the user's
    // holdings and route each one's `securities.type` through
    // `@ctx/integrations`' `PROVIDER_FOR_KIND` to the source that prices it;
    // until those holdings exist there is nothing to plan, and an invented
    // subject would be a request to a provider on behalf of a position nobody
    // holds.
    (async (_userId: string, asOfDate: string): Promise<RefreshPlan> => ({
      asOfDate,
      securities: [],
      fxPairs: [],
    }));

  return {
    flagKey: 'module.integrations',
    events: INTEGRATIONS_EVENTS,
    // No consumer. `@ctx/integrations` reacts to nothing: it is driven by the
    // clock and by an explicit refresh, and it may not read another context's
    // events any more than it may read their tables (08 §1.3 #11).
    jobs: [
      defineJob(PRICE_REFRESH_JOB_KIND, async (_payload, context) => {
        const asOfDate = clock.now().toISOString().slice(0, 10);
        const plan = await planFor(context.userId, asOfDate);
        // One transaction for the whole refresh: the rows and the events that
        // announce them commit together or not at all.
        await database.transaction(async (tx) => {
          const job = createPriceRefreshJob({
            userId: context.userId,
            sources: marketData.runtime.sources,
            writer: marketData.writer,
            recorder: marketData.recorder,
            outbox: { execute: (query) => tx.execute(query) as never },
            correlationId: context.correlationId,
            clock,
            keys: marketData.runtime.keys,
          });
          const result = await job.run(plan);
          context.logger.info(
            {
              asOfDate: result.asOfDate,
              priceRowsWritten: result.priceRowsWritten,
              fxRowsWritten: result.fxRowsWritten,
              securitiesPriced: result.securitiesPriced.length,
              securitiesUnpriced: result.securitiesUnpriced.length,
              unavailable: result.unavailable.map((entry) => entry.reason),
              sources: marketData.runtime.sources.map((source) => source.provider),
            },
            'price refresh complete',
          );
        });
      }),
    ],
    schedules: async (userId: string): Promise<void> => {
      await upsertSchedule(
        platformExecutor(database),
        {
          userId,
          name: PRICE_REFRESH_SCHEDULE_NAME,
          cron: PRICE_REFRESH_CRON,
          timezone: options.timezone,
          jobKind: PRICE_REFRESH_JOB_KIND,
          jobPayload: {},
          enabled: true,
          // Fifteen minutes, so this install does not dial four providers at
          // exactly 03:45:00 the way every other install would.
          jitterSeconds: 900,
        },
        clock,
      );
    },
  };
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
/**
 * The one source in a market-data runtime that can answer `macro()`.
 *
 * A structural check (`capabilities.macro` plus the method) rather than
 * `provider === 'fred'`, so a second macro source added later is found by this
 * function rather than by whoever remembers to edit it. `undefined` when the
 * runtime is absent or holds no macro source, which is the no-key install.
 */
function fredSourceOf(sources: readonly PriceSource[] | undefined): FredSource | undefined {
  return sources?.find(
    (source): source is FredSource =>
      source.capabilities.macro && typeof (source as FredSource).macro === 'function',
  );
}

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
      // WP 3.10a. `holdings.aggregate`, `holdings.detail` and
      // `liabilities.terms` need only a database handle and read the same
      // readers WP 3.9's routes do.
      investments: createInsightsInvestmentsPort(database, clock),
      // `market.rates` needs a *source*, and there is only one in the
      // deployment: `createMarketDataRuntime(...)`'s FRED adapter, which
      // exists only when a key file does. `undefined` here is the same
      // feature-detection `integrationsModule` above performs, one level in —
      // and it is why an on-demand run in the API process (`app.ts` supplies no
      // market-data wiring, because it runs no jobs) emits no `market_rates`
      // block while the nightly run in the worker does. Recorded rather than
      // hidden: see `wp3.10a-snapshot-readers.md` §6.
      marketData: createInsightsMarketDataPort({
        source: fredSourceOf(options.marketData?.runtime.sources),
      }),
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
