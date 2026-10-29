// SPDX-License-Identifier: MIT
/**
 * `/insights/*` and `/advisors/*` — the advisory feed, as HTTP.
 *
 * WP 2.6 shipped `@ctx/insights`'s platform (contract, validator, cooldown
 * ladder, alert budget, kill switches) with a named but unbuilt route file
 * (`docs/evidence/phase-2/wp2.6-insights.md` §6: "the plan assigns this route
 * file to WP 2.6's Owns list; it is not built here ... everything the route
 * needs is exported"). This file is that route.
 *
 * ## Auth policy
 *
 * Reading the feed and reviewing an insight (`accept`/`dismiss`/`snooze`) are
 * the user answering a question about their own data — session-only, the
 * `rules.ts` shape. Turning an advisor on or off (kill switch 2) and
 * triggering a manual run both change what the *system* does on a schedule
 * with no further click from the user, which is closer to
 * `connections.ts`'s "attach or destroy" than to an overlay edit — both need
 * `requireFreshSession`.
 *
 * ## `POST /advisors/run` needs the same `InsightsDependencies`
 * `apps/api/src/modules.ts`'s `insightsModule` builds for the nightly job
 *
 * Built here rather than threaded through `RouteDeps`, for the reason
 * `modules.ts`'s own comment gives: it is feature-detected on
 * `config.secrets.advisor_token_secret`, which is absent until an operator
 * opts in. Absent here means a 503 naming why, not a run with a secret nobody
 * chose.
 *
 * ## Kill level 1 is read, not assumed (WP 5.1, Phase 4 gate C-7 / G4-9)
 *
 * Until WP 5.1 this file built `InsightsSettings` with `advisorsEnabled: true,
 * moduleEnabled: true` as literals, so with `module.insights` off the button
 * still ran every advisor (the gate's probe: 31 `completed`). The run now
 * reads both halves of level 1 — `config.env.ADVISORS_ENABLED` and the
 * `module.insights` flag — and level 2, through `createRunSwitches` over an
 * **uncached** flag reader (`ttlMs: 0`): the same port the run watcher polls
 * once a second while a run is in flight, so a 30-second flag cache cannot
 * stand between a kill and the run it kills. `POST /advisors/run` checks level
 * 1 before anything else and answers 409 naming it, running nothing; every
 * run the service starts re-checks all four levels itself.
 *
 * A `local_model` advisor is never executed here: `requestAdvisorRuns` queues
 * it as `insights.run_local` and the response says `queued`.
 */
import { PLATFORM_FLAGS, createFlagService, platformExecutor } from '@core/platform';
import {
  advisorHealth,
  clearQuarantine,
  createBuiltinRegistry,
  createRunSwitches,
  findAdvisor,
  findInsight,
  insightFeed,
  listInsights,
  requestAdvisorRuns,
  reviewInsight,
  setAdvisorEnabled,
  CATEGORY_SUGGEST_ADVISOR_ID,
  contextLineOf,
  mentionCandidatesOf,
  segmentText,
  setInsightBookmark,
  setInsightFeedback,
  MENTION_ENTITY_TYPES,
  type AdvisorKind,
  type NamedMention,
  type InsightsContext,
  type InsightsDependencies,
  type InsightView,
  type RunSwitches,
  talkThroughRuleOf,
} from '@ctx/insights';
import {
  INSIGHT_HELPFULNESS_VALUES,
  INSIGHT_STATUSES,
  REASON_CODES,
  type InsightStatus,
} from '@ctx/insights/schema';
import { listCategories } from '@ctx/categorization';
import { listAccounts } from '@ctx/ledger';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  createInsightsBudgetPort,
  createInsightsCategorizationPort,
  createInsightsInvestmentsPort,
  createInsightsPlanningPort,
  createInsightsLedgerPort,
  createInsightsMarketDataPort,
  createInsightsRecurringPort,
} from '../domain.ts';
import { ADVISOR_KIND_FLAGS, MODULE_FLAGS } from '../platform.ts';
import { AppError, problems } from '../problem.ts';
import { isoInstant, moneyOrNull } from '../wire.ts';
import type { RouteDeps } from './deps.ts';

/** D6: one account holder. */
async function timezoneOf(deps: RouteDeps): Promise<string> {
  const rows = await deps.pool.query<{ display_timezone: string }>(
    `SELECT display_timezone FROM users ORDER BY created_at, id LIMIT 1`,
  );
  return rows.rows[0]?.display_timezone ?? 'UTC';
}

const FEEDBACK_ACTIONS = ['accept', 'dismiss', 'snooze', 'reopen'] as const;

function insightNotFound(insightId: string): AppError {
  return new AppError({
    status: 404,
    code: 'insights.insight_not_found',
    title: 'Not Found',
    detail: `no insight ${insightId}`,
    family: 'user',
  });
}

const evidenceSchema = z.object({
  position: z.int(),
  kind: z.string(),
  label: z.string(),
  value: z.string().nullable(),
  sourceRef: z.string().nullable(),
  resolvedDisplay: z.string().nullable(),
  href: z.string().nullable(),
});

const actionSchema = z.object({
  position: z.int(),
  kind: z.string(),
  label: z.string(),
  rationaleMd: z.string(),
  url: z.string().nullable(),
});

const insightTextSegmentSchema = z
  .object({
    text: z.string(),
    entityType: z.enum(MENTION_ENTITY_TYPES).optional(),
    entityId: z.uuid().optional(),
  })
  .meta({
    id: 'InsightTextSegment',
    description:
      "A run of an insight's text; with `entityType`/`entityId` it names an entity and is a link.",
  });

const insightMentionSchema = z
  .object({
    text: z.string(),
    entityType: z.enum(MENTION_ENTITY_TYPES),
    entityId: z.uuid(),
    /** The evidence row (by `position`) that cites the entity — the client re-resolves it against `evidence`. */
    evidencePosition: z.int(),
  })
  .meta({ id: 'InsightMention' });

const insightSchema = z
  .object({
    id: z.uuid(),
    advisorId: z.string(),
    /**
     * WP 3.13 carry-over: absent from this route until now
     * (03-phase-3-dispatch.md §2, "`advisor_version` absent from the
     * evidence panel"). `advisors.version` at the moment this insight was
     * written. camelCase, matching every other field on this response —
     * `advisor_version` is the advisor *contract*'s own snake_case name
     * (`@ctx/insights`'s `contract/response.ts`, a different wire format for
     * a different audience), not a convention this HTTP surface otherwise
     * follows.
     */
    advisorVersion: z.string(),
    key: z.string(),
    period: z.string(),
    type: z.string(),
    severity: z.string(),
    severityClamped: z.boolean(),
    title: z.string(),
    summaryMd: z.string(),
    confidence: z.number(),
    confidenceBasis: z.string(),
    horizon: z.string(),
    status: z.enum(INSIGHT_STATUSES),
    annualizedImpact: z.object({ minor: z.string(), currency: z.string() }).nullable(),
    oneTimeImpact: z.object({ minor: z.string(), currency: z.string() }).nullable(),
    impactBasis: z.string(),
    caveats: z.array(z.string()),
    inputDigest: z.string(),
    firstProposedAt: isoInstant,
    lastProposedAt: isoInstant,
    expiresAt: isoInstant.nullable(),
    evidence: z.array(evidenceSchema),
    actions: z.array(actionSchema),
    /** WP 10.15 (0051): when the holder bookmarked it; `null` = not bookmarked. */
    bookmarkedAt: isoInstant.nullable(),
    /** WP 10.15 (0051): "was this helpful?"; `null` = not answered. Persisted on the row; never moves policy. */
    feedback: z.enum(INSIGHT_HELPFULNESS_VALUES).nullable(),
    /** WP 10.15 (0051): the reason code given with `not_helpful`. */
    feedbackReason: z.enum(REASON_CODES).nullable(),
    /**
     * WP 10.15: the entities this insight's own evidence names (`@ctx/insights`' `mentions.ts`): a category,
     * account or transaction whose id an evidence row cites, named by its current label (a transaction by the
     * evidence row's label). An id the holder no longer has is dropped, never invented. Merchants cross the
     * advisor boundary as one-way pseudonyms (D22) and so never appear here.
     */
    mentions: z.array(insightMentionSchema),
    /** `title` split on the mentions' names (the texts concatenate to `title`). */
    titleSegments: z.array(insightTextSegmentSchema),
    /** `summaryMd` split the same way. */
    bodySegments: z.array(insightTextSegmentSchema),
    /** "About Groceries, Checking · transaction 1 …", or `null` when the insight names no entity. */
    contextLine: z.array(insightTextSegmentSchema).nullable(),
    /**
     * WP 11.5e: whether this finding offers "Talk this through" — a pending built-in finding whose rule has a
     * calculation the advisor can work from (`POST /advisor/sessions` with `origin`).
     */
    talkThrough: z.boolean(),
  })
  .meta({ id: 'Insight' });

/** Names for the entities an insight's evidence can mention: categories (archived included) and accounts (closed included). */
interface MentionNames {
  readonly category: ReadonlyMap<string, string>;
  readonly account: ReadonlyMap<string, string>;
}

const NO_NAMES: MentionNames = { category: new Map(), account: new Map() };

/** Read the names only when some insight's evidence cites an entity — most feeds cite none. */
async function mentionNamesFor(
  deps: RouteDeps,
  userId: string,
  views: readonly InsightView[],
): Promise<MentionNames> {
  const kinds = new Set(
    views.flatMap((view) => mentionCandidatesOf(view.evidence).map((c) => c.entityType)),
  );
  if (!kinds.has('category') && !kinds.has('account')) return NO_NAMES;
  const [categories, accounts] = await Promise.all([
    kinds.has('category')
      ? listCategories(deps.database, userId, { includeArchived: true })
      : Promise.resolve([]),
    kinds.has('account')
      ? listAccounts(deps.database, { userId, includeClosed: true })
      : Promise.resolve([]),
  ]);
  return {
    category: new Map(categories.map((category) => [category.id.toLowerCase(), category.label])),
    account: new Map(accounts.map((account) => [account.id.toLowerCase(), account.name])),
  };
}

/** The evidence-backed mentions, named; an entity with no name in this holder's data is dropped. */
function namedMentionsOf(
  view: InsightView,
  names: MentionNames,
): (NamedMention & { readonly evidencePosition: number })[] {
  return mentionCandidatesOf(view.evidence).flatMap((candidate) => {
    const text =
      candidate.entityType === 'transaction'
        ? candidate.label
        : (candidate.entityType === 'category' ? names.category : names.account).get(
            candidate.entityId,
          );
    if (text === undefined || text.length === 0) return [];
    return [
      {
        text,
        entityType: candidate.entityType,
        entityId: candidate.entityId,
        evidencePosition: candidate.evidencePosition,
      },
    ];
  });
}

function serialiseInsight(
  view: InsightView,
  names: MentionNames = NO_NAMES,
): z.infer<typeof insightSchema> {
  const mentions = namedMentionsOf(view, names);
  // A transaction's "name" is its evidence label, which is not a word in the title or body.
  const linkable = mentions.filter((mention) => mention.entityType !== 'transaction');
  return {
    id: view.id,
    advisorId: view.advisorId,
    advisorVersion: view.advisorVersion,
    key: view.key,
    period: view.period,
    type: view.type,
    severity: view.severity,
    severityClamped: view.severityClamped,
    title: view.title,
    summaryMd: view.summaryMd,
    confidence: view.confidence,
    confidenceBasis: view.confidenceBasis,
    horizon: view.horizon,
    status: view.status,
    annualizedImpact: moneyOrNull(view.annualizedImpact),
    oneTimeImpact: moneyOrNull(view.oneTimeImpact),
    impactBasis: view.impactBasis,
    caveats: [...view.caveats],
    inputDigest: view.inputDigest,
    firstProposedAt: view.firstProposedAt.toISOString(),
    lastProposedAt: view.lastProposedAt.toISOString(),
    expiresAt: view.expiresAt === null ? null : view.expiresAt.toISOString(),
    evidence: view.evidence.map((row) => ({ ...row })),
    actions: view.actions.map((row) => ({ ...row })),
    bookmarkedAt: view.bookmarkedAt === null ? null : view.bookmarkedAt.toISOString(),
    feedback: view.feedback,
    feedbackReason: view.feedbackReason,
    mentions: mentions.map((mention) => ({ ...mention })),
    titleSegments: segmentText(view.title, linkable),
    bodySegments: segmentText(view.summaryMd, linkable),
    contextLine: contextLineOf(mentions),
    talkThrough: view.status === 'pending_review' && talkThroughRuleOf(view.advisorId) !== null,
  };
}

const advisorHealthSchema = z
  .object({
    advisorId: z.string(),
    displayName: z.string(),
    kind: z.string(),
    version: z.string(),
    enabled: z.boolean(),
    quarantinedAt: isoInstant.nullable(),
    quarantineReason: z.string().nullable(),
    consecutiveFailures: z.int().nonnegative(),
    lastRunAt: isoInstant.nullable(),
    grantedScopes: z.array(z.string()),
    lastRunStatus: z.string().nullable(),
    lastRunRejected: z.int().nonnegative().nullable(),
  })
  .meta({ id: 'AdvisorHealth' });

function contextOf(
  deps: RouteDeps,
  userId: string,
  request: { readonly id: unknown },
): InsightsContext {
  return { userId, clock: deps.clock, correlationId: String(request.id) };
}

/**
 * Kill levels 1 and 2 for this process, read live.
 *
 * `ttlMs: 0` — every read goes to `feature_flags`. The run watcher polls this
 * once a second for the one run in flight; the platform's default 30-second
 * cache would make a flipped `module.insights` take up to 30 s to stop it.
 * `configuredKinds`: a `local_model` advisor is on only when this deployment
 * has a local model configured (`LOCAL_MODEL_ENDPOINT` with its name and
 * digest — `config.localModel`), whatever its flag says.
 */
function runSwitchesOf(deps: RouteDeps): RunSwitches {
  const configuredKinds = new Set<AdvisorKind>(['builtin']);
  if (deps.config.localModel !== undefined) configuredKinds.add('local_model');
  return createRunSwitches({
    advisorsEnabled: deps.config.env.ADVISORS_ENABLED,
    flags: createFlagService({
      db: platformExecutor(deps.database),
      defaults: [...PLATFORM_FLAGS, ...MODULE_FLAGS, ...ADVISOR_KIND_FLAGS],
      ttlMs: 0,
    }),
    configuredKinds,
  });
}

/**
 * Level 1, before anything else: a run with the module off is refused, named,
 * and nothing is started — not even a refused `advisor_runs` row per advisor,
 * because a disabled module contributes nothing (`resolveModules`, MF1).
 */
async function assertLevelOneOn(switches: RunSwitches, userId: string): Promise<void> {
  if (!(await switches.advisorsEnabled())) {
    throw new AppError({
      status: 409,
      code: 'insights.advisors_disabled',
      title: 'Conflict',
      detail:
        'Advisors are switched off for this deployment (ADVISORS_ENABLED=false, kill level 1); ' +
        'nothing was run.',
      family: 'domain',
    });
  }
  if (!(await switches.moduleEnabled(userId))) {
    throw new AppError({
      status: 409,
      code: 'insights.module_disabled',
      title: 'Conflict',
      detail:
        'The insights module is switched off (module.insights, kill level 1); nothing was run.',
      family: 'domain',
    });
  }
}

/** Feature-detected, the same way `modules.ts`'s `insightsModule` is. */
function dependenciesOf(
  deps: RouteDeps,
  timeZone: string,
  switches: RunSwitches,
): InsightsDependencies {
  const tokenSecret = deps.config.secrets.advisor_token_secret;
  if (tokenSecret === undefined) {
    throw new AppError({
      status: 503,
      code: 'insights.advisor_token_secret_unconfigured',
      title: 'Service Unavailable',
      detail:
        'No advisor_token_secret is configured; an operator must write one before an advisor ' +
        'can run (see wp2.6-insights.md §6).',
      family: 'internal',
    });
  }
  return {
    registry: createBuiltinRegistry(),
    ports: {
      ledger: createInsightsLedgerPort(deps.database, deps.clock),
      budget: createInsightsBudgetPort(deps.database),
      recurring: createInsightsRecurringPort(deps.database),
      // WP 3.10a. The portfolio ports need only a database handle. The market
      // rates port needs a FRED source, and this process has none: `app.ts`
      // builds no `MarketDataRuntime` because the API runs no jobs and must
      // not declare the 03:45 schedule row (`modules.ts`' `integrationsModule`
      // and `phase3-registration.test.ts` both turn on that). So an on-demand
      // run emits no `market_rates` block and the nightly run in the worker
      // does — a real asymmetry, named in `wp3.10a-snapshot-readers.md` §6
      // rather than papered over with a rate this process did not read.
      investments: createInsightsInvestmentsPort(deps.database, deps.clock),
      // WP 4.9: the Planning readers behind `goals.list`, `risk.profile` and
      // `plan.projection` — the same port the worker's nightly run binds.
      planning: createInsightsPlanningPort(deps.database, deps.clock, { timeZone }),
      marketData: createInsightsMarketDataPort({ source: undefined }),
      // WP 11.1: `categorization.rule_candidates`, bound as the worker's
      // `insightsModule` binds it, so an on-demand run (and its preview) sees the
      // same block the nightly run does.
      categorization: createInsightsCategorizationPort(deps.database, deps.clock),
    },
    // Levels 1 and 2 are read live through `switches`; there is no literal
    // `true` here any more (G4-9). No `promptRenderer`: this process never
    // executes a `local_model` advisor, it queues one (`requestAdvisorRuns`).
    switches,
    settings: {
      timeZone,
      baseCurrency: 'USD',
      tokenSecret: tokenSecret.reveal(),
    },
  };
}

/**
 * `?statuses=pending_review` — WP 3.13 carry-over (03-phase-3-dispatch.md §2,
 * wp2.11-inbox-ui.md §5). The prior schema, `z.array(z.enum(INSIGHT_STATUSES))`,
 * only ever validated a *repeated* querystring key (`?statuses=a&statuses=b`)
 * — the one-status form an inbox actually needs, `?statuses=pending_review`,
 * failed schema validation with a 400 (`fst_err_validation`, "expected array,
 * received string"), because Fastify's querystring parser hands a bare
 * single value through as a string, not a one-element array. `idList`
 * (`../wire.ts`) already solves exactly this for `states`/`types`/
 * `merchantIds` elsewhere; not reused here because those accept arbitrary
 * strings and this one must fail closed on a status that is not one of the
 * four enumerated values, which a plain `idList` (unvalidated beyond
 * non-empty) does not do.
 */
const statusList = z
  .union([z.enum(INSIGHT_STATUSES), z.array(z.enum(INSIGHT_STATUSES))])
  .optional()
  .transform((value): readonly InsightStatus[] | undefined =>
    value === undefined ? undefined : Array.isArray(value) ? value : [value],
  );

export const insightRoutes = (deps: RouteDeps): FastifyPluginAsyncZod => {
  const { guards, database, clock } = deps;
  const switches = runSwitchesOf(deps);

  return async (app) => {
    app.get(
      '/insights',
      {
        schema: {
          operationId: 'listInsightsFeed',
          summary: 'The advisory feed: pending review and already-reviewed, alert budget applied',
          tags: ['insights'],
          querystring: z.object({
            statuses: statusList,
          }),
          response: {
            200: z.object({
              dashboard: z.array(insightSchema),
              list: z.array(insightSchema),
              overflow: z.array(insightSchema),
              belowFloor: z.array(insightSchema),
            }),
            ...problems(401, 503),
          },
        },
      },
      async (request) => {
        const session = await guards.requireSession(request);
        const feed = await insightFeed(database, {
          userId: session.userId,
          statuses: request.query.statuses ?? [...INSIGHT_STATUSES],
          now: clock.now(),
          currency: 'USD',
        });
        const names = await mentionNamesFor(deps, session.userId, [
          ...feed.dashboard,
          ...feed.list,
          ...feed.overflow,
          ...feed.belowFloor,
        ]);
        const wire = (view: InsightView) => serialiseInsight(view, names);
        return {
          dashboard: feed.dashboard.map(wire),
          list: feed.list.map(wire),
          overflow: feed.overflow.map(wire),
          belowFloor: feed.belowFloor.map(wire),
        };
      },
    );

    app.get(
      '/insights/:insightId',
      {
        schema: {
          operationId: 'getInsight',
          summary: 'One insight, with its evidence panel',
          tags: ['insights'],
          params: z.object({ insightId: z.uuid() }),
          response: {
            200: z.object({ insight: insightSchema }),
            ...problems(401, 404, 503),
          },
        },
      },
      async (request) => {
        const session = await guards.requireSession(request);
        const rows = await listInsights(database, {
          userId: session.userId,
          statuses: [],
          now: clock.now(),
        });
        const found = rows.find((row) => row.id === request.params.insightId);
        if (found === undefined) {
          throw new AppError({
            status: 404,
            code: 'insights.insight_not_found',
            title: 'Not Found',
            detail: `no insight ${request.params.insightId}`,
            family: 'user',
          });
        }
        return {
          insight: serialiseInsight(found, await mentionNamesFor(deps, session.userId, [found])),
        };
      },
    );

    app.post(
      '/insights/:insightId/review',
      {
        schema: {
          operationId: 'reviewInsight',
          summary: 'Accept, dismiss, snooze or reopen an insight',
          description:
            'A dismissal starts the 30/90/permanent cooldown ladder — the third dismissal of the ' +
            "same finding suppresses it permanently (`@ctx/insights`'s `policy/cooldown.ts`). " +
            "An optional `reasonCode` (07 §8.3's seven-value taxonomy, WP 5.9) drives the feedback " +
            "loop: NOT_TRUE counts toward the rule's quarantine rate, ALREADY_KNOW skips to the " +
            '90-day rung, DONT_CARE turns the rule off for this holder, INTENTIONAL suppresses the ' +
            'entity permanently. Omitted, the three legacy preset strings in `reason` are still ' +
            'matched by exact text.',
          tags: ['insights'],
          params: z.object({ insightId: z.uuid() }),
          body: z.object({
            action: z.enum(FEEDBACK_ACTIONS),
            reason: z.string().nullable().optional(),
            reasonCode: z.enum(REASON_CODES).nullable().optional(),
            snoozeUntil: isoInstant.nullable().optional(),
          }),
          response: {
            200: z.object({
              insightId: z.uuid(),
              status: z.string(),
              dismissCount: z.int().nonnegative(),
              permanent: z.boolean(),
              suppressedUntil: isoInstant.nullable(),
            }),
            ...problems(400, 401, 404, 503),
          },
        },
      },
      async (request) => {
        const session = await guards.requireSession(request);
        const existing = await findInsight(database, session.userId, request.params.insightId);
        if (existing === null) {
          throw new AppError({
            status: 404,
            code: 'insights.insight_not_found',
            title: 'Not Found',
            detail: `no insight ${request.params.insightId}`,
            family: 'user',
          });
        }
        const result = await reviewInsight(database, contextOf(deps, session.userId, request), {
          insightId: request.params.insightId,
          action: request.body.action,
          reason: request.body.reason ?? null,
          reasonCode: request.body.reasonCode ?? null,
          snoozeUntil:
            request.body.snoozeUntil === undefined || request.body.snoozeUntil === null
              ? null
              : new Date(request.body.snoozeUntil),
        });
        return {
          insightId: result.insightId,
          status: result.status,
          dismissCount: result.dismissCount,
          permanent: result.permanent,
          suppressedUntil:
            result.suppressedUntil === null ? null : result.suppressedUntil.toISOString(),
        };
      },
    );

    app.post(
      '/insights/:insightId/bookmark',
      {
        schema: {
          operationId: 'bookmarkInsight',
          summary: 'Bookmark or un-bookmark an insight',
          description:
            'WP 10.15 (migration 0051): state on the insight row, replaced when it changes. A bookmark is the ' +
            "holder's own marker and moves no advisor policy. 404 for an insight the caller does not hold.",
          tags: ['insights'],
          params: z.object({ insightId: z.uuid() }),
          body: z.object({ bookmarked: z.boolean() }),
          response: {
            200: z.object({ insightId: z.uuid(), bookmarkedAt: isoInstant.nullable() }),
            ...problems(400, 401, 404, 503),
          },
        },
      },
      async (request) => {
        const session = await guards.requireSession(request);
        const result = await setInsightBookmark(
          database,
          session.userId,
          request.params.insightId,
          request.body.bookmarked,
          clock.now(),
        );
        if (result === null) throw insightNotFound(request.params.insightId);
        return {
          insightId: result.insightId,
          bookmarkedAt: result.bookmarkedAt === null ? null : result.bookmarkedAt.toISOString(),
        };
      },
    );

    app.post(
      '/insights/:insightId/feedback',
      {
        schema: {
          operationId: 'setInsightFeedback',
          summary: 'Say whether an insight was helpful',
          description:
            "WP 10.15 (migration 0051): `helpful`, `not_helpful` (optionally with one of 07 §8.3's reason " +
            'codes) or `null` to clear the answer and its reason. Persisted on the insight row only: unlike a ' +
            "dismissal's reason it never moves the cooldown ladder, the quarantine rate or rule health. A " +
            'reason with anything but `not_helpful` is a 400. 404 for an insight the caller does not hold.',
          tags: ['insights'],
          params: z.object({ insightId: z.uuid() }),
          body: z
            .object({
              feedback: z.enum(INSIGHT_HELPFULNESS_VALUES).nullable(),
              reasonCode: z.enum(REASON_CODES).nullable().optional(),
            })
            .refine(
              (body) =>
                body.reasonCode === undefined ||
                body.reasonCode === null ||
                body.feedback === 'not_helpful',
              'a reason is given only with "not_helpful"',
            ),
          response: {
            200: z.object({
              insightId: z.uuid(),
              feedback: z.enum(INSIGHT_HELPFULNESS_VALUES).nullable(),
              feedbackReason: z.enum(REASON_CODES).nullable(),
            }),
            ...problems(400, 401, 404, 503),
          },
        },
      },
      async (request) => {
        const session = await guards.requireSession(request);
        const result = await setInsightFeedback(
          database,
          session.userId,
          request.params.insightId,
          request.body.feedback,
          request.body.reasonCode ?? null,
        );
        if (result === null) throw insightNotFound(request.params.insightId);
        return result;
      },
    );

    app.get(
      '/advisors',
      {
        schema: {
          operationId: 'listAdvisors',
          summary: 'Every registered advisor, with the state of its kill switches',
          tags: ['insights'],
          response: {
            200: z.object({ advisors: z.array(advisorHealthSchema) }),
            ...problems(401, 503),
          },
        },
      },
      async (request) => {
        const session = await guards.requireSession(request);
        // No lazy repair (Phase 2 gate finding G2-1, condition C-1, closed):
        // `bootstrap-seed.ts`'s `seedUserState` registers the catalogue at
        // user creation, so an empty result here would mean the catalogue
        // genuinely has no rows, not a cold-install gap.
        const rows = await advisorHealth(database, session.userId);
        return {
          advisors: rows.map((row) => ({
            advisorId: row.advisorId,
            displayName: row.displayName,
            kind: row.kind,
            version: row.version,
            enabled: row.enabled,
            quarantinedAt: row.quarantinedAt === null ? null : row.quarantinedAt.toISOString(),
            quarantineReason: row.quarantineReason,
            consecutiveFailures: row.consecutiveFailures,
            lastRunAt: row.lastRunAt === null ? null : row.lastRunAt.toISOString(),
            grantedScopes: [...row.grantedScopes],
            lastRunStatus: row.lastRunStatus,
            lastRunRejected: row.lastRunRejected,
          })),
        };
      },
    );

    app.post(
      '/advisors/:advisorId/enabled',
      {
        schema: {
          operationId: 'setAdvisorEnabled',
          summary: 'Kill switch 2: turn one advisor on or off for this user',
          description: 'Needs a step-up assertion — it changes what runs on a schedule.',
          tags: ['insights'],
          params: z.object({ advisorId: z.string() }),
          body: z.object({ enabled: z.boolean(), clearQuarantine: z.boolean().optional() }),
          response: {
            200: z.object({ advisorId: z.string(), enabled: z.boolean() }),
            ...problems(401, 403, 404, 409, 503),
          },
        },
      },
      async (request) => {
        const session = await guards.requireFreshSession(request);
        const existing = await findAdvisor(database, session.userId, request.params.advisorId);
        if (existing === null) {
          throw new AppError({
            status: 404,
            code: 'insights.advisor_not_found',
            title: 'Not Found',
            detail: `no advisor ${request.params.advisorId}`,
            family: 'user',
          });
        }
        // WP 11.2: categorize.suggest is switched on only by its own card, which
        // checks the precision gate first (`/categories/suggestions/enabled`).
        // Switching it off here is always allowed.
        if (request.params.advisorId === CATEGORY_SUGGEST_ADVISOR_ID && request.body.enabled) {
          throw new AppError({
            status: 409,
            code: 'categorization.suggestions_enable_elsewhere',
            title: 'Conflict',
            detail:
              'Category suggestions are turned on in Settings, Language model, Category suggestions, which checks the precision gate first.',
            family: 'domain',
          });
        }
        const context = contextOf(deps, session.userId, request);
        await setAdvisorEnabled(database, context, request.params.advisorId, request.body.enabled);
        if (request.body.clearQuarantine === true) {
          await clearQuarantine(database, context, request.params.advisorId);
        }
        return { advisorId: request.params.advisorId, enabled: request.body.enabled };
      },
    );

    app.post(
      '/advisors/run',
      {
        schema: {
          operationId: 'runAdvisors',
          summary:
            'Manually trigger the nightly advisor pass, for one advisor or every registered one',
          description:
            'Needs a step-up assertion. 409 naming kill level 1 (`insights.advisors_disabled`, ' +
            '`insights.module_disabled`) when advisors or the module are switched off — nothing ' +
            'runs. 503 when no `advisor_token_secret` is configured. Built-in advisors run inline; ' +
            'a `local_model` advisor is queued in its own lane (`insights.run_local`) and answered ' +
            '`queued` with its job id.',
          tags: ['insights'],
          body: z.object({ advisorId: z.string().optional() }),
          response: {
            200: z.object({
              results: z.array(
                z.object({
                  /** `null` for a `queued` run: it has no `advisor_runs` row until the lane starts it. */
                  runId: z.uuid().nullable(),
                  advisorId: z.string(),
                  status: z.enum(['completed', 'failed', 'refused', 'cancelled', 'queued']),
                  refusal: z.string().nullable(),
                  cancelReason: z.string().nullable(),
                  jobId: z.uuid().nullable(),
                  proposed: z.int().nonnegative(),
                  accepted: z.int().nonnegative(),
                  rejected: z.int().nonnegative(),
                  suppressed: z.int().nonnegative(),
                  inserted: z.int().nonnegative(),
                  quarantined: z.boolean(),
                }),
              ),
            }),
            ...problems(401, 403, 409, 503),
          },
        },
      },
      async (request) => {
        const session = await guards.requireFreshSession(request);
        await assertLevelOneOn(switches, session.userId);
        const timezone = await timezoneOf(deps);
        const dependencies = dependenciesOf(deps, timezone, switches);
        const context = contextOf(deps, session.userId, request);

        const results = await requestAdvisorRuns(database, context, dependencies, {
          advisorIds:
            request.body.advisorId === undefined
              ? (await advisorHealth(database, session.userId)).map((row) => row.advisorId)
              : [request.body.advisorId],
          trigger: 'manual',
        });

        return {
          results: results.map((result) =>
            result.status === 'queued'
              ? {
                  runId: null,
                  advisorId: result.advisorId,
                  status: result.status,
                  refusal: null,
                  cancelReason: null,
                  jobId: result.jobId,
                  proposed: 0,
                  accepted: 0,
                  rejected: 0,
                  suppressed: 0,
                  inserted: 0,
                  quarantined: false,
                }
              : {
                  runId: result.runId,
                  advisorId: result.advisorId,
                  status: result.status,
                  refusal: result.refusal,
                  cancelReason: result.cancelReason,
                  jobId: null,
                  proposed: result.proposed,
                  accepted: result.accepted,
                  rejected: result.rejected,
                  suppressed: result.suppressed,
                  inserted: result.inserted,
                  quarantined: result.quarantined,
                },
          ),
        };
      },
    );
  };
};
