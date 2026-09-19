// SPDX-License-Identifier: MIT
/**
 * The upsert and the dismissal ladder, against a real Postgres.
 *
 * Both claims are claims about Postgres and not about TypeScript: the upsert is
 * a UNIQUE index plus `ON CONFLICT`, and the ladder's third rung is a CHECK.
 * `test/alert-budget.test.ts` proves the pure functions; this proves the rows.
 *
 * **Sabotage record.** `'a nightly re-run updates the row rather than
 * inserting'` was run once with `first_proposed_at` added to the upsert's
 * conflict branch, and observed red. `'a third dismissal suppresses
 * permanently'` was run once with `PERMANENT_AFTER_DISMISSALS` raised to 4, and
 * observed red. `'cooldown ladder 30/90/permanent'` was run once with
 * `service.ts`'s `isSuppressed` filter bypassed, and observed red. All three
 * red on the first try; all restored. Recorded in
 * docs/evidence/phase-2/wp2.6-insights.md §4.
 */
import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  insightDismissals,
  insightEvidence,
  insightFeedback,
  insights,
} from '../../schema/index.ts';
import { listInsights } from '../../src/read.ts';
import { reviewInsight, runAdvisor } from '../../src/service.ts';
import { grantScopes, registerAdvisor } from '../../src/store.ts';
import { responseFor } from '../fixtures.ts';
import {
  EPOCH,
  GRANTED_SCOPES,
  NO_DATABASE,
  clockAt,
  contextFor,
  insightsDatabase,
  scenario,
  selfCiting,
  type TestDatabase,
} from './harness.ts';

/** One day later, and so on: the ladder is measured in days. */
function plusDays(days: number): string {
  return new Date(new Date(EPOCH).getTime() + days * 86_400_000).toISOString();
}

describe.skipIf(NO_DATABASE)('dedupe and cooldown', () => {
  let database: TestDatabase;

  beforeEach(async () => {
    database ??= await insightsDatabase('cooldown');
    await database.truncate();
  }, 30_000);

  afterAll(async () => {
    await database?.drop();
  }, 30_000);

  async function ready(at: string = EPOCH) {
    const world = scenario();
    const context = contextFor(database.userId, clockAt(at));
    await registerAdvisor(database.db, context, { manifest: world.manifest, enabled: true });
    await grantScopes(database.db, context, world.manifest.advisor_id, [...GRANTED_SCOPES]);
    return { world, context };
  }

  async function run(world: ReturnType<typeof scenario>, at: string) {
    return runAdvisor(database.db, contextFor(database.userId, clockAt(at)), world.dependencies, {
      advisorId: world.manifest.advisor_id,
      trigger: 'schedule',
    });
  }

  it('a nightly re-run updates the row rather than inserting', async () => {
    const { world } = await ready();

    const first = await run(world, EPOCH);
    expect(first.inserted).toBe(1);
    const [before] = await database.db.select().from(insights);
    expect(before).toBeDefined();

    const second = await run(world, plusDays(1));
    expect(second.accepted).toBe(1);
    // Written, but not *inserted* — which is also what keeps `InsightProposed`
    // from firing a second time.
    expect(second.inserted).toBe(0);

    const rows = await database.db.select().from(insights);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(before?.id);
    // `first_proposed_at` is the answer to "since when has this been true?" and
    // must not move; `last_proposed_at` must.
    expect(rows[0]?.firstProposedAt.toISOString()).toBe(EPOCH);
    expect(rows[0]?.lastProposedAt.toISOString()).toBe(plusDays(1));

    // The evidence was replaced in place, not duplicated or re-parented.
    const evidence = await database.db.select().from(insightEvidence);
    expect(evidence).toHaveLength(1);
    expect(evidence[0]?.insightId).toBe(before?.id);

    // And exactly one InsightProposed was appended across both runs.
    const events = await database.db.execute(
      "SELECT event_type FROM domain_events WHERE event_type = 'insights.InsightProposed'",
    );
    expect(events.rows).toHaveLength(1);
  });

  it('a different period is a different row, not an overwrite', async () => {
    // Last month's "dining is over budget" is a separate, historical finding.
    const world = scenario({
      respond: (request) =>
        responseFor(request, [selfCiting(request, { key: 'over.budget', period: '2026-08' })]),
    });
    const context = contextFor(database.userId);
    await registerAdvisor(database.db, context, { manifest: world.manifest, enabled: true });
    await grantScopes(database.db, context, world.manifest.advisor_id, [...GRANTED_SCOPES]);
    await run(world, EPOCH);

    const september = scenario({
      respond: (request) =>
        responseFor(request, [selfCiting(request, { key: 'over.budget', period: '2026-09' })]),
    });
    await run(september, plusDays(1));

    const rows = await database.db.select().from(insights).orderBy(asc(insights.period));
    expect(rows.map((row) => row.period)).toEqual(['2026-08', '2026-09']);
  });

  it('a third dismissal suppresses permanently', async () => {
    const { world } = await ready();

    let dismissCount = 0;
    for (const day of [0, 40, 140]) {
      await run(world, plusDays(day));
      const [row] = await database.db.select().from(insights);
      expect(row, `day ${String(day)}`).toBeDefined();
      if (row === undefined) return;

      const review = await reviewInsight(
        database.db,
        contextFor(database.userId, clockAt(plusDays(day))),
        { insightId: row.id, action: 'dismiss', reason: 'not relevant' },
      );
      dismissCount = review.dismissCount;
    }

    expect(dismissCount).toBe(3);
    const [ladder] = await database.db.select().from(insightDismissals);
    expect(ladder?.dismissCount).toBe(3);
    expect(ladder?.permanent).toBe(true);
    // Permanent has no date to expire, so no clock change, timezone bug or
    // backfill can resurrect it.
    expect(ladder?.suppressedUntil).toBeNull();

    // A year later, the advisor still finds it, and it is still not proposed.
    const later = await run(world, plusDays(400));
    expect(later.accepted).toBe(0);
    expect(later.suppressed).toBe(1);

    // The dismissed row itself is untouched: the user can still see what they
    // refused and take it back.
    const rows = await database.db.select().from(insights);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('dismissed');

    // Three feedback rows, append-only, so "why is this hidden?" is answerable.
    const feedback = await database.db.select().from(insightFeedback);
    expect(feedback).toHaveLength(3);
    expect(feedback.every((row) => row.action === 'dismiss')).toBe(true);
  });

  it('cooldown ladder 30/90/permanent', async () => {
    const { world } = await ready();

    // --- rung 1: 30 days ---
    await run(world, EPOCH);
    const [first] = await database.db.select().from(insights);
    expect(first).toBeDefined();
    if (first === undefined) return;
    const one = await reviewInsight(database.db, contextFor(database.userId, clockAt(EPOCH)), {
      insightId: first.id,
      action: 'dismiss',
    });
    expect(one.dismissCount).toBe(1);
    expect(one.suppressedUntil?.toISOString()).toBe(plusDays(30));

    // Day 29: still silenced, and the advisor still finds it.
    const inside = await run(world, plusDays(29));
    expect(inside.suppressed).toBe(1);
    expect(inside.accepted).toBe(0);

    // Day 30: offered again. A cooldown that never expired would be a permanent
    // suppression wearing a date.
    const outside = await run(world, plusDays(30));
    expect(outside.suppressed).toBe(0);
    expect(outside.accepted).toBe(1);

    // --- rung 2: 90 days ---
    const two = await reviewInsight(
      database.db,
      contextFor(database.userId, clockAt(plusDays(30))),
      { insightId: first.id, action: 'dismiss' },
    );
    expect(two.dismissCount).toBe(2);
    expect(two.suppressedUntil?.toISOString()).toBe(plusDays(120));
    expect((await run(world, plusDays(119))).suppressed).toBe(1);
    expect((await run(world, plusDays(120))).accepted).toBe(1);

    // --- rung 3: permanent ---
    const three = await reviewInsight(
      database.db,
      contextFor(database.userId, clockAt(plusDays(120))),
      { insightId: first.id, action: 'dismiss' },
    );
    expect(three.permanent).toBe(true);
    expect(three.suppressedUntil).toBeNull();
    expect((await run(world, plusDays(9999))).suppressed).toBe(1);
  });

  it('a snooze silences without advancing the ladder', async () => {
    const { world } = await ready();
    await run(world, EPOCH);
    const [row] = await database.db.select().from(insights);
    expect(row).toBeDefined();
    if (row === undefined) return;

    for (const day of [0, 10, 20]) {
      await reviewInsight(database.db, contextFor(database.userId, clockAt(plusDays(day))), {
        insightId: row.id,
        action: 'snooze',
        snoozeUntil: new Date(plusDays(day + 7)),
      });
    }

    const [ladder] = await database.db.select().from(insightDismissals);
    // Snoozing three times is not the same statement as refusing three times.
    expect(ladder?.dismissCount).toBe(0);
    expect(ladder?.permanent).toBe(false);
    expect(ladder?.lastAction).toBe('snooze');
  });

  it('the permanent flag cannot be set without three dismissals', async () => {
    // `insight_dismissals_permanent_is_earned` — the ladder's third rung, in
    // SQL, so a bug that set it on the first dismissal fails the write rather
    // than quietly hiding a finding for good.
    const { world, context } = await ready();
    await run(world, EPOCH);
    const [row] = await database.db.select().from(insights);
    expect(row).toBeDefined();
    if (row === undefined) return;
    await reviewInsight(database.db, context, { insightId: row.id, action: 'dismiss' });

    const failure: unknown = await database.db
      .update(insightDismissals)
      .set({ permanent: true, suppressedUntil: null })
      .where(eq(insightDismissals.userId, database.userId))
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect((failure as { cause?: { constraint?: string } }).cause?.constraint).toBe(
      'insight_dismissals_permanent_is_earned',
    );
  });

  it('a reopened finding comes back without waiting for the next run', async () => {
    // Two suppression checks, two moments: `service.ts` refuses to *propose* a
    // silenced finding, `read.ts` refuses to *show* one. A reopen must clear
    // both immediately rather than at 04:15 tomorrow.
    const { world, context } = await ready();
    await run(world, EPOCH);
    const [row] = await database.db.select().from(insights);
    expect(row).toBeDefined();
    if (row === undefined) return;

    await reviewInsight(database.db, context, { insightId: row.id, action: 'dismiss' });
    const hidden = await listInsights(database.db, {
      userId: database.userId,
      now: new Date(EPOCH),
    });
    expect(hidden).toEqual([]);

    await reviewInsight(database.db, context, { insightId: row.id, action: 'reopen' });
    const shown = await listInsights(database.db, {
      userId: database.userId,
      now: new Date(EPOCH),
    });
    expect(shown.map((view) => view.id)).toEqual([row.id]);
    // The count survives the reopen: three refusals are three refusals.
    const [ladder] = await database.db.select().from(insightDismissals);
    expect(ladder?.dismissCount).toBe(1);
    expect(ladder?.permanent).toBe(false);
  });
});
