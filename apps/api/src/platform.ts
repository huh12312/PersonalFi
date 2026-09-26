// SPDX-License-Identifier: MIT
import type { AppConfig } from '@core/config';
import { createDatabase } from '@core/db';
import {
  PLATFORM_FLAGS,
  createEventRegistry,
  createFlagService,
  createMetrics,
  platformExecutor,
  type EventDefinition,
  type FlagDefinition,
  type EventRegistry,
  type FlagService,
  type JobHandlerRegistration,
  type Metrics,
  type RegisteredConsumer,
  type TransactionalExecutor,
} from '@core/platform';
import type pg from 'pg';

/**
 * The composition root's view of the platform.
 *
 * This file is where the app's modules are *assembled*, which is a job only
 * `apps/` may do: `@core/platform` knows how to run a consumer but not which
 * consumers exist, and a context knows its own consumers but not the others'.
 * Both facts meet here and nowhere else.
 *
 * It is also where feature flags stop being a lookup and start being a
 * structural decision. A module whose flag is off contributes no events, no
 * consumers, no job handlers, and no schedules, so it costs nothing at runtime
 * and cannot half-fill a read model nobody is reading (08 §6.9).
 */

export interface ModuleRegistration {
  /** `module.budgeting`. The flag that gates everything below. */
  readonly flagKey: string;
  readonly events?: readonly EventDefinition[];
  readonly consumers?: readonly RegisteredConsumer[];
  readonly jobs?: readonly JobHandlerRegistration[];
  /**
   * Called only when the flag is on; declares the module's cron rows.
   *
   * Takes the user and nothing else. Phase 0 passed the platform's
   * `TransactionalExecutor` here, on the assumption that a schedule declaration
   * would be raw SQL; WP 1.5 found it is not — `SyncOrchestrator`'s
   * `registerNightlySchedule` needs the module's *own* Drizzle handle so the
   * upsert can join a caller's transaction. A module that needs a database
   * closes over the one it was built with, which it necessarily already has.
   */
  readonly schedules?: (userId: string) => Promise<void>;
}

/**
 * The module flags, declared where the modules are assembled.
 *
 * `defaultEnabled: true` for both: WP 1.1 and WP 1.2 are complete and a
 * freshly-migrated database with no `feature_flags` rows should be a working
 * application. The switch exists for the other direction — turning a module
 * *off* during an incident without a redeploy — and for the half-finished
 * contexts Phase 2 will add, which ship `false`.
 */
export const MODULE_FLAGS: readonly FlagDefinition[] = Object.freeze([
  Object.freeze({
    key: 'module.ledger',
    defaultEnabled: true,
    owner: 'ledger',
    removeWhen: 'never — the system of record has no "off" that leaves a usable app',
  }),
  Object.freeze({
    key: 'module.connections',
    defaultEnabled: true,
    owner: 'connections',
    removeWhen: 'never — this is the kill switch for every provider sync',
  }),
  Object.freeze({
    key: 'module.categorization',
    defaultEnabled: true,
    owner: 'categorization',
    removeWhen: 'never — a synced transaction with no way to gain a category is a worse default',
  }),
  // The four below flipped `true` at this wave boundary
  // (docs/evidence/phase-2/wp2.w-wiring.md): `apps/api/test/db/
  // phase2-wiring.test.ts` proved each one's real `appModules()` registration
  // — not a fake — against a real database, through the real HTTP sync path.
  // Each still has its own, independent lock beneath the flag (an empty
  // budget has no lines to post activity into; a channel needs a
  // `verified_at`; an advisor needs a `snapshot_grants` row nobody has yet),
  // so "the module is on" is not "the module does anything" for an install
  // that has not also taken the per-feature step.
  Object.freeze({
    key: 'module.budgeting',
    defaultEnabled: true,
    owner: 'budgeting',
    removeWhen:
      'never — this is the kill switch for the envelope cascade, and 07 §1.9 ' +
      'requires the app stay fully usable with the budget off (budget_mode = OFF)',
  }),
  Object.freeze({
    key: 'module.recurring',
    defaultEnabled: true,
    owner: 'recurring',
    removeWhen: 'never — this is the kill switch for subscription detection',
  }),
  Object.freeze({
    key: 'module.notifications',
    defaultEnabled: true,
    owner: 'notifications',
    removeWhen: 'never — this is the kill switch for every outbound message the app can send',
  }),
  Object.freeze({
    key: 'module.insights',
    // `true`, unlike the other three, is provably inert on a fresh install:
    // `apps/api/src/modules.ts`'s `insightsModule` registers no consumer, job
    // or schedule at all unless `advisor_token_secret` is present, and
    // `compose.yml` does not yet mount that file (open item,
    // docs/evidence/phase-2/wp2.w-wiring.md) — so this flag has no observable
    // effect in the shipped stack today regardless of its value. `true` here
    // is what "on" means the day that secret and its compose mount land,
    // without a second code change to flip it.
    defaultEnabled: true,
    owner: 'insights',
    removeWhen:
      'never — off means no advisor runs, no consumer, no schedule, and a feed ' +
      'that answers with an empty list',
  }),
  // The two below are Phase 3's (03-phase-3-dispatch.md §4 item 3). Both
  // landed `defaultEnabled: false` and were flipped `true` at this wave
  // boundary once `apps/api/test/db/phase3-wiring.test.ts` proved the real
  // `appModules()` registration green against a real database — the same bar
  // the four Phase 2 flags above were held to, and the same reason the
  // dispatch reserves the flip for the orchestrator rather than the work
  // package: a context can prove its own engine, and only the composition
  // root can prove it is wired. Both were flipped; see
  // docs/evidence/phase-3/wp3.w-wiring.md for what proved each one.
  Object.freeze({
    key: 'module.investments',
    // Provably inert on an install with no investment accounts, in the strong
    // sense: the lot consumer reacts to `connections.SyncRunCompleted` and
    // derives from the facts `createInvestmentSyncPort(...).factsForRun`
    // returns, which today is always empty (WP 3.7 owns the provider legs that
    // persist them — see that function's doc). `runLotSync` over no facts
    // touches no holding, opens no lot and appends no event. `true` here is
    // what "on" means the day 3.7 lands, without a second code change, and it
    // buys one thing now: the consumer's offset advances over history from
    // first boot, so 3.7's first run is not also a full replay of every sync
    // run ever recorded.
    defaultEnabled: true,
    owner: 'investments',
    removeWhen:
      'never — this is the kill switch for cost-basis derivation, and a lot ' +
      'engine that cannot be switched off is one that cannot be paused while a ' +
      'basis-affecting bug is fixed',
  }),
  Object.freeze({
    key: 'module.integrations',
    // Not inert, and deliberately so: on, this registers the
    // `integrations.price_refresh` job handler and the 03:45 schedule. What
    // makes `true` safe on an install with no API keys is one layer down —
    // `createMarketDataRuntime` (domain.ts) registers no `PriceSource` for a
    // provider whose key file is absent, so the refresh runs, consults nothing,
    // writes nothing and records a run with zero requests. 03 §6: "Phase 3
    // completes with zero keys — it just cannot prove freshness."
    defaultEnabled: true,
    owner: 'integrations',
    removeWhen:
      'never — this is the kill switch for every outbound market-data call, and ' +
      'the only one that stops a provider being dialled without deleting its key',
  }),
  Object.freeze({
    key: 'module.planning',
    // WP 3.8, landed after the two above and held to the same bar: `false`
    // until `apps/api/test/db/phase3-wiring.test.ts` drove the real
    // `appModules()` registration — the real consumer through the real pump,
    // and the real `planning.net_worth_snapshot` schedule through the real
    // `upsertSchedule` — green against a real database.
    //
    // Safe at `true` on a fresh install for a reason that is structural rather
    // than a hope: `createNetWorthConsumer`'s handler is an UPDATE
    // (`markDirty`), so on an install with no `net_worth_daily` row it marks
    // nothing and says so, and the 04:00 job computes a day from whatever
    // `@ctx/ledger` and `@ctx/investments` actually hold — which, for a holder
    // with no accounts, is nothing at all. The one thing it must **not** do is
    // invent a point: a zero that means "not computed yet" is exactly the lie
    // WP 3.8 exists to refuse, and `upsertOpenDay` is only ever reached with a
    // computed snapshot.
    //
    // Flipped `true` once `phase3-wiring.test.ts` → 'module.planning: a real
    // ledger.BalanceRecorded reaches the net-worth consumer through the real
    // pump, and the 04:00 schedule lands' was green (6 passed).
    //
    // Phase 4 (docs/plan/04-phase-4-dispatch.md §4 item 3, asked for by
    // wp3.8-net-worth.md §9): this flag now guards Planning proper — goals,
    // assumptions, scenarios, the deterministic projection and the Monte
    // Carlo worker, and the `planning.projection_refresh` schedule — not only
    // the net-worth snapshotter it was born for. It stays `true`; every new
    // Planning consumer and schedule registers behind it, and WP 4.14 proves
    // flag-off registers none of them (the 2.13 pattern, re-proved in 3.14).
    defaultEnabled: true,
    owner: 'planning',
    removeWhen:
      'never — this is the kill switch for Planning as a whole: the net-worth ' +
      'read model, goals and assumptions, and every projection job. A ' +
      'snapshotter that cannot be switched off is one that cannot be paused ' +
      'while a sealed row is corrected, and a projection that cannot be ' +
      'switched off is one that keeps forecasting from inputs known to be wrong',
  }),
]);

export interface Platform {
  readonly db: TransactionalExecutor;
  readonly metrics: Metrics;
  readonly flags: FlagService;
  readonly registry: EventRegistry;
}

export interface BuildPlatformOptions {
  readonly config: AppConfig;
  readonly pool: pg.Pool;
}

export function buildPlatform(options: BuildPlatformOptions): Platform {
  const db = platformExecutor(createDatabase(options.pool));
  return {
    db,
    metrics: createMetrics(),
    flags: createFlagService({ db, defaults: [...PLATFORM_FLAGS, ...MODULE_FLAGS] }),
    registry: createEventRegistry(),
  };
}

export interface EnabledModules {
  readonly consumers: readonly RegisteredConsumer[];
  readonly jobs: readonly JobHandlerRegistration[];
  readonly enabled: readonly string[];
  readonly disabled: readonly string[];
}

/**
 * Resolve which modules are on, and collect what they contribute.
 *
 * The array comes from `appModules()` in `modules.ts`, which both the API and
 * the worker build from the same wiring — so "which events exist" cannot differ
 * between the two processes, and a module that is off in one is off in both.
 */
export async function resolveModules(
  platform: Platform,
  userId: string,
  modules: readonly ModuleRegistration[],
): Promise<EnabledModules> {
  const consumers: RegisteredConsumer[] = [];
  const jobs: JobHandlerRegistration[] = [];
  const enabled: string[] = [];
  const disabled: string[] = [];

  for (const module of modules) {
    if (!(await platform.flags.isEnabled(userId, module.flagKey))) {
      disabled.push(module.flagKey);
      continue;
    }
    enabled.push(module.flagKey);
    platform.registry.registerAll(module.events ?? []);
    consumers.push(...(module.consumers ?? []));
    jobs.push(...(module.jobs ?? []));
    await module.schedules?.(userId);
  }

  return { consumers, jobs, enabled, disabled };
}
