// SPDX-License-Identifier: MIT
/**
 * Phase 3 WP 3.13, condition **C-1**
 * (docs/evidence/phase-2/gate-security-review.md §5): the root fix, proven
 * end to end over a real database and through the real application.
 *
 * G2-1 (a Phase 2 sequel of D2-1) found the advisor catalogue empty on a cold
 * install because it was registered only at api `onReady`, and
 * `bootstrap-user` creates the account holder *after* that hook already ran.
 * The taxonomy had the identical shape a phase earlier. Both were patched
 * with a lazy repair at the read route — two copies of the same fix, and
 * neither one seeded the third thing a fresh user needs: a schedule row,
 * without which `resolveModules()` never registers this user's retrain,
 * delivery/digest or nightly-advisor cadence until the *worker* restarts.
 *
 * The root fix is `apps/api/src/bootstrap-seed.ts`'s `seedUserState`, called
 * once, at the moment a user is created — `bin/bootstrap-user.ts`'s only call
 * site. Both lazy repairs are deleted (`routes/categories.ts`,
 * `routes/insights.ts`).
 *
 * ## What this test actually exercises
 *
 * The harness's `createApiHarness` already built the app and ran `app.ready()`
 * (its `onReady` pass) for a raw-inserted primary user — exactly `just up`'s
 * state. This test then deletes that user (cascading away every row it
 * seeded) and creates a fresh one through the *same two calls*
 * `bin/bootstrap-user.ts` makes, in the same order: `UserService.createPrimary`
 * (the real identity call, not a raw insert), then `seedUserState`. Nothing
 * here restarts the application or calls `app.ready()` a second time — the
 * claim is specifically "no restart", and the only thing that could still
 * make it pass is a lazy repair, which is what the second describe block
 * below proves is gone.
 *
 * **Sabotage.** Comment out the `seedUserState(...)` call in
 * `bin/bootstrap-user.ts` (or delete `bootstrap-seed.ts`'s body) and the first
 * test goes red: zero categories, zero advisors, zero schedules. Observed red
 * before this file's fix and green after (see
 * docs/evidence/phase-3/wp3.13-carry-overs.md, item 1).
 */
import { FLAT_TAXONOMY } from '@ctx/categorization';
import { RETRAIN_JOB_KIND } from '@ctx/categorization';
import { BUILTIN_CATALOGUE } from '@ctx/insights';
import { RUN_ALL_JOB_KIND } from '@ctx/insights';
import { UserService } from '@ctx/identity';
import { DELIVER_JOB_KIND, DIGEST_JOB_KIND } from '@ctx/notifications';
import { systemClock } from '@core/kernel';
import { createFlagService, platformExecutor, PLATFORM_FLAGS } from '@core/platform';
import { createDatabase } from '@core/db';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createApiHarness,
  expectStatus,
  NO_DATABASE,
  type ApiHarness,
} from '../helpers/api-harness.ts';
import { seedUserState } from '../../src/bootstrap-seed.ts';
import {
  NET_WORTH_SNAPSHOT_JOB_KIND,
  NET_WORTH_SNAPSHOT_SCHEDULE_NAME,
  PRICE_REFRESH_JOB_KIND,
  PRICE_REFRESH_SCHEDULE_NAME,
} from '../../src/modules.ts';
import { MODULE_FLAGS } from '../../src/platform.ts';
import { DEFAULT_LADDERS, ladderRows } from '@ctx/investments';

interface WireCategory {
  readonly key: string;
}
interface WireAdvisor {
  readonly advisorId: string;
}
interface ScheduleRow extends Record<string, unknown> {
  readonly name: string;
  readonly job_kind: string;
}

describe.skipIf(NO_DATABASE)(
  'a user created after boot has taxonomy, advisors and schedules with no restart and no lazy repair',
  () => {
    let h: ApiHarness;

    beforeAll(async () => {
      h = await createApiHarness({ suite: 'coldinstall' });
    }, 300_000);

    afterAll(async () => {
      await h.close();
    }, 60_000);

    it('a user created after boot has taxonomy, advisors and schedules with no restart and no lazy repair', async () => {
      // The app is already built and `app.ready()` already ran — `just up`'s
      // state. Wipe the harness's own pre-seeded primary (testkit's raw
      // INSERT) so the account this test creates next is the only user
      // `createPrimary` will ever see. `ON DELETE CASCADE` on every
      // `user_id` column takes the old user's categories/advisors/schedules
      // with it.
      await h.database.db.execute(sql`DELETE FROM users`);

      // Call 1 of 2: the real identity call `bin/bootstrap-user.ts` makes —
      // not a raw insert.
      const users = new UserService({ db: h.database.pool, clock: systemClock });
      const user = await users.createPrimary({
        displayName: 'Cold Install Holder',
        displayTimezone: 'America/Los_Angeles',
      });

      // Call 2 of 2: the composition-root seeding function, with the same
      // flag defaults `apps/api/src/platform.ts` ships (all three of
      // categorization/notifications/insights default `true`), and a token
      // secret so the insights schedule is exercised too — a real deployment
      // needs a real file for that; this test only needs any non-`undefined`
      // string, since `seedUserState` never reads its contents.
      const flags = createFlagService({
        db: platformExecutor(createDatabase(h.database.pool)),
        defaults: [...PLATFORM_FLAGS, ...MODULE_FLAGS],
      });
      const seeded = await seedUserState(createDatabase(h.database.pool), flags, {
        userId: user.id,
        timezone: user.displayTimezone,
        clock: systemClock,
        advisorTokenSecret: 'cold-install-test-secret',
      });
      await flags.close();

      expect(seeded.categoriesInserted).toBe(FLAT_TAXONOMY.length);
      expect(seeded.advisorsRegistered).toBe(BUILTIN_CATALOGUE.length);
      expect(seeded.schedulesRegistered).toEqual(
        expect.arrayContaining([
          'categorization.retrain_weekly',
          'insights.nightly',
          // Phase 3 (docs/evidence/phase-3/wp3.w-wiring.md). Unlike the
          // insights one this has no secret to feature-detect on: an install
          // with no provider key still wants the row, because the refresh
          // runs, finds no source registered and records that honestly.
          PRICE_REFRESH_SCHEDULE_NAME,
          // WP 3.8 (04:00 local), the same claim one schedule later: a holder
          // created after boot gets the net-worth cadence with no restart. Like
          // the price refresh and unlike the insights one, there is no secret
          // to feature-detect on — a holder with no accounts still wants the
          // row, because the snapshotter computes an honest day from whatever
          // the ledger holds.
          NET_WORTH_SNAPSHOT_SCHEDULE_NAME,
        ]),
      );

      // `price_source_priority` — 07 §6.1's ladder as rows, per security kind
      // (wp3.4-market-data.md §9 item 6). This is the Phase 3 half of the same
      // C-1 claim the taxonomy and the advisor catalogue make: a user created
      // *after* boot has it, with no restart and no lazy repair at a read
      // route. Seeded unconditionally, so it does not move if
      // `module.integrations` is switched off.
      const expectedLadderRows = Object.entries(DEFAULT_LADDERS).flatMap(([kind, ladder]) =>
        ladderRows(user.id, kind, ladder),
      );
      expect(seeded.priceLadderRows).toBe(expectedLadderRows.length);

      const ladder = await h.database.db.execute<{
        security_kind: string;
        rung: number;
        source: string;
      }>(sql`
        SELECT security_kind, rung, source
          FROM price_source_priority
         WHERE user_id = ${user.id}::uuid
         ORDER BY security_kind, rung
      `);
      expect(ladder.rows).toHaveLength(expectedLadderRows.length);
      expect(new Set(ladder.rows.map((row) => row.security_kind))).toEqual(
        new Set(Object.keys(DEFAULT_LADDERS)),
      );
      // The two rungs `0015_market_data.sql` pins by CHECK: a user override
      // that is not first is not an override, and a carry-forward that is not
      // last would shadow a real quote with a stale one.
      for (const row of ladder.rows) {
        if (row.source === 'user_override') expect(row.rung).toBe(1);
        if (row.source === 'last_known') expect(row.rung).toBe(99);
      }

      // No restart between the seeding above and the reads below — same
      // `h.app`, same process, no second `app.ready()`.
      const session = await h.issueSession({ userId: user.id, fresh: false });

      const categoriesResponse = await h.request({
        method: 'GET',
        url: '/categories',
        session,
      });
      expectStatus(categoriesResponse, 200);
      const categories = (categoriesResponse.json() as { categories: WireCategory[] }).categories;
      expect(categories).toHaveLength(FLAT_TAXONOMY.length);
      expect(new Set(categories.map((c) => c.key))).toEqual(
        new Set(FLAT_TAXONOMY.map((entry) => entry.key)),
      );

      const advisorsResponse = await h.request({ method: 'GET', url: '/advisors', session });
      expectStatus(advisorsResponse, 200);
      const advisors = (advisorsResponse.json() as { advisors: WireAdvisor[] }).advisors;
      // The catalogue, plus the five query types registered beside it and never in the
      // nightly registry: WP 11.2's categorize.suggest (off), WP 11.3's insight.explain (on),
      // WP 11.4's brief.narrate (on) and WP 11.5c's ask.compile and ask.narrate (on); WP 11.5d's
      // six advisor steps (on) and its builtin follow-up watcher (on).
      expect(advisors).toHaveLength(BUILTIN_CATALOGUE.length + 12);
      expect(new Set(advisors.map((a) => a.advisorId))).toEqual(
        new Set([
          ...BUILTIN_CATALOGUE.map((entry) => entry.advisor.manifest.advisor_id),
          'categorize.suggest',
          'insight.explain',
          'brief.narrate',
          'ask.compile',
          'ask.narrate',
          'advisor.clarify',
          'advisor.gather',
          'advisor.options',
          'advisor.tradeoffs',
          'advisor.plan',
          'advisor.judge',
          'advisor.follow_up',
        ]),
      );

      // `schedules` — read directly (there is no HTTP route over this table)
      // — proves the third thing D2-1's original fix never seeded at all:
      // one row per background cadence this user now has, immediately, with
      // no worker restart to pick them up.
      const scheduleRows = await h.database.db.execute<ScheduleRow>(sql`
        SELECT name, job_kind FROM schedules WHERE user_id = ${user.id}::uuid ORDER BY name
      `);
      const jobKinds = new Set(scheduleRows.rows.map((row) => row.job_kind));
      expect(jobKinds).toContain(RETRAIN_JOB_KIND);
      expect(jobKinds).toContain(DELIVER_JOB_KIND);
      expect(jobKinds).toContain(DIGEST_JOB_KIND);
      expect(jobKinds).toContain(RUN_ALL_JOB_KIND);
      expect(jobKinds).toContain(PRICE_REFRESH_JOB_KIND);
      expect(jobKinds).toContain(NET_WORTH_SNAPSHOT_JOB_KIND);
    });
  },
);
