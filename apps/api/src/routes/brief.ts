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
 * ## A Brief item's action is the one the Brief recorded (WP 9.6, CF-24)
 *
 * `primaryAction` is read from `advisory_brief_items.primary_action`
 * (migration 0038), snapshotted at publish like the title and the summary — it
 * is never looked up in the live `insight_actions`, which the nightly upsert
 * rewrites. `null` for a Brief published before 0038: the screen says "no
 * action recorded" rather than show this week's suggestion under last week's
 * date.
 *
 * ## A Brief item's narration, and R-2's gate (WP 9.6 item 3)
 *
 * Each item carries `narration`: `narrated` (a narrator's wording is linked to
 * the item's finding, through `insights.narrates_insight_id`), `pending` (none
 * yet, but the narrator is on and the Brief is recent, so one is expected) or
 * `none`. The AI-assisted badge (`aiAssisted`) and the status are always
 * carried. The narration TEXT is delivered only when `NARRATION_TEXT_SHOWN` is
 * set — the Phase 5 gate's R-2: until WP 9.5's figure slots have landed and
 * been measured, or Chris accepts the residual in writing, the holder is not
 * shown model-written prose. The gate is read from config here, at the one
 * place the text leaves the server; the text is not on the wire at all while it
 * is closed. The narration is alternative wording beside the Brief's own
 * summary, never a replacement and never a source of a figure.
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
import { PLATFORM_FLAGS, createFlagService, platformExecutor } from '@core/platform';
import {
  findAdvisor,
  findLatestHealthScore,
  HEALTH_BANDS,
  HEALTH_COMPONENT_IDS,
  HEALTH_SCORE_DIRECTIONS,
  MODULE_FLAG_KEY,
  narrationsFor,
  retirementReasonInWords,
  type NarrationView,
} from '@ctx/insights';
import { advisoryBriefItems, advisoryBriefs } from '@ctx/insights/schema';
import { listUndismissedMilestones } from '@ctx/planning';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { ADVISOR_KIND_FLAGS, MODULE_FLAGS } from '../platform.ts';
import { AppError, problems } from '../problem.ts';
import { isoInstant, moneySchema } from '../wire.ts';
import type { NarratorRuntime } from '../narrator-wiring.ts';
import {
  briefItemBlocks,
  briefOverviewBlocks,
  type HealthForBlocks,
  type MilestoneForBlocks,
} from '../blocks/brief.ts';
import { blockDocument, blockDocumentSchema } from '../blocks/schema.ts';
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
    // Words on the wire (G5-11); the stored row keeps the engine's code.
    return { kind: 'not_computable', reason: retirementReasonInWords(String(raw['reason'])) };
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

const primaryActionSchema = z.object({
  kind: z.enum(['suggest_only', 'open_url', 'create_goal_draft', 'create_rule_draft']),
  label: z.string(),
  rationaleMd: z.string(),
  url: z.string().nullable(),
});

const narrationSchema = z.object({
  /** `narrated`: wording is linked to this item's finding. `pending`: expected, not yet arrived. `none`: no narration, none expected. */
  status: z.enum(['narrated', 'pending', 'none']),
  /** The AI-assisted badge: true exactly when `status` is `narrated`. */
  aiAssisted: z.boolean(),
  /** Whether this deployment shows narration text (`NARRATION_TEXT_SHOWN`, Phase 5 gate R-2). */
  textShown: z.boolean(),
  /** The narrator's alternative wording; null unless `narrated` AND `textShown`. */
  summaryMd: z.string().nullable(),
  /**
   * WP 10.6 (D30): who wrote the narration, named on every narration the
   * holder reads — `ollama` (the local model, by name) or the hosted provider
   * and model, as the narration's run recorded it. `null` unless `narrated`,
   * or when the run recorded no model.
   */
  narratedBy: z
    .object({
      provider: z.enum(['ollama', 'openai', 'openrouter', 'anthropic']),
      model: z.string(),
    })
    .nullable(),
});

const HOSTED_LABEL_PROVIDERS = ['openai', 'openrouter', 'anthropic'] as const;

/**
 * `advisor_runs.llm_model` in words: `name@sha256:<digest>` is the local
 * model (Ollama's names contain `:` themselves, so the digest suffix is what
 * tells it apart); `provider:model` is a hosted one. Anything else names
 * nobody, and is `null` rather than a guess.
 */
export function narratedByOf(
  llmModel: string | null,
): { provider: 'ollama' | (typeof HOSTED_LABEL_PROVIDERS)[number]; model: string } | null {
  if (llmModel === null) return null;
  const pin = llmModel.indexOf('@sha256:');
  if (pin > 0) return { provider: 'ollama', model: llmModel.slice(0, pin) };
  const colon = llmModel.indexOf(':');
  const provider = colon > 0 ? llmModel.slice(0, colon) : '';
  const model = llmModel.slice(colon + 1);
  for (const hosted of HOSTED_LABEL_PROVIDERS) {
    if (provider === hosted && model.length > 0) return { provider: hosted, model };
  }
  return null;
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
    /** CF-24: the action as the Brief said it; null for a Brief published before 0038 ("no action recorded"). */
    primaryAction: primaryActionSchema.nullable(),
    narration: narrationSchema,
    /**
     * WP 10.15 (V8): the card's deterministic content as blocks — its wording (a `text` block with role
     * `narration` under the badge whenever a narration exists or is expected), its headline figure or why there is
     * none, the carried badge. Built from the fields above (`blocks/brief.ts`); never model output.
     */
    blocks: blockDocumentSchema,
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
    /**
     * WP 10.15 (V8): the overview above the cards as blocks — the week, the ranked actions by dollar impact, net
     * worth milestones if any, and the health link card (`blocks/brief.ts`). Deterministic server code.
     */
    blocks: blockDocumentSchema,
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
 *
 * Exported (C5-6, G5-17) so `brief-routes.test.ts` can call it with a
 * *foreign* `briefId`: behind the route, `loadBrief`'s user-scoped read always
 * hands it the caller's own Brief, and the composite FK
 * `(user_id, brief_id) → advisory_briefs (user_id, id)` makes a mismatched
 * item row unrepresentable, so the `userId` predicate here could not otherwise
 * be seen to matter. The route calls this same function — no parallel copy.
 */
export async function loadItems(
  database: RouteDeps['database'],
  userId: string,
  briefId: string,
): Promise<readonly (typeof advisoryBriefItems.$inferSelect)[]> {
  return database
    .select()
    .from(advisoryBriefItems)
    .where(and(eq(advisoryBriefItems.userId, userId), eq(advisoryBriefItems.briefId, briefId)));
}

/** What `serialiseBrief` needs to say about narrations, read once per request. */
interface NarrationContext {
  readonly byFinding: ReadonlyMap<string, NarrationView>;
  /** A narration is expected to arrive (narrator on, model configured, Brief recent). */
  readonly expected: boolean;
  /** `NARRATION_TEXT_SHOWN`. */
  readonly textShown: boolean;
}

/**
 * A narration not delivered within a day of the Brief's publication is not
 * "pending" any more — the narrator failed, was refused or was quarantined, and
 * the Brief's own text stands (07 §7.5 rule 1). A status that read "pending"
 * for ever would be a promise nothing keeps.
 */
export const NARRATION_PENDING_WINDOW_MS = 24 * 60 * 60 * 1000;

function narrationOfItem(
  item: typeof advisoryBriefItems.$inferSelect,
  context: NarrationContext,
): z.infer<typeof narrationSchema> {
  const found = item.insightId === null ? undefined : context.byFinding.get(item.insightId);
  if (found !== undefined) {
    return {
      status: 'narrated',
      aiAssisted: true,
      textShown: context.textShown,
      summaryMd: context.textShown ? found.summaryMd : null,
      narratedBy: narratedByOf(found.llmModel),
    };
  }
  return {
    status: context.expected ? 'pending' : 'none',
    aiAssisted: false,
    textShown: context.textShown,
    summaryMd: null,
    narratedBy: null,
  };
}

function flagServiceOf(deps: RouteDeps) {
  return createFlagService({
    db: platformExecutor(deps.database),
    defaults: [...PLATFORM_FLAGS, ...MODULE_FLAGS, ...ADVISOR_KIND_FLAGS],
    ttlMs: 0,
  });
}

/**
 * Is a narration expected for a Brief published at `publishedAt`? Only if every
 * level of the ladder that stands between a Brief and its narration is open:
 * a model is configured on this deployment, `ADVISORS_ENABLED`, the holder's
 * `module.insights` and `advisors.kind.local_model`, and the narrator itself
 * registered, enabled and not quarantined — and the Brief is recent.
 */
async function narrationExpected(
  deps: RouteDeps,
  userId: string,
  publishedAt: Date,
  runtime: BriefRouteOptions['narrator'],
): Promise<boolean> {
  // WP 10.6: per holder — their chosen provider, or the local model; Off is none.
  if (runtime === undefined) {
    if (deps.config.localModelPin === undefined) return false;
  } else if ((await runtime.forUser(userId)) === null) {
    return false;
  }
  if (!deps.config.env.ADVISORS_ENABLED) return false;
  if (deps.clock.now().getTime() - publishedAt.getTime() > NARRATION_PENDING_WINDOW_MS) {
    return false;
  }
  const flags = flagServiceOf(deps);
  if (!(await flags.isEnabled(userId, MODULE_FLAG_KEY))) return false;
  if (!(await flags.isEnabled(userId, 'advisors.kind.local_model'))) return false;
  const narrator = await findAdvisor(deps.database, userId, 'local.narrator');
  return narrator !== null && narrator.enabled && narrator.quarantinedAt === null;
}

async function narrationContextFor(
  deps: RouteDeps,
  options: BriefRouteOptions,
  userId: string,
  brief: typeof advisoryBriefs.$inferSelect,
  items: readonly (typeof advisoryBriefItems.$inferSelect)[],
): Promise<NarrationContext> {
  const findingIds = items.flatMap((item) => (item.insightId === null ? [] : [item.insightId]));
  const [byFinding, expected] = await Promise.all([
    narrationsFor(deps.database, userId, findingIds),
    narrationExpected(deps, userId, brief.publishedAt, options.narrator),
  ]);
  return { byFinding, expected, textShown: deps.config.env.NARRATION_TEXT_SHOWN };
}

function serialiseBrief(
  brief: typeof advisoryBriefs.$inferSelect,
  items: readonly (typeof advisoryBriefItems.$inferSelect)[],
  narrations: NarrationContext,
): Omit<z.infer<typeof briefSchema>, 'blocks' | 'items'> & {
  readonly items: Omit<z.infer<typeof briefItemSchema>, 'blocks'>[];
} {
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
      primaryAction: item.primaryAction,
      narration: narrationOfItem(item, narrations),
    })),
  };
}

/** WP 10.15: the served Brief plus its blocks — built from the served fields only, after they are final. */
function withBlocks(
  served: Omit<z.infer<typeof briefSchema>, 'blocks' | 'items'> & {
    readonly items: readonly Omit<z.infer<typeof briefItemSchema>, 'blocks'>[];
  },
  overview: {
    readonly health: HealthForBlocks;
    readonly milestones: readonly MilestoneForBlocks[];
  },
): z.infer<typeof briefSchema> {
  return {
    ...served,
    items: served.items.map((item) => ({ ...item, blocks: blockDocument(briefItemBlocks(item)) })),
    blocks: blockDocument(briefOverviewBlocks(served, overview.health, overview.milestones)),
  };
}

/** The two reads the Brief screen's overview stands on, as their own routes serve them. */
async function overviewReadsFor(
  deps: RouteDeps,
  userId: string,
): Promise<{
  readonly health: HealthForBlocks;
  readonly milestones: readonly MilestoneForBlocks[];
}> {
  const [score, milestones] = await Promise.all([
    findLatestHealthScore(deps.database, userId),
    listUndismissedMilestones(deps.database, userId),
  ]);
  const health: HealthForBlocks =
    score === null
      ? { kind: 'not_computed' }
      : score.overall === null
        ? { kind: 'unscored', isoWeek: score.isoWeek }
        : { kind: 'scored', overall: score.overall, isoWeek: score.isoWeek };
  return {
    health,
    milestones: milestones.map((milestone) => ({
      id: milestone.id,
      milestone: { minor: milestone.milestoneMinor.toString(), currency: milestone.currency },
      direction: milestone.direction,
      crossedOn: milestone.crossedOn,
    })),
  };
}

export interface BriefRouteOptions {
  /** WP 10.6: the holder's narrator (the api's preview-mode runtime). Absent: `LOCAL_MODEL_PIN_*`, as before. */
  readonly narrator?: Pick<NarratorRuntime, 'forUser'>;
}

export const briefRoutes = (
  deps: RouteDeps,
  options: BriefRouteOptions = {},
): FastifyPluginAsyncZod => {
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
        const items = await loadItems(deps.database, session.userId, brief.id);
        const [narrations, overview] = await Promise.all([
          narrationContextFor(deps, options, session.userId, brief, items),
          overviewReadsFor(deps, session.userId),
        ]);
        return { brief: withBlocks(serialiseBrief(brief, items, narrations), overview) };
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
        const items = await loadItems(deps.database, session.userId, brief.id);
        const [narrations, overview] = await Promise.all([
          narrationContextFor(deps, options, session.userId, brief, items),
          overviewReadsFor(deps, session.userId),
        ]);
        return { brief: withBlocks(serialiseBrief(brief, items, narrations), overview) };
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
