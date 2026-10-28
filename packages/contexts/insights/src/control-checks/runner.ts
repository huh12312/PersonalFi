// SPDX-License-Identifier: MIT
/**
 * Running the catalogue (WP 10.16): the api's half in the api process, the
 * worker's half as the `insights.control_checks` job.
 *
 * ```
 * api:    start the row → approval gate, consent, inspector, switches, badge
 *         → enqueue insights.control_checks → poll the row (≤ 5 minutes)
 * worker:   cancel in flight → numerals → reply format → egress → window → pin
 * api:    close the row: anything the worker did not finish is skipped, by name
 * ```
 *
 * The api never gains a path to the model: every check that needs one runs in
 * the worker, against the narrator the worker's run-mode runtime resolves for
 * the holder — the same adapter, key, window and egress policy a narration
 * uses. The two halves meet only in the `ops_control_checks` row.
 */
import { systemClock, type Clock } from '@core/kernel';
import { defineJob, type JobContext, type JobHandlerRegistration } from '@core/platform';
import type { InsightsContext, InsightsDatabase } from '../db.ts';
import {
  CONTROL_CHECKS,
  checkApprovalGate,
  checkBudgetWindow,
  checkCancelInFlight,
  checkConsentWithdrawal,
  checkEgressAllowlist,
  checkInspectorDigest,
  checkModelPin,
  checkModuleSwitch,
  checkNarrationBadge,
  checkNumeralsRefusal,
  checkSchemaRefusal,
  checkExplainGrounding,
  checkBriefNarrationGrounding,
  checkSuggestEnumRefusal,
  errorClass,
  pendingRow,
  runCheck,
  type ControlCheckId,
  type ControlCheckOutcome,
  type ControlProbeModel,
  type ModuleSwitchPort,
  type ExplainProbeModel,
  type BriefNarrateProbeModel,
  type SuggestProbeModel,
  type WorkerCheckContext,
} from './catalogue.ts';
import type { HolderCheckPorts } from './holder-ports.ts';
import { controlProbeRequest } from './probe.ts';
import {
  findControlCheckRun,
  finishControlCheckRun,
  recordControlCheck,
  unfinishedChecks,
  type ControlCheckRun,
} from './store.ts';

export const CONTROL_CHECKS_JOB_KIND = 'insights.control_checks';
/** One run per holder per this long (the route answers 409 with Retry-After). */
export const CONTROL_CHECKS_MIN_INTERVAL_MS = 10 * 60_000;
/** The api waits this long for the worker's half, then closes the run. */
export const CONTROL_CHECKS_WORKER_CEILING_MS = 5 * 60_000;
/** How often the api reads the row while the worker runs. */
export const CONTROL_CHECKS_POLL_MS = 500;

export interface ApiCheckPorts extends HolderCheckPorts {
  readonly moduleSwitch: ModuleSwitchPort;
}

export interface ControlChecksJobPayload {
  readonly runId: string;
}

/** How the api hands the worker its half. */
export interface WorkerHandoff {
  /** Enqueue `insights.control_checks` for this run; the job's id. */
  enqueue(runId: string): Promise<string>;
  /** The api gave up: a job not yet claimed is not run later. True when it had not been claimed. */
  cancel(jobId: string): Promise<boolean>;
}

async function record(
  database: InsightsDatabase,
  context: InsightsContext,
  runId: string,
  id: ControlCheckId,
  check: () => Promise<ControlCheckOutcome>,
): Promise<boolean> {
  const definition = CONTROL_CHECKS.find((entry) => entry.id === id);
  if (definition === undefined) throw new Error(`unknown control check ${id}`);
  const open = await recordControlCheck(database, context.userId, runId, {
    ...pendingRow(definition),
    status: 'running',
  });
  if (!open) return false;
  const row = await runCheck(definition, context.clock, check);
  return recordControlCheck(database, context.userId, runId, row);
}

/** The api's half, in catalogue order. */
export async function runApiControlChecks(
  database: InsightsDatabase,
  context: InsightsContext,
  runId: string,
  ports: ApiCheckPorts,
  options: { readonly proveSwitch: boolean },
): Promise<void> {
  const checks: Partial<Record<ControlCheckId, () => Promise<ControlCheckOutcome>>> = {
    approval_gate: () => checkApprovalGate(ports.approvalGate),
    consent_withdrawal: () => checkConsentWithdrawal(ports.consent),
    inspector_digest: () => checkInspectorDigest(ports.inspector),
    module_switch: () => checkModuleSwitch(ports.moduleSwitch, { prove: options.proveSwitch }),
    narration_badge: () => checkNarrationBadge(ports.badge),
  };
  for (const definition of CONTROL_CHECKS) {
    if (definition.side !== 'api') continue;
    const check = checks[definition.id];
    if (check === undefined) continue;
    if (!(await record(database, context, runId, definition.id, check))) return;
  }
}

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Enqueue the worker's half and wait for it, reading the row. Wall time, by
 * counting polls: an injected clock that never moves must not make this wait
 * for ever.
 */
export async function awaitWorkerChecks(
  database: InsightsDatabase,
  context: InsightsContext,
  runId: string,
  handoff: WorkerHandoff,
  options: { readonly ceilingMs?: number; readonly pollMs?: number } = {},
): Promise<'finished' | 'timeout' | 'unclaimed' | 'closed'> {
  const pollMs = options.pollMs ?? CONTROL_CHECKS_POLL_MS;
  const polls = Math.ceil((options.ceilingMs ?? CONTROL_CHECKS_WORKER_CEILING_MS) / pollMs);
  const jobId = await handoff.enqueue(runId);
  for (let poll = 0; poll <= polls; poll += 1) {
    const run = await findControlCheckRun(database, context.userId, runId);
    if (run === null || run.finishedAt !== null) return 'closed';
    const left = unfinishedChecks(run).filter(
      (id) => CONTROL_CHECKS.find((entry) => entry.id === id)?.side === 'worker',
    );
    if (left.length === 0) return 'finished';
    await delay(pollMs);
  }
  const unclaimed = await handoff.cancel(jobId).catch(() => false);
  return unclaimed ? 'unclaimed' : 'timeout';
}

/** Both halves, then the row closed. What the route runs in the background and the CLI awaits. */
export async function runControlChecks(input: {
  readonly database: InsightsDatabase;
  readonly context: InsightsContext;
  readonly runId: string;
  readonly ports: ApiCheckPorts;
  readonly handoff: WorkerHandoff;
  readonly proveSwitch: boolean;
  readonly ceilingMs?: number;
  readonly pollMs?: number;
}): Promise<ControlCheckRun | null> {
  const { database, context, runId } = input;
  let why = 'The worker did not run this check.';
  try {
    await runApiControlChecks(database, context, runId, input.ports, {
      proveSwitch: input.proveSwitch,
    });
    const waited = await awaitWorkerChecks(database, context, runId, input.handoff, {
      ...(input.ceilingMs === undefined ? {} : { ceilingMs: input.ceilingMs }),
      ...(input.pollMs === undefined ? {} : { pollMs: input.pollMs }),
    });
    const minutes = String(
      Math.round((input.ceilingMs ?? CONTROL_CHECKS_WORKER_CEILING_MS) / 60_000),
    );
    if (waited === 'timeout') {
      why = `The worker started but did not finish this check within ${minutes} minutes.`;
    } else if (waited === 'unclaimed') {
      why = `The worker never picked this up within ${minutes} minutes (is the worker running, with the insights module on?).`;
    }
  } catch (error) {
    why = `The run stopped before this check (${errorClass(error)}).`;
  }
  return finishControlCheckRun(database, context, runId, why);
}

// ---------------------------------------------------------------------------
// The worker's half
// ---------------------------------------------------------------------------

export interface ResolvedProbeModel {
  readonly model: ControlProbeModel | null;
  /** Why there is no model, in words. */
  readonly unavailable: string | null;
}

export interface ControlChecksJobDependencies {
  readonly database: InsightsDatabase;
  readonly clock?: Clock;
  /** The holder's narrator in the worker (run mode), as the self-test reaches it. */
  probeFor(userId: string): Promise<ResolvedProbeModel>;
  /** WP 11.2: the holder's suggestion model's enum probe; absent or `null` skips that check as not applicable. */
  suggestProbeFor?(userId: string): Promise<SuggestProbeModel | null>;
  /** WP 11.3: the holder's explain model's grounding probe; absent or `null` skips that check as not applicable. */
  explainProbeFor?(userId: string): Promise<ExplainProbeModel | null>;
  /** WP 11.4: the holder's Brief-narration model's grounding probe; absent or `null` skips that check as not applicable. */
  briefNarrateProbeFor?(userId: string): Promise<BriefNarrateProbeModel | null>;
  /** Tests only. */
  readonly timing?: WorkerCheckContext['timing'];
}

const WORKER_CHECKS: Partial<
  Record<ControlCheckId, (context: WorkerCheckContext) => Promise<ControlCheckOutcome>>
> = {
  kill_level_4_cancel: checkCancelInFlight,
  numerals_refusal: checkNumeralsRefusal,
  schema_refusal: checkSchemaRefusal,
  egress_allowlist: checkEgressAllowlist,
  budget_window: checkBudgetWindow,
  model_pin: checkModelPin,
  suggest_enum_refusal: checkSuggestEnumRefusal,
  explain_grounding: checkExplainGrounding,
  brief_narration_grounding: checkBriefNarrationGrounding,
};

/** The worker's checks for one run, in catalogue order. Total: never throws past a check. */
export async function runWorkerControlChecks(
  dependencies: ControlChecksJobDependencies,
  context: InsightsContext,
  runId: string,
): Promise<void> {
  const { database } = dependencies;
  const run = await findControlCheckRun(database, context.userId, runId);
  if (run === null || run.finishedAt !== null) return;
  let resolved: ResolvedProbeModel;
  try {
    resolved = await dependencies.probeFor(context.userId);
  } catch (error) {
    resolved = {
      model: null,
      unavailable: `The worker could not resolve your narrator (${errorClass(error)}).`,
    };
  }
  const clock = context.clock;
  const suggest: SuggestProbeModel | null = await (
    dependencies.suggestProbeFor?.(context.userId) ?? Promise.resolve(null)
  ).catch(() => null);
  const explain: ExplainProbeModel | null = await (
    dependencies.explainProbeFor?.(context.userId) ?? Promise.resolve(null)
  ).catch(() => null);
  const briefNarrate: BriefNarrateProbeModel | null = await (
    dependencies.briefNarrateProbeFor?.(context.userId) ?? Promise.resolve(null)
  ).catch(() => null);
  const workerContext: WorkerCheckContext = {
    suggest,
    explain,
    briefNarrate,
    model: resolved.model,
    unavailable: resolved.unavailable,
    request: controlProbeRequest(clock),
    clock,
    probesSent: 0,
    budgetBefore: resolved.model?.budget?.remaining(clock.nowMs()) ?? null,
    ...(dependencies.timing === undefined ? {} : { timing: dependencies.timing }),
  };
  for (const definition of CONTROL_CHECKS) {
    if (definition.side !== 'worker') continue;
    const check = WORKER_CHECKS[definition.id];
    if (check === undefined) continue;
    if (!(await record(database, context, runId, definition.id, () => check(workerContext)))) {
      return;
    }
  }
}

/** `insights.control_checks`: one run's worker half. Concurrency 1; never retried. */
export function createControlChecksJob(
  dependencies: ControlChecksJobDependencies,
): JobHandlerRegistration {
  return defineJob<ControlChecksJobPayload>(
    CONTROL_CHECKS_JOB_KIND,
    async (payload: ControlChecksJobPayload, job: JobContext) => {
      if (typeof payload.runId !== 'string') return;
      await runWorkerControlChecks(
        dependencies,
        {
          userId: job.userId,
          clock: dependencies.clock ?? systemClock,
          correlationId: job.correlationId,
          causationId: null,
        },
        payload.runId,
      );
      job.logger.info(
        { job: CONTROL_CHECKS_JOB_KIND, runId: payload.runId },
        'controls self-test: the worker half finished',
      );
    },
    { concurrency: 1 },
  );
}
