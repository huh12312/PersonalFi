// SPDX-License-Identifier: MIT
/**
 * `/goals`, `/goals/{id}/contributions`, `/risk-profile`, `/plan/scenarios`,
 * `/plan/scenarios/{id}/projections`, `/plan/projections/{id}`,
 * `/plan/required-savings`, `/plan/life-events` and `/plan/compare` (WP 4.8),
 * over a real database.
 *
 * ## Cross-user scoping (dispatch §5 item 8)
 *
 * Every route below is driven twice per resource family — once by the holder
 * who owns the resource, once by a second, freshly created holder ("Bob") —
 * and Bob's request is asserted to see nothing of Alice's and to write
 * nothing under her id. That is a route-level, end-to-end proof that
 * `guards.requireSession(request).userId` is the *only* id that reaches the
 * domain call in every one of these routes: `goals-store.ts`
 * (`wp4.1-goals.md` §7) and `projection-store.ts`/`scenarios.ts`
 * (`wp4.6-projection-service.md` §7) already carry their own per-statement
 * sabotage record for the store underneath, so re-breaking those same
 * statements here would be re-proving someone else's control rather than
 * this WP's own.
 *
 * `DELETE /goals/{id}/contributions/{contributionId}` is the one place this
 * *route* — not the store — adds a second, independent scoping predicate (the
 * contribution must belong to *that* goal, not merely to the caller): the two
 * tests named "predicate 1"/"predicate 2" below each drive the route with
 * only one of the two facts true, and the evidence doc (`wp4.8-routes.md`)
 * records the manual sabotage — each check commented out in
 * `apps/api/src/routes/goals.ts`, this suite re-run and observed red, the
 * file restored and re-hashed — that proves these two tests are load-bearing
 * rather than incidentally green. `/advisors/{id}/grants`'s
 * "not permitted for this kind" check gets the same treatment, recorded in
 * the same evidence doc.
 */
import { computeNetWorth, sealDay, upsertOpenDay } from '@ctx/planning';
import { systemClock } from '@core/kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { planningPortsFor } from '../../src/domain.ts';
import {
  createApiHarness,
  expectStatus,
  NO_DATABASE,
  problemOf,
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
  readonly kind: string;
  readonly name: string;
  readonly target: { minor: string; currency: string };
  readonly targetDate: string;
  readonly status: string;
  readonly fundedFromAccountIds: readonly string[];
}

interface ContributionWire {
  readonly id: string;
  readonly goalId: string;
}

interface ScenarioWire {
  readonly kind: 'baseline' | 'fork';
  readonly id: string;
  readonly name: string;
  readonly seed?: string;
  readonly baselineId?: string;
}

interface RunWire {
  readonly id: string;
  readonly seed: string;
  readonly method: string;
  readonly successProbability: string;
  readonly balancesSealed: boolean;
}

interface OutcomeWire {
  readonly status: string;
  readonly run: RunWire | null;
  readonly percentiles: readonly unknown[];
}

interface LifeEventWire {
  readonly id: string;
  readonly kind: string;
  readonly occursOn: string;
  readonly amount: { minor: string; currency: string };
}

async function sealADay(h: ApiHarness, userId: string, asOfDate: string): Promise<void> {
  const ports = planningPortsFor(h.database.db, { userId, timeZone: 'UTC', clock: systemClock });
  const snapshot = await computeNetWorth(ports, { userId, asOfDate, baseCurrency: 'USD' });
  await upsertOpenDay(h.database.db, { userId, snapshot, clock: systemClock });
  await sealDay(h.database.db, { userId, asOfDate, clock: systemClock });
}

describe.skipIf(NO_DATABASE)('the WP 4.8 plan surface, over a real database', () => {
  let h: ApiHarness;
  let bob: TestSession;
  let bobId: string;
  let sealedDay: string;

  beforeAll(async () => {
    h = await createApiHarness({ suite: 'wp48-plan' });
    sealedDay = day(-2);
    await sealADay(h, h.userId, sealedDay);

    bobId = await h.database.createUser('Bob');
    bob = await h.issueSession({ userId: bobId, fresh: true });
    await sealADay(h, bobId, sealedDay);
  }, 120_000);

  afterAll(async () => {
    await h.close();
  });

  // -------------------------------------------------------------------
  // Goals
  // -------------------------------------------------------------------

  describe('/goals', () => {
    let goalId: string;

    it('401s without a session', async () => {
      const response = await h.request({ method: 'GET', url: '/goals' });
      expect(response.statusCode).toBe(401);
    });

    it('creates, lists, reads and edits a goal', async () => {
      const created = await h.request({
        method: 'POST',
        url: '/goals',
        session: h.stale,
        body: {
          kind: 'purchase',
          name: 'House deposit',
          target: moneyJson('2000000'),
          targetDate: day(420),
          priority: 2,
        },
      });
      expectStatus(created, 201);
      const goal = created.json() as GoalWire;
      goalId = goal.id;
      expect(goal.target).toEqual(moneyJson('2000000'));
      expect(goal.status).toBe('active');

      const listed = await h.request({ method: 'GET', url: '/goals', session: h.stale });
      expectStatus(listed, 200);
      expect((listed.json() as { goals: GoalWire[] }).goals.map((g) => g.id)).toContain(goalId);

      const single = await h.request({ method: 'GET', url: `/goals/${goalId}`, session: h.stale });
      expectStatus(single, 200);
      expect((single.json() as GoalWire).name).toBe('House deposit');

      const patched = await h.request({
        method: 'PATCH',
        url: `/goals/${goalId}`,
        session: h.stale,
        body: { name: 'House deposit fund', priority: 1 },
      });
      expectStatus(patched, 200);
      const updated = patched.json() as GoalWire;
      expect(updated.name).toBe('House deposit fund');
      expect(updated.target).toEqual(moneyJson('2000000')); // unchanged fields survive a partial PATCH
    });

    it('refuses a target date already in the past — a domain 422, never clamped', async () => {
      const response = await h.request({
        method: 'POST',
        url: '/goals',
        session: h.stale,
        body: { kind: 'custom', name: 'Backdated', target: moneyJson('100'), targetDate: day(-30) },
      });
      expect(response.statusCode).toBe(422);
      expect(problemOf(response)['code']).toBe('planning.goal_target_date_in_past');
    });

    it('refuses a funding account that does not exist — named, never dropped from the list', async () => {
      const response = await h.request({
        method: 'POST',
        url: '/goals',
        session: h.stale,
        body: {
          kind: 'custom',
          name: 'Bad funding',
          target: moneyJson('100'),
          targetDate: day(30),
          fundedFromAccountIds: ['00000000-0000-4000-8000-000000000000'],
        },
      });
      expect(response.statusCode).toBe(422);
      expect(problemOf(response)['code']).toBe('planning.goal_funding_account_not_found');
    });

    it("refuses another user's goal — 404, the same as one that never existed", async () => {
      const asBob = await h.request({ method: 'GET', url: `/goals/${goalId}`, session: bob });
      expect(asBob.statusCode).toBe(404);

      const patchAsBob = await h.request({
        method: 'PATCH',
        url: `/goals/${goalId}`,
        session: bob,
        body: { name: 'stolen' },
      });
      expect(patchAsBob.statusCode).toBe(404);

      const deleteAsBob = await h.request({
        method: 'DELETE',
        url: `/goals/${goalId}`,
        session: bob,
      });
      expect(deleteAsBob.statusCode).toBe(404);

      // Bob's own list is empty — Alice's goal is not visible by enumeration either.
      const bobList = await h.request({ method: 'GET', url: '/goals', session: bob });
      expect((bobList.json() as { goals: GoalWire[] }).goals).toEqual([]);

      // And Alice's goal is untouched.
      const stillAlices = await h.request({
        method: 'GET',
        url: `/goals/${goalId}`,
        session: h.stale,
      });
      expect((stillAlices.json() as GoalWire).name).toBe('House deposit fund');
    });
  });

  // -------------------------------------------------------------------
  // Contribution plans, and the two-predicate delete
  // -------------------------------------------------------------------

  describe('/goals/{id}/contributions', () => {
    let aliceGoalId: string;
    let aliceContributionId: string;
    let bobGoalId: string;
    let bobContributionId: string;

    beforeAll(async () => {
      const aliceGoal = await h.request({
        method: 'POST',
        url: '/goals',
        session: h.stale,
        body: {
          kind: 'custom',
          name: 'Alice plan',
          target: moneyJson('500000'),
          targetDate: day(400),
        },
      });
      aliceGoalId = (aliceGoal.json() as GoalWire).id;
      const aliceContribution = await h.request({
        method: 'POST',
        url: `/goals/${aliceGoalId}/contributions`,
        session: h.stale,
        body: { cadence: 'monthly', amount: moneyJson('50000'), startsOn: day(0), source: 'USER' },
      });
      aliceContributionId = (aliceContribution.json() as ContributionWire).id;

      const bobGoal = await h.request({
        method: 'POST',
        url: '/goals',
        session: bob,
        body: {
          kind: 'custom',
          name: 'Bob plan',
          target: moneyJson('500000'),
          targetDate: day(400),
        },
      });
      bobGoalId = (bobGoal.json() as GoalWire).id;
      const bobContribution = await h.request({
        method: 'POST',
        url: `/goals/${bobGoalId}/contributions`,
        session: bob,
        body: { cadence: 'monthly', amount: moneyJson('30000'), startsOn: day(0), source: 'USER' },
      });
      bobContributionId = (bobContribution.json() as ContributionWire).id;
    });

    it('lists and creates normally', async () => {
      const listed = await h.request({
        method: 'GET',
        url: `/goals/${aliceGoalId}/contributions`,
        session: h.stale,
      });
      expectStatus(listed, 200);
      expect(
        (listed.json() as { contributions: ContributionWire[] }).contributions.map((c) => c.id),
      ).toEqual([aliceContributionId]);
    });

    it("predicate 1 (the goal is the caller's) refuses Bob naming Alice's goal with his own contribution id", async () => {
      const response = await h.request({
        method: 'DELETE',
        url: `/goals/${aliceGoalId}/contributions/${bobContributionId}`,
        session: bob,
      });
      expect(response.statusCode).toBe(404);
    });

    it('predicate 2 (the contribution belongs to that goal) refuses Alice naming her own goal but a contribution that is not on it', async () => {
      const response = await h.request({
        method: 'DELETE',
        url: `/goals/${aliceGoalId}/contributions/${bobContributionId}`,
        session: h.stale,
      });
      expect(response.statusCode).toBe(404);
      expect(problemOf(response)['code']).toBe('planning.contribution_not_found');

      // Bob's contribution is untouched by Alice's refused attempt.
      const bobsStill = await h.request({
        method: 'GET',
        url: `/goals/${bobGoalId}/contributions`,
        session: bob,
      });
      expect(
        (bobsStill.json() as { contributions: ContributionWire[] }).contributions.map((c) => c.id),
      ).toEqual([bobContributionId]);
    });

    it('the real thing deletes cleanly', async () => {
      const response = await h.request({
        method: 'DELETE',
        url: `/goals/${aliceGoalId}/contributions/${aliceContributionId}`,
        session: h.stale,
      });
      expectStatus(response, 200);
      expect((response.json() as { deleted: boolean }).deleted).toBe(true);

      const listed = await h.request({
        method: 'GET',
        url: `/goals/${aliceGoalId}/contributions`,
        session: h.stale,
      });
      expect((listed.json() as { contributions: ContributionWire[] }).contributions).toEqual([]);
    });

    it('predicate 2, isolated from any cross-user effect: Alice’s own contribution under Alice’s own, different goal still refuses', async () => {
      // The named "predicate 2" test above pairs Alice's goal with Bob's
      // contribution, which a scoping-only reader could (wrongly) credit to
      // user-id scoping alone, since a stored contribution never resolves
      // across users regardless of this check. This is the same-user version
      // that isolates predicate 2 on its own: two goals and one contribution,
      // all Alice's, paired wrong.
      const otherGoal = await h.request({
        method: 'POST',
        url: '/goals',
        session: h.stale,
        body: {
          kind: 'custom',
          name: "Alice's second goal",
          target: moneyJson('1'),
          targetDate: day(400),
        },
      });
      const otherGoalId = (otherGoal.json() as GoalWire).id;
      const onFirstGoal = await h.request({
        method: 'POST',
        url: `/goals/${aliceGoalId}/contributions`,
        session: h.stale,
        body: { cadence: 'monthly', amount: moneyJson('1000'), startsOn: day(0), source: 'USER' },
      });
      const contributionOnFirstGoal = (onFirstGoal.json() as ContributionWire).id;

      const response = await h.request({
        method: 'DELETE',
        url: `/goals/${otherGoalId}/contributions/${contributionOnFirstGoal}`,
        session: h.stale,
      });
      expect(response.statusCode).toBe(404);
      expect(problemOf(response)['code']).toBe('planning.contribution_not_found');

      // And the contribution is untouched — reachable under its real goal.
      const stillThere = await h.request({
        method: 'GET',
        url: `/goals/${aliceGoalId}/contributions`,
        session: h.stale,
      });
      expect(
        (stillThere.json() as { contributions: ContributionWire[] }).contributions.map((c) => c.id),
      ).toEqual([contributionOnFirstGoal]);
    });

    it('reaching across goals with an unrelated but owned goalId+contributionId pair still refuses', async () => {
      // A further combination: Alice's second goal, paired with Bob's
      // contribution — neither belongs together, and it must still be a
      // plain not-found rather than any kind of scoping bypass.
      const otherGoal = await h.request({
        method: 'POST',
        url: '/goals',
        session: h.stale,
        body: {
          kind: 'custom',
          name: "Alice's third goal",
          target: moneyJson('1'),
          targetDate: day(400),
        },
      });
      const otherGoalId = (otherGoal.json() as GoalWire).id;
      const response = await h.request({
        method: 'DELETE',
        url: `/goals/${otherGoalId}/contributions/${bobContributionId}`,
        session: h.stale,
      });
      expect(response.statusCode).toBe(404);
    });
  });

  // -------------------------------------------------------------------
  // Risk profile
  // -------------------------------------------------------------------

  describe('/risk-profile', () => {
    it('starts with the instrument and no current profile', async () => {
      const response = await h.request({ method: 'GET', url: '/risk-profile', session: bob });
      expectStatus(response, 200);
      const body = response.json() as { instrument: string; items: unknown[]; current: unknown };
      expect(body.instrument).toBe('risk-v1');
      expect(body.items.length).toBe(6);
      expect(body.current).toBeNull();
    });

    it('WP 4.1’s Set B answers move the score to the conservative framing, not the mean', async () => {
      const response = await h.request({
        method: 'PUT',
        url: '/risk-profile',
        session: h.stale,
        body: {
          answers: {
            'drawdown.stated': 'buy_more',
            'drawdown.revealed': 'sold_all',
            'volatility.stated': 'range_wide',
            'volatility.revealed': 'stocks_60_to_80',
            'risk_identity.stated': 'willing',
            'risk_identity.revealed': 'mostly_stocks',
          },
          horizonYears: 20,
          liquidityNeed: 'medium',
          income: { taxableIncome: moneyJson('8400000'), filingStatus: 'single', taxYear: 2026 },
        },
      });
      expectStatus(response, 200);
      const body = response.json() as {
        profile: {
          tolerance: string;
          compositeScore: number;
          unpenalisedScore: number;
          consistencyPenalty: number;
          taxBracketBand: string | null;
        };
        derivation: { toleranceIfAveraged: string };
      };
      expect(body.profile.compositeScore).toBe(18);
      expect(body.profile.unpenalisedScore).toBe(22);
      expect(body.profile.consistencyPenalty).toBe(4);
      expect(body.profile.tolerance).toBe('moderate');
      expect(body.derivation.toleranceIfAveraged).toBe('moderate_aggressive');
      // 08 §4.2: a band, and the income minor units never appear on the wire.
      expect(body.profile.taxBracketBand).toBe('22-32');
      expect(response.body).not.toContain('8400000');

      const getBack = await h.request({ method: 'GET', url: '/risk-profile', session: h.stale });
      const current = (getBack.json() as { current: { compositeScore: number } }).current;
      expect(current.compositeScore).toBe(18);
    });

    it('declining income leaves the band null rather than inventing one', async () => {
      const response = await h.request({
        method: 'PUT',
        url: '/risk-profile',
        session: bob,
        body: {
          answers: {
            'drawdown.stated': 'hold',
            'drawdown.revealed': 'held',
            'volatility.stated': 'range_middle',
            'volatility.revealed': 'stocks_40_to_60',
            'risk_identity.stated': 'balanced',
            'risk_identity.revealed': 'split',
          },
          horizonYears: 10,
          liquidityNeed: 'low',
        },
      });
      expectStatus(response, 200);
      expect(
        (response.json() as { profile: { taxBracketBand: string | null } }).profile.taxBracketBand,
      ).toBeNull();
    });

    it("Bob's GET never shows Alice's profile", async () => {
      const bobsView = await h.request({ method: 'GET', url: '/risk-profile', session: bob });
      const current = (bobsView.json() as { current: { compositeScore: number } | null }).current;
      expect(current).not.toBeNull();
      expect(current?.compositeScore).not.toBe(18); // Bob's own consistent answering, not Alice's
    });
  });

  // -------------------------------------------------------------------
  // Scenarios
  // -------------------------------------------------------------------

  let baselineId: string;
  let forkId: string;

  describe('/plan/scenarios', () => {
    it('states the baseline, and restating it upserts rather than duplicating', async () => {
      const body = {
        kind: 'baseline' as const,
        name: 'My baseline',
        profile: {
          birthDate: '1980-01-01',
          retirementAge: 65,
          planEndAge: 95,
          currency: 'USD',
          glidepath: { kind: 'age_based' as const },
          contributionGrowth: 'flat' as const,
          annualSpending: moneyJson('4000000'),
          withdrawalPolicy: 'constant_real' as const,
          spendingFloor: 'none' as const,
          taxDeferredRate: '0.15',
          socialSecurity: null,
          pensions: [],
          contributions: { TAXABLE: moneyJson('600000') },
        },
      };
      const created = await h.request({
        method: 'POST',
        url: '/plan/scenarios',
        session: h.stale,
        body,
      });
      expectStatus(created, 201);
      const scenario = created.json() as ScenarioWire;
      expect(scenario.kind).toBe('baseline');
      baselineId = scenario.id;

      const restated = await h.request({
        method: 'POST',
        url: '/plan/scenarios',
        session: h.stale,
        body: { ...body, name: 'My baseline, restated' },
      });
      expectStatus(restated, 201);
      const restatedScenario = restated.json() as ScenarioWire;
      expect(restatedScenario.id).toBe(baselineId); // same row, same seed
      expect(restatedScenario.seed).toBe(scenario.seed);

      const listed = await h.request({
        method: 'GET',
        url: '/plan/scenarios',
        session: h.stale,
      });
      expect((listed.json() as { scenarios: ScenarioWire[] }).scenarios.map((s) => s.id)).toContain(
        baselineId,
      );
    });

    it('forks the baseline, storing only the levers that differ', async () => {
      const response = await h.request({
        method: 'POST',
        url: '/plan/scenarios',
        session: h.stale,
        body: {
          kind: 'fork',
          name: 'Spend a bit less',
          levers: { annualSpending: moneyJson('3600000') },
        },
      });
      expectStatus(response, 201);
      const scenario = response.json() as ScenarioWire;
      expect(scenario.kind).toBe('fork');
      expect(scenario.baselineId).toBe(baselineId);
      forkId = scenario.id;
    });

    it('a fork that restates every lever is refused, 422', async () => {
      const response = await h.request({
        method: 'POST',
        url: '/plan/scenarios',
        session: h.stale,
        body: { kind: 'fork', name: 'No-op fork', levers: {} },
      });
      expect(response.statusCode).toBe(422);
      expect(problemOf(response)['code']).toBe('planning.scenario_levers_empty');
    });

    it("Bob's scenario list never contains Alice's baseline or fork", async () => {
      const bobsList = await h.request({
        method: 'GET',
        url: '/plan/scenarios',
        session: bob,
      });
      const ids = (bobsList.json() as { scenarios: ScenarioWire[] }).scenarios.map((s) => s.id);
      expect(ids).not.toContain(baselineId);
      expect(ids).not.toContain(forkId);
    });
  });

  // -------------------------------------------------------------------
  // Projections
  // -------------------------------------------------------------------

  describe('/plan/scenarios/{id}/projections and /plan/projections/{id}', () => {
    let runId: string;

    it('runs a deterministic projection, caches an identical repeat, and never expresses successProbability as a JSON number', async () => {
      const first = await h.request({
        method: 'POST',
        url: `/plan/scenarios/${baselineId}/projections`,
        session: h.stale,
        body: { method: 'deterministic' },
      });
      expectStatus(first, 200);
      // The wire assertion, on the raw body text: a quoted string, never a bare number.
      expect(first.body).toMatch(/"successProbability":"[^"]*"/);
      const outcome = first.json() as OutcomeWire;
      expect(outcome.status).toBe('computed');
      expect(typeof outcome.run?.successProbability).toBe('string');
      expect(outcome.run?.balancesSealed).toBe(true);
      runId = outcome.run?.id as string;

      const second = await h.request({
        method: 'POST',
        url: `/plan/scenarios/${baselineId}/projections`,
        session: h.stale,
        body: { method: 'deterministic' },
      });
      expectStatus(second, 200);
      expect((second.json() as OutcomeWire).status).toBe('cached');
      expect((second.json() as OutcomeWire).run?.id).toBe(runId);
    });

    it('runs a real Monte Carlo projection (or falls back honestly, and says which)', async () => {
      const response = await h.request({
        method: 'POST',
        url: `/plan/scenarios/${forkId}/projections`,
        session: h.stale,
        body: { method: 'monte_carlo', paths: 200 },
      });
      expectStatus(response, 200);
      const outcome = response.json() as OutcomeWire;
      expect(['deterministic', 'monte_carlo']).toContain(outcome.run?.method);
      expect(response.body).toMatch(/"successProbability":"[^"]*"/);
      if (outcome.run?.method === 'monte_carlo') {
        expect(Number(outcome.run.successProbability)).toBeGreaterThanOrEqual(0);
        expect(Number(outcome.run.successProbability)).toBeLessThanOrEqual(1);
      }
    });

    it('GET /plan/projections/{id} reads the stored run back, never recomputing', async () => {
      const response = await h.request({
        method: 'GET',
        url: `/plan/projections/${runId}`,
        session: h.stale,
      });
      expectStatus(response, 200);
      const body = response.json() as OutcomeWire;
      expect(body.run?.id).toBe(runId);
      expect(body.status).toBe('computed');
    });

    it("refuses another user's scenario and run, 404", async () => {
      const projectAsBob = await h.request({
        method: 'POST',
        url: `/plan/scenarios/${baselineId}/projections`,
        session: bob,
        body: { method: 'deterministic' },
      });
      expect(projectAsBob.statusCode).toBe(404);

      const readAsBob = await h.request({
        method: 'GET',
        url: `/plan/projections/${runId}`,
        session: bob,
      });
      expect(readAsBob.statusCode).toBe(404);
    });
  });

  // -------------------------------------------------------------------
  // Required savings
  // -------------------------------------------------------------------

  describe('/plan/required-savings', () => {
    it('a target date less than a year away is unreachable — no_contribution_window, and no monthly field at all', async () => {
      const response = await h.request({
        method: 'POST',
        url: '/plan/required-savings',
        session: h.stale,
        body: {
          objective: {
            kind: 'wealth_at',
            targetDate: day(30),
            target: moneyJson('100000000'),
            basis: 'real',
          },
          maxMonthly: moneyJson('100000'),
        },
      });
      expectStatus(response, 200);
      const body = response.json() as { kind: string; constraint?: { name: string } };
      expect(body.kind).toBe('unreachable');
      expect(body.constraint?.name).toBe('no_contribution_window');
      expect(response.body).not.toContain('"monthly"');
    });

    it('a ceiling far below the gap is unreachable — monthly_ceiling, with the shortfall in dollars, never implying a solution', async () => {
      const response = await h.request({
        method: 'POST',
        url: '/plan/required-savings',
        session: h.stale,
        body: {
          objective: {
            kind: 'wealth_at',
            targetDate: day(420),
            target: moneyJson('2000000000'), // $20,000,000 — nothing at this ceiling reaches it
            basis: 'real',
          },
          maxMonthly: moneyJson('1000'), // $10/month
        },
      });
      expectStatus(response, 200);
      const body = response.json() as {
        kind: string;
        constraint?: { name: string; ceiling: unknown; gapAtCeiling: unknown };
      };
      expect(body.kind).toBe('unreachable');
      expect(body.constraint?.name).toBe('monthly_ceiling');
      expect(body.constraint?.ceiling).toEqual(moneyJson('1000'));
      expect(response.body).not.toContain('"monthly"');
    });

    it('a trivial target is already met, with no engine call implied by the shape', async () => {
      const response = await h.request({
        method: 'POST',
        url: '/plan/required-savings',
        session: h.stale,
        body: {
          objective: {
            kind: 'wealth_at',
            targetDate: day(1800),
            target: moneyJson('1'),
            basis: 'real',
          },
          maxMonthly: moneyJson('100000'),
        },
      });
      expectStatus(response, 200);
      expect((response.json() as { kind: string }).kind).toBe('already_met');
    });

    it("solves against a goal's own target and date when goalId is given", async () => {
      const goal = await h.request({
        method: 'POST',
        url: '/goals',
        session: h.stale,
        body: {
          kind: 'purchase',
          name: 'Required-savings goal',
          target: moneyJson('2000000000'),
          targetDate: day(420),
        },
      });
      const goalId = (goal.json() as GoalWire).id;
      const response = await h.request({
        method: 'POST',
        url: '/plan/required-savings',
        session: h.stale,
        body: { goalId, maxMonthly: moneyJson('1000') },
      });
      expectStatus(response, 200);
      const body = response.json() as { kind: string; constraint?: { name: string } };
      expect(body.kind).toBe('unreachable');
      expect(body.constraint?.name).toBe('monthly_ceiling');
    });

    it('refuses a body with neither a goalId nor an objective', async () => {
      const response = await h.request({
        method: 'POST',
        url: '/plan/required-savings',
        session: h.stale,
        body: { maxMonthly: moneyJson('1000') },
      });
      expect(response.statusCode).toBe(400);
    });

    it("refuses another user's goal id", async () => {
      const goal = await h.request({
        method: 'POST',
        url: '/goals',
        session: h.stale,
        body: {
          kind: 'custom',
          name: 'Alice-only',
          target: moneyJson('100000'),
          targetDate: day(400),
        },
      });
      const goalId = (goal.json() as GoalWire).id;
      const response = await h.request({
        method: 'POST',
        url: '/plan/required-savings',
        session: bob,
        body: { goalId, maxMonthly: moneyJson('1000') },
      });
      expect(response.statusCode).toBe(404);
    });
  });

  // -------------------------------------------------------------------
  // Life events
  // -------------------------------------------------------------------

  describe('/plan/life-events', () => {
    let eventId: string;

    it('creates, lists, moves and deletes a life event', async () => {
      const created = await h.request({
        method: 'POST',
        url: '/plan/life-events',
        session: h.stale,
        body: { kind: 'windfall', name: 'Bonus', occursOn: day(60), amount: moneyJson('500000') },
      });
      expectStatus(created, 201);
      eventId = (created.json() as LifeEventWire).id;

      const listed = await h.request({
        method: 'GET',
        url: '/plan/life-events',
        session: h.stale,
      });
      expect(
        (listed.json() as { lifeEvents: LifeEventWire[] }).lifeEvents.map((e) => e.id),
      ).toContain(eventId);

      const moved = await h.request({
        method: 'PATCH',
        url: `/plan/life-events/${eventId}`,
        session: h.stale,
        body: { occursOn: day(90) },
      });
      expectStatus(moved, 200);
      expect((moved.json() as LifeEventWire).occursOn).toBe(day(90));

      const deleted = await h.request({
        method: 'DELETE',
        url: `/plan/life-events/${eventId}`,
        session: h.stale,
      });
      expectStatus(deleted, 200);
      expect((deleted.json() as { deleted: boolean }).deleted).toBe(true);
    });

    it('refuses a sign mismatch — a home purchase must be negative', async () => {
      const response = await h.request({
        method: 'POST',
        url: '/plan/life-events',
        session: h.stale,
        body: {
          kind: 'home_purchase',
          name: 'Condo',
          occursOn: day(60),
          amount: moneyJson('500000'), // positive: wrong
        },
      });
      expect(response.statusCode).toBe(422);
      expect(problemOf(response)['code']).toBe('planning.life_event_sign_mismatch');
    });

    it("refuses another user's life event", async () => {
      const created = await h.request({
        method: 'POST',
        url: '/plan/life-events',
        session: h.stale,
        body: { kind: 'inheritance', name: 'Gift', occursOn: day(60), amount: moneyJson('100000') },
      });
      const id = (created.json() as LifeEventWire).id;

      const patchAsBob = await h.request({
        method: 'PATCH',
        url: `/plan/life-events/${id}`,
        session: bob,
        body: { name: 'stolen' },
      });
      expect(patchAsBob.statusCode).toBe(404);

      const deleteAsBob = await h.request({
        method: 'DELETE',
        url: `/plan/life-events/${id}`,
        session: bob,
      });
      expect(deleteAsBob.statusCode).toBe(404);

      const bobsList = await h.request({
        method: 'GET',
        url: '/plan/life-events',
        session: bob,
      });
      expect((bobsList.json() as { lifeEvents: LifeEventWire[] }).lifeEvents).toEqual([]);
    });
  });

  // -------------------------------------------------------------------
  // Compare
  // -------------------------------------------------------------------

  describe('/plan/compare', () => {
    it('compares the baseline and its fork under a shared seed', async () => {
      const response = await h.request({
        method: 'GET',
        url: `/plan/compare?a=${baselineId}&b=${forkId}&method=deterministic`,
        session: h.stale,
      });
      expectStatus(response, 200);
      const body = response.json() as {
        a: OutcomeWire;
        b: OutcomeWire;
        seed: string;
        successProbabilityDelta: string;
        retirementDeltaMonths: number;
      };
      expect(body.a.run?.seed).toBe(body.seed);
      expect(body.b.run?.seed).toBe(body.seed);
      expect(typeof body.successProbabilityDelta).toBe('string');
    });

    it("refuses another user's scenario ids", async () => {
      const response = await h.request({
        method: 'GET',
        url: `/plan/compare?a=${baselineId}&b=${forkId}&method=deterministic`,
        session: bob,
      });
      expect(response.statusCode).toBe(404);
    });
  });
});
