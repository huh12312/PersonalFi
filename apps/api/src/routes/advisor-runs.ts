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
 * ## The renderer: bound when a model is configured (WP 9.6, CF-1, R-4)
 *
 * The api binds the pure, preview-only `PromptRenderer` and `local.narrator`'s
 * manifest — never its executor, and never an endpoint — whenever
 * `config.localModelPin` (`LOCAL_MODEL_PIN_NAME` and `LOCAL_MODEL_PIN_DIGEST`)
 * is set; `app.ts` builds the `PreviewModel` (`modules.ts`'s
 * `createPreviewModel`) and hands it here. Phase 5's "deliberately no
 * renderer" (WP 5.1 §13) is overruled by the Phase 5 gate's R-4: without one
 * no install can approve a payload, and the worker's run is refused
 * `payload_not_approved` forever (G5-2). With no model configured nothing is
 * bound, `previewRequest` still refuses `renderer_unavailable` for a
 * `local_model` row some other process registered, and that refusal is named:
 * 503 `insights.prompt_renderer_unavailable`, saying which setting is missing.
 *
 * The registry's `local.narrator` comes from the code's manifest, not from the
 * possibly older row the worker stored: a payload approval is keyed to
 * `{advisor_id, version, kind, scopes, template hash}`, and the version in that
 * shape must be the one the worker will run.
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
  MODULE_FLAG_KEY,
  registerAdvisor,
  AdvisorRequestSchema,
  PreviewError,
  approvePayload,
  findAdvisor,
  findRun,
  inspectRunPayload,
  latestRuns,
  listAdvisors,
  NARRATOR_MANIFEST,
  INSIGHT_EXPLAIN_ADVISOR_ID,
  approveInsightExplain,
  insightFeed,
  loadInsightExplainTarget,
  previewInsightExplain,
  ungrantedExplainScopes,
  type ExplainTarget,
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
  createInsightsCategorizationPort,
  createInsightsInvestmentsPort,
  createInsightsLedgerPort,
  createInsightsMarketDataPort,
  createInsightsPlanningPort,
  createInsightsRecurringPort,
} from '../domain.ts';
import { ADVISOR_KIND_FLAGS, MODULE_FLAGS } from '../platform.ts';
import { AppError, problems } from '../problem.ts';
import { isoInstant } from '../wire.ts';
import type { PreviewModel } from '../modules.ts';
import type { NarratorRuntime } from '../narrator-wiring.ts';
import type { ExplainRuntime } from '../insight-explain.ts';
import type { RouteDeps } from './deps.ts';

/** D6: one account holder — the same reading every other route file uses. */
export async function timezoneOf(deps: Pick<RouteDeps, 'pool'>): Promise<string> {
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

function kindFlagNotFound(kind: AdvisorKind): AppError {
  return new AppError({
    status: 404,
    code: 'insights.kind_flag_not_found',
    title: 'Not Found',
    detail:
      `advisor kind '${kind}' has no kill switch of its own (only a kind with a ` +
      'declared flag does — see ADVISOR_KIND_FLAGS)',
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
async function previewRegistryFor(
  deps: Pick<RouteDeps, 'database'>,
  userId: string,
  preview: PreviewModel | undefined,
): Promise<AdvisorRegistry> {
  const rows = await listAdvisors(deps.database, userId);
  const registry = new AdvisorRegistry();
  // The code's `local.narrator` goes in first: a stored row for the same id is
  // then a refused duplicate (`register` returns a verdict, it does not throw),
  // so the shape is always the one this build's worker will run.
  if (preview !== undefined) registry.register(preview.narrator);
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
 * never `switches` (preview and approval do not execute anything), and a
 * `promptRenderer` only when a model is configured (see this file's header). No
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
export async function previewDependenciesOf(
  deps: Pick<RouteDeps, 'database' | 'clock' | 'config'>,
  userId: string,
  timeZone: string,
  preview: PreviewModel | undefined,
): Promise<InsightsDependencies> {
  return {
    registry: await previewRegistryFor(deps, userId, preview),
    ...(preview === undefined ? {} : { promptRenderer: preview.promptRenderer }),
    ports: {
      ledger: createInsightsLedgerPort(deps.database, deps.clock),
      budget: createInsightsBudgetPort(deps.database),
      recurring: createInsightsRecurringPort(deps.database),
      investments: createInsightsInvestmentsPort(deps.database, deps.clock),
      planning: createInsightsPlanningPort(deps.database, deps.clock, { timeZone }),
      marketData: createInsightsMarketDataPort({ source: undefined }),
      // WP 11.1: `categorization.rule_candidates`, bound as the worker's
      // `insightsModule` binds it, so an on-demand run (and its preview) sees the
      // same block the nightly run does.
      categorization: createInsightsCategorizationPort(deps.database, deps.clock),
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

/** WP 11.3: what `insight.explain` would send now (`previewInsightExplain`). */
const explainPreviewRequestSchema = z
  .object({
    request_id: z.string(),
    subject: z.record(z.string(), z.unknown()),
    deadline: z.string(),
    max_response_bytes: z.int(),
    snapshot: z.record(z.string(), z.unknown()),
    granted_scopes: z.array(z.string()),
  })
  .meta({ id: 'ExplainPreviewRequest' });

const payloadPreviewSchema = z
  .object({
    advisorId: z.string(),
    kind: z.enum(ADVISOR_KINDS),
    queryShape: z.string(),
    scopes: z.array(z.string()),
    promptTemplateHash: z.string().nullable(),
    // WP 11.3: `insight.explain`'s request is its own (a subject, not a
    // snapshot of scopes); it still carries `snapshot` and `granted_scopes`,
    // which is what the panel shows.
    request: z.union([AdvisorRequestSchema, explainPreviewRequestSchema]),
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

const kindStateSchema = z
  .object({
    kind: z.enum(ADVISOR_KINDS),
    /** Level 2's user half: the `advisors.kind.<kind>` flag as last written (or its default). */
    enabled: z.boolean(),
    /** Level 2's operator half: this deployment has a model configured for the kind. */
    configured: z.boolean(),
    /** Both. A kind runs only when the flag is on and a model is configured. */
    effective: z.boolean(),
  })
  .meta({ id: 'AdvisorKindState' });

const moduleStateSchema = z
  .object({
    /** Level 1's operator half: `ADVISORS_ENABLED`, static per process (a change is a restart). */
    operator: z.object({ advisorsEnabled: z.boolean() }),
    /** Level 1's user half: the `module.insights` flag as last written (or its default). */
    user: z.object({ enabled: z.boolean() }),
    /** Both. Advisors run only when the operator allows them and the holder has not switched them off. */
    effective: z.boolean(),
  })
  .meta({ id: 'AdvisorModuleState' });

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

export const advisorRunRoutes = (
  deps: RouteDeps,
  staticPreview?: PreviewModel,
  narratorPreview?: Pick<NarratorRuntime, 'forUser'>,
  explain?: { readonly runtime: ExplainRuntime },
): FastifyPluginAsyncZod => {
  const { guards, database, clock } = deps;

  /**
   * WP 11.3: `insight.explain`'s renderer for this holder — the narrator's
   * provider, in preview mode — or a 503 naming why there is none.
   */
  async function explainRenderer(userId: string) {
    const resolution = explain === undefined ? null : await explain.runtime.resolve(userId);
    if (resolution?.adapter == null) {
      throw new AppError({
        status: 503,
        code: 'insights.prompt_renderer_unavailable',
        title: 'Service Unavailable',
        detail:
          'no language model is configured for you (the narrator is Off or not set up), so the ' +
          'payload of insight.explain cannot be shown or approved: choose a model in Settings, ' +
          'Language model, first',
        family: 'internal',
      });
    }
    return resolution.adapter;
  }

  /** The holder's own top explainable insight, for the preview; `null` shows the illustrative one. */
  async function explainPreviewTarget(userId: string): Promise<ExplainTarget | null> {
    const feed = await insightFeed(database, { userId, now: clock.now(), currency: 'USD' });
    for (const view of feed.list.slice(0, 20)) {
      const loaded = await loadInsightExplainTarget(database, userId, view.id);
      if (loaded.status !== 'found') continue;
      if ((await ungrantedExplainScopes(database, userId, loaded.target)).length > 0) continue;
      return loaded.target;
    }
    return null;
  }

  /**
   * WP 10.6 (D30): the holder's own narrator — their provider and model, or
   * the local model, or none (Off) — as a preview-only renderer and a
   * manifest whose `run` rejects. The renderer's template hash covers the
   * provider and the model, so the shape an approval is keyed to is the one
   * the worker's run will compute for the same holder. Without a runtime (a
   * narrow test app) the static `LOCAL_MODEL_PIN_*` preview, as before.
   */
  async function previewFor(userId: string): Promise<PreviewModel | undefined> {
    if (narratorPreview === undefined) return staticPreview;
    const narrator = await narratorPreview.forUser(userId);
    if (narrator === null) return undefined;
    return Object.freeze({
      promptRenderer: narrator.renderer,
      narrator: Object.freeze({
        manifest: NARRATOR_MANIFEST,
        run: () =>
          Promise.reject(
            new Error(
              'the api process never executes an advisor: local.narrator is registered here as a manifest only',
            ),
          ),
      }),
    });
  }

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
        if (request.params.advisorId === INSIGHT_EXPLAIN_ADVISOR_ID) {
          const renderer = await explainRenderer(session.userId);
          const preview = await previewInsightExplain(
            database,
            contextOf(deps, session.userId, request),
            { renderer, target: await explainPreviewTarget(session.userId) },
          );
          return {
            advisorId: preview.advisorId,
            kind: 'local_model' as const,
            queryShape: preview.queryShape,
            scopes: [...preview.scopes],
            promptTemplateHash: preview.promptTemplateHash,
            request: {
              request_id: preview.request.request_id,
              subject: preview.request.subject as unknown as Record<string, unknown>,
              deadline: preview.request.deadline,
              max_response_bytes: preview.request.max_response_bytes,
              snapshot: preview.request.snapshot as unknown as Record<string, unknown>,
              granted_scopes: [...preview.request.granted_scopes],
            },
            prompt: preview.prompt,
            approvalRequired: true,
            approved: preview.approved,
          };
        }
        const timeZone = await timezoneOf(deps);
        const holderPreview = await previewFor(session.userId);
        const dependencies = await previewDependenciesOf(
          deps,
          session.userId,
          timeZone,
          holderPreview,
        );
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
        if (request.params.advisorId === INSIGHT_EXPLAIN_ADVISOR_ID) {
          const renderer = await explainRenderer(session.userId);
          try {
            return await approveInsightExplain(database, contextOf(deps, session.userId, request), {
              renderer,
              queryShape: request.body.queryShape,
            });
          } catch (error) {
            if (error instanceof PreviewError) throw previewProblem(error);
            throw error;
          }
        }
        const timeZone = await timezoneOf(deps);
        const preview = await previewFor(session.userId);
        const dependencies = await previewDependenciesOf(deps, session.userId, timeZone, preview);
        // `approvePayload` does not itself check this — it only refuses a
        // *mismatched* shape (`shape_changed`) — and `advisor_payload_approvals`'
        // own CHECK (`advisor_payload_approvals_local_has_template`, 0028)
        // requires a `local_model` row to carry a prompt template hash. With no
        // renderer bound (no model pin configured) that hash is always `null`,
        // so an insert would violate the CHECK and surface as a raw 500.
        // Refused here, named, the same way `previewRequest` already refuses
        // its own renderer-dependent half.
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
              `no model is configured on the api, so ${request.params.advisorId}'s payload ` +
              'cannot be approved here: set LOCAL_MODEL_PIN_NAME and LOCAL_MODEL_PIN_DIGEST ' +
              'on the api service (the model’s name and digest — never its endpoint)',
            family: 'internal',
          });
        }
        // The approval row is foreign-keyed to the advisor's own row
        // (`advisor_payload_approvals_advisor_fk`), and that row is normally
        // written by the worker at boot. If the api is being asked first, it
        // registers `local.narrator` the way the worker does — off — rather than
        // answer a raw FK violation. An approval is not a switch.
        if (
          preview !== undefined &&
          request.params.advisorId === preview.narrator.manifest.advisor_id
        ) {
          const context = contextOf(deps, session.userId, request);
          if ((await findAdvisor(database, session.userId, request.params.advisorId)) === null) {
            await registerAdvisor(database, context, {
              manifest: preview.narrator.manifest,
              enabled: false,
            });
          }
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

    app.get(
      '/advisors/kinds/:kind/enabled',
      {
        schema: {
          operationId: 'getAdvisorKindEnabled',
          summary:
            'Kill switch 2, as it stands: the kind flag, the model configuration and both together',
          description:
            'What the settings screen shows instead of the last `PUT`: `enabled` is the flag the ' +
            'holder controls, `configured` is whether this deployment has a model configured for ' +
            'the kind (`LOCAL_MODEL_PIN_*` on the api, or the full `LOCAL_MODEL_*` set), and ' +
            '`effective` is both. Only a kind with a declared flag has a state; 404 ' +
            '`insights.kind_flag_not_found` otherwise, exactly as the `PUT`.',
          tags: ['insights'],
          params: z.object({ kind: z.enum(ADVISOR_KINDS) }),
          response: {
            200: kindStateSchema,
            ...problems(401, 404),
          },
        },
      },
      async (request) => {
        const session = await guards.requireSession(request);
        const kind: AdvisorKind = request.params.kind;
        const key = `advisors.kind.${kind}`;
        if (!ADVISOR_KIND_FLAGS.some((definition) => definition.key === key)) {
          throw kindFlagNotFound(kind);
        }
        const enabled = await flagServiceOf(deps).isEnabled(session.userId, key);
        // WP 10.6: per holder — their provider (with a key and a consent) or the local model.
        const configured =
          kind === 'local_model' &&
          (narratorPreview === undefined
            ? deps.config.localModelPin !== undefined
            : (await narratorPreview.forUser(session.userId)) !== null);
        return { kind, enabled, configured, effective: enabled && configured };
      },
    );

    app.get(
      '/advisors/module/enabled',
      {
        schema: {
          operationId: 'getAdvisorModuleEnabled',
          summary:
            'Kill switch 1, as it stands: the operator setting, the holder’s flag and both together',
          description:
            '`operator.advisorsEnabled` is `ADVISORS_ENABLED` (static per process; the operator ' +
            'changes it with a restart). `user.enabled` is `module.insights`, which the holder ' +
            'flips with `PUT /advisors/module/enabled` (G5-14: until now it was a line of SQL).',
          tags: ['insights'],
          response: {
            200: moduleStateSchema,
            ...problems(401),
          },
        },
      },
      async (request) => {
        const session = await guards.requireSession(request);
        const advisorsEnabled = deps.config.env.ADVISORS_ENABLED;
        const enabled = await flagServiceOf(deps).isEnabled(session.userId, MODULE_FLAG_KEY);
        return {
          operator: { advisorsEnabled },
          user: { enabled },
          effective: advisorsEnabled && enabled,
        };
      },
    );

    app.put(
      '/advisors/module/enabled',
      {
        schema: {
          operationId: 'setAdvisorModuleEnabled',
          summary: 'Kill switch 1, the holder’s half: turn the insights module on or off',
          description:
            'Writes `module.insights`. Needs a fresh session — the same class of act as the kind ' +
            'switch and `POST /advisors/{id}/enabled` (D21). Off stops every advisor of every kind ' +
            'within about a second, a run in flight included (WP 5.1). Returns the state as it now ' +
            'stands, the operator half included.',
          tags: ['insights'],
          body: z.object({ enabled: z.boolean() }),
          response: {
            200: moduleStateSchema,
            ...problems(401, 403),
          },
        },
      },
      async (request) => {
        const session = await guards.requireFreshSession(request);
        await flagServiceOf(deps).set(
          platformExecutor(database),
          session.userId,
          MODULE_FLAG_KEY,
          request.body.enabled,
        );
        const advisorsEnabled = deps.config.env.ADVISORS_ENABLED;
        return {
          operator: { advisorsEnabled },
          user: { enabled: request.body.enabled },
          effective: advisorsEnabled && request.body.enabled,
        };
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
          throw kindFlagNotFound(kind);
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
