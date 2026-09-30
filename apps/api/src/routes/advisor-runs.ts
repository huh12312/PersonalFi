// SPDX-License-Identifier: MIT
/**
 * `/advisors/{id}/runs`, `/advisors/runs/{runId}`,
 * `/advisors/runs/{runId}/cancel`, `/advisors/{id}/payload-preview`,
 * `/advisors/{id}/payload-approvals`, `/advisors/kinds/{kind}/enabled` and
 * `/advisors/rule-health` — WP 5.1's run control, preview/approval gate and
 * kind switch, and WP 5.9's rule health, as HTTP (05-phase-5-dispatch.md §3
 * WP 5.10).
 *
 * ## The inspector re-digests the retained payload; it never trusts it
 *
 * `GET /advisors/runs/{runId}` calls `inspectRunPayload` (`@ctx/insights`,
 * WP 5.1's `preview.ts`), which recomputes `inputDigest(payload.snapshot)`
 * from the stored bytes and compares it with `advisor_runs.input_digest` —
 * written *before* the call, from the request that was actually sent. This
 * route only forwards that `verified` bit as `payload.digestVerified`; it
 * recomputes nothing itself, which is the point (03 §5 note: a route that
 * re-derived the digest would be a second implementation of the same check).
 *
 * ## Preview and approval, on this process, for every registered kind
 *
 * `previewRequest`/`approvePayload` (`@ctx/insights`'s `preview.ts`) only
 * ever read `RegisteredAdvisor.manifest` — never `.advisor.run(...)`, which
 * only `service.ts`'s run path calls. So this file's registry is built from
 * every row `listAdvisors` returns (builtins *and* any `local_model`/
 * `external` row — every advisor gets a DB row at registration, whatever
 * process registered it: `bootstrap-seed.ts` for builtins, W-C's wiring for
 * the narrator), each wrapped in a stub `Advisor` whose `run` rejects. The
 * manifest is stored "as registered, verbatim" (`schema/advisors.ts`'s own
 * comment on the column), so this re-validates it through `AdvisorRegistry`
 * rather than trusting the jsonb, and a row that fails re-validation is
 * skipped (logged nowhere; `.register()` returns a verdict, not a throw) so
 * one bad row cannot take down preview for every other advisor. This is
 * **not** `routes/insights.ts`'s `createBuiltinRegistry()` — that registry
 * only ever held the built-in catalogue, which is right for *running* an
 * advisor on this process (it is the only kind the api process may run
 * inline) but wrong for *previewing* one, which never runs anything at all.
 *
 * One thing does **not** carry over from the worker: the api process is
 * deliberately given no `PromptRenderer` binding (`routes/insights.ts`'s own
 * comment: *"No promptRenderer in the api — deliberate"*; the binding lives
 * in `worker.ts`, WP 5.1 §13, which this WP does not own). `previewRequest`
 * refuses `renderer_unavailable` for a `local_model` advisor without one —
 * mapped below to a named 503 — so **every advisor's preview shows its
 * request and scopes; only a `local_model` advisor's rendered prompt bytes
 * are unavailable on this process**, until it also binds a renderer.
 *
 * The same absence reaches **approval**, and more sharply:
 * `advisor_payload_approvals`'s own CHECK (`advisor_payload_approvals_local_has_template`,
 * migration 0028) requires a `local_model` row to carry a non-null prompt
 * template hash, which is always `null` here — `approvePayload` itself does
 * not pre-check this (it only refuses a *mismatched* shape), so an insert
 * would violate the CHECK and surface as a raw 500. The approval handler
 * below refuses first, named (503 `insights.prompt_renderer_unavailable`),
 * the same code the preview route uses for the same underlying reason. A
 * `local_model` advisor's payload **cannot be approved on this process at
 * all** until it binds a renderer — not just previewed incompletely.
 * Recorded under "Needs the orchestrator" in this WP's evidence.
 *
 * ## The preview sends nothing to any model
 *
 * `previewRequest` calls no advisor and no model — `buildAdvisorRequest`
 * only assembles the snapshot, and a `PromptRenderer.render` is a pure
 * function by its own contract (`ports.ts`). This process holds no HTTP
 * client capable of reaching a model at all: `@advisor/local-model`
 * (WP 5.2) is never imported here or anywhere under `@ctx/insights`
 * (`scripts/eslint-boundaries.js`'s `insights` layer comment, "no LLM
 * client"). The exit test proves it from the outside: a fake HTTP server
 * standing in for Ollama, hit zero times across a preview call.
 */
import {
  ADVISOR_KINDS,
  AdvisorRegistry,
  AdvisorRequestSchema,
  PreviewError,
  approvePayload,
  findAdvisor,
  findRun,
  inspectRunPayload,
  latestRuns,
  listAdvisors,
  previewRequest,
  requestRunCancel,
  ruleHealth,
  type Advisor,
  type AdvisorKind,
  type AdvisorManifest,
  type InsightsContext,
  type InsightsDependencies,
} from '@ctx/insights';
import { REASON_CODES, type ReasonCode } from '@ctx/insights/schema';
import { PLATFORM_FLAGS, createFlagService, platformExecutor } from '@core/platform';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  createInsightsBudgetPort,
  createInsightsInvestmentsPort,
  createInsightsLedgerPort,
  createInsightsMarketDataPort,
  createInsightsPlanningPort,
  createInsightsRecurringPort,
} from '../domain.ts';
import { ADVISOR_KIND_FLAGS, MODULE_FLAGS } from '../platform.ts';
import { AppError, problems } from '../problem.ts';
import { isoInstant } from '../wire.ts';
import type { RouteDeps } from './deps.ts';

/** D6: one account holder — the same reading every other route file uses. */
async function timezoneOf(deps: RouteDeps): Promise<string> {
  const rows = await deps.pool.query<{ display_timezone: string }>(
    `SELECT display_timezone FROM users ORDER BY created_at, id LIMIT 1`,
  );
  return rows.rows[0]?.display_timezone ?? 'UTC';
}

function contextOf(
  deps: RouteDeps,
  userId: string,
  request: { readonly id: unknown },
): InsightsContext {
  return { userId, clock: deps.clock, correlationId: String(request.id) };
}

function advisorNotFound(advisorId: string): AppError {
  return new AppError({
    status: 404,
    code: 'insights.advisor_not_found',
    title: 'Not Found',
    detail: `no advisor ${advisorId}`,
    family: 'user',
  });
}

function runNotFound(runId: string): AppError {
  return new AppError({
    status: 404,
    code: 'insights.run_not_found',
    title: 'Not Found',
    detail: `no run ${runId}`,
    family: 'user',
  });
}

/**
 * Every advisor this holder has a row for, re-validated into a live
 * `AdvisorRegistry` whose `Advisor.run` is a stub that rejects — see this
 * file's header. A row that fails re-validation is skipped, not thrown: one
 * legacy or corrupt manifest must not break preview for every other advisor.
 */
async function previewRegistryFor(deps: RouteDeps, userId: string): Promise<AdvisorRegistry> {
  const rows = await listAdvisors(deps.database, userId);
  const registry = new AdvisorRegistry();
  for (const row of rows) {
    const advisor: Advisor = {
      manifest: row.manifest as AdvisorManifest,
      run: () =>
        Promise.reject(
          new Error(
            'the api process never executes an advisor; this registry exists only to preview and approve payload shapes',
          ),
        ),
    };
    registry.register(advisor);
  }
  return registry;
}

/**
 * `previewRequest`/`approvePayload` need ports, a registry and settings —
 * never `switches` (preview and approval do not execute anything) and never
 * a `promptRenderer` (this process has none; see this file's header). No
 * `advisor_token_secret` is required either: that secret keys merchant
 * pseudonyms for a `builtin` rule's *output copy*, not the snapshot the
 * preview reads, and `buildAdvisorRequest`'s `deriveTokenKey` call only needs
 * `settings.tokenSecret` to be *some* stable string for this deployment — the
 * empty string the moment nobody has written one is a temporary
 * pseudonymisation key exactly as live as the real one, never persisted
 * differently, and irrelevant to what the preview proves (the *shape* of the
 * request, not merchant secrecy, which `snapshot/tokens.ts` handles either
 * way).
 */
async function previewDependenciesOf(
  deps: RouteDeps,
  userId: string,
  timeZone: string,
): Promise<InsightsDependencies> {
  return {
    registry: await previewRegistryFor(deps, userId),
    ports: {
      ledger: createInsightsLedgerPort(deps.database, deps.clock),
      budget: createInsightsBudgetPort(deps.database),
      recurring: createInsightsRecurringPort(deps.database),
      investments: createInsightsInvestmentsPort(deps.database, deps.clock),
      planning: createInsightsPlanningPort(deps.database, deps.clock, { timeZone }),
      marketData: createInsightsMarketDataPort({ source: undefined }),
    },
    settings: {
      timeZone,
      baseCurrency: 'USD',
      tokenSecret: deps.config.secrets.advisor_token_secret?.reveal() ?? 'preview-only-unsealed',
    },
  };
}

function flagServiceOf(deps: RouteDeps) {
  return createFlagService({
    db: platformExecutor(deps.database),
    defaults: [...PLATFORM_FLAGS, ...MODULE_FLAGS, ...ADVISOR_KIND_FLAGS],
    ttlMs: 0,
  });
}

// ---------------------------------------------------------------------------
// Wire shapes
// ---------------------------------------------------------------------------

const runSummarySchema = z
  .object({
    id: z.uuid(),
    advisorId: z.string(),
    advisorVersion: z.string().nullable(),
    trigger: z.string(),
    status: z.string(),
    refusal: z.string().nullable(),
    inputDigest: z.string().nullable(),
    grantedScopes: z.array(z.string()),
    emittedScopes: z.array(z.string()),
    proposedCount: z.int().nonnegative(),
    acceptedCount: z.int().nonnegative(),
    rejectedCount: z.int().nonnegative(),
    errorCode: z.string().nullable(),
    durationMs: z.int().nullable(),
    startedAt: isoInstant,
    finishedAt: isoInstant.nullable(),
    cancelRequestedAt: isoInstant.nullable(),
    cancelReason: z.string().nullable(),
    llmModel: z.string().nullable(),
    llmPromptHash: z.string().nullable(),
  })
  .meta({ id: 'AdvisorRunSummary' });

function serialiseRunSummary(row: {
  readonly id: string;
  readonly advisorId: string;
  readonly advisorVersion: string | null;
  readonly trigger: string;
  readonly status: string;
  readonly refusal: string | null;
  readonly inputDigest: string | null;
  readonly grantedScopes: readonly string[];
  readonly emittedScopes: readonly string[];
  readonly proposedCount: number;
  readonly acceptedCount: number;
  readonly rejectedCount: number;
  readonly errorCode: string | null;
  readonly durationMs: number | null;
  readonly startedAt: Date;
  readonly finishedAt: Date | null;
  readonly cancelRequestedAt: Date | null;
  readonly cancelReason: string | null;
  readonly llmModel: string | null;
  readonly llmPromptHash: string | null;
}): z.infer<typeof runSummarySchema> {
  return {
    id: row.id,
    advisorId: row.advisorId,
    advisorVersion: row.advisorVersion,
    trigger: row.trigger,
    status: row.status,
    refusal: row.refusal,
    inputDigest: row.inputDigest,
    grantedScopes: [...row.grantedScopes],
    emittedScopes: [...row.emittedScopes],
    proposedCount: row.proposedCount,
    acceptedCount: row.acceptedCount,
    rejectedCount: row.rejectedCount,
    errorCode: row.errorCode,
    durationMs: row.durationMs,
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt === null ? null : row.finishedAt.toISOString(),
    cancelRequestedAt: row.cancelRequestedAt === null ? null : row.cancelRequestedAt.toISOString(),
    cancelReason: row.cancelReason,
    llmModel: row.llmModel,
    llmPromptHash: row.llmPromptHash,
  };
}

const retainedPayloadSchema = z
  .object({
    queryShape: z.string(),
    recordedDigest: z.string().nullable(),
    /** Recomputed server-side from the stored bytes — see this file's header. */
    recomputedDigest: z.string(),
    digestVerified: z.boolean(),
    payload: z.record(z.string(), z.unknown()),
    expiresAt: isoInstant,
  })
  .meta({ id: 'AdvisorRunRetainedPayload' });

const runInspectorSchema = z
  .object({
    run: runSummarySchema,
    rejections: z.array(z.record(z.string(), z.unknown())),
    payload: retainedPayloadSchema.nullable(),
  })
  .meta({ id: 'AdvisorRunInspector' });

const payloadPreviewSchema = z
  .object({
    advisorId: z.string(),
    kind: z.enum(ADVISOR_KINDS),
    queryShape: z.string(),
    scopes: z.array(z.string()),
    promptTemplateHash: z.string().nullable(),
    request: AdvisorRequestSchema,
    prompt: z.object({ text: z.string(), hash: z.string() }).nullable(),
    approvalRequired: z.boolean(),
    approved: z.boolean(),
  })
  .meta({ id: 'AdvisorPayloadPreview' });

const ruleHealthSchema = z
  .object({
    advisorId: z.string(),
    firings: z.int().nonnegative(),
    accepted: z.int().nonnegative(),
    dismissedByReason: z.record(z.enum([...REASON_CODES, 'none']), z.int().nonnegative()),
    notTrueRate: z.number(),
    notTrueFiringsConsidered: z.int().nonnegative(),
    quarantinedForNotTrue: z.boolean(),
    outcomes: z.object({
      acted: z.int().nonnegative(),
      incomplete: z.int().nonnegative(),
      pending: z.int().nonnegative(),
    }),
    wrongAmountFlags: z.array(
      z.object({
        insightId: z.uuid(),
        key: z.string(),
        inputDigest: z.string(),
        derivations: z.array(z.record(z.string(), z.unknown())),
        flaggedAt: isoInstant,
      }),
    ),
  })
  .meta({ id: 'AdvisorRuleHealth' });

/**
 * Maps a `PreviewError` (`@ctx/insights`'s `preview.ts`) to a named problem.
 * `advisor_not_registered` covers two distinct situations the library
 * conflates under one code (unregistered advisor; a builtin asked to approve
 * a payload it never sends) — the message tells them apart.
 */
function previewProblem(error: PreviewError): AppError {
  if (error.code === 'shape_changed') {
    return new AppError({
      status: 409,
      code: 'insights.payload_shape_changed',
      title: 'Conflict',
      detail: error.message,
      family: 'domain',
    });
  }
  if (error.code === 'renderer_unavailable') {
    return new AppError({
      status: 503,
      code: 'insights.prompt_renderer_unavailable',
      title: 'Service Unavailable',
      detail: error.message,
      family: 'internal',
    });
  }
  if (error.message.includes('sends no payload to approve')) {
    return new AppError({
      status: 422,
      code: 'insights.advisor_kind_needs_no_approval',
      title: 'Unprocessable Content',
      detail: error.message,
      family: 'domain',
    });
  }
  return advisorNotFound(error.message);
}

export const advisorRunRoutes = (deps: RouteDeps): FastifyPluginAsyncZod => {
  const { guards, database, clock } = deps;

  return async (app) => {
    app.get(
      '/advisors/:advisorId/runs',
      {
        schema: {
          operationId: 'listAdvisorRuns',
          summary: 'The most recent runs of one advisor, newest first',
          tags: ['insights'],
          params: z.object({ advisorId: z.string() }),
          querystring: z.object({ limit: z.coerce.number().int().min(1).max(200).optional() }),
          response: {
            200: z.object({ runs: z.array(runSummarySchema) }),
            ...problems(401, 404),
          },
        },
      },
      async (request) => {
        const session = await guards.requireSession(request);
        const advisor = await findAdvisor(database, session.userId, request.params.advisorId);
        if (advisor === null) throw advisorNotFound(request.params.advisorId);
        const runs = await latestRuns(
          database,
          session.userId,
          request.params.advisorId,
          request.query.limit,
        );
        return { runs: runs.map(serialiseRunSummary) };
      },
    );

    app.get(
      '/advisors/runs/:runId',
      {
        schema: {
          operationId: 'getAdvisorRun',
          summary: 'The run inspector: one run, with its retained payload re-verified',
          description:
            '`payload.digestVerified` is recomputed server-side from the retained bytes ' +
            'against `input_digest`, never trusted from storage — see this file’s header.',
          tags: ['insights'],
          params: z.object({ runId: z.uuid() }),
          response: {
            200: runInspectorSchema,
            ...problems(401, 404),
          },
        },
      },
      async (request) => {
        const session = await guards.requireSession(request);
        const run = await findRun(database, session.userId, request.params.runId);
        if (run === null) throw runNotFound(request.params.runId);
        const inspected = await inspectRunPayload(
          database,
          session.userId,
          request.params.runId,
          clock.now(),
        );
        return {
          run: serialiseRunSummary(run),
          rejections: [...run.rejections],
          payload:
            inspected === null
              ? null
              : {
                  queryShape: inspected.queryShape,
                  recordedDigest: inspected.recordedDigest,
                  recomputedDigest: inspected.recomputedDigest,
                  digestVerified: inspected.verified,
                  payload: inspected.payload,
                  expiresAt: inspected.expiresAt.toISOString(),
                },
        };
      },
    );

    app.post(
      '/advisors/runs/:runId/cancel',
      {
        schema: {
          operationId: 'cancelAdvisorRun',
          summary: 'Kill level 4: ask one in-flight run to stop',
          description:
            'Needs a fresh session. The run watcher notices within about a second and closes ' +
            '`cancelled` with `cancel_reason = run_cancelled`; nothing is written after the kill. ' +
            '409 `insights.run_not_in_flight` when the run has already finished.',
          tags: ['insights'],
          params: z.object({ runId: z.uuid() }),
          response: {
            200: z.object({ runId: z.uuid(), outcome: z.literal('requested') }),
            ...problems(401, 403, 404, 409),
          },
        },
      },
      async (request) => {
        const session = await guards.requireFreshSession(request);
        const outcome = await requestRunCancel(
          database,
          contextOf(deps, session.userId, request),
          request.params.runId,
        );
        if (outcome === 'not_found') throw runNotFound(request.params.runId);
        if (outcome === 'not_running') {
          throw new AppError({
            status: 409,
            code: 'insights.run_not_in_flight',
            title: 'Conflict',
            detail: `run ${request.params.runId} has already finished; there is nothing to cancel`,
            family: 'domain',
          });
        }
        return { runId: request.params.runId, outcome: 'requested' as const };
      },
    );

    app.get(
      '/advisors/:advisorId/payload-preview',
      {
        schema: {
          operationId: 'previewAdvisorPayload',
          summary: 'The exact payload a run of this advisor would send now — invokes nothing',
          description:
            'Sends nothing to any model (see this file’s header). For a `local_model` advisor ' +
            'whose prompt bytes cannot be shown on this process, `prompt` is `null` and ' +
            '`promptTemplateHash` still names the template — see "Needs the orchestrator" in ' +
            "this WP's evidence.",
          tags: ['insights'],
          params: z.object({ advisorId: z.string() }),
          response: {
            200: payloadPreviewSchema,
            ...problems(401, 404, 503),
          },
        },
      },
      async (request) => {
        const session = await guards.requireSession(request);
        const timeZone = await timezoneOf(deps);
        const dependencies = await previewDependenciesOf(deps, session.userId, timeZone);
        try {
          const preview = await previewRequest(
            database,
            contextOf(deps, session.userId, request),
            dependencies,
            request.params.advisorId,
          );
          return {
            advisorId: preview.advisorId,
            kind: preview.kind,
            queryShape: preview.queryShape,
            scopes: [...preview.scopes],
            promptTemplateHash: preview.promptTemplateHash,
            request: preview.request,
            prompt: preview.prompt,
            approvalRequired: preview.approvalRequired,
            approved: preview.approved,
          };
        } catch (error) {
          if (error instanceof PreviewError) throw previewProblem(error);
          throw error;
        }
      },
    );

    app.post(
      '/advisors/:advisorId/payload-approvals',
      {
        schema: {
          operationId: 'approveAdvisorPayload',
          summary: 'Approve the payload shape a preview returned',
          description:
            'Needs a fresh session. Carries the `queryShape` the preview returned; refuses ' +
            '409 `insights.payload_shape_changed` if the advisor’s shape has changed since — a ' +
            'scope granted, a version bumped or a template edited. The approval is for exactly ' +
            'what was shown, never for "whatever this advisor sends next".',
          tags: ['insights'],
          params: z.object({ advisorId: z.string() }),
          body: z.object({ queryShape: z.string() }),
          response: {
            200: z.object({ approvalId: z.uuid(), queryShape: z.string() }),
            ...problems(401, 403, 404, 409, 422, 503),
          },
        },
      },
      async (request) => {
        const session = await guards.requireFreshSession(request);
        const timeZone = await timezoneOf(deps);
        const dependencies = await previewDependenciesOf(deps, session.userId, timeZone);
        // `approvePayload` does not itself check this — it only refuses a
        // *mismatched* shape (`shape_changed`) — and `advisor_payload_approvals`'
        // own CHECK (`advisor_payload_approvals_local_has_template`, 0028)
        // requires a `local_model` row to carry a prompt template hash. On
        // this process that hash is always `null` (no `PromptRenderer`
        // bound — this file's header), so an insert would violate the CHECK
        // and surface as a raw 500. Refused here, named, the same way
        // `previewRequest` already refuses its own renderer-dependent half.
        const registered = dependencies.registry.get(request.params.advisorId);
        if (
          registered?.manifest.kind === 'local_model' &&
          dependencies.promptRenderer === undefined
        ) {
          throw new AppError({
            status: 503,
            code: 'insights.prompt_renderer_unavailable',
            title: 'Service Unavailable',
            detail:
              `no PromptRenderer is bound on this process, so ${request.params.advisorId}'s ` +
              'payload cannot be approved here (see this file’s header)',
            family: 'internal',
          });
        }
        try {
          const approved = await approvePayload(
            database,
            contextOf(deps, session.userId, request),
            dependencies,
            { advisorId: request.params.advisorId, queryShape: request.body.queryShape },
          );
          return approved;
        } catch (error) {
          if (error instanceof PreviewError) throw previewProblem(error);
          throw error;
        }
      },
    );

    app.put(
      '/advisors/kinds/:kind/enabled',
      {
        schema: {
          operationId: 'setAdvisorKindEnabled',
          summary: 'Kill switch 2: turn every advisor of one kind on or off',
          description:
            'Needs a fresh session — the same class of act as `POST /advisors/{id}/enabled` ' +
            '(D21). Only a kind with a declared flag can be switched here; today that is ' +
            '`local_model` (`advisors.kind.local_model`, off by default).',
          tags: ['insights'],
          params: z.object({ kind: z.enum(ADVISOR_KINDS) }),
          body: z.object({ enabled: z.boolean() }),
          response: {
            200: z.object({ kind: z.enum(ADVISOR_KINDS), enabled: z.boolean() }),
            ...problems(401, 403, 404),
          },
        },
      },
      async (request) => {
        const session = await guards.requireFreshSession(request);
        const kind: AdvisorKind = request.params.kind;
        const key = `advisors.kind.${kind}`;
        const flags = flagServiceOf(deps);
        if (!ADVISOR_KIND_FLAGS.some((definition) => definition.key === key)) {
          throw new AppError({
            status: 404,
            code: 'insights.kind_flag_not_found',
            title: 'Not Found',
            detail:
              `advisor kind '${kind}' has no kill switch of its own (only a kind with a ` +
              'declared flag does — see ADVISOR_KIND_FLAGS)',
            family: 'user',
          });
        }
        await flags.set(platformExecutor(database), session.userId, key, request.body.enabled);
        return { kind, enabled: request.body.enabled };
      },
    );

    app.get(
      '/advisors/rule-health',
      {
        schema: {
          operationId: 'getRuleHealth',
          summary:
            "Every registered advisor's health: firings, dismissals by reason, NOT_TRUE rate",
          tags: ['insights'],
          response: {
            200: z.object({ advisors: z.array(ruleHealthSchema) }),
            ...problems(401),
          },
        },
      },
      async (request) => {
        const session = await guards.requireSession(request);
        const rows = await ruleHealth(database, session.userId);
        return {
          advisors: rows.map((row) => ({
            advisorId: row.advisorId,
            firings: row.firings,
            accepted: row.accepted,
            dismissedByReason: row.dismissedByReason as Record<ReasonCode | 'none', number>,
            notTrueRate: row.notTrueRate,
            notTrueFiringsConsidered: row.notTrueFiringsConsidered,
            quarantinedForNotTrue: row.quarantinedForNotTrue,
            outcomes: { ...row.outcomes },
            wrongAmountFlags: row.wrongAmountFlags.map((flag) => ({
              insightId: flag.insightId,
              key: flag.key,
              inputDigest: flag.inputDigest,
              derivations: [...flag.derivations],
              flaggedAt: flag.flaggedAt.toISOString(),
            })),
          })),
        };
      },
    );
  };
};
