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
