// SPDX-License-Identifier: MIT
/**
 * Settings, Language model, **Run control checks** (WP 10.16; RUNBOOK
 * "Proving the GenAI controls").
 *
 * Chris's request (verbatim): "good with creating 10.16." — after "a 'Run
 * control checks' button on the Language model screen would exercise every
 * control against your live instance with your own session … Each check
 * writes a dated evidence row like the restore drills do, and the
 * dashboard's backup line would show when the controls were last proven."
 *
 * | Operation | Guard | What |
 * | --- | --- | --- |
 * | `POST /narrator/control-checks` | step-up | start a run: 202 with its row (every check pending); the checks run in the background — the api's half here, the worker's half as `insights.control_checks` — and the row fills in as each finishes. One per holder per 10 minutes (409 `narrator.control_checks_too_soon`, `Retry-After`) |
 * | `GET /narrator/control-checks` | session | the last 20 runs, newest first, with their per-check rows; the cost of a run for the active provider, in words; when the next run is allowed; when the controls were last proven |
 *
 * Step-up, because a run spends hosted calls with the holder's key and
 * touches run state (inside transactions that are rolled back). The api never
 * calls a model: the checks that need one are the worker's.
 */
import { HOSTED_DISPLAY_NAMES } from '@advisor/local-model';
import {
  CONTROL_CHECK_IDS,
  CONTROL_CHECKS_EVIDENCE_VERSION,
  CONTROL_CHECKS_MIN_INTERVAL_MS,
  CONTROL_CHECKS_WORKER_CEILING_MS,
  errorClass,
  finishControlCheckRun,
  isHostedProviderName,
  listControlCheckRuns,
  runControlChecks,
  startControlCheckRun,
  type ControlCheckRun,
  type InsightsContext,
  type WorkerHandoff,
} from '@ctx/insights';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  apiCheckPorts,
  controlChecksCost,
  correlationIdOf,
  queueHandoff,
} from '../control-checks.ts';
import type { PreviewModel } from '../modules.ts';
import type { NarratorRuntime } from '../narrator-wiring.ts';
import { AppError, problems } from '../problem.ts';
import { isoInstant } from '../wire.ts';
import type { RouteDeps } from './deps.ts';

const PROVIDERS = ['ollama', 'openai', 'openrouter', 'anthropic', 'off'] as const;

/** A run whose api process went away mid-way never closes; past this it reads `interrupted`. */
const INTERRUPTED_AFTER_MS = CONTROL_CHECKS_WORKER_CEILING_MS + 5 * 60_000;

const checkRowWire = z.object({
  id: z.enum(CONTROL_CHECK_IDS),
  name: z.string(),
  proves: z.string(),
  side: z.enum(['api', 'worker']),
  status: z.enum(['pending', 'running', 'pass', 'fail', 'skipped', 'reported']),
  /** Why it failed or was skipped, in words. */
  reason: z.string().nullable(),
  /** What was observed, in words. Never a payload, a prompt, a key or a model's reply. */
  facts: z.array(z.string()),
  /** A skip that is a property of the provider (a local model has no consent, no window). */
  notApplicable: z.boolean(),
  durationMs: z.int().nonnegative().nullable(),
});

const runWire = z
  .object({
    id: z.uuid(),
    startedAt: isoInstant,
    finishedAt: isoInstant.nullable(),
    state: z.enum(['running', 'finished', 'interrupted']),
    provider: z.enum(PROVIDERS),
    /** `provider:model` or the local model's `name@sha256:…`; null when Off. */
    model: z.string().nullable(),
    overall: z.enum(['pass', 'fail', 'partial']).nullable(),
    evidenceVersion: z.string(),
    results: z.array(checkRowWire),
  })
  .meta({ id: 'ControlCheckRun' });

const listWire = z
  .object({
    runs: z.array(runWire),
    /** The active provider now, and the model in force. */
    provider: z.enum(PROVIDERS),
    model: z.string().nullable(),
    /** What a run costs, said before it is pressed. */
    cost: z.object({
      modelCalls: z.int().nonnegative(),
      hosted: z.boolean(),
      message: z.string(),
    }),
    /** When the next run is allowed (one per 10 minutes); null when it is allowed now. */
    nextAllowedAt: isoInstant.nullable(),
    /** The newest finished run, for the dashboard line. Null: never proven. */
    lastProven: z
      .object({ at: isoInstant, overall: z.enum(['pass', 'fail', 'partial']) })
      .nullable(),
  })
  .meta({ id: 'ControlCheckRuns' });

export interface ControlCheckRouteOptions {
  /** The api's preview-mode runtime: resolves and renders, never calls a model. */
  readonly runtime: Pick<NarratorRuntime, 'resolve' | 'forUser'>;
  readonly preview: PreviewModel | undefined;
  /** Tests only: how the worker's half is handed over. Production: the job queue. */
  readonly handoff?: (context: InsightsContext) => WorkerHandoff;
  /** Tests only. */
  readonly ceilingMs?: number;
  readonly pollMs?: number;
}

function wireOf(run: ControlCheckRun, nowMs: number): z.infer<typeof runWire> {
  const state =
    run.finishedAt !== null
      ? ('finished' as const)
      : nowMs - run.startedAt.getTime() > INTERRUPTED_AFTER_MS
        ? ('interrupted' as const)
        : ('running' as const);
  const known = new Set<string>(CONTROL_CHECK_IDS);
  return {
    id: run.id,
    startedAt: run.startedAt.toISOString(),
    finishedAt: run.finishedAt?.toISOString() ?? null,
    state,
    provider: run.provider,
    model: run.model,
    overall: run.overall,
    evidenceVersion: run.evidenceVersion,
    results: run.results
      .filter((row) => known.has(row.id))
      .map((row) => ({
        id: row.id,
        name: row.name,
        proves: row.proves,
        side: row.side,
        status: row.status,
        reason: row.reason,
        facts: [...row.facts],
        notApplicable: row.notApplicable,
        durationMs: row.durationMs,
      })),
  };
}

export const narratorControlCheckRoutes = (
  deps: RouteDeps,
  options: ControlCheckRouteOptions,
): FastifyPluginAsyncZod => {
  const { guards, database, clock } = deps;
  const inFlight = new Set<Promise<unknown>>();

  async function active(userId: string) {
    const resolution = await options.runtime.resolve(userId);
    return {
      provider: resolution.provider,
      label: resolution.narrator?.label ?? null,
      model: resolution.narrator?.modelId ?? null,
    };
  }

  function displayName(provider: string): string {
    return isHostedProviderName(provider) ? HOSTED_DISPLAY_NAMES[provider] : 'the local model';
  }

  return async (app) => {
    app.addHook('onClose', async () => {
      await Promise.allSettled([...inFlight]);
    });

    app.get(
      '/narrator/control-checks',
      {
        schema: {
          operationId: 'listNarratorControlChecks',
          summary: 'The GenAI controls self-test: the last 20 runs, and what a run costs',
          description:
            'Newest first, each with its per-check rows (pending, running, pass, fail, skipped ' +
            'with its reason, or reported). The facts are sentences in words: never a payload, a ' +
            'prompt, a key or a model reply. `cost` says, before a press, how many model calls a ' +
            'run spends and with whom; `lastProven` is the newest finished run, for the dashboard.',
          tags: ['insights'],
          response: { 200: listWire, ...problems(401, 503) },
        },
      },
      async (request) => {
        const session = await guards.requireSession(request);
        const nowMs = clock.nowMs();
        const [runs, now] = await Promise.all([
          listControlCheckRuns(database, session.userId, 20),
          active(session.userId),
        ]);
        const latest = runs[0];
        const opensAt =
          latest === undefined ? null : latest.startedAt.getTime() + CONTROL_CHECKS_MIN_INTERVAL_MS;
        const finished = runs.find((run) => run.finishedAt !== null && run.overall !== null);
        return {
          runs: runs.map((run) => wireOf(run, nowMs)),
          provider: now.provider,
          model: now.model,
          cost: controlChecksCost(now.provider, displayName(now.provider)),
          nextAllowedAt:
            opensAt !== null && opensAt > nowMs ? new Date(opensAt).toISOString() : null,
          lastProven:
            finished === undefined || finished.finishedAt === null || finished.overall === null
              ? null
              : { at: finished.finishedAt.toISOString(), overall: finished.overall },
        };
      },
    );

    app.post(
      '/narrator/control-checks',
      {
        schema: {
          operationId: 'runNarratorControlChecks',
          summary: 'Run the GenAI controls self-test against this install',
          description:
            'Needs a step-up (it spends hosted calls with your key and touches run state inside ' +
            'transactions that are rolled back). Answers 202 with the new run, every check ' +
            'pending; the checks run in the background and the row fills in as each finishes ' +
            '(read it back with GET). The checks that need a model run in the worker; this ' +
            'process never calls one. `proveSwitch: true` also proves kill switch 1 by turning ' +
            'the module off inside a rolled-back transaction. One run per holder per 10 minutes: ' +
            '409 `narrator.control_checks_too_soon` with `Retry-After`.',
          tags: ['insights'],
          body: z.object({ proveSwitch: z.boolean().optional() }).optional(),
          response: { 202: runWire, ...problems(400, 401, 403, 409, 503) },
        },
      },
      async (request, reply) => {
        const session = await guards.requireFreshSession(request);
        const userId = session.userId;
        const nowMs = clock.nowMs();
        const [latest] = await listControlCheckRuns(database, userId, 1);
        if (latest !== undefined) {
          const opensAt = latest.startedAt.getTime() + CONTROL_CHECKS_MIN_INTERVAL_MS;
          if (opensAt > nowMs) {
            const seconds = Math.max(1, Math.ceil((opensAt - nowMs) / 1000));
            void reply.header('retry-after', String(seconds));
            throw new AppError({
              status: 409,
              code: 'narrator.control_checks_too_soon',
              title: 'Conflict',
              detail: `The controls were checked less than 10 minutes ago. Try again in ${String(Math.ceil(seconds / 60))} min.`,
              family: 'domain',
            });
          }
        }
        const now = await active(userId);
        const context: InsightsContext = {
          userId,
          clock,
          correlationId: correlationIdOf(request.id),
          causationId: null,
        };
        const run = await startControlCheckRun(database, context, {
          provider: now.provider,
          model: now.label,
        });
        const handoff = (options.handoff ?? ((ctx) => queueHandoff(database, ctx)))(context);
        const work = (async () => {
          let ports;
          try {
            ports = await apiCheckPorts(
              {
                database,
                pool: deps.pool,
                clock,
                config: deps.config,
                runtime: options.runtime,
                preview: options.preview,
              },
              context,
            );
          } catch (error) {
            await finishControlCheckRun(
              database,
              context,
              run.id,
              `The checks could not start (${errorClass(error)}).`,
            );
            return;
          }
          await runControlChecks({
            database,
            context,
            runId: run.id,
            ports,
            handoff,
            proveSwitch: request.body?.proveSwitch === true,
            ...(options.ceilingMs === undefined ? {} : { ceilingMs: options.ceilingMs }),
            ...(options.pollMs === undefined ? {} : { pollMs: options.pollMs }),
          });
        })().catch((error: unknown) => {
          request.log.error(
            { event: 'control_checks.failed', runId: run.id, err: error },
            'the controls self-test stopped',
          );
        });
        inFlight.add(work);
        void work.finally(() => inFlight.delete(work));
        request.log.info(
          {
            event: 'control_checks.started',
            runId: run.id,
            provider: now.provider,
            evidenceVersion: CONTROL_CHECKS_EVIDENCE_VERSION,
          },
          'controls self-test started',
        );
        return reply.code(202).send(wireOf(run, nowMs));
      },
    );
  };
};
