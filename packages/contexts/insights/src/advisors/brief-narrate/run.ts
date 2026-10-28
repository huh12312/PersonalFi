// SPDX-License-Identifier: MIT
/**
 * Running `brief.narrate`: the one-call guard, the scope ceiling, the kill
 * ladder, the approval, the run inspector, the call, the validator and the
 * outcome — in that order (11 §2 rule 3: same gate, same ladder, same
 * evidence; `insight.explain`'s `run.ts`, step for step).
 *
 *   0. **One call per Brief.** Under the advisor row's lock, a Brief that
 *      already has a `brief_narrations` row is never asked about again —
 *      whatever that row says (shown, refused, failed, cancelled, or a call
 *      still in flight). The row is claimed in transaction 1, before the call.
 *   1. **Nothing to narrate.** A Brief with no ranked item inside the ceiling
 *      sends nothing; its deterministic opening is the whole header.
 *   2. **The scope ceiling.** The union of the items' scopes must be inside
 *      the holder's live grant to the narrator (`local.narrator`'s effective
 *      run scopes) and the bound. Otherwise nothing is sent and no run is
 *      recorded.
 *   3. **Gate**, through `decideContinue` as every `local_model` run reads it
 *      (levels 1–3 and this shape's approval). A refusal is an `advisor_runs`
 *      row and claims nothing: the opening stands.
 *   4. **The run row and the claim** — `advisor_runs` with the payload's
 *      digest, the prompt hash and the model; the payload retained for the
 *      inspector; the `brief_narrations` row claimed (`calling`).
 *   5. **The call**, raced against the manifest's deadline and the watcher.
 *   6. **The barrier** — a kill that landed during the call discards the
 *      reply (`cancelled`).
 *   7. **Validation** (`reply.ts`), then the outcome on the claimed row in the
 *      run's finishing transaction: both texts (`shown`), or the refusal class
 *      (`refused`), or `failed` — none of them asked again.
 *
 * Nothing else is written: no insight, no Brief row, no grant, no approval, no
 * setting.
 */
import {
  BREAKER_THRESHOLDS,
  decideContinue,
  type CancelReason,
  type RunSwitches,
} from '../../policy/kill-switches.ts';
import { RUN_WATCH_POLL_MS, RunCancelled, watchRun } from '../../policy/run-watch.ts';
import { narratorGrantCeiling } from '../local/grant.ts';
import { hasLiveApproval, queryShape } from '../../preview.ts';
import type { InsightsContext, InsightsDatabase, InsightsExecutor } from '../../db.ts';
import {
  findAdvisor,
  findRun,
  finishRun,
  lockAdvisor,
  quarantineAdvisor,
  recordRunHealth,
  recordRunModel,
  retainRunPayload,
  startRun,
} from '../../store.ts';
import type { RunTrigger } from '../../../schema/index.ts';
import {
  BRIEF_NARRATE_ADVISOR_ID,
  BRIEF_NARRATE_MANIFEST,
  BRIEF_NARRATE_SCOPES,
  BRIEF_NARRATE_VERSION,
} from './manifest.ts';
import {
  buildBriefNarrateRequest,
  type BriefNarrateTarget,
  type BriefNarrateWireRequest,
} from './request.ts';
import { validateBriefNarrateReply, type BriefNarrateRefusalClass } from './reply.ts';
import {
  claimBriefNarration,
  findBriefNarration,
  finishBriefNarration,
  type StoredBriefNarration,
} from './source.ts';

/** What the composition root binds: `@advisor/local-model`'s `BriefNarrateModelAdapter`, structurally. */
export interface BriefNarrateModelPort {
  readonly provider: string;
  readonly label: string;
  readonly templateHash: string;
  render(request: BriefNarrateWireRequest): { readonly text: string; readonly hash: string };
  run(
    request: BriefNarrateWireRequest,
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
export type BriefNarrateRenderer = Pick<
  BriefNarrateModelPort,
  'provider' | 'label' | 'templateHash' | 'render'
>;

export interface BriefNarrateDependencies {
  readonly switches: RunSwitches;
  /** This holder's model — the narrator's provider — or `null` (Off, or nothing configured). */
  readonly model: BriefNarrateModelPort | null;
  /** Tests only. */
  readonly runWatchPollMs?: number;
}

/** The approvable shape: advisor id, version, kind, the scope bound and the brief-narrate template hash. */
export function briefNarrateShape(templateHash: string | null): string {
  return queryShape({
    advisorId: BRIEF_NARRATE_ADVISOR_ID,
    advisorVersion: BRIEF_NARRATE_VERSION,
    kind: 'local_model',
    scopes: BRIEF_NARRATE_SCOPES,
    promptTemplateHash: templateHash,
  });
}

export type BriefNarrateUnavailableReason = CancelReason | 'scope_not_granted';

/** The narrator's live grant ∩ the bound: the ceiling a composition's items must sit inside. */
export async function briefNarrateCeiling(
  executor: InsightsExecutor,
  userId: string,
): Promise<readonly string[]> {
  return narratorGrantCeiling(executor, userId, BRIEF_NARRATE_SCOPES);
}

/** The scopes of `target` outside the ceiling; empty when every one is inside. */
export async function ungrantedBriefNarrateScopes(
  executor: InsightsExecutor,
  userId: string,
  target: Pick<BriefNarrateTarget, 'scopes'>,
): Promise<readonly string[]> {
  const ceiling = new Set(await briefNarrateCeiling(executor, userId));
  return target.scopes.filter((scope) => !ceiling.has(scope));
}

interface GateInputs {
  readonly userId: string;
  readonly shape: string | null;
  readonly runId: string | null;
  readonly modelBound: boolean;
}

async function readGate(
  executor: InsightsExecutor,
  switches: RunSwitches,
  input: GateInputs,
): Promise<CancelReason | null> {
  const [advisorsEnabled, moduleEnabled, kindEnabled] = await Promise.all([
    switches.advisorsEnabled(),
    switches.moduleEnabled(input.userId),
    switches.kindEnabled(input.userId, 'local_model'),
  ]);
  const row = await findAdvisor(executor, input.userId, BRIEF_NARRATE_ADVISOR_ID);
  const payloadApproved =
    input.shape !== null &&
    (await hasLiveApproval(executor, input.userId, BRIEF_NARRATE_ADVISOR_ID, input.shape));
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

/** Could this holder's Brief be narrated now? `null` means yes. The route's "unavailable" reads this. */
export async function briefNarrateUnavailable(
  executor: InsightsExecutor,
  switches: RunSwitches,
  input: { readonly userId: string; readonly templateHash: string | null },
): Promise<CancelReason | null> {
  const reason = await readGate(executor, switches, {
    userId: input.userId,
    shape: input.templateHash === null ? null : briefNarrateShape(input.templateHash),
    runId: null,
    modelBound: input.templateHash !== null,
  });
  return reason === 'run_cancelled' ? null : reason;
}

export interface BriefNarrateResult {
  readonly status:
    | 'already'
    | 'nothing_to_narrate'
    | 'scope_not_granted'
    | 'refused'
    | 'completed'
    | 'failed'
    | 'cancelled';
  /** `null` when nothing was run. */
  readonly runId: string | null;
  readonly digest: string;
  /** The Brief's narration row after this pass (also for `already`). */
  readonly narration: StoredBriefNarration | null;
  readonly refusal: CancelReason | null;
  readonly cancelReason: CancelReason | null;
  readonly errorCode: string | null;
  readonly replyRefusal: BriefNarrateRefusalClass | null;
}

async function invokeModel(
  model: BriefNarrateModelPort,
  request: BriefNarrateWireRequest,
  controller: AbortController,
  timeoutMs: number,
): Promise<Awaited<ReturnType<BriefNarrateModelPort['run']>>> {
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
  const failures = await recordRunHealth(executor, context, BRIEF_NARRATE_ADVISOR_ID, succeeded);
  if (!succeeded && failures >= BREAKER_THRESHOLDS.local_model.consecutiveFailures) {
    await quarantineAdvisor(executor, context, BRIEF_NARRATE_ADVISOR_ID, 'consecutive_failures');
  }
}

/**
 * Narrate one Brief. Writes `advisor_runs` (and its retained payload) and
 * `brief_narrations` only, and asks the model at most once per Brief.
 */
export async function runBriefNarration(
  database: InsightsDatabase,
  context: InsightsContext,
  dependencies: BriefNarrateDependencies,
  input: { readonly target: BriefNarrateTarget; readonly trigger: RunTrigger },
): Promise<BriefNarrateResult> {
  const limits = BRIEF_NARRATE_MANIFEST.limits;
  const model = dependencies.model;
  const { target } = input;
  const built = buildBriefNarrateRequest({
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

  // --- 0. one call per Brief (read; re-checked under the lock below) -------------
  const existing = await findBriefNarration(database, context.userId, target.briefId);
  if (existing !== null) return { ...base, status: 'already', runId: null, narration: existing };

  // --- 1. nothing to narrate ---------------------------------------------------
  if (target.subject.items.length === 0) {
    return { ...base, status: 'nothing_to_narrate', runId: null, narration: null };
  }

  // --- 2. the scope ceiling ----------------------------------------------------
  if ((await ungrantedBriefNarrateScopes(database, context.userId, target)).length > 0) {
    return { ...base, status: 'scope_not_granted', runId: null, narration: null };
  }

  const shape = briefNarrateShape(model?.templateHash ?? null);
  const gate = {
    userId: context.userId,
    shape: model === null ? null : shape,
    modelBound: model !== null,
  };
  const started = context.clock.nowMs();

  // --- 3–4. transaction 1: the lock, the guard, the gate, the run row, the claim -
  const opened = await database.transaction(async (tx) => {
    await lockAdvisor(tx, context.userId, BRIEF_NARRATE_ADVISOR_ID);
    const already = await findBriefNarration(tx, context.userId, target.briefId);
    if (already !== null) return { kind: 'already' as const, narration: already };
    const run = await startRun(tx, context, {
      advisorId: BRIEF_NARRATE_ADVISOR_ID,
      advisorVersion: BRIEF_NARRATE_VERSION,
      trigger: input.trigger,
    });
    const reason = await readGate(tx, dependencies.switches, { ...gate, runId: null });
    const refusal = reason === 'run_cancelled' ? null : reason;
    if (refusal !== null || model === null) {
      await finishRun(tx, context, {
        runId: run.id,
        status: 'refused',
        refusal: (refusal ?? 'kind_disabled') as never,
        durationMs: 0,
      });
      return { kind: 'refused' as const, runId: run.id, refusal: refusal ?? 'kind_disabled' };
    }
    const rendered = model.render(built.request);
    await recordRunModel(tx, context, {
      runId: run.id,
      llmModel: model.label,
      llmPromptHash: rendered.hash,
    });
    await retainRunPayload(tx, context, {
      runId: run.id,
      advisorId: BRIEF_NARRATE_ADVISOR_ID,
      queryShape: shape,
      payload: built.payload as unknown as Record<string, unknown>,
      payloadBytes: new TextEncoder().encode(JSON.stringify(built.payload)).length,
    });
    const claimed = await claimBriefNarration(tx, context, {
      briefId: target.briefId,
      inputDigest: built.digest,
      provider: model.provider,
      model: model.label,
      runId: run.id,
    });
    if (!claimed) {
      // The lock makes this unreachable; the unique index is the backstop.
      await finishRun(tx, context, {
        runId: run.id,
        status: 'refused',
        refusal: 'advisor_disabled' as never,
        durationMs: 0,
      });
      return {
        kind: 'already' as const,
        narration: await findBriefNarration(tx, context.userId, target.briefId),
      };
    }
    return { kind: 'open' as const, runId: run.id };
  });
  if (opened.kind === 'already') {
    return { ...base, status: 'already', runId: null, narration: opened.narration };
  }
  if (opened.kind === 'refused' || model === null) {
    return {
      ...base,
      status: 'refused',
      runId: opened.kind === 'refused' ? opened.runId : null,
      narration: null,
      refusal: opened.kind === 'refused' ? opened.refusal : 'kind_disabled',
    };
  }
  const runId = opened.runId;

  // --- 5. the call, watched ------------------------------------------------------
  const controller = new AbortController();
  const watch = watchRun({
    controller,
    pollMs: dependencies.runWatchPollMs ?? RUN_WATCH_POLL_MS,
    probe: () => readGate(database, dependencies.switches, { ...gate, runId }),
  });
  let reply: Awaited<ReturnType<BriefNarrateModelPort['run']>> | null = null;
  let failure: unknown = null;
  try {
    reply = await invokeModel(model, built.request, controller, limits.timeout_ms);
  } catch (error) {
    failure = error;
  } finally {
    await watch.stop();
  }

  // --- 6–7. transaction 2: the barrier, the record, the outcome -------------------
  return database.transaction(async (tx) => {
    const durationMs = Math.max(0, context.clock.nowMs() - started);
    const scopes = [...target.scopes];
    const stoppedBy =
      watch.reason() ??
      (failure instanceof RunCancelled ? failure.reason : null) ??
      (await readGate(tx, dependencies.switches, { ...gate, runId }));
    if (stoppedBy !== null) {
      await finishRun(tx, context, {
        runId,
        status: 'cancelled',
        cancelReason: stoppedBy as never,
        inputDigest: built.digest,
        grantedScopes: scopes,
        durationMs,
      });
      const narration = await finishBriefNarration(tx, context, {
        briefId: target.briefId,
        status: 'cancelled',
        narration: null,
        recap: null,
        refusal: null,
        model: null,
      });
      return {
        ...base,
        status: 'cancelled' as const,
        runId,
        narration,
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
      const narration = await finishBriefNarration(tx, context, {
        briefId: target.briefId,
        status: 'failed',
        narration: null,
        recap: null,
        refusal: null,
        model: null,
      });
      return { ...base, status: 'failed' as const, runId, narration, errorCode };
    }
    const verdict = validateBriefNarrateReply(reply.reply, built.check);
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
    // A reply outside the format is a failure for the breaker; a reply the
    // validator refused on its content is not (a hostile title that talks the
    // model into a figure must not switch the feature off).
    await tripBreaker(tx, context, !schema);
    const narration = await finishBriefNarration(tx, context, {
      briefId: target.briefId,
      status: verdict.ok ? 'shown' : 'refused',
      narration: verdict.ok ? verdict.narration : null,
      recap: verdict.ok ? verdict.recap : null,
      refusal: verdict.ok ? null : verdict.refusal,
      model: reply.label,
    });
    return {
      ...base,
      status: 'completed' as const,
      runId,
      narration,
      errorCode: schema ? 'reply_schema' : null,
      replyRefusal: verdict.ok ? null : verdict.refusal,
    };
  });
}
