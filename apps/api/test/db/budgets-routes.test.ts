// SPDX-License-Identifier: MIT
/**
 * `/budgets/*` — WP 2.r's REST surface over `@ctx/budgeting`, over a real
 * database. Session-only throughout (see `routes/budgets.ts`'s module
 * comment for why no route here needs a step-up assertion).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createApiHarness,
  expectStatus,
  problemOf,
  NO_DATABASE,
  type ApiHarness,
} from '../helpers/api-harness.ts';

interface WireCategory {
  readonly id: string;
  readonly assignable: boolean;
}
interface WireLine {
  readonly id: string;
  readonly categoryId: string | null;
  readonly assigned: { minor: string; currency: string };
  readonly available: { minor: string; currency: string };
}
interface WirePeriod {
  readonly id: string;
  readonly readyToAssign: { minor: string; currency: string };
  readonly lines: readonly WireLine[];
}

async function firstAssignableCategoryId(h: ApiHarness): Promise<string> {
  const response = await h.request({ method: 'GET', url: '/categories', session: h.stale });
  expectStatus(response, 200);
  const { categories } = response.json() as { categories: WireCategory[] };
  const leaf = categories.find((category) => category.assignable);
  if (leaf === undefined) throw new Error('no assignable category seeded');
  return leaf.id;
}

describe.skipIf(NO_DATABASE)('/budgets (WP 2.r)', () => {
  let h: ApiHarness;
  let categoryId: string;

  beforeAll(async () => {
    h = await createApiHarness({ suite: 'wp-budgets' });
    categoryId = await firstAssignableCategoryId(h);
  }, 120_000);

  afterAll(async () => {
    await h.close();
  }, 60_000);

  it('refuses every budgets route without a session, with 401', async () => {
    const noSession = {
      accessToken: 'not-a-real-session-token',
      csrf: 'x'.repeat(40),
      fresh: false,
    };
    const someId = '00000000-0000-4000-8000-000000000000';
    const attempts = [
      { method: 'GET' as const, url: '/budgets/current', session: noSession },
      { method: 'GET' as const, url: `/budgets/periods?budgetId=${someId}`, session: noSession },
      {
        method: 'POST' as const,
        url: '/budgets/lines',
        session: noSession,
        body: { periodId: someId, categoryId: someId },
      },
      {
        method: 'PATCH' as const,
        url: `/budgets/lines/${someId}`,
        session: noSession,
        body: { assigned: { minor: '100', currency: 'USD' } },
      },
      {
        method: 'POST' as const,
        url: '/budgets/periods/roll',
        session: noSession,
        body: { budgetId: someId, periodId: someId },
      },
    ];
    for (const attempt of attempts) {
      const response = await h.request(attempt);
      expect(response.statusCode).toBe(401);
      expect(problemOf(response)['code']).toBe('not_authenticated');
    }
  });

  it('opens the current period, creates a line, assigns to it, and rolls the period', async () => {
    const current = await h.request({ method: 'GET', url: '/budgets/current', session: h.stale });
    expectStatus(current, 200);
    const { budgetId, period } = current.json() as { budgetId: string; period: WirePeriod };
    expect(period.readyToAssign).toEqual({ minor: '0', currency: 'USD' });

    const created = await h.request({
      method: 'POST',
      url: '/budgets/lines',
      session: h.stale,
      body: { periodId: period.id, categoryId, priority: 5 },
    });
    expectStatus(created, 201);
    const line = (created.json() as { line: WireLine }).line;
    expect(line.categoryId).toBe(categoryId);
    expect(line.assigned).toEqual({ minor: '0', currency: 'USD' });

    const assigned = await h.request({
      method: 'PATCH',
      url: `/budgets/lines/${line.id}`,
      session: h.stale,
      body: { assigned: { minor: '2500', currency: 'USD' } },
    });
    expectStatus(assigned, 200);
    const patchedLine = (assigned.json() as { line: WireLine }).line;
    expect(patchedLine.assigned).toEqual({ minor: '2500', currency: 'USD' });
    expect(patchedLine.available).toEqual({ minor: '2500', currency: 'USD' });

    // With no on-budget cash account, assigning $25 pushes Ready-to-Assign to
    // -$25 — 07 §1.9's "one hard alert", not an identity violation.
    const refreshed = await h.request({ method: 'GET', url: '/budgets/current', session: h.stale });
    expectStatus(refreshed, 200);
    const refreshedPeriod = (refreshed.json() as { period: WirePeriod }).period;
    expect(refreshedPeriod.readyToAssign).toEqual({ minor: '-2500', currency: 'USD' });

    const periods = await h.request({
      method: 'GET',
      url: `/budgets/periods?budgetId=${budgetId}`,
      session: h.stale,
    });
    expectStatus(periods, 200);
    expect(
      (periods.json() as { periods: { id: string }[] }).periods.some((p) => p.id === period.id),
    ).toBe(true);

    const rolled = await h.request({
      method: 'POST',
      url: '/budgets/periods/roll',
      session: h.stale,
      body: { budgetId, periodId: period.id },
    });
    expectStatus(rolled, 200);
    const rollBody = rolled.json() as { fromPeriodId: string; toPeriodId: string };
    expect(rollBody.fromPeriodId).toBe(period.id);
    expect(rollBody.toPeriodId).not.toBe(period.id);
  });

  it('a budget line belonging to one user is invisible and unreachable to another', async () => {
    const current = await h.request({ method: 'GET', url: '/budgets/current', session: h.stale });
    const { period } = current.json() as { period: WirePeriod };
    const line = period.lines[0];
    expect(line).toBeDefined();

    const otherUserId = await h.database.createUser('Budgets Second Holder');
    const otherSession = await h.issueSession({ userId: otherUserId });

    const theirPeriods = await h.request({
      method: 'GET',
      url: `/budgets/periods?budgetId=${(current.json() as { budgetId: string }).budgetId}`,
      session: otherSession,
    });
    expectStatus(theirPeriods, 200);
    expect((theirPeriods.json() as { periods: unknown[] }).periods).toEqual([]);

    const patch = await h.request({
      method: 'PATCH',
      url: `/budgets/lines/${line?.id ?? ''}`,
      session: otherSession,
      body: { assigned: { minor: '100', currency: 'USD' } },
    });
    expect(patch.statusCode).toBe(404);
    expect(problemOf(patch)['code']).toBe('budgeting.line_not_found');
  });
});
