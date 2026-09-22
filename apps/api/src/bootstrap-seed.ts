// SPDX-License-Identifier: MIT
/**
 * `seedUserState` — the one composition-root call that puts a brand-new user
 * into the state every other context already assumes an existing user has:
 * the shipped category taxonomy, WP 2.7's advisor catalogue, and the
 * categorization/notifications/insights cron schedules.
 *
 * ## Condition C-1 (docs/evidence/phase-2/gate-security-review.md §5)
 *
 * G2-1 found the advisor catalogue empty on a cold install because it was
 * registered only at api `onReady`, and `bootstrap-user` creates the account
 * holder *after* that hook has already run — the same shape D2-1 found for
 * the category taxonomy a phase earlier. Both were patched with a lazy
 * repair at the read route (`routes/categories.ts`, `routes/insights.ts`):
 * idempotent, but two copies of the same fix, and neither one seeds the third
 * thing a fresh user needs — a schedule row. Without one, `resolveModules()`
 * (`platform.ts`) never calls `module.schedules?.(userId)` for this user
 * until the *worker* restarts, so a user bootstrapped while the worker is up
 * gets no retrain, no notification delivery/digest cadence and no nightly
 * advisor run either — unobserved until now because nothing exercised a
 * cold-install worker process against a user created after it started.
 *
 * The root fix is this file: one function, called once, at the moment a user
 * is actually created — today that is exactly one call site
 * (`bin/bootstrap-user.ts`; `UserService.createPrimary` refuses a second user
 * outright, D6) — so the gap this closes is real from the first request any
 * of these three contexts ever see for that user, not from the next restart.
 * `app.ts`'s `onReady` pass keeps calling `ensureTaxonomy` and
 * `registerBuiltinAdvisors` every boot as an **idempotent repair for
 * installs that predate this file** (an upgrade must not leave an existing
 * user's taxonomy stuck on the release they were created under); it does not
 * (and must not) re-run schedule registration, because `upsertSchedule`
 * deliberately never overwrites `enabled` or `next_run_at` on conflict — a
 * restart must not silently re-enable a schedule the user turned off.
 *
 * **TODO (multi-user, tracked with 03-phase-3-dispatch.md §2's own "deferred
 * again, same reason"):** the day `@ctx/identity` grows a second user, this
 * function's one call site in `bootstrap-user.ts` is not the only
 * user-creation path any more, and whatever creates user #2 must call this
 * too — ideally via an `identity.UserCreated` event consumer registered in
 * `modules.ts`, which does not exist today because identity emits no events
 * at all (`@ctx/identity`'s own scope: sessions and credentials, not an event
 * producer). Until then this file's only caller is enumerable by hand.
 *
 * **Connections' nightly sync schedule is deliberately not seeded here.**
 * Unlike the three below, it needs a `SyncOrchestrator` — a `SecretBox` and
 * the connector registry — and `bootstrap-user.ts` builds neither (it derives
 * the KEK for key custody, not to run a sync). Carried, not forgotten: no
 * user-visible gap exists today because `just bootstrap-user` runs with the
 * stack already up (RUNBOOK.md "Because the stack is up at this point..."),
 * so the worker that owns that schedule is already live and picks up the
 * newly-created user the moment it next resolves modules for a request or
 * job that names them — which, unlike a cron schedule, connections' sync
 * already handles by fan-out (`modules.ts`'s `syncAllJob`) rather than by a
 * per-user row this file would otherwise have to seed.
 */
import type { Database } from '@core/db';
import { newId, type Clock } from '@core/kernel';
import { platformExecutor, type FlagService } from '@core/platform';
import { registerRetrainSchedule } from '@ctx/categorization';
import { ensureTaxonomy } from '@ctx/categorization';
import {
  BUILTIN_CATALOGUE,
  registerNightlySchedule as registerInsightsNightlySchedule,
} from '@ctx/insights';
import { registerNotificationSchedules } from '@ctx/notifications';
import { registerBuiltinAdvisors } from './modules.ts';

export interface SeedUserStateOptions {
  readonly userId: string;
  /** The account holder's display timezone — schedules fire in it, never in the container's TZ (08 §3.7). */
  readonly timezone: string;
  readonly clock: Clock;
  readonly correlationId?: string;
  /**
   * `config.secrets.advisor_token_secret`, revealed — absent means the
   * operator has not opted into `module.insights` yet (wp2.6-insights.md §6
   * open item 5). Mirrors `modules.ts`'s `insightsModule` feature detection:
   * no secret, no schedule, exactly as inert as the flag being off.
   */
  readonly advisorTokenSecret?: string;
}

export interface SeedUserStateResult {
  readonly categoriesInserted: number;
  /** Bookkeeping only — nothing runs from registering a manifest (`registerBuiltinAdvisors`'s own doc). */
  readonly advisorsRegistered: number;
  /** Which schedule families were actually registered — omits any whose module flag was off. */
  readonly schedulesRegistered: readonly string[];
}

/**
 * Seed everything a brand-new user needs with no restart and no lazy repair.
 *
 * Taxonomy and the advisor catalogue are seeded unconditionally, the same
 * policy `app.ts`'s `onReady` pass already used: both are inert bookkeeping
 * when their module is off (a category nobody can be assigned costs nothing;
 * an advisor manifest with no `enabled` grant runs nothing). Schedules are
 * the one part that is **not** unconditional — `upsertSchedule`'s own
 * contract is "not called when that module's flag is off"
 * (`packages/platform/src/jobs/scheduler.ts`), because the scheduler's `tick`
 * enqueues any due row with no flag check of its own; a schedule for a
 * disabled module would enqueue jobs with no registered handler to run them.
 */
export async function seedUserState(
  database: Database,
  flags: FlagService,
  options: SeedUserStateOptions,
): Promise<SeedUserStateResult> {
  const correlationId = options.correlationId ?? newId();

  const taxonomy = await ensureTaxonomy(database, {
    userIds: [options.userId],
    clock: options.clock,
  });

  await registerBuiltinAdvisors(database, {
    userId: options.userId,
    clock: options.clock,
    correlationId,
  });

  const schedulesRegistered: string[] = [];

  if (await flags.isEnabled(options.userId, 'module.categorization')) {
    await registerRetrainSchedule(
      database,
      { userId: options.userId, timezone: options.timezone },
      options.clock,
    );
    schedulesRegistered.push('categorization.retrain_weekly');
  }

  if (await flags.isEnabled(options.userId, 'module.notifications')) {
    await registerNotificationSchedules(
      platformExecutor(database),
      { userId: options.userId, timezone: options.timezone },
      options.clock,
    );
    schedulesRegistered.push('notifications.deliver', 'notifications.digest');
  }

  if (
    options.advisorTokenSecret !== undefined &&
    (await flags.isEnabled(options.userId, 'module.insights'))
  ) {
    await registerInsightsNightlySchedule(
      database,
      { userId: options.userId, timezone: options.timezone },
      options.clock,
    );
    schedulesRegistered.push('insights.nightly');
  }

  return {
    categoriesInserted: taxonomy.categoriesInserted,
    advisorsRegistered: BUILTIN_CATALOGUE.length,
    schedulesRegistered,
  };
}
