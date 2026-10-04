// SPDX-License-Identifier: MIT
/**
 * `/insights/brief/*` and `/insights/health-score` — WP 5.6's Weekly Advisory
 * Brief and WP 5.8's health score, as HTTP (05-phase-5-dispatch.md §3 WP 5.10).
 *
 * ## The Brief is served exactly as stored, never recomputed
 *
 * `advisory_briefs`/`advisory_brief_items` (migration 0032) are immutable once
 * published (`brief/store.ts`'s header: "a Brief is a record of what was
 * said"). This route reads those two tables and reshapes each row for the
 * wire; it calls no engine, no `RetirementImpactPort` and no ranking function.
 * `retirementEffectWire` below only reformats the stored JSONB (money stays
 * `{minor, currency}`; a months-of-spending figure becomes a decimal string,
 * never a JSON number, matching `docs/CONVENTIONS.md` and the same rule
 * `plan.ts` already applies to `successProbability`) — it never calls
 * `solveRetirementImpact` or anything like it.
 *
 * ## Why this file queries `advisoryBriefs`/`advisoryBriefItems` directly
 *
 * WP 5.6 owns `packages/contexts/insights/src/brief/store.ts`, and its reads
 * — `findBriefByWeek`, `listBriefItems`, plus `brief/iso-week.ts`'s
 * `isoWeekOf`/`isIsoWeek` — are not re-exported through `@ctx/insights`'s
 * barrel (`src/index.ts`); the package's `exports` map (`"."` only) makes a
 * deep import a compile error under `moduleResolution: "nodenext"`, so
 * `findBriefByWeek`/`listBriefItems` themselves are not reachable from this
 * process (checked: `grep -n findBriefByWeek packages/contexts/insights/src/index.ts`
 * finds nothing at the commit this file was written against). This WP's
 * ownership note is explicit for exactly this situation ("if a read you need
 * does not exist ... serve a 501 meanwhile") for a read that is *missing
 * outright*; here the primitive is not missing, only its barrel export is —
 * `advisoryBriefs`/`advisoryBriefItems` themselves are already public
 * (`@ctx/insights/schema`, re-exported from `schema/index.ts`, used the same
 * way `ledger-splits.ts` and `domain.ts` already read another context's
 * tables directly) and `apps/` is the composition-root layer that
 * `scripts/eslint-boundaries.js` allows to import anything. So rather than a
 * 501 that could never turn green without a change outside this WP's files,
 * this route runs the same two-predicate queries `findBriefByWeek`/
 * `listBriefItems` run (read against their source, quoted in this WP's
 * evidence) directly, over the public schema export, and calls neither
 * `serializeRetirementEffect` nor `deserializeRetirementEffect` (unexported,
 * and unneeded — see `retirementEffectWire` above). Recorded under "Needs the
 * orchestrator" in `docs/evidence/phase-5/wp5.10-routes.md`: `index.ts`'s WP
 * 5.6 block should gain `findBriefByWeek`, `listBriefItems`, `isoWeekOf` and
 * `isIsoWeek` so the next reader of Brief data does not have to repeat this
 * note.
 *
 * ## "Current" is the latest published week, not today's ISO week
 *
 * `isoWeekOf(today)` is exactly what's missing (above), and re-deriving ISO
 * 8601 week arithmetic independently here would be the kind of second
 * implementation 03 §5.2 warns against. `iso_week` is `YYYY-Www` with a
 * zero-padded four-digit year and a zero-padded two-digit week
 * (`brief/iso-week.ts`'s own pattern, mirrored below in `isoWeekParam`), so
 * lexicographic ordering is chronological ordering; `ORDER BY iso_week DESC
 * LIMIT 1` is "the most recently published Brief" with no date arithmetic at
 * all, which is what "current" means to a holder opening the screen.
 *
 * ## `GET /insights/health-score` — WP 5.8's read, folded in
 *
 * `health_scores` (migration 0033) is a single table with no child and no
 * foreign key toward the Brief's tables (`0033_health_scores.sql`'s own
 * header). WP 5.8 exported `findLatestHealthScore` through `@ctx/insights`'s
 * barrel (`src/index.ts`'s own WP 5.8 block) rather than repeating this
 * file's "deep import is a compile error" workaround for the Brief above —
 * the barrel export did not exist when WP 5.6/5.10 needed the equivalent
 * Brief reads, and does now, so this handler imports `findLatestHealthScore`
 * directly rather than querying `healthScores` by hand. "Current" is the
 * latest computed week, the same `ORDER BY iso_week DESC LIMIT 1` meaning
 * `loadBrief` gives it, and the row is served exactly as
 * `computeAndStoreHealthScore` stored it — no recomputation here, the same
 * rule the Brief above follows. No row for this holder yet (including every
 * holder before WP 5.8 landed) is still 404 `insights.health_score_not_computed`,
 * unchanged from the stub — only the 200 path is new.
 */
import { and, desc, eq } from 'drizzle-orm';
import {
  findLatestHealthScore,
  HEALTH_BANDS,
  HEALTH_COMPONENT_IDS,
  HEALTH_SCORE_DIRECTIONS,
} from '@ctx/insights';
import { advisoryBriefItems, advisoryBriefs } from '@ctx/insights/schema';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { AppError, problems } from '../problem.ts';
import { isoInstant, moneySchema } from '../wire.ts';
import type { RouteDeps } from './deps.ts';

/** Mirrors `brief/iso-week.ts`'s `ISO_WEEK_PATTERN` — see this file's header. */
const isoWeekParam = z
  .string()
  .regex(/^[0-9]{4}-W(0[1-9]|[1-4][0-9]|5[0-3])$/, 'not an ISO week (YYYY-Www)');

const evidenceSchema = z.object({
  position: z.int(),
  kind: z.string(),
  label: z.string(),
  value: z.string().nullable(),
  sourceRef: z.string().nullable(),
  resolvedDisplay: z.string().nullable(),
  href: z.string().nullable(),
});

const retirementAgeEffectSchema = z.union([
  z.object({ kind: z.literal('earliest'), age: z.number(), engineRuns: z.number() }),
  z.object({
    kind: z.literal('unreachable'),
    reason: z.enum(['retirement_started', 'latest_age']),
    detail: z.string(),
  }),
]);

const monthsOfSpendingSchema = z.union([
  z.object({
    /** A decimal string, never a JSON number (05 §3 WP 5.10's own rule). */
    months: z.string(),
    atAge: z.number(),
    wealthDifference: moneySchema,
    firstYearSpending: moneySchema,
    derivation: z.string(),
  }),
  z.object({
    months: z.null(),
    reason: z.enum(['retirement_started', 'no_retirement_spending']),
  }),
]);

const retirementEffectSchema = z.union([
  z.object({ kind: z.literal('not_computable'), reason: z.string() }),
  z.object({
    kind: z.literal('computed'),
    engineVersion: z.string(),
    assumptionsVersion: z.string(),
    plannedRetirementAge: z.number(),
    baseline: retirementAgeEffectSchema,
    withAction: retirementAgeEffectSchema,
    yearsEarlier: z.number().nullable(),
    monthsOfSpending: monthsOfSpendingSchema,
    assumption: z.string(),
  }),
]);

type RetirementEffectWire = z.infer<typeof retirementEffectSchema>;

/**
 * Reshape the stored JSONB (`brief/ports.ts#RetirementImpactAnswer`, written
 * once by `serializeRetirementEffect` at publish time — never called here)
 * for the wire: money is already `{minor, currency}` (`Money.toJSON`'s own
 * shape); `monthsOfSpending.months` is a stored `number` and becomes a
 * decimal string. Nothing here derives a new value.
 */
function retirementEffectWire(raw: Record<string, unknown>): RetirementEffectWire {
  if (raw['kind'] === 'not_computable') {
    return { kind: 'not_computable', reason: String(raw['reason']) };
  }
  const monthsRaw = raw['monthsOfSpending'] as Record<string, unknown>;
  const monthsOfSpending: z.infer<typeof monthsOfSpendingSchema> =
    monthsRaw['months'] === null
      ? {
          months: null,
          reason: monthsRaw['reason'] as 'retirement_started' | 'no_retirement_spending',
        }
      : {
          months: String(monthsRaw['months']),
          atAge: Number(monthsRaw['atAge']),
          wealthDifference: monthsRaw['wealthDifference'] as { minor: string; currency: string },
          firstYearSpending: monthsRaw['firstYearSpending'] as {
            minor: string;
            currency: string;
          },
          derivation: String(monthsRaw['derivation']),
        };
  return {
    kind: 'computed',
    engineVersion: String(raw['engineVersion']),
    assumptionsVersion: String(raw['assumptionsVersion']),
    plannedRetirementAge: Number(raw['plannedRetirementAge']),
    baseline: raw['baseline'] as z.infer<typeof retirementAgeEffectSchema>,
    withAction: raw['withAction'] as z.infer<typeof retirementAgeEffectSchema>,
    yearsEarlier:
      raw['yearsEarlier'] === null || raw['yearsEarlier'] === undefined
        ? null
        : Number(raw['yearsEarlier']),
    monthsOfSpending,
    assumption: String(raw['assumption']),
  };
}

const briefItemSchema = z
  .object({
    id: z.uuid(),
    section: z.enum(['ranked', 'attention']),
    position: z.int(),
    insightId: z.uuid().nullable(),
    advisorId: z.string(),
    insightKey: z.string(),
    insightType: z.string(),
    severity: z.string(),
    title: z.string(),
    summaryMd: z.string(),
    confidence: z.number(),
    horizon: z.string(),
    carried: z.boolean(),
    annualizedImpact: moneySchema.nullable(),
    oneTimeImpact: moneySchema.nullable(),
    evidence: z.array(evidenceSchema),
    score: z.number().nullable(),
    retirementEffect: retirementEffectSchema,
  })
  .meta({ id: 'BriefItem' });

const briefSchema = z
  .object({
    id: z.uuid(),
    isoWeek: z.string(),
    currency: z.string().length(3),
    nothingMaterial: z.boolean(),
    coldStart: z.boolean(),
    coldStartNote: z.string().nullable(),
    inputDigest: z.string(),
    publishedAt: isoInstant,
    items: z.array(briefItemSchema),
  })
  .meta({ id: 'AdvisoryBrief' });

// ---------------------------------------------------------------------------
// WP 5.8 — the health score, folded into this file per the dispatch's
// ownership note (05 §3 WP 5.10/5.8). Mirrors `HealthScoreResult`
// (`@ctx/insights/health/score.ts`) exactly: six named components, each
// with value, band, weight, score and direction in words — never an opaque
// single number (09 ADV-7) — plus an excluded list naming any component a
// snapshot had no data for.
// ---------------------------------------------------------------------------

const healthComponentWireSchema = z
  .object({
    component: z.enum(HEALTH_COMPONENT_IDS),
    /** A decimal string (months, a ratio) or `Money` — never a JSON number. */
    value: z.union([z.string(), moneySchema]),
    band: z.enum(HEALTH_BANDS),
    /** A decimal string, renormalised over the computable components. */
    weight: z.string(),
    /** 0-100. */
    score: z.number(),
    direction: z.enum(HEALTH_SCORE_DIRECTIONS),
  })
  .meta({ id: 'HealthScoreComponent' });

const healthExcludedWireSchema = z
  .object({
    component: z.enum(HEALTH_COMPONENT_IDS),
    reason: z.string(),
  })
  .meta({ id: 'HealthScoreExcludedComponent' });

const healthScoreSchema = z
  .object({
    isoWeek: z.string(),
    /** 0-100, or `null` when every component was excluded that week. */
    overall: z.number().nullable(),
    components: z.array(healthComponentWireSchema),
    excluded: z.array(healthExcludedWireSchema),
    computedAt: isoInstant,
  })
  .meta({ id: 'HealthScore' });

function healthScoreNotComputed(): AppError {
  return new AppError({
    status: 404,
    code: 'insights.health_score_not_computed',
    title: 'Not Found',
    detail: 'No health score has been computed for this holder yet.',
    family: 'user',
  });
}

function briefNotFound(detail: string): AppError {
  return new AppError({
    status: 404,
    code: 'insights.brief_not_found',
    title: 'Not Found',
    detail,
    family: 'user',
  });
}

/**
 * Two independent predicates, matching `brief/store.ts#findBriefByWeek`'s own
 * query exactly (read against its source at the top of this file): the row
 * must belong to the caller **and**, when a week is named, match that week.
 * `isoWeek === undefined` is "current" — see this file's header.
 */
async function loadBrief(
  deps: RouteDeps,
  userId: string,
  isoWeek: string | undefined,
): Promise<typeof advisoryBriefs.$inferSelect | null> {
  const rows = await deps.database
    .select()
    .from(advisoryBriefs)
    .where(
      isoWeek === undefined
        ? eq(advisoryBriefs.userId, userId)
        : and(eq(advisoryBriefs.userId, userId), eq(advisoryBriefs.isoWeek, isoWeek)),
    )
    .orderBy(desc(advisoryBriefs.isoWeek))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Two independent predicates, matching `brief/store.ts#listBriefItems`'s own
 * query exactly: the row must belong to the caller **and** belong to this
 * Brief. Dropping either alone is this WP's cross-user sabotage matrix (§5
 * item 8); both are needed together (`briefId` is a UUID but not by itself a
 * secret the route treats as authorization — `userId` is what an attacker
 * cannot supply).
 */
async function loadItems(
  deps: RouteDeps,
  userId: string,
  briefId: string,
): Promise<readonly (typeof advisoryBriefItems.$inferSelect)[]> {
  return deps.database
    .select()
    .from(advisoryBriefItems)
    .where(and(eq(advisoryBriefItems.userId, userId), eq(advisoryBriefItems.briefId, briefId)));
}

function serialiseBrief(
  brief: typeof advisoryBriefs.$inferSelect,
  items: readonly (typeof advisoryBriefItems.$inferSelect)[],
): z.infer<typeof briefSchema> {
  const sorted = [...items].sort((a, b) =>
    a.section === b.section ? a.position - b.position : a.section.localeCompare(b.section),
  );
  return {
    id: brief.id,
    isoWeek: brief.isoWeek,
    currency: brief.currency,
    nothingMaterial: brief.nothingMaterial,
    coldStart: brief.coldStart,
    coldStartNote: brief.coldStartNote,
    inputDigest: brief.inputDigest,
    publishedAt: brief.publishedAt.toISOString(),
    items: sorted.map((item) => ({
      id: item.id,
      section: item.section,
      position: item.position,
      insightId: item.insightId,
      advisorId: item.advisorId,
      insightKey: item.insightKey,
      insightType: item.insightType,
      severity: item.severity,
      title: item.title,
      summaryMd: item.summaryMd,
      confidence: Number.parseFloat(item.confidence),
      horizon: item.horizon,
      carried: item.carried,
      annualizedImpact:
        item.impactAnnualizedMinor === null || item.impactCurrency === null
          ? null
          : { minor: item.impactAnnualizedMinor.toString(), currency: item.impactCurrency },
      oneTimeImpact:
        item.impactOneTimeMinor === null || item.impactCurrency === null
          ? null
          : { minor: item.impactOneTimeMinor.toString(), currency: item.impactCurrency },
      evidence: item.evidence as unknown as z.infer<typeof evidenceSchema>[],
      score: item.score === null ? null : Number.parseFloat(item.score),
      retirementEffect: retirementEffectWire(item.retirementEffect),
    })),
  };
}

export const briefRoutes = (deps: RouteDeps): FastifyPluginAsyncZod => {
  const { guards } = deps;

  return async (app) => {
    app.get(
      '/insights/brief/current',
      {
        schema: {
          operationId: 'getCurrentBrief',
          summary: 'The most recently published Weekly Advisory Brief',
          description:
            'Served exactly as stored (05 §3 WP 5.10) — no ranking, no retirement-effect ' +
            'recomputation. 404 `insights.brief_not_found` when no Brief has ever been published.',
          tags: ['insights'],
          response: {
            200: z.object({ brief: briefSchema }),
            ...problems(401, 404),
          },
        },
      },
      async (request) => {
        const session = await guards.requireSession(request);
        const brief = await loadBrief(deps, session.userId, undefined);
        if (brief === null) {
          throw briefNotFound('no Weekly Advisory Brief has been published for this holder yet');
        }
        const items = await loadItems(deps, session.userId, brief.id);
        return { brief: serialiseBrief(brief, items) };
      },
    );

    app.get(
      '/insights/brief/:isoWeek',
      {
        schema: {
          operationId: 'getBriefByWeek',
          summary: 'One week’s published Weekly Advisory Brief, by its ISO week',
          tags: ['insights'],
          params: z.object({ isoWeek: isoWeekParam }),
          response: {
            200: z.object({ brief: briefSchema }),
            ...problems(400, 401, 404),
          },
        },
      },
      async (request) => {
        const session = await guards.requireSession(request);
        const brief = await loadBrief(deps, session.userId, request.params.isoWeek);
        if (brief === null) {
          throw briefNotFound(`no Weekly Advisory Brief for ${request.params.isoWeek}`);
        }
        const items = await loadItems(deps, session.userId, brief.id);
        return { brief: serialiseBrief(brief, items) };
      },
    );

    app.get(
      '/insights/health-score',
      {
        schema: {
          operationId: 'getHealthScore',
          summary: 'The holder’s financial health score, with its six-component breakdown',
          description:
            'The most recently computed week (05 §3 WP 5.8), served exactly as stored — no ' +
            'recomputation on read, the same rule the Brief above follows. Six named ' +
            'components, each with value, band, weight, score and direction of travel against ' +
            'the previous stored week; a component with no data is named in `excluded`, never ' +
            'scored as zero (09 ADV-7). 404 `insights.health_score_not_computed` when no score ' +
            'has ever been computed for this holder.',
          tags: ['insights'],
          response: {
            200: z.object({ healthScore: healthScoreSchema }),
            ...problems(401, 404),
          },
        },
      },
      async (request) => {
        const session = await guards.requireSession(request);
        const score = await findLatestHealthScore(deps.database, session.userId);
        if (score === null) {
          throw healthScoreNotComputed();
        }
        return {
          healthScore: {
            isoWeek: score.isoWeek,
            overall: score.overall,
            components: score.components.map((component) => ({ ...component })),
            excluded: score.excluded.map((excluded) => ({ ...excluded })),
            computedAt: score.computedAt.toISOString(),
          },
        };
      },
    );
  };
};
