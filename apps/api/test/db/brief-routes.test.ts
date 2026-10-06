// SPDX-License-Identifier: MIT
/**
 * `/insights/brief/current`, `/insights/brief/{isoWeek}` and
 * `/insights/health-score` (WP 5.10), over a real database.
 *
 * WP 5.6's `publishWeeklyBrief` is not called here: the Brief's own assembly,
 * ranking and idempotence are `brief.test.ts`/`db/brief.test.ts`'s claims
 * (WP 5.6), already proven. This suite's claim is the *route* — that a
 * published Brief is served exactly as stored, that "current" means the
 * latest published week, and that another holder's Brief is unreachable —
 * so fixture rows are inserted directly against the public
 * `advisoryBriefs`/`advisoryBriefItems` schema export (`@ctx/insights/schema`,
 * the same tables `apps/api/src/routes/brief.ts` reads), matching exactly
 * what `publishWeeklyBrief` would have written.
 *
 * ## Cross-user scoping and the predicate matrix (dispatch §5 item 8)
 *
 * `routes/brief.ts#loadBrief` has two predicates when a week is named
 * (`userId` AND `isoWeek`) and one when it is not (`userId` only, ordered to
 * the latest week); `loadItems` has two (`userId` AND `briefId`). Each is
 * exercised by a *realistic* HTTP request — not a synthetic drop, because an
 * ISO week is not secret (everyone's "2026-W40" is the same calendar week)
 * and a holder can genuinely request one that is not theirs:
 *
 *   * **`userId` dropped** would let Bob read Alice's Brief by naming her
 *     week. Proved by `'a Brief belonging to one holder is unreachable by
 *     another, by week and as "current"'`, and additionally sabotaged at the
 *     source (recorded in `docs/evidence/phase-5/wp5.10-routes.md`): the
 *     `eq(advisoryBriefs.userId, userId)` half commented out of `loadBrief`,
 *     this suite re-run, the cross-user case observed red, the file restored
 *     and re-diffed clean.
 *   * **`isoWeek` dropped** (when named) would make `/insights/brief/{week}`
 *     silently return the caller's *other* week's Brief instead of 404.
 *     Proved by `'a week with no published Brief 404s even when the same
 *     holder has one for a different week'`.
 *   * **`briefId` on `loadItems`** — proved by `'items from one week never
 *     bleed into another week's response'`: two Briefs for the same holder,
 *     each with its own items, and each week's response carries only its own.
 *   * **Together** — `'a week that belongs to nobody the caller is 404 for
 *     every caller'`.
 */
import { newId, systemClock } from '@core/kernel';
import { advisoryBriefItems, advisoryBriefs } from '@ctx/insights/schema';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadItems } from '../../src/routes/brief.ts';
import {
  createApiHarness,
  expectStatus,
  NO_DATABASE,
  problemOf,
  type ApiHarness,
} from '../helpers/api-harness.ts';

interface BriefItemWire {
  readonly section: string;
  readonly insightKey: string;
  readonly annualizedImpact: { readonly minor: string; readonly currency: string } | null;
  readonly retirementEffect: Record<string, unknown>;
}

interface BriefWire {
  readonly id: string;
  readonly isoWeek: string;
  readonly items: readonly BriefItemWire[];
}

const COMPUTED_EFFECT = Object.freeze({
  kind: 'computed',
  engineVersion: 'engine-v1',
  assumptionsVersion: 'assumptions-v1',
  plannedRetirementAge: 65,
  baseline: { kind: 'earliest', age: 65, engineRuns: 3 },
  withAction: { kind: 'earliest', age: 63, engineRuns: 3 },
  yearsEarlier: 2,
  monthsOfSpending: {
    months: 7.5,
    atAge: 65,
    wealthDifference: { minor: '150000', currency: 'USD' },
    firstYearSpending: { minor: '20000', currency: 'USD' },
    derivation: 'wealth_diff_over_spend',
  },
  assumption: 'if the saving is invested in your plan, from now to retirement',
});

const NOT_COMPUTABLE_EFFECT = Object.freeze({ kind: 'not_computable', reason: 'no_baseline' });

/** Insert one published Brief with two items, matching `publishWeeklyBrief`'s shape exactly. */
async function seedBrief(
  h: ApiHarness,
  userId: string,
  isoWeek: string,
  keyPrefix: string,
  attentionEffect: Record<string, unknown> = NOT_COMPUTABLE_EFFECT,
): Promise<string> {
  const briefId = newId();
  const now = systemClock.now();
  await h.database.db.insert(advisoryBriefs).values({
    id: briefId,
    userId,
    isoWeek,
    currency: 'USD',
    nothingMaterial: false,
    coldStart: false,
    coldStartNote: null,
    inputDigest: `sha256:${'a'.repeat(64)}`,
    publishedAt: now,
    createdAt: now,
  });
  await h.database.db.insert(advisoryBriefItems).values([
    {
      id: newId(),
      userId,
      briefId,
      section: 'ranked',
      position: 0,
      insightId: null,
      advisorId: 'builtin.cash.emergency_fund_short',
      insightKey: `${keyPrefix}.ranked`,
      insightType: 'cash.emergency_fund_short',
      severity: 'notable',
      title: 'Ranked item',
      summaryMd: 'A ranked Brief item.',
      confidence: '0.750000',
      horizon: 'this_period',
      carried: false,
      impactAnnualizedMinor: 50_000n,
      impactOneTimeMinor: null,
      impactCurrency: 'USD',
      evidence: [
        {
          position: 0,
          kind: 'fact',
          label: 'Balance',
          value: '500.00',
          sourceRef: 'snapshot:cash_summary.balance',
          resolvedDisplay: '$500.00',
          href: null,
        },
      ],
      score: '0.812345',
      scoreFactors: { impact: 0.8, confidence: 0.9 },
      retirementEffect: COMPUTED_EFFECT,
      createdAt: now,
    },
    {
      id: newId(),
      userId,
      briefId,
      section: 'attention',
      position: 0,
      insightId: null,
      advisorId: 'builtin.cash.overdraft_risk',
      insightKey: `${keyPrefix}.attention`,
      insightType: 'cash.overdraft_risk',
      severity: 'urgent',
      title: 'Attention item',
      summaryMd: 'An urgent, no-dollar-figure Brief item.',
      confidence: '0.900000',
      horizon: 'immediate',
      carried: false,
      impactAnnualizedMinor: null,
      impactOneTimeMinor: null,
      impactCurrency: null,
      evidence: [],
      score: null,
      scoreFactors: null,
      retirementEffect: attentionEffect,
      createdAt: now,
    },
  ]);
  return briefId;
}

describe.skipIf(NO_DATABASE)('/insights/brief and /insights/health-score (WP 5.10)', () => {
  let h: ApiHarness;

  beforeAll(async () => {
    h = await createApiHarness({ suite: 'wp510-brief' });
  }, 120_000);

  afterAll(async () => {
    await h.close();
  });

  it('401s every route without a session', async () => {
    const current = await h.request({ method: 'GET', url: '/insights/brief/current' });
    expect(current.statusCode).toBe(401);
    const byWeek = await h.request({ method: 'GET', url: '/insights/brief/2026-W40' });
    expect(byWeek.statusCode).toBe(401);
    const health = await h.request({ method: 'GET', url: '/insights/health-score' });
    expect(health.statusCode).toBe(401);
  });

  it('400s a malformed ISO week before any query runs', async () => {
    const response = await h.request({
      method: 'GET',
      url: '/insights/brief/not-a-week',
      session: h.stale,
    });
    expect(response.statusCode).toBe(400);
  });

  it('404s "current" and any week before a Brief has ever been published', async () => {
    const current = await h.request({
      method: 'GET',
      url: '/insights/brief/current',
      session: h.stale,
    });
    expect(current.statusCode).toBe(404);
    expect(problemOf(current)['code']).toBe('insights.brief_not_found');

    const byWeek = await h.request({
      method: 'GET',
      url: '/insights/brief/2020-W01',
      session: h.stale,
    });
    expect(byWeek.statusCode).toBe(404);
  });

  it('GET /insights/health-score 404s insights.health_score_not_computed (WP 5.8 has not landed)', async () => {
    const response = await h.request({
      method: 'GET',
      url: '/insights/health-score',
      session: h.stale,
    });
    expect(response.statusCode).toBe(404);
    expect(problemOf(response)['code']).toBe('insights.health_score_not_computed');
  });

  describe('a published Brief', () => {
    let week1: string;
    let week2: string;

    beforeAll(async () => {
      week1 = '2026-W38';
      week2 = '2026-W40'; // the later week — "current"
      await seedBrief(h, h.userId, week1, 'wp510-w1');
      await seedBrief(h, h.userId, week2, 'wp510-w2');
    });

    it('"current" is the latest published week, and it is served exactly as stored', async () => {
      const response = await h.request({
        method: 'GET',
        url: '/insights/brief/current',
        session: h.stale,
      });
      expectStatus(response, 200);
      const body = response.json() as { brief: BriefWire };
      expect(body.brief.isoWeek).toBe(week2);
      expect(body.brief.items).toHaveLength(2);
    });

    it("a specific week is served, and its items never bleed into another week's response", async () => {
      const response = await h.request({
        method: 'GET',
        url: `/insights/brief/${week1}`,
        session: h.stale,
      });
      expectStatus(response, 200);
      const body = response.json() as { brief: BriefWire };
      expect(body.brief.isoWeek).toBe(week1);
      expect(body.brief.items.map((item) => item.insightKey).sort()).toEqual([
        'wp510-w1.attention',
        'wp510-w1.ranked',
      ]);
    });

    it('a week with no published Brief 404s even when the same holder has one for a different week', async () => {
      const response = await h.request({
        method: 'GET',
        url: '/insights/brief/2019-W01',
        session: h.stale,
      });
      expect(response.statusCode).toBe(404);
    });

    it("a Brief item's money is {minor, currency}; its retirement effect is served exactly as stored and never recomputed on read", async () => {
      const response = await h.request({
        method: 'GET',
        url: `/insights/brief/${week1}`,
        session: h.stale,
      });
      expectStatus(response, 200);
      const body = response.json() as { brief: BriefWire };
      const ranked = body.brief.items.find((item) => item.section === 'ranked');
      expect(ranked?.annualizedImpact).toEqual({ minor: '50000', currency: 'USD' });
      const effect = ranked?.retirementEffect as {
        kind: string;
        yearsEarlier: number;
        monthsOfSpending: { months: unknown; wealthDifference: unknown };
      };
      expect(effect.kind).toBe('computed');
      expect(effect.yearsEarlier).toBe(2); // exactly what was stored, unchanged
      // The exit test's own claim: months-of-spending is a decimal string, never a JSON number.
      expect(typeof effect.monthsOfSpending.months).toBe('string');
      expect(effect.monthsOfSpending.months).toBe('7.5');
      expect(effect.monthsOfSpending.wealthDifference).toEqual({
        minor: '150000',
        currency: 'USD',
      });

      const attention = body.brief.items.find((item) => item.section === 'attention');
      expect(attention?.annualizedImpact).toBeNull();
      expect((attention?.retirementEffect as { kind: string }).kind).toBe('not_computable');
    });

    it('a Brief belonging to one holder is unreachable by another, by week and as "current"', async () => {
      const otherUserId = await h.database.createUser('Brief Second Holder');
      const otherSession = await h.issueSession({ userId: otherUserId, fresh: false });

      const current = await h.request({
        method: 'GET',
        url: '/insights/brief/current',
        session: otherSession,
      });
      expect(current.statusCode).toBe(404);

      const byWeek = await h.request({
        method: 'GET',
        url: `/insights/brief/${week1}`,
        session: otherSession,
      });
      expect(byWeek.statusCode).toBe(404);
    });

    it('a not-computable retirement effect is served in words, never as an engine code (G5-11)', async () => {
      // The gate's walk: a fresh install, no sealed net-worth day yet.
      await seedBrief(h, h.userId, '2026-W29', 'wp93-g511', {
        kind: 'not_computable',
        reason: 'planning.projection_no_balances',
      });
      const response = await h.request({
        method: 'GET',
        url: '/insights/brief/2026-W29',
        session: h.stale,
      });
      expectStatus(response, 200);
      const body = response.json() as { brief: BriefWire };
      for (const item of body.brief.items) {
        const effect = item.retirementEffect as { kind: string; reason?: string };
        if (item.section === 'attention') {
          expect(effect.kind).toBe('not_computable');
          expect(effect.reason).toMatch(/net-worth day/);
          expect(effect.reason).not.toMatch(/planning\./);
        }
      }
    }, 30_000);

    it("loadItems' own userId predicate (C5-6, G5-17 R2a): a foreign briefId yields nothing for another holder", async () => {
      // Through HTTP this predicate is shadowed: `loadBrief` is user-scoped, so
      // it only ever hands `loadItems` the caller's own Brief id, and the
      // composite FK (user_id, brief_id) makes a mismatched item unrepresentable.
      // So the shipped `loadItems` — the function both routes call — is called
      // with a briefId that is not the caller's, and must see nothing.
      const otherUserId = await h.database.createUser('Brief Fourth Holder');
      const briefId = await seedBrief(h, h.userId, '2026-W30', 'wp93-c56');

      expect(await loadItems(h.database.db, otherUserId, briefId)).toEqual([]);
      const own = await loadItems(h.database.db, h.userId, briefId);
      expect(own.map((item) => item.insightKey).sort()).toEqual([
        'wp93-c56.attention',
        'wp93-c56.ranked',
      ]);
    });

    it('a week that belongs to nobody the caller is 404 for every caller (both predicates wrong together)', async () => {
      const otherUserId = await h.database.createUser('Brief Third Holder');
      const otherSession = await h.issueSession({ userId: otherUserId, fresh: false });
      const response = await h.request({
        method: 'GET',
        url: '/insights/brief/2099-W01',
        session: otherSession,
      });
      expect(response.statusCode).toBe(404);
    });
  });
});
