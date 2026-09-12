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
  type EventRegistry,
  type FlagDefinition,
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
  /** Called only when the flag is on; declares the module's cron rows. */
  readonly schedules?: (db: TransactionalExecutor, userId: string) => Promise<void>;
}

export interface Platform {
  readonly pool: pg.Pool;
  readonly db: TransactionalExecutor;
  readonly metrics: Metrics;
  readonly flags: FlagService;
  readonly registry: EventRegistry;
}

export interface BuildPlatformOptions {
  readonly config: AppConfig;
  readonly pool: pg.Pool;
  readonly flagDefaults?: readonly FlagDefinition[];
  readonly metrics?: Metrics;
}

export function buildPlatform(options: BuildPlatformOptions): Platform {
  const db = platformExecutor(createDatabase(options.pool));
  return {
    pool: options.pool,
    db,
    metrics: options.metrics ?? createMetrics(),
    flags: createFlagService({
      db,
      defaults: options.flagDefaults ?? PLATFORM_FLAGS,
    }),
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
 * Phase 0 registers nothing: there are no contexts yet. The shape is here so
 * Phase 1 adds `@ctx/ledger` by appending one object to an array in
 * `worker.ts`, rather than by discovering at that point that consumers have to
 * be wired through four files.
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
    await module.schedules?.(platform.db, userId);
  }

  return { consumers, jobs, enabled, disabled };
}
