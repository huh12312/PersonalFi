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
 * | `module.insights`       | 9      | `insights.dispatch@v1`             | `insights.run`, `insights.run_all`, `insights.run_local`, `insights.brief` | nightly (04:15), weekly Brief (Sun 06:00) |
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
import { type LocalModelTransport } from '@advisor/local-model';
import type { LocalModelPin } from '@core/config';
import { createNarratorWiring, type NarratorRuntime } from './narrator-wiring.ts';
import {
  CATEGORIZATION_EVENTS,
  createCategorizationConsumer,
  registerRetrainSchedule,
  retrainJobHandler,
  type CategorizationDatabase,
} from '@ctx/categorization';
import {
  CONNECTIONS_EVENTS,
  createProviderCredentialsConsumer,
  isLanguageModelKeyProvider,
  listSyncableConnections,
  syncAllJob,
  type ConnectionsDatabase,
  type ConnectorRegistry,
  type ConnectionsExecutor,
  type SyncOrchestrator,
} from '@ctx/connections';
import { BUDGETING_EVENTS, createBudgetingConsumer, type BudgetingDatabase } from '@ctx/budgeting';
import {
  createBriefJob,
  createHealthSnapshotJob,
  createBuiltinRegistry,
  createInsightsConsumer,
  createNarratorAdvisor,
  createNarratorSettingsConsumer,
  createRunLocalJob,
  createRunSwitches,
  evaluateDueOutcomes,
  insightsJobs,
  registerHealthSnapshotSchedule,
  registerWeeklyBriefSchedule,
  type Advisor,
  type AdvisorKind,
  type NarratorModelPort,
  type PromptRenderer,
  registerAdvisor,
  registerNightlySchedule as registerInsightsNightlySchedule,
  BUILTIN_CATALOGUE,
  INSIGHTS_EVENTS,
  NARRATOR_MANIFEST,
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
  createGoalPaceConsumer,
  createNetWorthConsumer,
  goalEvaluationStoreOf,
  netWorthSnapshotJobHandler,
  projectionRefreshJobHandler,
  registerNetWorthSnapshotSchedule,
  registerProjectionRefreshSchedule,
  type MonteCarloRunner,
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
  type FredSource,
  type MarketDataRunRecorder,
  type MarketDataWriter,
  type PriceSource,
} from '@ctx/integrations';
import { newId, systemClock, todayIn, type Clock } from '@core/kernel';
import {
  createPriceRefreshPlanner,
  runPriceRefresh,
  type PriceRefreshPlanner,
} from './price-refresh.ts';
import {
  PLATFORM_FLAGS,
  createFlagService,
  defineJob,
  platformExecutor,
  upsertSchedule,
} from '@core/platform';
import type { SecretBox } from '@core/secretbox';
import {
  createBudgetingLedgerPort,
  createCategorizationLedgerPort,
  createInsightsBudgetPort,
  createInsightsInvestmentsPort,
  createInsightsPlanningPort,
  createInsightsLedgerPort,
  createInsightsMarketDataPort,
  createInsightsRecurringPort,
  createInsightsRetirementImpactPort,
  createRecurringLedgerPort,
  assertDrizzleTransaction,
  planningPortsFor,
  planningRevealedPortsFor,
  type MarketDataRuntime,
} from './domain.ts';
import type { InvestmentSyncPort } from '@ctx/investments';
import { ADVISOR_KIND_FLAGS, MODULE_FLAGS, type ModuleRegistration } from './platform.ts';
import { createLivingExpensesPort } from './reports/living-expenses.ts';

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
   * WP 5.1 kill level 1, the operator half: `config.env.ADVISORS_ENABLED`.
   * Static per process — a change is a restart. Read through the
   * `RunSwitches` port `insightsModule` builds (W-A wiring), never a literal.
   */
  readonly advisorsEnabled: boolean;
  /**
   * WP 5.1 kill level 2, the operator half: `config.localModel !== undefined`
   * (an endpoint, a name and a digest all set). A kind nothing is configured
   * to serve is off whatever its `advisors.kind.local_model` flag says.
   */
  readonly localModelConfigured: boolean;
  /**
   * WP 5.2's adapter bound to `@ctx/insights`' `PromptRenderer` port: the
   * exact prompt bytes for the preview gate and the run inspector, invoking
   * nothing. Absent in the api process (it never runs a local model —
   * `POST /advisors/run` queues one) and in a worker with no local model.
   */
  readonly promptRenderer?: PromptRenderer;
  /**
   * WP 5.3's narrator, bound to WP 5.2's adapter (W-C wiring;
   * 05-phase-5-dispatch.md §4 W-C). `createLocalModelAdapter(...)`'s own
   * `run(request, signal)` already satisfies this port structurally — see
   * `worker.ts`, which passes the same object it built `promptRenderer` from.
   *
   * `local.narrator` is registered in `insightsModule` **only when** this and
   * `localModelConfigured` are both present: a model bound with nothing
   * pointed at it (`localModelConfigured: false`, the default — kill level 2
   * is off by default) must never advertise an advisor nobody can run, and a
   * `narratorModel` with `localModelConfigured: false` would be exactly that
   * — the two are read together, not either alone. The api process supplies
   * neither: it never runs a local model (`POST /advisors/run` queues one).
   */
  readonly narratorModel?: NarratorModelPort;
  /**
   * WP 10.6 (D30): the holder's own narrator — the local model, a hosted
   * provider with their key, or Off — resolved per run by
   * `narrator-wiring.ts`'s `createNarratorRuntime` (30 s cache, dropped by the
   * `insights.NarratorSettingsChanged` and `connections.ProviderCredentialsChanged`
   * consumers below). When present it decides, per holder, whether
   * `local.narrator` is registered for a run, which model it calls and which
   * renderer keys the approval (`InsightsDependencies.narratorFor`), kill
   * level 2's configured half, and whether a Brief enqueues narrations. Absent:
   * `localModelConfigured` / `promptRenderer` / `narratorModel` decide, as
   * before. The worker supplies it; the api does not run advisors.
   */
  readonly narratorRuntime?: Pick<NarratorRuntime, 'forUser' | 'invalidate'>;
  /**
   * The account holder these modules are being built for — the same id
   * `resolveModules(platform, userId, …)` is called with.
   *
   * `module.planning`'s own jobs no longer need it closed over: WP 4.6 changed
   * `SnapshotJobDependencies.portsFor` (and `ProjectionRefreshJobDependencies
   * .portsFor`) to `(executor, userId) => …`, so `planningModule` below builds
   * `@ctx/planning`'s ports from **the job's own `context.userId`** on every
   * run — `docs/evidence/phase-3/wp3.w-wiring.md` §10's clean fix, made by
   * `@ctx/planning` itself in `docs/evidence/phase-4/wp4.6-projection-service.md`
   * §10.1. This field is kept because every other module still takes it (the
   * flag-resolution call site, `orchestrator.registerNightlySchedule`, …), and
   * because **this deployment still has one holder (D6)** — the same
   * assumption `module.notifications`'s `secretBoxFor: () => options.secretBox`
   * makes one screen up — but that is now a deployment fact this process is
   * only ever asked to serve, not a structural refusal `planningModule` has to
   * enforce: a job or a schedule call for a second holder is served correctly,
   * from that holder's own ports, which is exactly what
   * `apps/api/test/db/phase4-wiring.test.ts`'s "a second holder's refresh job
   * is served, not refused by name" drives against a real pump.
   */
  readonly userId: string;
  /**
   * WP 10.1. The worker's connector registry, so `module.connections` can register
   * the consumer that drops its cached Plaid client when a holder changes their
   * stored provider credentials (`connections.ProviderCredentialsChanged`). Absent
   * in a caller with no registry to invalidate; the cache's own short TTL then
   * bounds the staleness.
   */
  readonly connectorRegistry?: ConnectorRegistry;
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
  /**
   * WP 4.5's Monte Carlo, bound to WP 4.5's worker host and a loaded return
   * series (`domain.ts`'s `createMonteCarloRunner` /
   * `createMonteCarloRunnerFromCache`). `undefined` and `null` are the same
   * thing to `planningModule`: the nightly `planning.projection_refresh` job
   * runs the deterministic baseline and the run records `method:
   * 'deterministic'` — **never** a silent substitution of the lognormal
   * engine for an unavailable Monte Carlo one
   * (docs/evidence/phase-4/wp4.6-projection-service.md §10.2;
   * wp4.5-montecarlo.md §10 item 4). Only the worker process constructs a
   * non-null value today (`app.ts` runs no jobs, so it has nothing to refresh
   * with one); see this WP's evidence, "For the orchestrator", for the exact
   * line `worker.ts` needs.
   */
  readonly monteCarlo?: MonteCarloRunner | null;
}

/** The three `module.integrations` collaborators `domain.ts` builds. */
export interface MarketDataWiringOptions {
  readonly runtime: MarketDataRuntime;
  readonly writer: MarketDataWriter;
  readonly recorder: MarketDataRunRecorder;
  /**
   * What to refresh. `createPriceRefreshJob` deliberately does not query
   * holdings — it prices what it is handed — so the plan is built here, in the
   * composition root.
   *
   * WP 10.5: absent means **the real planner** (`createPriceRefreshPlanner`,
   * `price-refresh.ts`: every security with a non-zero position, routed through
   * `PROVIDER_FOR_KIND`), not an empty plan. Before WP 10.5 the default was
   * "the honest empty plan" and nothing ever supplied this, so the nightly
   * refresh priced nothing on any install (WP 10.4 §0, defect (f)). A caller
   * passes one only to substitute a plan in a test.
   */
  readonly planFor?: PriceRefreshPlanner;
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
 * `planning.projection_refresh` — WP 4.6's 04:30 job and schedule, and WP 4.6's
 * `planning.goal_pace@v1` consumer name. Re-exported rather than restated for
 * the same one-definition reason as the net-worth constants just above.
 */
export {
  PROJECTION_REFRESH_CRON,
  PROJECTION_REFRESH_JOB_KIND,
  PROJECTION_REFRESH_SCHEDULE_NAME,
  GOAL_PACE_CONSUMER_NAME,
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
      // WP 10.1 + WP 10.4: one consumer drops every cache built from stored
      // provider credentials — the connector registry's (Plaid) and the
      // market-data runtime's (tiingo / fred / coingecko / openfigi) — so a
      // key changed in the product reaches this process without a restart.
      // WP 10.6: and the narrator runtime's, for a language-model key.
      consumers:
        options.connectorRegistry === undefined &&
        options.marketData === undefined &&
        options.narratorRuntime === undefined
          ? []
          : [
              createProviderCredentialsConsumer({
                onChanged: (provider) => {
                  options.connectorRegistry?.invalidate(provider);
                  if (provider !== 'plaid') options.marketData?.runtime.invalidate();
                  if (isLanguageModelKeyProvider(provider)) options.narratorRuntime?.invalidate();
                },
              }),
            ],
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
 * `module.planning` — WP 3.8's net-worth snapshot and WP 4.6's baseline
 * projection refresh.
 *
 * Two jobs, each with the same three-part division of labour: a consumer that
 * marks something dirty (or, for the second, claims a run) and does no
 * arithmetic, a job that does the work once overnight, and a schedule that
 * fires it.
 *
 *   * `planning.net_worth@v1` (WP 3.8) marks the open day `dirty` when a
 *     balance, a holding or a price lands; `planning.net_worth_snapshot`
 *     seals it at 04:00 local.
 *   * `planning.goal_pace@v1` (WP 4.6) claims a **baseline** run's
 *     `planning.ProjectionCompleted` and evaluates goal pace exactly once per
 *     evaluation; `planning.projection_refresh` recomputes (or re-serves from
 *     cache) the baseline at 04:30 local, after the snapshot has sealed the
 *     day it starts from.
 *
 * ## Two things this function is careful about
 *
 * **`executorFor`/`storeFor`/`outboxFor` hand each consumer the pump's Drizzle
 * transaction.** `markDirty` and the goal-pace claim are both written against
 * the query builder, and `ConsumerContext.tx` is not a Drizzle handle unless
 * the pump was built with `drizzleTransactionalExecutor` — see `domain.ts` and
 * wp3.w-wiring.md §4. `assertDrizzleTransaction` fails **by name** if it was
 * not, rather than as a `db.select is not a function` recorded in
 * `failed_error` where nobody looks.
 *
 * **Neither job binds one holder any more.** Through WP 3.8, `portsFor`
 * received the job's transaction and no user id, so this function closed over
 * `options.userId` and refused, by name, a job whose `context.userId` differed
 * (D6: one holder, checked rather than merely documented). WP 4.6 changed
 * `SnapshotJobDependencies.portsFor` and added
 * `ProjectionRefreshJobDependencies.portsFor` as `(executor, userId) => …`
 * (docs/evidence/phase-4/wp4.6-projection-service.md §10.1), so both jobs below
 * build `@ctx/planning`'s ports from **the job's own `context.userId`** —
 * `netWorthSnapshotJobHandler` and `projectionRefreshJobHandler` do the
 * threading internally, and there is no wrapper left here to refuse anything.
 * `apps/api/test/db/phase4-wiring.test.ts` drives a second holder's refresh
 * job and asserts it is served, not refused.
 */
function planningModule(options: ModuleWiringOptions, clock: Clock): ModuleRegistration {
  const database = options.database;
  const baseCurrency = options.baseCurrency ?? 'USD';
  // Built once per holder id, for the two jobs below — `planningPortsFor` and
  // `planningRevealedPortsFor` both take `(executor, { userId, timeZone, clock })`.
  const portOptions = (userId: string): { userId: string; timeZone: string; clock: Clock } => ({
    userId,
    timeZone: options.timezone,
    clock,
  });
  const snapshot = netWorthSnapshotJobHandler({
    database,
    portsFor: (executor, userId) => planningPortsFor(executor, portOptions(userId)),
    timeZone: options.timezone,
    baseCurrency,
  });
  const refresh = projectionRefreshJobHandler({
    database,
    portsFor: (executor, userId) => planningRevealedPortsFor(executor, portOptions(userId)),
    // `null` until WP 4.5's worker host is bound (see `ModuleWiringOptions
    // .monteCarlo`'s own doc): the nightly baseline then runs deterministic
    // and the run records that it did.
    monteCarlo: options.monteCarlo ?? null,
    timeZone: options.timezone,
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
      // `planning.goal_pace@v1` on `planning.ProjectionCompleted`. The claim,
      // every read and every `GoalOffTrack` land in the pump's own
      // transaction — the WP 3.2 "re-delivery re-announced" lesson, closed in
      // the row rather than in a receipt (wp4.6-projection-service.md §4).
      createGoalPaceConsumer({
        storeFor: (context) =>
          goalEvaluationStoreOf(assertDrizzleTransaction(context.tx), context.clock),
        outboxFor: (context) => context.tx,
      }),
    ],
    // planning.net_worth_snapshot (04:00), planning.projection_refresh
    // (04:30) — both concurrency 1 (declared by each job in `@ctx/planning`'s
    // own `jobs.ts`, preserved here because nothing wraps them any more).
    jobs: [snapshot, refresh],
    schedules: async (userId: string): Promise<void> => {
      await registerNetWorthSnapshotSchedule(
        database,
        { userId, timezone: options.timezone },
        clock,
      );
      await registerProjectionRefreshSchedule(
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
  // WP 10.5: the real planner — the holder's current positions, through
  // `@ctx/investments`' read model, each routed by `securities.type` through
  // `PROVIDER_FOR_KIND`. The same function `POST /market-data/refresh` uses.
  const planFor =
    marketData.planFor ??
    createPriceRefreshPlanner(database, { baseCurrency: options.baseCurrency ?? 'USD' });

  return {
    flagKey: 'module.integrations',
    events: INTEGRATIONS_EVENTS,
    // No consumer. `@ctx/integrations` reacts to nothing: it is driven by the
    // clock and by an explicit refresh, and it may not read another context's
    // events any more than it may read their tables (08 §1.3 #11).
    jobs: [
      defineJob(PRICE_REFRESH_JOB_KIND, async (_payload, context) => {
        // The holder's own calendar day (CONVENTIONS "Time": every "today" is
        // computed in the user's zone). The Tiingo adapter looks back a week
        // from it for the latest close, so 03:45 — before that day's close
        // exists — still prices from the previous session (WP 10.5).
        const asOfDate = todayIn(clock, options.timezone);
        // WP 10.4: this holder's view — the files, or their stored keys where
        // the files are empty — resolved per run, so a key saved in Settings
        // is used by the next refresh without a restart.
        const view = await marketData.runtime.forUser(context.userId);
        // One transaction for the whole refresh: the rows and the events that
        // announce them commit together or not at all (`runPriceRefresh`).
        const { plan, result } = await runPriceRefresh({
          database,
          clock,
          userId: context.userId,
          correlationId: context.correlationId,
          asOfDate,
          planFor,
          view,
          writer: marketData.writer,
          recorder: marketData.recorder,
        });
        context.logger.info(
          {
            asOfDate: result.asOfDate,
            held: plan.held.length,
            planned: plan.securities.length,
            unplannable: plan.unplannable.map((entry) => entry.reason),
            notPricedByProvider: plan.notPricedByProvider.length,
            fxPairs: plan.fxPairs.length,
            priceRowsWritten: result.priceRowsWritten,
            fxRowsWritten: result.fxRowsWritten,
            securitiesPriced: result.securitiesPriced.length,
            securitiesUnpriced: result.securitiesUnpriced.length,
            unpricedReasons: result.unpriced.map((entry) => entry.reason),
            unavailable: result.unavailable.map((entry) => entry.reason),
            sources: view.sources.map((source) => source.provider),
          },
          'price refresh complete',
        );
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

/**
 * WP 5.1 (W-A wiring): levels 1 and 2 of the kill ladder as a port. The run
 * watcher reads these once a second while a run is in flight and the write
 * barrier reads them again before the insert, so the flag reader here is
 * deliberately UNCACHED (`ttlMs: 0`) — the shared `FlagService`'s 30 s
 * backstop cache would make a flipped `module.insights` take up to 30 s to
 * stop a run, and 05 §3 WP 5.1's exit is "within two seconds".
 *
 * Exported — not merely called inline — so that claim has a **behavioural**
 * test rather than only an inspection of this file: `wave-a-wiring.md` §4
 * named "the composition root's cache setting is proved only by inspection
 * until W-C lands", and `apps/api/test/db/phase5-wiring.test.ts` calls this
 * exact function to build the switches its kill-ladder cases run against, so
 * a sabotage of `ttlMs: 0` here is a sabotage of what that test exercises,
 * not of a second, parallel construction that could quietly drift from it.
 */
export function insightsRunSwitches(
  database: ModuleWiringOptions['database'],
  options: Pick<
    ModuleWiringOptions,
    'advisorsEnabled' | 'localModelConfigured' | 'narratorRuntime'
  >,
) {
  const runtime = options.narratorRuntime;
  return createRunSwitches({
    advisorsEnabled: options.advisorsEnabled,
    flags: createFlagService({
      db: platformExecutor(database),
      defaults: [...PLATFORM_FLAGS, ...MODULE_FLAGS, ...ADVISOR_KIND_FLAGS],
      ttlMs: 0,
    }),
    configuredKinds: new Set<AdvisorKind>(
      options.localModelConfigured ? ['builtin', 'local_model'] : ['builtin'],
    ),
    // WP 10.6 (D30): per holder — their chosen provider with a key and a
    // consent, or the local model, configures `local_model`; Off does not.
    ...(runtime === undefined
      ? {}
      : {
          configuredKindsFor: async (userId: string) =>
            new Set<AdvisorKind>(
              (await runtime.forUser(userId)) === null ? ['builtin'] : ['builtin', 'local_model'],
            ),
        }),
  });
}

/**
 * What the api binds when a model is configured (WP 9.6, CF-1, R-4): the
 * pure, preview-only `PromptRenderer` and `local.narrator`'s manifest — never
 * its executor. Preview and "Approve this payload" are api routes; without
 * these an install cannot approve the narrator's payload, so the worker's run
 * is refused `payload_not_approved` forever (Phase 5 gate G5-2).
 */
export interface PreviewModel {
  /** Pure by contract (`ports.ts`): renders prompt bytes, invokes nothing. */
  readonly promptRenderer: PromptRenderer;
  /**
   * `local.narrator` as a manifest and a `run` that rejects. The registry the
   * preview routes build is for showing and approving payload shapes; nothing
   * on the api ever calls `run`, and there is no model behind it to call.
   */
  readonly narrator: Advisor;
}

/**
 * The api holds no model endpoint — it is given a name and a digest
 * (`LOCAL_MODEL_PIN_*`), which is enough to render and to approve and nothing
 * that could be dialled. The adapter below is built over this transport, so
 * even a code path that reached `run` would refuse rather than connect; the
 * adapter is not retained, only its pure renderer is.
 */
const NO_ENDPOINT_TRANSPORT: LocalModelTransport = Object.freeze({
  request: () =>
    Promise.reject(
      new Error('the api process holds no model endpoint: it renders and previews, it never calls'),
    ),
});

/**
 * `undefined` unless a model is configured (`config.localModelPin`). Built
 * through `createNarratorWiring` — the same constructor the worker's adapter
 * comes from — so the template hash in the shape an approval is keyed to is the
 * hash the worker's run computes.
 */
export function createPreviewModel(pin: LocalModelPin | undefined): PreviewModel | undefined {
  if (pin === undefined) return undefined;
  // Through `createNarratorWiring` — the constructor the worker's own adapter
  // comes from (WP 9.5) — so everything that goes into the template hash (the
  // prompt, the reply format, the sampling options) is one definition and
  // cannot differ between the process that approves a payload and the process
  // that runs it. `endpoint` is never read: a transport is injected, so no
  // endpoint policy is built and nothing resolves a name.
  const wiring = createNarratorWiring(
    { endpoint: '', name: pin.name, digest: pin.digest, timeoutMs: 1_000, allowRemote: false },
    { transport: NO_ENDPOINT_TRANSPORT },
  );
  if (wiring === undefined) return undefined;
  const adapter = wiring.localModel;
  return Object.freeze({
    promptRenderer: adapter.promptRenderer,
    narrator: Object.freeze({
      manifest: NARRATOR_MANIFEST,
      run: () =>
        Promise.reject(
          new Error(
            'the api process never executes an advisor: local.narrator is registered here as a manifest only',
          ),
        ),
    }),
  });
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
  // WP 5.3 / W-C: `local.narrator` is registered in this registry **only**
  // when both halves of kill level 2's operator side are present — a model
  // endpoint bound (`localModelConfigured`) *and* a port to call it through
  // (`narratorModel`, W-C's own binding in `worker.ts`). The api process
  // supplies neither, so it never advertises an advisor it cannot run and
  // `POST /advisors/run` for `local.narrator` there refuses the same way any
  // other unregistered advisor id does.
  const narratorConfigured = options.localModelConfigured && options.narratorModel !== undefined;
  if (narratorConfigured && options.narratorModel !== undefined) {
    registry.assertRegistered(createNarratorAdvisor({ model: options.narratorModel }));
  }
  const switches = insightsRunSwitches(database, options);
  const dependencies: InsightsDependencies = {
    registry,
    switches,
    ...(options.promptRenderer === undefined ? {} : { promptRenderer: options.promptRenderer }),
    // WP 10.6: the holder's own narrator, per run (`@ctx/insights`' `holder.ts`).
    ...(options.narratorRuntime === undefined
      ? {}
      : { narratorFor: options.narratorRuntime.forUser }),
    ports: {
      ledger: createInsightsLedgerPort(database, clock),
      budget: createInsightsBudgetPort(database),
      recurring: createInsightsRecurringPort(database),
      // WP 3.10a. `holdings.aggregate`, `holdings.detail` and
      // `liabilities.terms` need only a database handle and read the same
      // readers WP 3.9's routes do.
      investments: createInsightsInvestmentsPort(database, clock),
      // WP 4.9. `goals.list`, `risk.profile` and `plan.projection` read
      // Planning's own readers (goals, the derived risk score, the baseline's
      // latest projection run) under 08 §4.2 minimisation; the retirement
      // wave is silent without this binding.
      planning: createInsightsPlanningPort(database, clock, { timeZone: options.timezone }),
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
        // WP 10.4: a FRED key stored in Settings counts too, per holder.
        ...(options.marketData === undefined
          ? {}
          : {
              sourceFor: async (userId: string) =>
                fredSourceOf((await options.marketData?.runtime.forUser(userId))?.sources),
            }),
      }),
    },
    settings: {
      // Kill switches 1 and 2 are read through `switches` above (WP 5.1);
      // the two literals that used to sit here were the Phase 4 gate's G4-9.
      timeZone: options.timezone,
      // No config key yet either (wp2.6-insights.md §6 open item 3); every
      // seed and every account in this deployment is USD today.
      baseCurrency: 'USD',
      tokenSecret: options.advisorTokenSecret,
    },
  };

  // WP 5.6 / W-C: the weekly Brief job, `insights.brief` — the retirement
  // effect through `createInsightsRetirementImpactPort` over WP 5.5's solver
  // (§3's own arrows-point-down rule: `@ctx/insights` never imports
  // `@ctx/planning`). No currency config key yet, the same reason
  // `settings.baseCurrency` above has none (wp2.6-insights.md §6 open item 3).
  const briefJob = createBriefJob({
    database,
    retirementImpactPort: createInsightsRetirementImpactPort(database, {
      timeZone: options.timezone,
    }),
    timeZone: options.timezone,
    currencyCode: 'USD',
    clock,
    // WP 5.8's fold (wp5.8-health.md §6): the same ports the advisor-run path
    // builds its snapshot from, and the token secret `deriveTokenKey` needs.
    snapshotPorts: dependencies.ports,
    tokenSecret: options.advisorTokenSecret,
    // W-C's decision (wp5.6-brief.md §8 item 2): gate the narration enqueue
    // on the same flag the narrator's own registration above reads, rather
    // than leave a Brief queue `insights.run_local` for an advisor nobody
    // registered.
    narratorConfigured,
    // WP 10.6: per holder, when the runtime is bound — Off enqueues nothing.
    ...(options.narratorRuntime === undefined
      ? {}
      : {
          narratorConfiguredFor: async (userId: string) =>
            (await options.narratorRuntime?.forUser(userId)) != null,
        }),
  });
  // WP 5.9's outcome check (`evaluateDueOutcomes`) is exported as a plain
  // function, not a job step of its own (§4 W-C: "the outcome check ...
  // folded into the weekly job") — so it is folded in here, after the
  // Brief's own work, rather than given a schedule nothing in 05 names. A
  // wrapper rather than an edit to `brief/job.ts`: `createBriefJob` already
  // returns a complete `JobHandlerRegistration`, and composing one job kind
  // out of two steps is exactly what a composition root does with what a
  // package exports.
  const weeklyJob = defineJob(
    briefJob.kind,
    async (payload: unknown, context) => {
      await briefJob.handler(payload, context);
      await evaluateDueOutcomes(
        database,
        { userId: context.userId, clock: context.clock, correlationId: context.correlationId },
        context.clock.now(),
      );
    },
    briefJob.concurrency === undefined ? {} : { concurrency: briefJob.concurrency },
  );

  return {
    flagKey: 'module.insights',
    events: INSIGHTS_EVENTS,
    consumers: [
      createInsightsConsumer({ registry }),
      // WP 10.6: a settings change drops the cached narrator at once.
      ...(options.narratorRuntime === undefined
        ? []
        : [
            createNarratorSettingsConsumer({
              onChanged: () => options.narratorRuntime?.invalidate(),
            }),
          ]),
    ],
    jobs: [
      ...insightsJobs({ database, dependencies, clock }),
      // WP 5.1's local-model lane: `insights.run_local`, concurrency 1, so a
      // three-minute model call never queues every builtin behind it in
      // `insights.run`, and the api never executes one inline.
      createRunLocalJob({ database, dependencies, clock }),
      // WP 5.6's `insights.brief`, WP 5.9's outcome check folded in (above).
      weeklyJob,
      // WP 10.12: the daily health snapshot (04:10 local), the same snapshot ports the Brief's weekly
      // score reads, plus the budget's variability for the living-expenses cover.
      createHealthSnapshotJob({
        database,
        snapshotPorts: dependencies.ports,
        tokenSecret: options.advisorTokenSecret,
        currencyCode: 'USD',
        timeZone: options.timezone,
        livingExpenses: createLivingExpensesPort(database),
        clock,
      }),
    ],
    schedules: async (userId: string): Promise<void> => {
      await registerInsightsNightlySchedule(
        database,
        { userId, timezone: options.timezone },
        clock,
      );
      // WP 5.3 / W-C: through the same `registerAdvisor` path
      // `registerBuiltinAdvisors` uses for the catalogue (`app.ts`'s onReady
      // hook), so `enabled_source`/`enabled` follow the same rules — a
      // restart cannot re-enable an advisor a human (or WP 5.9's feedback
      // loop) switched off, and a later release reaches an existing install.
      // Default off, matching kill level 3's own default (05 §3 WP 5.1's
      // ladder table).
      if (
        narratorConfigured ||
        (options.narratorRuntime !== undefined &&
          (await options.narratorRuntime.forUser(userId)) !== null)
      ) {
        await registerAdvisor(
          database,
          { userId, clock, correlationId: newId() },
          { manifest: NARRATOR_MANIFEST, enabled: false },
        );
      }
      // WP 5.6's Sunday 06:00 local schedule, after the 04:15 advisor pass
      // and the 04:30 projection refresh.
      await registerWeeklyBriefSchedule(database, { userId, timezone: options.timezone }, clock);
      // WP 10.12: 04:10 local, every day — after the 03:45 price refresh and the 04:00 net-worth
      // snapshot, before the 04:15 advisor pass.
      await registerHealthSnapshotSchedule(database, { userId, timezone: options.timezone }, clock);
    },
  };
}
