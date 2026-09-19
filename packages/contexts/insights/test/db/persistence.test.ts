// SPDX-License-Identifier: MIT
/**
 * `pending_review` persistence, and the kill switches, against a real Postgres.
 *
 * `test/pending-review.test.ts` proves an advisor cannot *express* another
 * status. This proves a row cannot *hold* one: the insert writes the literal,
 * the constraint pairs `status` with `reviewed_at`, and the only writer of a
 * non-pending row is the user's own action.
 *
 * **Sabotage record.** `"a quarantined advisor's output never reaches
 * pending_review"` was run once with `decideRun`'s `quarantinedAt` branch
 * removed, and observed red on the first try — the advisor ran and its insight
 * landed. Restored. Recorded in docs/evidence/phase-2/wp2.6-insights.md §4.
 */
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { advisorRuns, advisors, insightEvidence, insights } from '../../schema/index.ts';
import { reviewInsight, runAdvisor } from '../../src/service.ts';
import {
  grantScopes,
  quarantineAdvisor,
  registerAdvisor,
  setAdvisorEnabled,
} from '../../src/store.ts';
import { listInsights } from '../../src/read.ts';
import { responseFor } from '../fixtures.ts';
import {
  CORRELATION_ID,
  EPOCH,
  GRANTED_SCOPES,
  NO_DATABASE,
  contextFor,
  insightsDatabase,
  scenario,
  selfCiting,
  type TestDatabase,
} from './harness.ts';

describe.skipIf(NO_DATABASE)('pending_review persistence', () => {
  let database: TestDatabase;

  beforeEach(async () => {
    database ??= await insightsDatabase('persist');
    await database.truncate();
  }, 30_000);

  afterAll(async () => {
    await database?.drop();
  }, 30_000);

  async function enable(manifest: Parameters<typeof registerAdvisor>[2]['manifest']) {
    const context = contextFor(database.userId);
    await registerAdvisor(database.db, context, { manifest, enabled: true });
    await grantScopes(database.db, context, manifest.advisor_id, [...GRANTED_SCOPES]);
    return context;
  }

  it('a validated insight is persisted as pending_review', async () => {
    const world = scenario();
    const context = await enable(world.manifest);

    const result = await runAdvisor(database.db, context, world.dependencies, {
      advisorId: world.manifest.advisor_id,
      trigger: 'manual',
    });
    expect(result.status).toBe('completed');
    expect(result.rejections).toEqual([]);
    expect(result.accepted).toBe(1);
    expect(result.inserted).toBe(1);

    const rows = await database.db.select().from(insights);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('pending_review');
    expect(rows[0]?.reviewedAt).toBeNull();
    expect(rows[0]?.inputDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    // The digest on the insight is the digest of the run that proposed it.
    const runs = await database.db.select().from(advisorRuns);
    expect(runs[0]?.inputDigest).toBe(rows[0]?.inputDigest);
    expect(runs[0]?.status).toBe('completed');
    expect(runs[0]?.emittedScopes).toEqual(['cash.summary']);

    // And the evidence landed with it, resolvable.
    const evidence = await database.db.select().from(insightEvidence);
    expect(evidence).toHaveLength(1);
    expect(evidence[0]?.sourceRef).toBe('snapshot:cash_summary.as_of');
    expect(evidence[0]?.resolvedDisplay).toBe('2026-09-19');
  });

  it('no advisor return value produces status other than pending_review', async () => {
    // The advisor tries every shape `pending-review.test.ts` enumerates, at the
    // database boundary this time. Each is refused before any row is written,
    // so the queue is empty rather than holding an insight with a status
    // somebody has to notice is wrong.
    for (const extra of [
      { status: 'accepted' },
      { requires_review: false },
      { reviewed_at: EPOCH },
    ]) {
      await database.truncate();
      const world = scenario({
        respond: (request) => responseFor(request, [{ ...selfCiting(request), ...extra } as never]),
      });
      const context = await enable(world.manifest);
      const result = await runAdvisor(database.db, context, world.dependencies, {
        advisorId: world.manifest.advisor_id,
        trigger: 'manual',
      });
      expect(result.status, JSON.stringify(extra)).toBe('failed');
      expect(await database.db.select().from(insights)).toEqual([]);
    }
  });

  it('the status column refuses a review with no timestamp', async () => {
    // `insights_reviewed_has_timestamp`. Nothing leaves `pending_review`
    // without a recorded review, enforced in SQL so a row written by any path
    // carries it — including a future route nobody has written yet.
    const world = scenario();
    const context = await enable(world.manifest);
    await runAdvisor(database.db, context, world.dependencies, {
      advisorId: world.manifest.advisor_id,
      trigger: 'manual',
    });

    // Asserted on the *constraint name* rather than on the message: Drizzle
    // wraps a driver error in one whose `message` is the SQL it sent, so
    // `toThrow(/name/)` would pass for any failure of this statement — an
    // assertion that cannot tell "the constraint fired" from "the column does
    // not exist" is not an assertion about the constraint.
    const failure: unknown = await database.db
      .update(insights)
      .set({ status: 'accepted', reviewedAt: null })
      .where(eq(insights.userId, database.userId))
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(failure).not.toBeNull();
    expect((failure as { cause?: { constraint?: string } }).cause?.constraint).toBe(
      'insights_reviewed_has_timestamp',
    );
  });

  it('the only writer of a non-pending row is the user', async () => {
    const world = scenario();
    const context = await enable(world.manifest);
    await runAdvisor(database.db, context, world.dependencies, {
      advisorId: world.manifest.advisor_id,
      trigger: 'manual',
    });
    const [row] = await database.db.select().from(insights);
    expect(row).toBeDefined();
    if (row === undefined) return;

    const review = await reviewInsight(database.db, context, {
      insightId: row.id,
      action: 'accept',
    });
    expect(review.status).toBe('accepted');

    const [after] = await database.db.select().from(insights);
    expect(after?.status).toBe('accepted');
    expect(after?.reviewedAt).not.toBeNull();

    // An `insights.InsightAccepted` was appended in the same transaction.
    const events = await database.db.execute(
      sql`SELECT event_type FROM domain_events ORDER BY seq`,
    );
    expect(events.rows.map((event) => (event as { event_type: string }).event_type)).toContain(
      'insights.InsightAccepted',
    );
  });
});

describe.skipIf(NO_DATABASE)('kill switches', () => {
  let database: TestDatabase;

  beforeEach(async () => {
    database ??= await insightsDatabase('switches');
    await database.truncate();
  }, 30_000);

  afterAll(async () => {
    await database?.drop();
  }, 30_000);

  async function register(enabled: boolean) {
    const world = scenario();
    const context = contextFor(database.userId);
    await registerAdvisor(database.db, context, { manifest: world.manifest, enabled });
    await grantScopes(database.db, context, world.manifest.advisor_id, [...GRANTED_SCOPES]);
    return { world, context };
  }

  it("a quarantined advisor's output never reaches pending_review", async () => {
    const { world, context } = await register(true);

    // It works first.
    const before = await runAdvisor(database.db, context, world.dependencies, {
      advisorId: world.manifest.advisor_id,
      trigger: 'manual',
    });
    expect(before.status).toBe('completed');
    expect(await database.db.select().from(insights)).toHaveLength(1);
    await database.db.delete(insights).where(eq(insights.userId, database.userId));

    // Then the breaker trips.
    await quarantineAdvisor(database.db, context, world.manifest.advisor_id, 'rejection_rate');

    const after = await runAdvisor(database.db, context, world.dependencies, {
      advisorId: world.manifest.advisor_id,
      trigger: 'manual',
    });
    expect(after.status).toBe('refused');
    expect(after.refusal).toBe('advisor_quarantined');
    expect(await database.db.select().from(insights)).toEqual([]);

    // Nothing was even built: a refused run has no digest, because the refusal
    // happens before the snapshot exists. That is a stronger claim than "we
    // dropped its output".
    const runs = await database.db
      .select()
      .from(advisorRuns)
      .where(eq(advisorRuns.status, 'refused'));
    expect(runs).toHaveLength(1);
    expect(runs[0]?.inputDigest).toBeNull();
    expect(runs[0]?.proposedCount).toBe(0);
    expect(runs[0]?.refusal).toBe('advisor_quarantined');
  });

  it('each of the three switches refuses independently', async () => {
    const cases = [
      ['advisors_disabled', { advisorsEnabled: false }, true],
      ['module_disabled', { moduleEnabled: false }, true],
      ['advisor_disabled', {}, false],
    ] as const;

    for (const [refusal, settings, enabled] of cases) {
      await database.truncate();
      const world = scenario({ settings });
      const context = contextFor(database.userId);
      await registerAdvisor(database.db, context, { manifest: world.manifest, enabled });
      await grantScopes(database.db, context, world.manifest.advisor_id, [...GRANTED_SCOPES]);

      const result = await runAdvisor(database.db, context, world.dependencies, {
        advisorId: world.manifest.advisor_id,
        trigger: 'schedule',
      });
      expect(result.status, refusal).toBe('refused');
      expect(result.refusal, refusal).toBe(refusal);
      expect(await database.db.select().from(insights), refusal).toEqual([]);
      // Observable: a refused run has a row saying which switch did it, because
      // an absence of rows is also what a broken scheduler looks like.
      const runs = await database.db.select().from(advisorRuns);
      expect(runs, refusal).toHaveLength(1);
      expect(runs[0]?.refusal, refusal).toBe(refusal);
    }
  });

  it('a newly registered advisor is off until somebody turns it on', async () => {
    const { world, context } = await register(false);
    const first = await runAdvisor(database.db, context, world.dependencies, {
      advisorId: world.manifest.advisor_id,
      trigger: 'manual',
    });
    expect(first.refusal).toBe('advisor_disabled');

    await setAdvisorEnabled(database.db, context, world.manifest.advisor_id, true);
    const second = await runAdvisor(database.db, context, world.dependencies, {
      advisorId: world.manifest.advisor_id,
      trigger: 'manual',
    });
    expect(second.status).toBe('completed');
  });

  it('re-registering a newer version does not re-enable or un-quarantine', async () => {
    // A version bump is not a reason to forget that the breaker tripped last
    // night, or that the user switched this advisor off.
    const { world, context } = await register(true);
    await quarantineAdvisor(
      database.db,
      context,
      world.manifest.advisor_id,
      'consecutive_failures',
    );

    await registerAdvisor(database.db, context, {
      manifest: { ...world.manifest, version: '1.1.0' },
    });

    const [row] = await database.db
      .select()
      .from(advisors)
      .where(
        and(
          eq(advisors.userId, database.userId),
          eq(advisors.advisorId, world.manifest.advisor_id),
        ),
      );
    expect(row?.version).toBe('1.1.0');
    expect(row?.quarantinedAt).not.toBeNull();
    expect(row?.quarantineReason).toBe('consecutive_failures');
  });

  it('a validator that refuses most of a run quarantines the advisor', async () => {
    // The breaker's second trigger. An advisor whose output is mostly
    // unciteable is not having a bad night, and it never throws.
    const world = scenario({
      respond: (request) =>
        responseFor(request, [
          selfCiting(request, { key: 'ok.1' }),
          selfCiting(request, {
            key: 'bad.1',
            evidence: [
              {
                kind: 'metric',
                label: 'Invented',
                value: null,
                source_ref: 'snapshot:budgets_status.ready_to_assign',
                url: null,
              },
            ],
          }),
          selfCiting(request, {
            key: 'bad.2',
            evidence: [
              {
                kind: 'metric',
                label: 'Invented',
                value: null,
                source_ref: 'snapshot:holdings_detail.positions[0].symbol',
                url: null,
              },
            ],
          }),
          selfCiting(request, {
            key: 'bad.3',
            summary_md: 'You will save $4,912 a year.',
          }),
        ]),
    });
    const context = contextFor(database.userId);
    await registerAdvisor(database.db, context, { manifest: world.manifest, enabled: true });
    await grantScopes(database.db, context, world.manifest.advisor_id, [...GRANTED_SCOPES]);

    const result = await runAdvisor(database.db, context, world.dependencies, {
      advisorId: world.manifest.advisor_id,
      trigger: 'schedule',
    });
    expect(result.status).toBe('completed');
    expect(result.accepted).toBe(1);
    expect(result.rejected).toBe(3);
    expect(result.quarantined).toBe(true);

    const [row] = await database.db.select().from(advisors);
    expect(row?.quarantineReason).toBe('rejection_rate');

    // The per-step detail is kept, because "advisor X keeps failing step 7" is
    // the question this table exists to answer and a count cannot.
    const [run] = await database.db.select().from(advisorRuns);
    expect(run?.rejections).toHaveLength(3);
    expect((run?.rejections ?? []).map((rejection) => rejection['step'])).toEqual([
      'evidence',
      'evidence',
      'numerals',
    ]);

    // And the next run is refused outright.
    const next = await runAdvisor(database.db, context, world.dependencies, {
      advisorId: world.manifest.advisor_id,
      trigger: 'schedule',
    });
    expect(next.refusal).toBe('advisor_quarantined');
  });

  it('the feed is empty and the app is usable with advisors off', async () => {
    const world = scenario({ settings: { advisorsEnabled: false } });
    const context = contextFor(database.userId);
    await registerAdvisor(database.db, context, { manifest: world.manifest, enabled: true });
    await runAdvisor(database.db, context, world.dependencies, {
      advisorId: world.manifest.advisor_id,
      trigger: 'schedule',
    });
    // The read model answers, with nothing in it. A feed that threw when
    // advisors were off would take the dashboard down with them.
    await expect(
      listInsights(database.db, { userId: database.userId, now: new Date(EPOCH) }),
    ).resolves.toEqual([]);
    expect(CORRELATION_ID).toMatch(/^[0-9a-f-]{36}$/);
  });
});
