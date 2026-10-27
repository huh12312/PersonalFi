// SPDX-License-Identifier: MIT
/**
 * Running `insight.explain`: the cache, the scope bound, the kill ladder, the
 * approval, the run inspector, the call, the validator and the cache write —
 * in that order (11 §2 rule 3: same gate, same ladder, same evidence).
 *
 *   0. **The cache.** The request is built first (it is pure), and its digest
 *      is the cache key: an explanation already given for exactly this
 *      evidence is returned as it is, and nothing is sent.
 *   1. **The scope bound.** Every scope the entity was built from must be in
 *      the holder's live grant to the narrator (`local.narrator`'s effective
 *      run scopes). Otherwise nothing is sent and no run is recorded: the
 *      payload would carry a data category the holder never let reach a model.
 *   2. **Gate**, read through `decideContinue` as every `local_model` run reads
 *      it: level 1 (`ADVISORS_ENABLED`, `module.insights`), level 2 (the
 *      `local_model` kind switch, and a model bound for this holder — the
 *      narrator's provider; Off is off), level 3 (`advisors.enabled` for
 *      `insight.explain`, and its quarantine), then the payload approval for
 *      the shape this run would send. A refusal is an `advisor_runs` row.
 *   3. **The run row** — `advisor_runs` with the payload's digest, the prompt
 *      hash and the model before the call; the payload retained 30 days for
 *      the inspector (`inspectRunPayload` re-derives the digest).
 *   4. **The call**, raced against the manifest's deadline and the watcher
 *      (every switch and the run's own cancel flag, once a second).
 *   5. **The barrier** — the switches once more after the reply; a kill that
 *      landed during the call discards everything the model said.
 *   6. **Validation** (`reply.ts`), then **the cache write** in the same
 *      transaction as the run's finish: the text, or the refusal class. A
 *      failed call writes no cache row (it may be asked again); a refusal is
 *      cached, because re-asking until the validator agrees is
 *      retry-until-valid.
 *
 * Nothing else is written: no insight, no grant, no approval, no setting.
 */
import { NARRATOR_ADVISOR_ID, NARRATOR_MANIFEST } from '../local/manifest.ts';
import {
  BREAKER_THRESHOLDS,
  decideContinue,
  type CancelReason,
  type RunSwitches,
} from '../../policy/kill-switches.ts';
import { RUN_WATCH_POLL_MS, RunCancelled, watchRun } from '../../policy/run-watch.ts';
import { effectiveRunScopes, hasLiveApproval, queryShape } from '../../preview.ts';
import type { InsightsContext, InsightsDatabase, InsightsExecutor } from '../../db.ts';
import {
  findAdvisor,
  findRun,
  finishRun,
  listGrants,
  quarantineAdvisor,
  recordRunHealth,
  recordRunModel,
  retainRunPayload,
  startRun,
} from '../../store.ts';
import type { RunTrigger } from '../../../schema/index.ts';
import {
  INSIGHT_EXPLAIN_ADVISOR_ID,
  INSIGHT_EXPLAIN_MANIFEST,
  INSIGHT_EXPLAIN_SCOPES,
  INSIGHT_EXPLAIN_VERSION,
} from './manifest.ts';
import { buildExplainRequest, type ExplainTarget, type ExplainWireRequest } from './request.ts';
import { validateExplainReply, type ExplainRefusalClass } from './reply.ts';
import { findExplanation, recordExplanation, type StoredExplanation } from './source.ts';

/** What the composition root binds: `@advisor/local-model`'s `ExplainModelAdapter`, structurally. */
export interface ExplainModelPort {
  readonly provider: string;
  readonly label: string;
  readonly templateHash: string;
  render(request: ExplainWireRequest): { readonly text: string; readonly hash: string };
  run(
    request: ExplainWireRequest,
    signal: AbortSignal,
  ): Promise<{
    readonly reply: unknown;
    readonly isJson: boolean;
    readonly label: string;
    readonly promptHash: string;
    readonly warnings: readonly string[];
    readonly runtimeMs: number;
  }>;
}

/** The renderer half: what the api binds (it never calls a model). */
export type ExplainRenderer = Pick<
  ExplainModelPort,
  'provider' | 'label' | 'templateHash' | 'render'
>;

export interface InsightExplainDependencies {
  readonly switches: RunSwitches;
  /** This holder's explain model — the narrator's provider — or `null` (Off, or nothing configured). */
  readonly model: ExplainModelPort | null;
  /** Tests only. */
  readonly runWatchPollMs?: number;
}

/** The approvable shape: advisor id, version, kind, the scope bound and the explain template hash. */
export function insightExplainShape(templateHash: string | null): string {
  return queryShape({
    advisorId: INSIGHT_EXPLAIN_ADVISOR_ID,
    advisorVersion: INSIGHT_EXPLAIN_VERSION,
    kind: 'local_model',
    scopes: INSIGHT_EXPLAIN_SCOPES,
    promptTemplateHash: templateHash,
  });
}

/** Why an explanation cannot be given now, before anything is sent. */
export type ExplainUnavailableReason = CancelReason | 'scope_not_granted';

/** The scopes of `target` the holder has not granted the narrator; empty when every one is granted. */
export async function ungrantedExplainScopes(
  executor: InsightsExecutor,
  userId: string,
  target: Pick<ExplainTarget, 'scopes'>,
): Promise<readonly string[]> {
  const grant = new Set<string>(
    effectiveRunScopes(NARRATOR_MANIFEST, await listGrants(executor, userId, NARRATOR_ADVISOR_ID)),
  );
  const bound = new Set<string>(INSIGHT_EXPLAIN_SCOPES);
  return target.scopes.filter((scope) => !grant.has(scope) || !bound.has(scope));
}

interface GateInputs {
  readonly userId: string;
  readonly shape: string | null;
  readonly runId: string | null;
  readonly modelBound: boolean;
}

async function readExplainGate(
  executor: InsightsExecutor,
  switches: RunSwitches,
  input: GateInputs,
): Promise<CancelReason | null> {
  const [advisorsEnabled, moduleEnabled, kindEnabled] = await Promise.all([
    switches.advisorsEnabled(),
    switches.moduleEnabled(input.userId),
    switches.kindEnabled(input.userId, 'local_model'),
  ]);
  const row = await findAdvisor(executor, input.userId, INSIGHT_EXPLAIN_ADVISOR_ID);
  const payloadApproved =
    input.shape !== null &&
    (await hasLiveApproval(executor, input.userId, INSIGHT_EXPLAIN_ADVISOR_ID, input.shape));
  const run = input.runId === null ? null : await findRun(executor, input.userId, input.runId);
  return decideContinue({
    advisorsEnabled,
    moduleEnabled,
    kindEnabled: kindEnabled && input.modelBound,
    advisorEnabled: row?.enabled ?? false,
    quarantinedAt: row?.quarantinedAt ?? null,
    payloadApproved,
    cancelRequestedAt: run?.cancelRequestedAt ?? null,
  });
}

/**
 * Could an explanation of `target` be asked for now? The api's route, the
 * job and the Brief's prefetch all ask this before anything is enqueued or
 * sent. `null` means yes.
 */
export async function explainUnavailable(
  executor: InsightsExecutor,
  switches: RunSwitches,
  input: {
    readonly userId: string;
    readonly templateHash: string | null;
    readonly target: Pick<ExplainTarget, 'scopes'> | null;
  },
): Promise<ExplainUnavailableReason | null> {
  const reason = await readExplainGate(executor, switches, {
    userId: input.userId,
    shape: input.templateHash === null ? null : insightExplainShape(input.templateHash),
    runId: null,
    modelBound: input.templateHash !== null,
  });
  if (reason !== null && reason !== 'run_cancelled') return reason;
  if (input.target !== null) {
    const ungranted = await ungrantedExplainScopes(executor, input.userId, input.target);
    if (ungranted.length > 0) return 'scope_not_granted';
  }
  return null;
}

export interface InsightExplainResult {
  readonly status:
    'cached' | 'completed' | 'refused' | 'failed' | 'cancelled' | 'scope_not_granted';
  /** `null` for a cache hit and for a scope refusal: nothing was run. */
  readonly runId: string | null;
  readonly digest: string;
  /** The explanation or its refusal, when one exists for this digest. */
  readonly explanation: StoredExplanation | null;
  /** The gate's refusal, when `status` is `refused`. */
  readonly refusal: CancelReason | null;
  readonly cancelReason: CancelReason | null;
  readonly errorCode: string | null;
  /** The validator's refusal class, when the reply was refused. */
  readonly replyRefusal: ExplainRefusalClass | null;
}

async function invokeModel(
  model: ExplainModelPort,
  request: ExplainWireRequest,
  controller: AbortController,
  timeoutMs: number,
): Promise<Awaited<ReturnType<ExplainModelPort['run']>>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const stopped = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort(new Error('advisor_timeout'));
      reject(new Error('advisor_timeout'));
    }, timeoutMs);
    onAbort = () => {
      const reason: unknown = controller.signal.reason;
      reject(reason instanceof Error ? reason : new Error('advisor_aborted'));
    };
    if (controller.signal.aborted) onAbort();
    else controller.signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([model.run(request, controller.signal), stopped]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort !== undefined) controller.signal.removeEventListener('abort', onAbort);
  }
}

function errorCodeOf(error: unknown): string {
  if (error instanceof RunCancelled) return 'run_cancelled';
  if (error instanceof Error && error.message === 'advisor_timeout') return 'advisor_timeout';
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[a-z][a-z0-9_.:-]{0,63}$/u.test(code)
    ? code
    : 'model_unavailable';
}

async function tripBreaker(
  executor: InsightsExecutor,
  context: InsightsContext,
  succeeded: boolean,
): Promise<void> {
  const failures = await recordRunHealth(executor, context, INSIGHT_EXPLAIN_ADVISOR_ID, succeeded);
  if (!succeeded && failures >= BREAKER_THRESHOLDS.local_model.consecutiveFailures) {
    await quarantineAdvisor(executor, context, INSIGHT_EXPLAIN_ADVISOR_ID, 'consecutive_failures');
  }
}

/** Explain one entity. Writes `advisor_runs` (and its retained payload) and `insight_explanations` only. */
export async function runInsightExplain(
  database: InsightsDatabase,
  context: InsightsContext,
  dependencies: InsightExplainDependencies,
  input: { readonly target: ExplainTarget; readonly trigger: RunTrigger },
): Promise<InsightExplainResult> {
  const limits = INSIGHT_EXPLAIN_MANIFEST.limits;
  const model = dependencies.model;
  const { target } = input;
  const built = buildExplainRequest({
    target,
    now: context.clock.now(),
    timeoutMs: limits.timeout_ms,
    maxResponseBytes: limits.max_response_bytes,
  });
  const base = {
    digest: built.digest,
    refusal: null,
    cancelReason: null,
    errorCode: null,
    replyRefusal: null,
  } as const;

  // --- 0. the cache -----------------------------------------------------------
  const cached = await findExplanation(database, context.userId, {
    entityKind: target.entityKind,
    entityId: target.entityId,
    evidenceDigest: built.digest,
  });
  if (cached !== null) return { ...base, status: 'cached', runId: null, explanation: cached };

  // --- 1. the scope bound -----------------------------------------------------
  if ((await ungrantedExplainScopes(database, context.userId, target)).length > 0) {
    return { ...base, status: 'scope_not_granted', runId: null, explanation: null };
  }

  const shape = insightExplainShape(model?.templateHash ?? null);
  const gate = {
    userId: context.userId,
    shape: model === null ? null : shape,
    modelBound: model !== null,
  };
  const started = context.clock.nowMs();

  // --- 2–3. transaction 1: the gate and the run row ---------------------------
  const opened = await database.transaction(async (tx) => {
    const run = await startRun(tx, context, {
      advisorId: INSIGHT_EXPLAIN_ADVISOR_ID,
      advisorVersion: INSIGHT_EXPLAIN_VERSION,
      trigger: input.trigger,
    });
    const reason = await readExplainGate(tx, dependencies.switches, { ...gate, runId: null });
    const refusal = reason === 'run_cancelled' ? null : reason;
    if (refusal !== null || model === null) {
      await finishRun(tx, context, {
        runId: run.id,
        status: 'refused',
        refusal: (refusal ?? 'kind_disabled') as never,
        durationMs: 0,
      });
      return { runId: run.id, refusal: refusal ?? 'kind_disabled' };
    }
    const rendered = model.render(built.request);
    await recordRunModel(tx, context, {
      runId: run.id,
      llmModel: model.label,
      llmPromptHash: rendered.hash,
    });
    await retainRunPayload(tx, context, {
      runId: run.id,
      advisorId: INSIGHT_EXPLAIN_ADVISOR_ID,
      queryShape: shape,
      payload: built.payload as unknown as Record<string, unknown>,
      payloadBytes: new TextEncoder().encode(JSON.stringify(built.payload)).length,
    });
    return { runId: run.id, refusal: null };
  });
  if (opened.refusal !== null || model === null) {
    return {
      ...base,
      status: 'refused',
      runId: opened.runId,
      explanation: null,
      refusal: opened.refusal,
    };
  }
  const runId = opened.runId;

  // --- 4. the call, watched ---------------------------------------------------
  const controller = new AbortController();
  const watch = watchRun({
    controller,
    pollMs: dependencies.runWatchPollMs ?? RUN_WATCH_POLL_MS,
    probe: () => readExplainGate(database, dependencies.switches, { ...gate, runId }),
  });
  let reply: Awaited<ReturnType<ExplainModelPort['run']>> | null = null;
  let failure: unknown = null;
  try {
    reply = await invokeModel(model, built.request, controller, limits.timeout_ms);
  } catch (error) {
    failure = error;
  } finally {
    await watch.stop();
  }

  // --- 5–6. transaction 2: the barrier, the record, the cache ----------------
  return database.transaction(async (tx) => {
    const durationMs = Math.max(0, context.clock.nowMs() - started);
    const scopes = [...target.scopes];
    const stoppedBy =
      watch.reason() ??
      (failure instanceof RunCancelled ? failure.reason : null) ??
      (await readExplainGate(tx, dependencies.switches, { ...gate, runId }));
    if (stoppedBy !== null) {
      await finishRun(tx, context, {
        runId,
        status: 'cancelled',
        cancelReason: stoppedBy as never,
        inputDigest: built.digest,
        grantedScopes: scopes,
        durationMs,
      });
      return {
        ...base,
        status: 'cancelled' as const,
        runId,
        explanation: null,
        cancelReason: stoppedBy,
      };
    }
    if (reply === null) {
      const errorCode = errorCodeOf(failure);
      await finishRun(tx, context, {
        runId,
        status: 'failed',
        inputDigest: built.digest,
        grantedScopes: scopes,
        errorCode,
        durationMs,
      });
      await tripBreaker(tx, context, false);
      return { ...base, status: 'failed' as const, runId, explanation: null, errorCode };
    }
    const verdict = validateExplainReply(reply.reply, built.trace);
    const schema = !verdict.ok && verdict.refusal === 'schema';
    await finishRun(tx, context, {
      runId,
      status: 'completed',
      inputDigest: built.digest,
      grantedScopes: scopes,
      emittedScopes: scopes,
      proposedCount: 1,
      acceptedCount: verdict.ok ? 1 : 0,
      rejectedCount: verdict.ok ? 0 : 1,
      rejections: verdict.ok ? [] : [{ refusal: verdict.refusal }],
      errorCode: schema ? 'reply_schema' : null,
      durationMs,
    });
    // A whole reply outside the format is a failure for the breaker; a reply
    // the validator refused on its content is not — a hostile evidence label
    // that talks the model into a figure must not switch the feature off.
    await tripBreaker(tx, context, !schema);
    const written = await recordExplanation(tx, context, {
      entityKind: target.entityKind,
      entityId: target.entityId,
      evidenceDigest: built.digest,
      text: verdict.ok ? verdict.text : null,
      refusal: verdict.ok ? null : verdict.refusal,
      provider: model.provider,
      model: reply.label,
      runId,
    });
    const explanation =
      written ??
      (await findExplanation(tx, context.userId, {
        entityKind: target.entityKind,
        entityId: target.entityId,
        evidenceDigest: built.digest,
      }));
    return {
      ...base,
      status: 'completed' as const,
      runId,
      explanation,
      errorCode: schema ? 'reply_schema' : null,
      replyRefusal: verdict.ok ? null : verdict.refusal,
    };
  });
}
