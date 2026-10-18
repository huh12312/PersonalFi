// SPDX-License-Identifier: MIT
/**
 * `GET /insights/health` (WP 10.12, migration 0048) over the real application.
 *
 * 1. **On demand, once a day.** The first read of the day computes and writes today's snapshot
 *    (`writtenNow`); every later read that day serves the same row and writes nothing.
 * 2. **The zone edges are the scoring rules'.** `thresholds` is `HEALTH_BAND_THRESHOLDS`, boundary for
 *    boundary — the web never types an edge of its own.
 * 3. **Living expenses come from the budget's variability.** No category classified → the emergency-fund
 *    pillar's living cover is withheld with "Classify your categories on the Budget screen."; once rent is
 *    classified fixed and an annual premium non-monthly, the cover is Reports' own spending cells over the
 *    rule's windows — and a flexible category's spending is never in it.
 * 4. **No snapshot can be built and none exists** (no `advisor_token_secret`) → 404, never a zero.
 */
import { DateOnly, fixedClock } from '@core/kernel';
import { HEALTH_BAND_THRESHOLDS, HEALTH_COMPONENT_IDS } from '@ctx/insights';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  NO_DATABASE,
  createApiHarness,
  expectStatus,
  linkManual,
  problemOf,
  type ApiHarness,
} from '../helpers/api-harness.ts';

interface WireCategory {
  readonly id: string;
  readonly kind: string;
  readonly assignable: boolean;
  readonly parentId: string | null;
}

interface WirePillar {
  readonly component: string;
  readonly status: 'scored' | 'withheld';
  readonly score?: number;
  readonly livingCover?: Record<string, unknown>;
}

interface WireHealth {
  readonly asOfDate: string;
  readonly today: string;
  readonly score: number | null;
  readonly pillars: WirePillar[];
  readonly history: { asOfDate: string; score: number | null }[];
  readonly thresholds: {
    component: string;
    unit: string;
    higherIsBetter: boolean;
    boundaries: string[];
  }[];
  readonly writtenNow: boolean;
}

const NOW = '2026-09-19T15:00:00.000Z';
const TOKEN = 'wp1012-health-token-secret-0123456789abcdef';

describe.skipIf(NO_DATABASE)('GET /insights/health (WP 10.12)', () => {
  let h: ApiHarness;

  async function read(): Promise<WireHealth> {
    const response = await h.request({ method: 'GET', url: '/insights/health', session: h.stale });
    expectStatus(response, 200);
    return (response.json() as { health: WireHealth }).health;
  }

  async function rows(): Promise<{ as_of_date: string }[]> {
    const result = await h.database.pool.query<{ as_of_date: string }>(
      'SELECT as_of_date::text AS as_of_date FROM health_score_snapshots ORDER BY as_of_date',
    );
    return result.rows;
  }

  beforeAll(async () => {
    h = await createApiHarness({
      suite: 'wp1012_health',
      clock: fixedClock(NOW),
      extraSecrets: { advisor_token_secret: TOKEN },
    });
  }, 120_000);

  afterAll(async () => {
    await h.close();
  }, 60_000);

  it('the first read of the day writes today’s snapshot; later reads serve it and write nothing', async () => {
    const first = await read();
    expect(first.writtenNow).toBe(true);
    expect(first.asOfDate).toBe(first.today);
    expect(first.pillars.map((p) => p.component)).toEqual([...HEALTH_COMPONENT_IDS]);
    expect(first.history.map((entry) => entry.asOfDate)).toEqual([first.asOfDate]);
    for (const pillar of first.pillars) {
      if (pillar.status === 'withheld') expect(pillar).not.toHaveProperty('score');
    }

    const second = await read();
    expect(second.writtenNow).toBe(false);
    expect(second.score).toBe(first.score);
    expect(await rows()).toEqual([{ as_of_date: first.asOfDate }]);
  });

  it('the zone edges on the wire are the scoring rules’ boundaries, verbatim', async () => {
    const { thresholds } = await read();
    expect(thresholds).toEqual(
      HEALTH_COMPONENT_IDS.map((component) => ({
        component,
        unit: HEALTH_BAND_THRESHOLDS[component].unit,
        higherIsBetter: HEALTH_BAND_THRESHOLDS[component].higherIsBetter,
        boundaries: HEALTH_BAND_THRESHOLDS[component].boundaries.map((b) => b.value),
      })),
    );
  });

  it('living expenses: withheld until a category is classified, then fixed + non-monthly ÷ 12, never flexible', async () => {
    const before = await read();
    const emergency = before.pillars.find((p) => p.component === 'emergency_fund_months');
    expect(emergency?.livingCover).toMatchObject({
      status: 'withheld',
      unlock: 'Classify your categories on the Budget screen.',
    });

    const listed = await h.request({ method: 'GET', url: '/categories', session: h.fresh });
    expectStatus(listed, 200);
    const leaves = (listed.json() as { categories: WireCategory[] }).categories.filter(
      (c) => c.assignable && c.kind === 'expense' && c.parentId !== null,
    );
    const [rent, insurance, dining] = leaves;
    if (rent === undefined || insurance === undefined || dining === undefined) {
      throw new Error('taxonomy not seeded');
    }

    const bank = await linkManual(h, {
      providerConnectionId: 'wp1012-bank',
      displayName: 'Everyday Bank',
      accounts: [
        { providerAccountId: 'chk', name: 'Checking', type: 'depository', currency: 'USD' },
      ],
    });
    const [checking] = bank.accountIds;
    if (checking === undefined) throw new Error('no account');

    const add = async (minor: string, postedDate: string, name: string, categoryId: string) => {
      const response = await h.request({
        method: 'POST',
        url: `/accounts/${checking}/transactions`,
        session: h.fresh,
        body: {
          transactions: [
            { amount: { minor, currency: 'USD' }, postedDate, name, merchantName: name },
          ],
        },
      });
      expectStatus(response, 201);
      const id = (response.json() as { addedTransactionIds: string[] }).addedTransactionIds[0];
      const patched = await h.request({
        method: 'PATCH',
        url: `/transactions/${String(id)}`,
        session: h.fresh,
        body: { categoryId },
      });
      expectStatus(patched, 200);
    };
    // Rent $1,500 in each of June, July, August (the three complete months before September).
    await add('-150000', '2026-06-01', 'Landlord', rent.id);
    await add('-150000', '2026-07-01', 'Landlord', rent.id);
    await add('-150000', '2026-08-01', 'Landlord', rent.id);
    // September's rent is this (partial) month: never counted.
    await add('-150000', '2026-09-01', 'Landlord', rent.id);
    // A $600 annual premium in January: $50 a month.
    await add('-60000', '2026-01-15', 'Insurer', insurance.id);
    // Dining, flexible: never counted, however large.
    await add('-99900', '2026-07-10', 'Bistro', dining.id);

    for (const [category, variability] of [
      [rent, 'fixed'],
      [insurance, 'non_monthly'],
      [dining, 'flexible'],
    ] as const) {
      const response = await h.request({
        method: 'PATCH',
        url: `/categories/${category.id}`,
        session: h.fresh,
        body: { variability },
      });
      expectStatus(response, 200);
    }

    // Today's row is write-once; remove it so the next read computes again over the new data.
    await h.database.pool.query('DELETE FROM health_score_snapshots');
    const after = await read();
    expect(after.writtenNow).toBe(true);
    const cover = after.pillars.find((p) => p.component === 'emergency_fund_months')?.livingCover;
    expect(cover).toMatchObject({
      status: 'computed',
      livingExpenses: {
        status: 'computed',
        monthly: { minor: '155000', currency: 'USD' },
        fixedMonthlyAverage: { minor: '150000', currency: 'USD' },
        nonMonthlyMonthlyShare: { minor: '5000', currency: 'USD' },
        fixedCategoryCount: 1,
        nonMonthlyCategoryCount: 1,
        fixedWindow: { from: '2026-06', to: '2026-08' },
        nonMonthlyWindow: { from: '2025-09', to: '2026-08' },
      },
    });
    expect(String((cover as { months?: string } | undefined)?.months)).toMatch(/^\d+\.\d$/);
    expect(DateOnly.parse(after.asOfDate)).toBe(after.today);
  });
});

describe.skipIf(NO_DATABASE)('GET /insights/health with no advisor_token_secret (WP 10.12)', () => {
  let h: ApiHarness;

  beforeAll(async () => {
    h = await createApiHarness({ suite: 'wp1012_health_nosecret', clock: fixedClock(NOW) });
  }, 120_000);

  afterAll(async () => {
    await h.close();
  }, 60_000);

  it('nothing stored and nothing computable → 404 insights.health_not_computed, never a zero', async () => {
    const response = await h.request({ method: 'GET', url: '/insights/health', session: h.stale });
    expectStatus(response, 404);
    expect(problemOf(response)['code']).toBe('insights.health_not_computed');
  });
});
