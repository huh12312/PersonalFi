// SPDX-License-Identifier: MIT
/**
 * WP 10.15 (V8), migration `0051_insight_feedback.sql`: an insight's bookmark and the holder's "was this helpful?"
 * answer persist on the row, are read back through `listInsights`, are scoped to their holder by two predicates,
 * are refused by the database when malformed, and never touch the review-action log that drives policy.
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '@core/kernel';
import { createTestDatabase } from '@core/testkit';
import {
  InsightFeedbackReasonError,
  listInsights,
  setInsightBookmark,
  setInsightFeedback,
} from '../../src/index.ts';
import { NO_DATABASE, type TestDatabase } from './harness.ts';

async function seedInsight(database: TestDatabase, userId: string, key: string): Promise<string> {
  const id = newId();
  // fixture: insights row written by raw insert because upsertInsight needs a ValidatedInsight from a full advisor
  // run; these are exactly its NOT NULL columns, and the bookmark/feedback columns start NULL as 0051 leaves them.
  await database.db.execute(sql`
    INSERT INTO insights (
      id, user_id, advisor_id, advisor_version, key, period, type, severity,
      title, summary_md, confidence, confidence_basis, horizon, input_digest
    ) VALUES (
      ${id}::uuid, ${userId}::uuid, 'builtin.example', '1.0.0', ${key}, 'all_time',
      'example.finding', 'notable', 't', 's', 0.9, 'deterministic', 'this_year', ${'sha256:' + '0'.repeat(64)}
    )
  `);
  return id;
}

async function viewOf(database: TestDatabase, userId: string, id: string) {
  const views = await listInsights(database.db, { userId, statuses: [], now: null });
  return views.find((view) => view.id === id);
}

async function policyRows(
  database: TestDatabase,
): Promise<{ feedback: number; dismissals: number }> {
  const result = await database.db.execute<{ feedback: number; dismissals: number }>(sql`
    SELECT (SELECT count(*)::int FROM insight_feedback) AS feedback,
           (SELECT count(*)::int FROM insight_dismissals) AS dismissals
  `);
  return result.rows[0] ?? { feedback: -1, dismissals: -1 };
}

describe.skipIf(NO_DATABASE)('an insight bookmark and helpfulness (0051)', () => {
  let database: TestDatabase;
  let other: string;

  beforeAll(async () => {
    database = await createTestDatabase('wp1015_ins_bookmarks');
    other = await database.createUser('Other Holder');
  }, 60_000);

  afterAll(async () => {
    await database?.drop();
  }, 60_000);

  it('a bookmark persists and reads back, and un-bookmarking clears it', async () => {
    const id = await seedInsight(database, database.userId, 'bookmark');
    expect((await viewOf(database, database.userId, id))?.bookmarkedAt).toBeNull();
    const at = new Date('2026-10-18T12:00:00.000Z');
    const set = await setInsightBookmark(database.db, database.userId, id, true, at);
    expect(set).toEqual({ insightId: id, bookmarkedAt: at });
    expect((await viewOf(database, database.userId, id))?.bookmarkedAt?.toISOString()).toBe(
      at.toISOString(),
    );
    await setInsightBookmark(database.db, database.userId, id, false, at);
    expect((await viewOf(database, database.userId, id))?.bookmarkedAt).toBeNull();
  });

  it('feedback persists with its reason; helpful drops the reason; null clears both', async () => {
    const id = await seedInsight(database, database.userId, 'feedback');
    expect(
      await setInsightFeedback(database.db, database.userId, id, 'not_helpful', 'NOT_ACTIONABLE'),
    ).toEqual({
      insightId: id,
      feedback: 'not_helpful',
      feedbackReason: 'NOT_ACTIONABLE',
    });
    let view = await viewOf(database, database.userId, id);
    expect([view?.feedback, view?.feedbackReason]).toEqual(['not_helpful', 'NOT_ACTIONABLE']);
    await setInsightFeedback(database.db, database.userId, id, 'helpful', null);
    view = await viewOf(database, database.userId, id);
    expect([view?.feedback, view?.feedbackReason]).toEqual(['helpful', null]);
    await setInsightFeedback(database.db, database.userId, id, 'not_helpful', 'NOT_TRUE');
    await setInsightFeedback(database.db, database.userId, id, null, null);
    view = await viewOf(database, database.userId, id);
    expect([view?.feedback, view?.feedbackReason]).toEqual([null, null]);
    await expect(
      setInsightFeedback(database.db, database.userId, id, 'helpful', 'NOT_TRUE'),
    ).rejects.toBeInstanceOf(InsightFeedbackReasonError);
  });

  it("another holder's insight is neither bookmarked nor answered, and reads unchanged", async () => {
    const id = await seedInsight(database, database.userId, 'cross-user');
    const now = new Date('2026-10-18T12:00:00.000Z');
    expect(await setInsightBookmark(database.db, other, id, true, now)).toBeNull();
    expect(await setInsightFeedback(database.db, other, id, 'not_helpful', 'DONT_CARE')).toBeNull();
    const view = await viewOf(database, database.userId, id);
    expect([view?.bookmarkedAt, view?.feedback, view?.feedbackReason]).toEqual([null, null, null]);
  });

  it('the database refuses an unknown answer, an unknown reason, and a reason without "not helpful"', async () => {
    const id = await seedInsight(database, database.userId, 'checks');
    /** The constraint Postgres names (drizzle wraps the driver error; the code is in `cause`). */
    async function refusedBy(fragment: ReturnType<typeof sql>): Promise<string> {
      try {
        await database.db.execute(sql`UPDATE insights SET ${fragment} WHERE id = ${id}::uuid`);
      } catch (error) {
        const cause = (error as { cause?: { constraint?: string; code?: string } }).cause;
        return `${cause?.code ?? '?'}:${cause?.constraint ?? '?'}`;
      }
      return 'accepted';
    }
    expect(await refusedBy(sql`feedback = 'meh'`)).toBe('23514:insights_feedback_check');
    expect(await refusedBy(sql`feedback = 'not_helpful', feedback_reason = 'BORED'`)).toBe(
      '23514:insights_feedback_reason_check',
    );
    expect(await refusedBy(sql`feedback = 'helpful', feedback_reason = 'NOT_TRUE'`)).toBe(
      '23514:insights_feedback_reason_requires_not_helpful',
    );
    expect(await refusedBy(sql`feedback_reason = 'NOT_TRUE'`)).toBe(
      '23514:insights_feedback_reason_requires_not_helpful',
    );
    expect(await refusedBy(sql`feedback = 'not_helpful', feedback_reason = 'LATER'`)).toBe(
      'accepted',
    );
  });

  it('neither write touches the review-action log or the cooldown ladder', async () => {
    const before = await policyRows(database);
    const id = await seedInsight(database, database.userId, 'policy');
    await setInsightBookmark(
      database.db,
      database.userId,
      id,
      true,
      new Date('2026-10-18T12:00:00.000Z'),
    );
    await setInsightFeedback(database.db, database.userId, id, 'not_helpful', 'NOT_TRUE');
    expect(await policyRows(database)).toEqual(before);
    const status = await database.db.execute<{ status: string }>(
      sql`SELECT status FROM insights WHERE id = ${id}::uuid`,
    );
    expect(status.rows[0]?.status).toBe('pending_review');
  });
});
