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
 */
import {
  advisorHealth,
  clearQuarantine,
  createBuiltinRegistry,
  findAdvisor,
  findInsight,
  insightFeed,
  listInsights,
  reviewInsight,
  runAdvisor,
  runAdvisors,
  setAdvisorEnabled,
  type InsightsContext,
  type InsightsDependencies,
  type InsightView,
} from '@ctx/insights';
import { INSIGHT_STATUSES, type InsightStatus } from '@ctx/insights/schema';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  createInsightsBudgetPort,
  createInsightsInvestmentsPort,
  createInsightsPlanningPort,
  createInsightsLedgerPort,
  createInsightsMarketDataPort,
  createInsightsRecurringPort,
} from '../domain.ts';
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
  })
  .meta({ id: 'Insight' });

function serialiseInsight(view: InsightView): z.infer<typeof insightSchema> {
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

/** Feature-detected, the same way `modules.ts`'s `insightsModule` is. */
function dependenciesOf(deps: RouteDeps, timeZone: string): InsightsDependencies {
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
    },
    settings: {
      advisorsEnabled: true,
      moduleEnabled: true,
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
        return {
          dashboard: feed.dashboard.map(serialiseInsight),
          list: feed.list.map(serialiseInsight),
          overflow: feed.overflow.map(serialiseInsight),
          belowFloor: feed.belowFloor.map(serialiseInsight),
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
        return { insight: serialiseInsight(found) };
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
            "same finding suppresses it permanently (`@ctx/insights`'s `policy/cooldown.ts`).",
          tags: ['insights'],
          params: z.object({ insightId: z.uuid() }),
          body: z.object({
            action: z.enum(FEEDBACK_ACTIONS),
            reason: z.string().nullable().optional(),
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
            ...problems(401, 403, 404, 503),
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
            'Needs a step-up assertion. 503 when no `advisor_token_secret` is configured.',
          tags: ['insights'],
          body: z.object({ advisorId: z.string().optional() }),
          response: {
            200: z.object({
              results: z.array(
                z.object({
                  runId: z.uuid(),
                  advisorId: z.string(),
                  status: z.enum(['completed', 'failed', 'refused']),
                  refusal: z.string().nullable(),
                  proposed: z.int().nonnegative(),
                  accepted: z.int().nonnegative(),
                  rejected: z.int().nonnegative(),
                  suppressed: z.int().nonnegative(),
                  inserted: z.int().nonnegative(),
                  quarantined: z.boolean(),
                }),
              ),
            }),
            ...problems(401, 403, 503),
          },
        },
      },
      async (request) => {
        const session = await guards.requireFreshSession(request);
        const timezone = await timezoneOf(deps);
        const dependencies = dependenciesOf(deps, timezone);
        const context = contextOf(deps, session.userId, request);

        const results =
          request.body.advisorId === undefined
            ? await runAdvisors(database, context, dependencies, {
                advisorIds: (await advisorHealth(database, session.userId)).map(
                  (row) => row.advisorId,
                ),
                trigger: 'manual',
              })
            : [
                await runAdvisor(database, context, dependencies, {
                  advisorId: request.body.advisorId,
                  trigger: 'manual',
                }),
              ];

        return {
          results: results.map((result) => ({
            runId: result.runId,
            advisorId: result.advisorId,
            status: result.status,
            refusal: result.refusal,
            proposed: result.proposed,
            accepted: result.accepted,
            rejected: result.rejected,
            suppressed: result.suppressed,
            inserted: result.inserted,
            quarantined: result.quarantined,
          })),
        };
      },
    );
  };
};
