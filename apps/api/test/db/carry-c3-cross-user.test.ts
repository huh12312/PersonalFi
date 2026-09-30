// SPDX-License-Identifier: MIT
/**
 * WP 5.13b, carrying Phase 4 gate condition C-3 (G4-4:
 * `docs/evidence/phase-4/gate-security-review.md` §2.2, §6).
 *
 * `apps/api/test/db/plan-routes.test.ts` already covers "predicate 1" (Bob
 * naming Alice's goal, with his *own* contribution id) and "predicate 2"
 * (Alice naming her own goal, with a contribution that is not on it). The
 * gate's own §2.2 finding is that neither is the real attack: "'predicate 1'
 * uses Bob's own contribution id, which the route's membership check refuses
 * whatever the scoping" — a test built that way cannot tell "the goal
 * ownership check works" apart from "the contribution never resolved to
 * begin with". This file drives the one combination neither existing test
 * names: **Bob's session, Alice's goal id, and Alice's own contribution id,
 * together** — the pair an attacker who had merely observed Alice's ids (a
 * leaked URL, a shared support ticket) would actually try.
 *
 * Own scratch database (`wp513b-carry-c3`), per the harness's own suite
 * naming (`createApiHarness({ suite })`).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createApiHarness,
  expectStatus,
  NO_DATABASE,
  type ApiHarness,
  type TestSession,
} from '../helpers/api-harness.ts';

const DAY_MS = 86_400_000;
function day(offsetDays: number): string {
  return new Date(Date.now() + offsetDays * DAY_MS).toISOString().slice(0, 10);
}

function moneyJson(minor: string, currency = 'USD'): { minor: string; currency: string } {
  return { minor, currency };
}

interface GoalWire {
  readonly id: string;
}

interface ContributionWire {
  readonly id: string;
  readonly goalId: string;
}

describe.skipIf(NO_DATABASE)('WP 5.13b carry C-3 — the real cross-user contribution attack', () => {
  let h: ApiHarness;
  let bob: TestSession;
  let aliceGoalId: string;
  let aliceContributionId: string;

  beforeAll(async () => {
    h = await createApiHarness({ suite: 'wp513b-carry-c3' });
    const bobId = await h.database.createUser('Bob');
    bob = await h.issueSession({ userId: bobId, fresh: true });

    const goal = await h.request({
      method: 'POST',
      url: '/goals',
      session: h.stale,
      body: {
        kind: 'custom',
        name: "Alice's plan",
        target: moneyJson('500000'),
        targetDate: day(400),
      },
    });
    aliceGoalId = (goal.json() as GoalWire).id;

    const contribution = await h.request({
      method: 'POST',
      url: `/goals/${aliceGoalId}/contributions`,
      session: h.stale,
      body: { cadence: 'monthly', amount: moneyJson('50000'), startsOn: day(0), source: 'USER' },
    });
    aliceContributionId = (contribution.json() as ContributionWire).id;
  }, 60_000);

  afterAll(async () => {
    await h.close();
  });

  it("refuses Bob naming Alice's goal AND Alice's own contribution id, together — the real attack, not the own-contribution decoy", async () => {
    const response = await h.request({
      method: 'DELETE',
      url: `/goals/${aliceGoalId}/contributions/${aliceContributionId}`,
      session: bob,
    });
    expect(response.statusCode).toBe(404);

    // Alice's contribution is untouched by Bob's refused attempt.
    const stillThere = await h.request({
      method: 'GET',
      url: `/goals/${aliceGoalId}/contributions`,
      session: h.stale,
    });
    expectStatus(stillThere, 200);
    expect(
      (stillThere.json() as { contributions: ContributionWire[] }).contributions.map((c) => c.id),
    ).toEqual([aliceContributionId]);
  });
});
