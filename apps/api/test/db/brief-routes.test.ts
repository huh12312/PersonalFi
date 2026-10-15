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
import { fixedClock, newId, systemClock } from '@core/kernel';
import { createJobRunner, enqueueJob, platformExecutor, silentLogger } from '@core/platform';
import { createEgressPolicy, createNtfyChannel, createSmtpChannel } from '@ctx/notifications';
import { registerAdvisor, NARRATOR_MANIFEST } from '@ctx/insights';
import {
  advisoryBriefItems,
  advisoryBriefs,
  insightActions,
  insightEvidence,
  insights,
} from '@ctx/insights/schema';
import { and, eq, sql } from 'drizzle-orm';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createConnectorRegistry,
  createDomainRuntime,
  createInvestmentSyncPort,
} from '../../src/domain.ts';
import { appModules, registerBuiltinAdvisors } from '../../src/modules.ts';
import { loadItems } from '../../src/routes/brief.ts';
import { startApiWithEnv, type EnvApi } from '../helpers/api-with-env.ts';
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
  readonly primaryAction: {
    readonly kind: string;
    readonly label: string;
    readonly rationaleMd: string;
    readonly url: string | null;
  } | null;
  readonly narration: {
    readonly status: 'narrated' | 'pending' | 'none';
    readonly aiAssisted: boolean;
    readonly textShown: boolean;
    readonly summaryMd: string | null;
  };
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
  // fixture: advisory_briefs row written by the schema insert because `publishWeeklyBrief` (the weekly job) is its only writer and needs a full advisor run; the job could write it as a published week with items from position 0 (as here), and the routes read it back through their response schemas — input_digest is a placeholder no route or reader recomputes.
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
  // fixture: advisory_brief_items rows written by the schema insert because `publishWeeklyBrief` is their only writer; the job could write a ranked and an attention item at positions 0.. with evidence and score factors, as here, and the routes read them back through their response schemas.
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

// ---------------------------------------------------------------------------
// WP 9.6 item 3 (a Brief item's narration, R-2's gate) and item 4 (CF-24)
// ---------------------------------------------------------------------------

type Db = ApiHarness['database']['db'];

/**
 * One live finding the way the nightly upsert leaves it: an `insights` row,
 * one evidence row, one proposed action. Direct inserts against the public
 * schema, matching what `upsertInsight` writes (the file header's reason).
 */
async function seedFinding(
  db: Db,
  userId: string,
  input: {
    readonly advisorId: string;
    readonly key: string;
    readonly title: string;
    readonly action: { kind: string; label: string; rationaleMd: string; url: string | null };
    readonly lastProposedAt?: Date;
  },
): Promise<string> {
  const id = newId();
  const proposed = input.lastProposedAt ?? new Date('2026-10-05T12:00:00.000Z');
  // fixture: insights row written by the schema insert because `upsertInsight` (the nightly advisor run) is its only writer; the run could write it as a pending_review finding with evidence and a proposed action (as here), and the Brief/insights routes read it back through their response schemas — input_digest is a placeholder no route recomputes.
  await db.insert(insights).values({
    id,
    userId,
    advisorId: input.advisorId,
    advisorVersion: '1.0.0',
    runId: null,
    key: input.key,
    period: 'all_time',
    type: 'cash.emergency_fund_short',
    severity: 'notable',
    severityClamped: false,
    title: input.title,
    summaryMd: `The template wording for ${input.title}.`,
    confidence: '0.900000',
    confidenceBasis: 'deterministic',
    horizon: 'this_period',
    status: 'pending_review',
    impactAnnualizedMinor: 50_000n,
    impactOneTimeMinor: null,
    impactCurrency: 'USD',
    impactBasis: 'A stated basis.',
    impactDerivationId: null,
    derivations: [],
    caveats: [],
    narratesInsightId: null,
    inputDigest: `sha256:${'b'.repeat(64)}`,
    firstProposedAt: proposed,
    lastProposedAt: proposed,
    reviewedAt: null,
    expiresAt: null,
  });
  await db.insert(insightEvidence).values({
    id: newId(),
    userId,
    insightId: id,
    position: 0,
    kind: 'metric',
    label: 'Balance',
    value: '500.00',
    sourceRef: 'snapshot:cash_summary.balance',
    resolvedDisplay: '$500.00',
    href: null,
  });
  // fixture: insight_actions row written by the schema insert because `upsertInsight` is its only writer; the nightly run could write it as a proposed action at the given position (the second, later action and the replaced action are the shapes the test is about).
  await db.insert(insightActions).values({
    id: newId(),
    userId,
    insightId: id,
    position: 0,
    kind: input.action.kind as 'suggest_only',
    label: input.action.label,
    rationaleMd: input.action.rationaleMd,
    url: input.action.url,
  });
  return id;
}

/** The narrator's alternative wording of `findingId` (`narrates_insight_id`), newer than the finding. */
async function seedNarration(
  db: Db,
  userId: string,
  findingId: string,
  text: string,
): Promise<void> {
  const proposed = new Date('2026-10-05T18:00:00.000Z');
  // fixture: insights row (the narration) written by the schema insert because the narrator pipeline (`local.narrator`, through the same insight upsert) is its only writer and needs a model run; the pipeline could write it as a pending_review narration of the finding it narrates (narrates_insight_id), as here.
  await db.insert(insights).values({
    id: newId(),
    userId,
    advisorId: 'local.narrator',
    advisorVersion: '1.0.0',
    runId: null,
    key: `narration.${findingId}`,
    period: 'all_time',
    type: 'cash.emergency_fund_short',
    severity: 'notable',
    severityClamped: false,
    title: 'A narrated title',
    summaryMd: text,
    confidence: '0.700000',
    confidenceBasis: 'model',
    horizon: 'this_period',
    status: 'pending_review',
    impactAnnualizedMinor: null,
    impactOneTimeMinor: null,
    impactCurrency: null,
    impactBasis: '',
    impactDerivationId: null,
    derivations: [],
    caveats: [],
    narratesInsightId: findingId,
    inputDigest: `sha256:${'c'.repeat(64)}`,
    firstProposedAt: proposed,
    lastProposedAt: proposed,
    reviewedAt: null,
    expiresAt: null,
  });
}

/** A published Brief whose items point at live findings (`insight_id`), for the narration join. */
async function seedBriefOver(
  db: Db,
  userId: string,
  isoWeek: string,
  findings: readonly { readonly insightId: string | null; readonly key: string }[],
  publishedAt = new Date('2026-10-05T12:30:00.000Z'),
): Promise<void> {
  const briefId = newId();
  // fixture: advisory_briefs row written by the schema insert because `publishWeeklyBrief` is its only writer; same shape and same placeholder input_digest as seedBrief's.
  await db.insert(advisoryBriefs).values({
    id: briefId,
    userId,
    isoWeek,
    currency: 'USD',
    nothingMaterial: false,
    coldStart: false,
    coldStartNote: null,
    inputDigest: `sha256:${'a'.repeat(64)}`,
    publishedAt,
    createdAt: publishedAt,
  });
  let position = 0;
  for (const finding of findings) {
    // fixture: advisory_brief_items row written by the schema insert because `publishWeeklyBrief` is its only writer; the job could write it as a ranked item at the given position linked to its insight (or insight-less), as here — see the advisory_briefs note on seedBrief.
    await db.insert(advisoryBriefItems).values({
      id: newId(),
      userId,
      briefId,
      section: 'ranked',
      position: position++,
      insightId: finding.insightId,
      advisorId: 'builtin.cash.emergency_fund_short',
      insightKey: finding.key,
      insightType: 'cash.emergency_fund_short',
      severity: 'notable',
      title: `Item ${finding.key}`,
      summaryMd: `The template wording of ${finding.key}.`,
      confidence: '0.900000',
      horizon: 'this_period',
      carried: false,
      impactAnnualizedMinor: 50_000n,
      impactOneTimeMinor: null,
      impactCurrency: 'USD',
      evidence: [],
      score: '0.500000',
      scoreFactors: { impact: 0.8 },
      retirementEffect: NOT_COMPUTABLE_EFFECT,
      createdAt: publishedAt,
    });
  }
}

describe.skipIf(NO_DATABASE)(
  'a Brief item carries its narration, gated by R-2 (WP 9.6 item 3)',
  () => {
    const TEXT = 'A friendlier way to say the same thing, written by the narrator.';

    /** Seeds, for one holder: item A has a narration, item B has none. Returns the week. */
    async function seedNarratedWeek(
      db: Db,
      userId: string,
      week: string,
    ): Promise<{ narrated: string; plain: string }> {
      await registerBuiltinAdvisors(db, { userId, clock: systemClock, correlationId: newId() });
      const action = {
        kind: 'suggest_only',
        label: 'Review it',
        rationaleMd: 'Worth a look.',
        url: null,
      };
      const narrated = await seedFinding(db, userId, {
        advisorId: 'builtin.cash.emergency_fund_short',
        key: `wp96-narrated-${week}`,
        title: 'Narrated finding',
        action,
      });
      const plain = await seedFinding(db, userId, {
        advisorId: 'builtin.cash.emergency_fund_short',
        key: `wp96-plain-${week}`,
        title: 'Plain finding',
        action,
      });
      await seedNarration(db, userId, narrated, TEXT);
      await seedBriefOver(db, userId, week, [
        { insightId: narrated, key: `wp96-narrated-${week}` },
        { insightId: plain, key: `wp96-plain-${week}` },
      ]);
      return { narrated, plain };
    }

    async function itemsOf(api: EnvApi, week: string): Promise<BriefItemWire[]> {
      const response = await api.request({
        method: 'GET',
        url: `/insights/brief/${week}`,
        session: api.stale,
      });
      expectStatus(response as never, 200);
      return (response.json() as { brief: BriefWire }).brief.items as BriefItemWire[];
    }

    it(
      'a Brief item with a narration carries it, badged; one without carries none ' +
        '(NARRATION_TEXT_SHOWN off: the badge and the status, never the text)',
      async () => {
        // The default config: the gate is closed.
        const api = await startApiWithEnv('narroff');
        try {
          await seedNarratedWeek(api.database.db, api.database.userId, '2026-W41');
          const items = await itemsOf(api, '2026-W41');
          const narrated = items.find((item) => item.insightKey.startsWith('wp96-narrated'));
          const plain = items.find((item) => item.insightKey.startsWith('wp96-plain'));
          expect(narrated?.narration).toEqual({
            status: 'narrated',
            aiAssisted: true,
            textShown: false,
            summaryMd: null,
            narratedBy: null,
          });
          expect(plain?.narration).toEqual({
            status: 'none',
            aiAssisted: false,
            textShown: false,
            summaryMd: null,
            narratedBy: null,
          });
          // The text never reaches the wire while the gate is closed — not even
          // somewhere a client could dig it out.
          const raw = await api.request({
            method: 'GET',
            url: '/insights/brief/2026-W41',
            session: api.stale,
          });
          expect(JSON.stringify(raw.json())).not.toContain(TEXT);
        } finally {
          await api.close();
        }
      },
      120_000,
    );

    it(
      'a Brief item with a narration carries it, badged; one without carries none ' +
        '(NARRATION_TEXT_SHOWN on: the text, beside the built-in wording)',
      async () => {
        const api = await startApiWithEnv('narron', { NARRATION_TEXT_SHOWN: 'true' });
        try {
          await seedNarratedWeek(api.database.db, api.database.userId, '2026-W41');
          const items = await itemsOf(api, '2026-W41');
          const narrated = items.find((item) => item.insightKey.startsWith('wp96-narrated'));
          const plain = items.find((item) => item.insightKey.startsWith('wp96-plain'));
          expect(narrated?.narration).toEqual({
            status: 'narrated',
            aiAssisted: true,
            textShown: true,
            summaryMd: TEXT,
            narratedBy: null,
          });
          // The built-in's own summary is untouched: a narration is alternative
          // wording, never a replacement of what the Brief stored.
          expect((narrated as unknown as { summaryMd: string }).summaryMd).toMatch(
            /^The template wording of/,
          );
          expect(plain?.narration).toEqual({
            status: 'none',
            aiAssisted: false,
            textShown: true,
            summaryMd: null,
            narratedBy: null,
          });
        } finally {
          await api.close();
        }
      },
      120_000,
    );

    it('WP 10.6 (D30): the narration names its provider and model, from the run that wrote it', async () => {
      const api = await startApiWithEnv('narrby', { NARRATION_TEXT_SHOWN: 'true' });
      try {
        const userId = api.database.userId;
        const { narrated } = await seedNarratedWeek(api.database.db, userId, '2026-W41');
        async function narratedByRun(llmModel: string): Promise<unknown> {
          const runId = newId();
          await api.database.db.execute(sql`
              INSERT INTO advisor_runs (id, user_id, advisor_id, advisor_version, trigger, status,
                granted_scopes, emitted_scopes, proposed_count, accepted_count, rejected_count,
                rejections, correlation_id, started_at, finished_at, llm_model)
              VALUES (${runId}::uuid, ${userId}::uuid, 'local.narrator', '1', 'event', 'completed',
                '{}', '{}', 1, 1, 0, '[]'::jsonb, ${newId()}::uuid, now(), now(), ${llmModel})`);
          await api.database.db.execute(sql`
              UPDATE insights SET run_id = ${runId}::uuid
               WHERE user_id = ${userId}::uuid AND narrates_insight_id = ${narrated}::uuid`);
          const items = await itemsOf(api, '2026-W41');
          return items.find((item) => item.insightKey.startsWith('wp96-narrated'))?.narration;
        }
        expect(await narratedByRun('anthropic:claude-sonnet-5-5')).toMatchObject({
          status: 'narrated',
          narratedBy: { provider: 'anthropic', model: 'claude-sonnet-5-5' },
        });
        expect(await narratedByRun('openrouter:anthropic/claude-sonnet-5.5')).toMatchObject({
          narratedBy: { provider: 'openrouter', model: 'anthropic/claude-sonnet-5.5' },
        });
        expect(
          await narratedByRun(`qwen2.5:7b-instruct-q4_K_M@sha256:${'8'.repeat(64)}`),
        ).toMatchObject({
          narratedBy: { provider: 'ollama', model: 'qwen2.5:7b-instruct-q4_K_M' },
        });
      } finally {
        await api.close();
      }
    }, 120_000);

    it(
      "another holder's narration is never joined onto this holder's item (userId alone), " +
        'and a narration of a finding not on the Brief is not shown (finding id alone)',
      async () => {
        const api = await startApiWithEnv('narrx', { NARRATION_TEXT_SHOWN: 'true' });
        try {
          const bob = await api.database.createUser('Narration Second Holder');
          const alice = api.database.userId;
          const { narrated } = await seedNarratedWeek(api.database.db, alice, '2026-W41');
          // Bob's Brief item names Alice's narrated finding as its source (the FK on
          // `advisory_brief_items.insight_id` is on `id` alone, so this row is
          // representable — and the join must not follow it into Alice's data).
          await seedBriefOver(api.database.db, bob, '2026-W41', [
            { insightId: narrated, key: 'wp96-bob-points-at-alices' }, // gitleaks:allow — a synthetic narration key, not a credential
          ]);
          const bobSession = await api.issueSession({ userId: bob });
          const response = await api.request({
            method: 'GET',
            url: '/insights/brief/2026-W41',
            session: bobSession,
          });
          const items = (response.json() as { brief: BriefWire }).brief.items;
          expect(items).toHaveLength(1);
          expect(items[0]?.narration.status).toBe('none');
          expect(JSON.stringify(response.json())).not.toContain(TEXT);

          // Alice's own plain item carries no narration although a narration
          // exists for her OTHER finding: the join is per finding.
          const aliceItems = await itemsOf(api, '2026-W41');
          expect(aliceItems.filter((item) => item.narration.status === 'narrated')).toHaveLength(1);
        } finally {
          await api.close();
        }
      },
      120_000,
    );

    it('a narration still expected is "pending"; with no model, or an old Brief, it is "none"', async () => {
      const pin = {
        LOCAL_MODEL_PIN_NAME: 'qwen2.5:7b-instruct-q4_K_M',
        LOCAL_MODEL_PIN_DIGEST: `sha256:${'a'.repeat(64)}`,
      };
      const configured = await startApiWithEnv('narrpend', pin);
      const bare = await startApiWithEnv('narrnone');
      try {
        for (const [api, expectPending] of [
          [configured, true],
          [bare, false],
        ] as const) {
          const userId = api.database.userId;
          await registerBuiltinAdvisors(api.database.db, {
            userId,
            clock: systemClock,
            correlationId: newId(),
          });
          const finding = await seedFinding(api.database.db, userId, {
            advisorId: 'builtin.cash.emergency_fund_short',
            key: 'wp96-pending',
            title: 'Pending finding',
            action: {
              kind: 'suggest_only',
              label: 'Review it',
              rationaleMd: 'Worth a look.',
              url: null,
            },
          });
          // A Brief published just now, and one published three days ago.
          await seedBriefOver(
            api.database.db,
            userId,
            '2026-W41',
            [{ insightId: finding, key: 'wp96-pending' }],
            new Date(),
          );
          await seedBriefOver(
            api.database.db,
            userId,
            '2026-W38',
            [{ insightId: finding, key: 'wp96-pending-old' }],
            new Date(Date.now() - 3 * 86_400_000),
          );
          if (expectPending) {
            // The narrator is registered AND switched on, the kind is on, the
            // module is on: a narration is expected to arrive.
            await registerAdvisor(
              api.database.db,
              { userId, clock: systemClock, correlationId: newId() },
              { manifest: NARRATOR_MANIFEST, enabled: true },
            );
            expect(
              (
                await api.request({
                  method: 'PUT',
                  url: '/advisors/kinds/local_model/enabled',
                  session: api.fresh,
                  body: { enabled: true },
                })
              ).statusCode,
            ).toBe(200);
          }
          const recent = await itemsOf(api, '2026-W41');
          expect(recent[0]?.narration.status).toBe(expectPending ? 'pending' : 'none');
          // Never "pending" forever: a Brief past the window reads "none".
          const old = await itemsOf(api, '2026-W38');
          expect(old[0]?.narration.status).toBe('none');
          expect(recent[0]?.narration.aiAssisted).toBe(false);
        }
      } finally {
        await configured.close();
        await bare.close();
      }
    }, 180_000);
  },
);

describe.skipIf(NO_DATABASE)('a published Brief records its action (WP 9.6 item 4, CF-24)', () => {
  let h: ApiHarness;
  let userId: string;

  beforeAll(async () => {
    h = await createApiHarness({ suite: 'wp96-brief-action' });
    userId = await h.database.createUser('Brief action holder');
  }, 120_000);

  afterAll(async () => {
    await h.close();
  });

  it("a published Brief's action is the one shown at publication, after the insight's action changes", async () => {
    const db = h.database.db;
    await registerBuiltinAdvisors(db, { userId, clock: systemClock, correlationId: newId() });
    const finding = await seedFinding(db, userId, {
      advisorId: 'builtin.cash.emergency_fund_short',
      key: 'wp96-action',
      title: 'A finding with an action',
      action: {
        kind: 'suggest_only',
        label: 'Move $500 into savings',
        rationaleMd: 'It closes the gap to three months.',
        url: null,
      },
    });

    // A second, later action: the Brief records the FIRST by position.
    await db.insert(insightActions).values({
      id: newId(),
      userId,
      insightId: finding,
      position: 1,
      kind: 'open_url',
      label: 'Read the savings guide',
      rationaleMd: 'Background reading.',
      url: 'https://example.com/guide',
    });

    // The real weekly job, through the real `appModules` composition, on a
    // real job runner — the publish path, not a fixture.
    const logger = pino({ level: 'silent' });
    const denyAll = createEgressPolicy({ allowedHosts: [] });
    const runtime = createDomainRuntime({
      database: db,
      clock: systemClock,
      logger,
      registry: createConnectorRegistry(),
      secretBox: h.security.requireSecretBox(),
    });
    const modules = appModules({
      advisorsEnabled: true,
      localModelConfigured: false,
      advisorTokenSecret: 'wp96-brief-secret', // gitleaks:allow — synthetic advisor-token secret for a test
      database: db,
      userId,
      orchestrator: runtime.orchestrator,
      timezone: 'America/Los_Angeles',
      clock: fixedClock('2026-10-06T12:00:00.000Z'), // 2026-W41
      notificationChannels: {
        ntfy: createNtfyChannel({ policy: denyAll }),
        smtp: createSmtpChannel({ policy: denyAll }),
      },
      secretBox: h.security.requireSecretBox(),
      investmentSyncPort: createInvestmentSyncPort(db),
    });
    const briefJob = modules
      .find((module) => module.flagKey === 'module.insights')
      ?.jobs?.find((job) => job.kind === 'insights.brief');
    if (briefJob === undefined) throw new Error('insights.brief did not register');
    const runner = createJobRunner({
      pool: h.database.pool,
      db: platformExecutor(db),
      handlers: [briefJob],
      concurrency: 1,
      pollIntervalMs: 25,
      logger: silentLogger,
    });
    await runner.start();
    try {
      await enqueueJob(platformExecutor(db), {
        kind: 'insights.brief',
        userId,
        payload: {},
        correlationId: newId(),
      });
      const deadline = Date.now() + 20_000;
      for (;;) {
        const rows = await db
          .select()
          .from(advisoryBriefs)
          .where(eq(advisoryBriefs.userId, userId));
        if (rows.length === 1) break;
        if (Date.now() > deadline) throw new Error('the Brief did not publish');
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    } finally {
      await runner.stop();
    }

    const session = await h.issueSession({ userId });
    const read = async () => {
      const response = await h.request({
        method: 'GET',
        url: '/insights/brief/2026-W41',
        session,
      });
      expectStatus(response, 200);
      return (response.json() as { brief: BriefWire }).brief.items;
    };

    const atPublication = await read();
    const item = atPublication.find((entry) => entry.insightKey === 'wp96-action');
    expect(item?.primaryAction).toEqual({
      kind: 'suggest_only',
      label: 'Move $500 into savings',
      rationaleMd: 'It closes the gap to three months.',
      url: null,
    });

    // The nightly upsert deletes and re-inserts a finding's actions (`store.ts`
    // `upsertInsight`): the live insight now proposes something else.
    await db
      .delete(insightActions)
      .where(and(eq(insightActions.userId, userId), eq(insightActions.insightId, finding)));
    await db.insert(insightActions).values({
      id: newId(),
      userId,
      insightId: finding,
      position: 0,
      kind: 'open_url',
      label: 'Open the savings comparison',
      rationaleMd: 'A different suggestion, this week.',
      url: 'https://example.com/savings',
    });
    const live = await db
      .select({ label: insightActions.label })
      .from(insightActions)
      .where(eq(insightActions.insightId, finding));
    expect(live.map((row) => row.label)).toEqual(['Open the savings comparison']);

    // The Brief still says what it said.
    const later = await read();
    expect(later.find((entry) => entry.insightKey === 'wp96-action')?.primaryAction).toEqual(
      item?.primaryAction,
    );
  }, 120_000);

  it('a Brief published before 0038 reads "no action recorded", never the live insight\'s action', async () => {
    // `seedBrief` writes the rows as they were before the column existed.
    await seedBrief(h, userId, '2026-W20', 'wp96-old');
    const session = await h.issueSession({ userId });
    const response = await h.request({
      method: 'GET',
      url: '/insights/brief/2026-W20',
      session,
    });
    expectStatus(response, 200);
    for (const item of (response.json() as { brief: BriefWire }).brief.items) {
      expect(item.primaryAction).toBeNull();
    }
  }, 60_000);

  it('the shape CHECK refuses an action that is not one of the four non-acting kinds', async () => {
    const week = '2026-W21';
    await seedBrief(h, userId, week, 'wp96-check');
    for (const bad of [
      { kind: 'transfer', label: 'Move money', rationaleMd: '', url: null },
      { kind: 'open_url', label: 'Link', rationaleMd: '', url: 'http://not-https.example' },
      { kind: 'suggest_only', label: 'x', rationaleMd: '', url: 'https://example.com' },
      { kind: 'suggest_only', label: '   ', rationaleMd: '', url: null },
      { kind: 'suggest_only', label: 'x', rationaleMd: '' },
      { kind: 'suggest_only', label: 'x', rationaleMd: '', url: null, extra: 1 },
    ]) {
      await expect(
        h.database.db.execute(sql`
          UPDATE advisory_brief_items SET primary_action = ${JSON.stringify(bad)}::jsonb
           WHERE user_id = ${userId}::uuid AND insight_key = 'wp96-check.ranked'
        `),
      ).rejects.toMatchObject({ cause: { code: '23514' } });
    }
    // And a well-formed one is accepted.
    await h.database.db.execute(sql`
      UPDATE advisory_brief_items
         SET primary_action = ${JSON.stringify({ kind: 'open_url', label: 'Go', rationaleMd: 'r', url: 'https://example.com' })}::jsonb
       WHERE user_id = ${userId}::uuid AND insight_key = 'wp96-check.ranked'
    `);
  }, 60_000);
});
