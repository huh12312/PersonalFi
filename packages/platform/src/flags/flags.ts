// SPDX-License-Identifier: MIT
import { systemClock, type Clock } from '@core/kernel';
import { sql } from 'drizzle-orm';
import type pg from 'pg';
import { describeError } from '../errors.ts';
import { silentLogger, type Executor, type PlatformLogger } from '../executor.ts';
import { CHANNEL, createNotifyListener, type NotifyListener } from '../notify.ts';

/**
 * Feature flags.
 *
 * Not A/B testing — **progressive module rollout and safe degradation** (08 §6.9).
 * Each context ships behind `module.<name>`, so a half-finished Phase 3 merges to
 * `main` with `module.investments = false` instead of living on a branch for six
 * weeks, which for a solo developer is the difference between shipping and a
 * merge nightmare.
 *
 * The flag gates **registration**, not just rendering. A disabled module
 * registers no consumers and no schedules, so it costs nothing at runtime and
 * cannot half-process events into a read model nobody is looking at:
 *
 * ```ts
 * if (await flags.isEnabled(userId, 'module.budgeting')) {
 *   consumers.push(registerConsumer('budgeting.actuals@v1', handleActuals));
 *   await upsertSchedule(db, { name: 'budgeting.rollover', … });
 * }
 * ```
 *
 * Defaults live in code and a row is an override, so a fresh database has every
 * flag at its coded default and a missing row is never an error.
 */

export interface FlagDefinition {
  readonly key: string;
  readonly defaultEnabled: boolean;
  /** Who is responsible for it, so an orphaned flag has a name attached. */
  readonly owner: string;
  /**
   * What has to be true before this flag is deleted. A flag with no removal
   * criterion is permanent configuration wearing a flag's clothes, and the
   * 90-day staleness warning has nothing to say about it.
   */
  readonly removeWhen: string;
}

export interface FlagService {
  isEnabled(userId: string, key: string): Promise<boolean>;
  all(userId: string): Promise<Readonly<Record<string, boolean>>>;
  set(executor: Executor, userId: string, key: string, enabled: boolean): Promise<void>;
  /** Drop the cache now. The NOTIFY listener calls this on any writer's change. */
  invalidate(): void;
  /** Begin listening for cross-process invalidation. Optional; polling still works. */
  watch(pool: pg.Pool): Promise<void>;
  close(): Promise<void>;
  definitions(): readonly FlagDefinition[];
}

export interface FlagServiceOptions {
  readonly db: Executor;
  readonly defaults: readonly FlagDefinition[];
  readonly clock?: Clock;
  readonly logger?: PlatformLogger;
  /**
   * Cache lifetime. Short on purpose: the invalidation NOTIFY is the fast path,
   * and this is the backstop for the case where it did not arrive. Thirty seconds
   * of staleness on a module toggle is invisible; an unbounded cache that needs a
   * container restart to clear is the bug this number prevents.
   */
  readonly ttlMs?: number;
}

/** The flags the platform itself knows about. Contexts add their own. */
export const PLATFORM_FLAGS: readonly FlagDefinition[] = Object.freeze([
  Object.freeze({
    key: 'platform.scheduler',
    defaultEnabled: true,
    owner: 'platform',
    removeWhen: 'never — this is the kill switch for all scheduled work',
  }),
  Object.freeze({
    key: 'platform.metrics_endpoint',
    defaultEnabled: false,
    owner: 'platform',
    removeWhen: 'Prometheus exposition ships and is documented in the RUNBOOK',
  }),
]);

export function createFlagService(options: FlagServiceOptions): FlagService {
  const { db, defaults, clock = systemClock, logger = silentLogger, ttlMs = 30_000 } = options;
  const defaultsByKey = new Map(defaults.map((definition) => [definition.key, definition]));

  let cache: Map<string, boolean> | null = null;
  let cachedUserId: string | null = null;
  let cachedAtMs = 0;
  let listener: NotifyListener | null = null;
  let watching: Promise<void> | null = null;

  async function load(userId: string): Promise<Map<string, boolean>> {
    const fresh =
      cache !== null && cachedUserId === userId && clock.nowMs() - cachedAtMs < ttlMs;
    if (fresh && cache !== null) return cache;

    const rows = await db.execute<{ key: string; enabled: boolean }>(sql`
      SELECT key, enabled FROM feature_flags WHERE user_id = ${userId}::uuid
    `);

    const resolved = new Map<string, boolean>();
    for (const definition of defaults) resolved.set(definition.key, definition.defaultEnabled);
    for (const row of rows.rows) resolved.set(row.key, row.enabled);

    cache = resolved;
    cachedUserId = userId;
    cachedAtMs = clock.nowMs();
    return resolved;
  }

  function invalidate(): void {
    cache = null;
    cachedUserId = null;
    cachedAtMs = 0;
  }

  return {
    async isEnabled(userId, key) {
      const resolved = await load(userId);
      const value = resolved.get(key);
      if (value !== undefined) return value;
      // An unknown key is off, and says so once. Failing closed is right: a typo
      // in a flag name must not silently enable a half-finished module.
      if (!defaultsByKey.has(key)) {
        logger.warn({ key }, 'unknown feature flag queried; treating as disabled');
      }
      return false;
    },

    async all(userId) {
      return Object.fromEntries(await load(userId));
    },

    async set(executor, userId, key, enabled) {
      await executor.execute(sql`
        INSERT INTO feature_flags (user_id, key, enabled)
        VALUES (${userId}::uuid, ${key}, ${enabled})
        ON CONFLICT (user_id, key) DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = now()
      `);
      // Local invalidation is immediate; other processes learn from the trigger's
      // NOTIFY. Without both, toggling a module in the UI takes effect on the api
      // process and not on the worker, which is a confusing half-enabled state
      // that looks like a bug in the module rather than in the cache.
      invalidate();
    },

    invalidate,

    async watch(pool) {
      if (watching !== null) return await watching;
      watching = (async () => {
        listener = await createNotifyListener(pool, CHANNEL.featureFlags, logger);
        void (async () => {
          for (;;) {
            const current = listener;
            if (current === null) return;
            try {
              const result = await current.wait(60_000);
              if (listener === null) return;
              if (result === 'notified') invalidate();
            } catch (cause) {
              logger.warn({ err: describeError(cause) }, 'flag invalidation listener failed');
              return;
            }
          }
        })();
      })();
      return await watching;
    },

    async close() {
      const current = listener;
      listener = null;
      watching = null;
      await current?.close();
    },

    definitions: () => defaults,
  };
}
