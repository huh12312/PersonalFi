// SPDX-License-Identifier: MIT
/**
 * Outcome verification and forward validation (09 ADV-4; 05-phase-5-
 * dispatch.md §3 WP 5.9; the §1 cut-line-2 substitute for 07 §8.2's
 * bitemporal backtest), against a real Postgres.
 *
 * The scene is `dedupe-cooldown.test.ts`'s: `scenario()`'s echo advisor,
 * `runAdvisor` to produce and re-produce a real row, `reviewInsight` to
 * accept it the way the route does. `policy/outcomes.ts`'s pure half
 * (`verdictFor`, `isForwardProposal`) is proved in `test/feedback.test.ts`'s
 * neighbourhood by construction — the two functions in this file are the
 * ones that read `insights.last_proposed_at` for real.
 *
 * **Sabotage record**, both against the first test (`'an accepted finding
 * still proposed after its horizon raises exactly one follow-up'`), both
 * red on the first try, both restored — recorded in full, with the reasoning
 * for each, in docs/evidence/phase-5/wp5.9-feedback.md:
 *
 *   1. `isNull(outcome)` removed from *both* the `SELECT` and the `UPDATE` in
 *      `evaluateDueOutcomes` — the second `evaluateDueOutcomes` call
 *      re-selected and re-wrote the already-decided row: `secondPass` read
 *      length 1, not 0. (Removing only one of the two guards left the other
 *      still enforcing "exactly once" — a finding of its own, recorded in
 *      the evidence rather than treated as a failed sabotage.)
 *   2. The join's `lastProposedAt` selected `insights.firstProposedAt`
 *      instead — the finding that really was re-proposed at day 70 then
 *      read its *first* proposal (day 0, frozen) against `due_at` (day 60)
 *      and concluded `ACTED` instead of `INCOMPLETE`: the exact "reads a
 *      proposal that predates the insight" failure forward validation exists
 *      to refuse.
 */
import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { insightOutcomes, insights } from '../../schema/index.ts';
import { evaluateDueOutcomes } from '../../src/policy/outcomes.ts';
import { reviewInsight, runAdvisor } from '../../src/service.ts';
import { grantScopes, registerAdvisor } from '../../src/store.ts';
import {
  EPOCH,
  GRANTED_SCOPES,
  NO_DATABASE,
  clockAt,
  contextFor,
  insightsDatabase,
  scenario,
  type TestDatabase,
} from './harness.ts';

function plusDays(days: number): string {
  return new Date(new Date(EPOCH).getTime() + days * 86_400_000).toISOString();
}

describe.skipIf(NO_DATABASE)('outcome verification and forward validation', () => {
  let database: TestDatabase;

  beforeEach(async () => {
    database ??= await insightsDatabase('outcomes');
    await database.truncate();
  }, 30_000);

  afterAll(async () => {
    await database?.drop();
  }, 30_000);

  async function ready() {
    const world = scenario();
    const context = contextFor(database.userId, clockAt(EPOCH));
    await registerAdvisor(database.db, context, { manifest: world.manifest, enabled: true });
    await grantScopes(database.db, context, world.manifest.advisor_id, [...GRANTED_SCOPES]);
    return { world };
  }

  async function run(world: ReturnType<typeof scenario>, at: string) {
    return runAdvisor(database.db, contextFor(database.userId, clockAt(at)), world.dependencies, {
      advisorId: world.manifest.advisor_id,
      trigger: 'schedule',
    });
  }

  it('an accepted finding still proposed after its horizon raises exactly one follow-up', async () => {
    const { world } = await ready();
    await run(world, EPOCH);
    const [row] = await database.db.select().from(insights);
    expect(row).toBeDefined();
    if (row === undefined) return;

    await reviewInsight(database.db, contextFor(database.userId, clockAt(EPOCH)), {
      insightId: row.id,
      action: 'accept',
    });

    const [outcome] = await database.db.select().from(insightOutcomes);
    expect(outcome?.outcome).toBeNull();
    expect(outcome?.dueAt.toISOString()).toBe(plusDays(60));

    // The advisor keeps finding the same problem, well past the horizon.
    await run(world, plusDays(70));
    const [reProposed] = await database.db.select().from(insights).where(eq(insights.id, row.id));
    expect(reProposed?.lastProposedAt.toISOString()).toBe(plusDays(70));

    const context = contextFor(database.userId, clockAt(plusDays(70)));
    const now = new Date(plusDays(70));
    const firstPass = await evaluateDueOutcomes(database.db, context, now);
    expect(firstPass).toHaveLength(1);
    expect(firstPass[0]?.outcome).toBe('INCOMPLETE');

    // A second evaluation — a retry, a second scheduler tick — raises no
    // second follow-up: the row is already decided.
    const secondPass = await evaluateDueOutcomes(database.db, context, now);
    expect(secondPass).toHaveLength(0);

    const [stored] = await database.db.select().from(insightOutcomes);
    expect(stored?.outcome).toBe('INCOMPLETE');
    expect(stored?.evaluatedAt?.toISOString()).toBe(plusDays(70));
  });

  it('forward validation reads only proposals made after the insight, never before', async () => {
    const { world } = await ready();
    await run(world, EPOCH);
    const [row] = await database.db.select().from(insights);
    expect(row).toBeDefined();
    if (row === undefined) return;

    // The advisor re-proposes once more, but still *before* the user accepts
    // it — this is history the verdict must not read as recurrence.
    await run(world, plusDays(5));
    const [beforeAccept] = await database.db.select().from(insights).where(eq(insights.id, row.id));
    expect(beforeAccept?.lastProposedAt.toISOString()).toBe(plusDays(5));

    await reviewInsight(database.db, contextFor(database.userId, clockAt(plusDays(10))), {
      insightId: row.id,
      action: 'accept',
    });
    const [outcome] = await database.db.select().from(insightOutcomes);
    expect(outcome?.acceptedAt.toISOString()).toBe(plusDays(10));
    expect(outcome?.dueAt.toISOString()).toBe(plusDays(70));

    // Never re-proposed again: last_proposed_at stays frozen at day 5, well
    // before due_at (day 70) — and, notably, before accepted_at (day 10)
    // too. A reader that mistook "was ever proposed more than once" for
    // "recurred after acceptance" would fail this the same way a reader
    // using first_proposed_at instead of last_proposed_at would: both are
    // timestamps that predate the acceptance this row is judged from.
    const evaluated = await evaluateDueOutcomes(
      database.db,
      contextFor(database.userId, clockAt(plusDays(70))),
      new Date(plusDays(70)),
    );
    expect(evaluated).toHaveLength(1);
    expect(evaluated[0]?.outcome).toBe('ACTED');
  });
});
